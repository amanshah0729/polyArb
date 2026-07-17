require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const { Resend } = require('resend');
const eventLog = require('./eventLog');
const polyTrader = require('./polyTrader');
const polyBook = require('./polyBook');
const { placeBet } = require('../scripts/bfagaming/placeBet');
const cooldown = require('./bfaCooldown');
const riskLimits = require('./riskLimits');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALARM_EMAIL = process.env.NOTIFICATION_EMAIL;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const POLY_PRICE_TOLERANCE = 0.01;
const POLY_BUY_SLIPPAGE = 0.005;

async function alarm(subject, body, payload = {}) {
  eventLog.alarm({ subject, body, ...payload });
  if (!resend || !ALARM_EMAIL) return;
  try {
    await resend.emails.send({
      from: 'polyArb <onboarding@resend.dev>',
      to: [ALARM_EMAIL],
      subject: `[polyArb ALARM] ${subject}`,
      text: body,
    });
  } catch (e) {
    console.error('Alarm email failed:', e.message);
  }
}

/**
 * Execute an arb opportunity.
 *   bfa:  { eventId, fixtureId, marketType, side, contestantId, line, price, amount, isLive }
 *   poly: { marketSlug, intent, expectedPrice, quantity }
 *   meta: { strategy, sport, awayTeam, homeTeam, profitPct, bestCost }
 * Returns the final outcome record.
 */
async function executeArb({ bfa, poly, meta = {}, opts = {} }) {
  const attemptId = crypto.randomUUID();
  const started = Date.now();

  eventLog.attempt({
    attemptId,
    bfa: { ...bfa },
    poly: { ...poly },
    meta,
  });

  // Pre-resolve the Poly slug using rich scan-row context (sport, date, team
  // names, marketType, isSeries). The name-based matcher handles Predexon ↔
  // Polymarket.US encoding divergence (digits in fighter codes, reversed
  // home/away order, accented names) by matching on `market.question` rather
  // than slug-substring heuristics. PM.US series markets are tradeable; we no
  // longer reject them — the cross-type guard inside the matcher prevents a
  // single-game scan from binding to a series market and vice versa.
  const matcher = require('./marketMatcher');
  // For series markets each PM.US outcome side has its own slug (`-det`,
  // `-orl`). Pass the team being bought on Poly so the matcher picks the
  // right side. Default: derive from polySide if frontend didn't send it.
  const polyTeamFromSide = meta.polySide === 'away' ? meta.awayTeam : meta.polySide === 'home' ? meta.homeTeam : null;
  let resolvedSlug = null;
  try {
    const r = await matcher.resolveMarket(polyTrader.client(), {
      slug:       poly.marketSlug,
      sport:      meta.sport,
      date:       meta.date,
      awayTeam:   meta.awayTeam,
      homeTeam:   meta.homeTeam,
      polyTeam:   meta.polyTeam || polyTeamFromSide,
      isSeries:   meta.isSeries,
      marketType: meta.marketType,
      line:       meta.line,
    });
    resolvedSlug = r?.resolvedSlug || null;
  } catch (e) {
    const final = {
      attemptId, outcome: 'unsupported', reason: 'resolver_threw',
      marketSlug: poly.marketSlug, error: e.message, ...meta,
    };
    eventLog.finalize(final);
    return final;
  }
  if (!resolvedSlug) {
    const final = {
      attemptId, outcome: 'unsupported', reason: 'no_match_found',
      marketSlug: poly.marketSlug, resolvedSlug: null,
      hint: 'No Polymarket.US market matches this scan row (names + date + market type).',
      ...meta,
    };
    eventLog.finalize(final);
    return final;
  }

  // PM.US series markets (`tec-`) are per-outcome single-leg markets — buying
  // a side is always BUY_LONG regardless of the binary intent the scanner
  // emitted. Rewire poly.* to the resolved slug + corrected intent so all
  // downstream BBO/depth/order calls use the real PM.US market.
  poly.marketSlug = resolvedSlug;
  if (resolvedSlug.startsWith('tec-')) {
    poly.intent = 'ORDER_INTENT_BUY_LONG';
  }

  // 1. Pre-flight: re-quote Poly to catch ghost arbs
  let bbo;
  try { bbo = await polyTrader.getBBO(poly.marketSlug); }
  catch (e) {
    const final = { attemptId, outcome: 'false_arb', reason: 'poly_bbo_fetch_failed', error: e.message, ...meta };
    eventLog.finalize(final);
    return final;
  }
  const actualAsk = poly.intent === 'ORDER_INTENT_BUY_SHORT'
    ? (bbo.bestBid != null ? 1 - bbo.bestBid : null)   // SHORT buy price ≈ 1 - bestBid
    : bbo.bestAsk;

  if (actualAsk == null) {
    const final = { attemptId, outcome: 'false_arb', reason: 'poly_no_quote', bbo, ...meta };
    eventLog.finalize(final);
    return final;
  }
  const drift = actualAsk - poly.expectedPrice;
  if (drift > POLY_PRICE_TOLERANCE) {
    const final = {
      attemptId, outcome: 'false_arb', reason: 'poly_price_moved',
      expectedPrice: poly.expectedPrice, actualAsk, drift, bbo, ...meta,
    };
    eventLog.finalize(final);
    return final;
  }

  // Re-validate the arb at the LIVE ask. The drift check above only confirms the ask
  // hasn't moved past the *expected* price — but if expectedPrice itself was already a
  // drifted (post-scan) price, bfaImplied + actualAsk can be out of any arb tier while
  // drift ≈ 0. Recompute the cost from the live ask and refuse to fire an out-of-tier
  // "arb" (this is what let a 42%-scanned row execute at 44%). Protects every caller,
  // including the auto path that passes scan-row meta straight through.
  const { tierForCost } = require('./betSizing');
  const liveBfaImplied = Number(meta.bfaImplied);
  if (Number.isFinite(liveBfaImplied) && liveBfaImplied > 0 && liveBfaImplied < 1) {
    // Fee-aware: charge the PM.US taker fee (or credit the maker rebate) into the cost
    // the gate checks, so ask + fee + bfaImplied is what's compared against the arb tier.
    const gateFeeMode = opts.execMode === 'maker' ? 'maker' : 'taker';
    const liveFee = polyBook.effectiveFeeAdder(actualAsk, gateFeeMode);
    const liveCost = liveBfaImplied + actualAsk + liveFee;
    if (!tierForCost(liveCost)) {
      const final = {
        attemptId, outcome: 'false_arb', reason: 'arb_gone_live_price',
        liveCost, actualAsk, liveFee, bfaImplied: liveBfaImplied,
        scannedCost: Number(meta.scannedCost ?? meta.bestCost),
        scannedPolyImplied: Number(meta.scannedPolyImplied ?? meta.polyImplied), ...meta,
      };
      eventLog.finalize(final);
      return final;
    }
  }

  const execMode = opts.execMode === 'maker' ? 'maker' : 'ioc';
  const feeMode = execMode === 'maker' ? 'maker' : 'taker';

  // 1b. Depth-aware pre-flight: make sure the requested qty fits inside the
  // profitable portion of the book (price + bfaImplied < 1 at every level).
  const bfaImpliedForDepth = Number(meta.bfaImplied);
  if (Number.isFinite(bfaImpliedForDepth) && bfaImpliedForDepth > 0 && bfaImpliedForDepth < 1) {
    try {
      const depth = await polyTrader.getDepth(poly.marketSlug);
      const mp = polyBook.maxProfitableSize({
        book: depth.raw, intent: poly.intent, bfaImplied: bfaImpliedForDepth, feeMode,
      });
      if (mp.maxShares > 0 && poly.quantity > mp.maxShares + 1e-6) {
        const final = {
          attemptId, outcome: 'false_arb', reason: 'size_exceeds_depth',
          requestedQty: poly.quantity, maxShares: mp.maxShares,
          vwapAtMax: mp.vwapAtMax, expectedPnl: mp.expectedPnl, ...meta,
        };
        eventLog.finalize(final);
        return final;
      }
    } catch (e) {
      // Depth unknown — don't block execution; BBO check above is still in force.
      eventLog.attempt({ attemptId, note: 'depth_fetch_failed', error: e.message });
    }
  }

  // 2. Check cooldown + BFA balance up front (belt-and-suspenders; placeBet also checks)
  if (cooldown.isInCooldown()) {
    const final = { attemptId, outcome: 'skipped', reason: 'bfa_cooldown', ...meta };
    eventLog.finalize(final);
    return final;
  }

  // 3. Buy Poly leg — IOC (taker) or maker GTC with optional IOC fallback
  let polyBuy;
  if (execMode === 'maker') {
    // Post passively: for BUY_LONG rest at/below bestBid; for BUY_SHORT rest at/above bestAsk (long-side).
    // Price arg is in long-side coords (same as buyIOC).
    const makerPx = poly.intent === 'ORDER_INTENT_BUY_SHORT'
      ? (bbo.bestAsk != null ? bbo.bestAsk : 1 - poly.expectedPrice)
      : (bbo.bestBid != null ? bbo.bestBid : poly.expectedPrice);
    polyBuy = await polyTrader.buyMaker({
      marketSlug: poly.marketSlug,
      intent: poly.intent,
      price: makerPx,
      quantity: poly.quantity,
      timeoutMs: opts.makerTimeoutMs ?? 30000,
      pollMs: opts.makerPollMs ?? 2000,
      iocFallback: opts.iocFallback === true,
      fallbackPrice: actualAsk,
      fallbackTolerance: POLY_BUY_SLIPPAGE,
    });
  } else {
    polyBuy = await polyTrader.buyIOC({
      marketSlug: poly.marketSlug,
      intent: poly.intent,
      price: actualAsk,
      quantity: poly.quantity,
      tolerance: POLY_BUY_SLIPPAGE,
    });
  }

  if (!polyBuy.filledQty || polyBuy.filledQty <= 0) {
    eventLog.polyFailed({ attemptId, ...polyBuy });
    const final = { attemptId, outcome: 'false_arb', reason: 'poly_no_fill', polyBuy, ...meta };
    eventLog.finalize(final);
    return final;
  }

  // Verify fill matches expected. SDK avgPx is ALWAYS long-side coords; for
  // BUY_SHORT the price actually paid per share is 1 − avgPx. Comparing raw
  // long-side avgPx against the short-side expectedPrice flags clean short
  // fills as massive slippage and unwinds them.
  const rawFillPx = polyBuy.avgPx ?? polyBuy.limitPrice;
  const effectiveFillPx = poly.intent === 'ORDER_INTENT_BUY_SHORT' && rawFillPx != null
    ? 1 - rawFillPx
    : rawFillPx;
  polyBuy.effectivePx = effectiveFillPx;
  const fillSlippage = effectiveFillPx - poly.expectedPrice;
  eventLog.polyFilled({
    attemptId, marketSlug: poly.marketSlug, orderId: polyBuy.orderId,
    filledQty: polyBuy.filledQty, avgPx: polyBuy.avgPx, effectivePx: effectiveFillPx, notional: polyBuy.notional,
    expectedPrice: poly.expectedPrice, fillSlippage,
  });

  if (fillSlippage > POLY_PRICE_TOLERANCE) {
    // Filled at worse than tolerance — unwind immediately rather than proceed
    const unwind = await polyTrader.unwindLadder({
      marketSlug: poly.marketSlug, intent: poly.intent,
      entryPrice: polyBuy.avgPx, quantity: polyBuy.filledQty,
    });
    eventLog.unwind({ attemptId, reason: 'poly_slippage_exceeded', ...unwind });
    const final = {
      attemptId, outcome: unwind.success ? 'poly_unwound' : 'poly_stuck',
      reason: 'poly_slippage_exceeded',
      polyBuy, unwind, unwindLoss: unwind.unwindLoss, ...meta,
    };
    eventLog.finalize(final);
    if (!unwind.success) {
      await alarm('Poly unwind incomplete after slippage',
        `Failed to sell ${unwind.remainingQty}/${polyBuy.filledQty} shares on ${poly.marketSlug}. Manual intervention required.`,
        { attemptId, final });
    }
    return final;
  }

  // 3b. Partial fill → scale the BFA hedge to the shares actually filled. The
  // BFA stake was sized to hedge the FULL poly.quantity (equal-payout); an IOC
  // that only cleared part of a thin book leaves us net-long BFA if we place
  // the whole stake. Preserve the original stake:shares ratio. If the scaled
  // stake would fall below BFA's $5 minimum we can't place a valid hedge at
  // all, so unwind the Poly fill instead of firing a naked BFA bet.
  const { BFA_MIN_BET } = require('./betSizing');
  const requestedQty = poly.quantity;
  if (Number.isFinite(requestedQty) && requestedQty > 0 && polyBuy.filledQty + 1e-6 < requestedQty) {
    const fillRatio = polyBuy.filledQty / requestedQty;
    const scaled = Math.round(bfa.amount * fillRatio * 100) / 100;
    eventLog.attempt({
      attemptId, note: 'poly_partial_fill',
      filledQty: polyBuy.filledQty, requestedQty, fillRatio, bfaFull: bfa.amount, bfaScaled: scaled,
    });
    if (scaled < BFA_MIN_BET) {
      const unwind = await polyTrader.unwindLadder({
        marketSlug: poly.marketSlug, intent: poly.intent,
        entryPrice: polyBuy.avgPx ?? (poly.intent === 'ORDER_INTENT_BUY_SHORT' ? 1 - poly.expectedPrice : poly.expectedPrice),
        quantity: polyBuy.filledQty,
      });
      eventLog.unwind({ attemptId, reason: 'partial_fill_below_bfa_min', ...unwind });
      const final = {
        attemptId, outcome: unwind.success ? 'poly_unwound' : 'poly_stuck',
        reason: 'partial_fill_below_bfa_min',
        polyBuy: { orderId: polyBuy.orderId, filledQty: polyBuy.filledQty, avgPx: polyBuy.avgPx },
        unwind, unwindLoss: unwind.unwindLoss, ...meta,
      };
      eventLog.finalize(final);
      if (!unwind.success) {
        await alarm('Poly unwind incomplete after sub-min partial fill',
          `Failed to sell ${unwind.remainingQty}/${polyBuy.filledQty} shares on ${poly.marketSlug}. Manual intervention required.`,
          { attemptId, final });
      }
      return final;
    }
    // Scale the BFA stake and the reported guaranteed PnL to the filled portion.
    bfa.amount = scaled;
    if (Number.isFinite(meta.guaranteedPnl)) meta.guaranteedPnl = Math.round(meta.guaranteedPnl * fillRatio * 100) / 100;
  }

  // 4. Place BFA leg
  let bfaRes;
  try {
    bfaRes = await placeBet({
      ...bfa,
      meta: { attemptId, polyOrderId: polyBuy.orderId, ...meta },
    });
  } catch (e) {
    bfaRes = { placed: false, error: e.message, skipped: false };
  }

  if (bfaRes?.placed) {
    eventLog.bfaFilled({ attemptId, idTransaction: bfaRes.idTransaction, amount: bfa.amount, price: bfa.price });
    const guaranteedPnl = meta.guaranteedPnl ?? null;
    const final = {
      attemptId, outcome: 'filled_both',
      polyBuy: { orderId: polyBuy.orderId, filledQty: polyBuy.filledQty, avgPx: polyBuy.avgPx, effectivePx: polyBuy.effectivePx },
      bfa: { idTransaction: bfaRes.idTransaction, amount: bfa.amount, price: bfa.price },
      guaranteedPnl, ...meta,
    };
    eventLog.finalize(final);
    return final;
  }

  // BFA failed — unwind Poly
  eventLog.bfaFailed({
    attemptId,
    reason: bfaRes?.reason ?? 'unknown',
    skipped: !!bfaRes?.skipped,
    error: bfaRes?.error ?? null,
    body: bfaRes?.body ?? null,
  });

  const unwind = await polyTrader.unwindLadder({
    marketSlug: poly.marketSlug, intent: poly.intent,
    // unwindLadder expects long-side coords (SDK avgPx convention); the
    // expectedPrice fallback is in intent coords, so convert for shorts.
    entryPrice: polyBuy.avgPx ?? (poly.intent === 'ORDER_INTENT_BUY_SHORT' ? 1 - poly.expectedPrice : poly.expectedPrice),
    quantity: polyBuy.filledQty,
  });
  eventLog.unwind({ attemptId, reason: 'bfa_failed', ...unwind });

  const final = {
    attemptId,
    outcome: unwind.success ? 'poly_unwound' : 'poly_stuck',
    reason: bfaRes?.skipped ? `bfa_skipped:${bfaRes.reason}` : 'bfa_failed',
    polyBuy: { orderId: polyBuy.orderId, filledQty: polyBuy.filledQty, avgPx: polyBuy.avgPx },
    bfa: bfaRes,
    unwind, unwindLoss: unwind.unwindLoss,
    ...meta,
  };
  eventLog.finalize(final);

  await alarm(
    unwind.success ? 'BFA leg failed — Poly unwound' : 'BFA leg failed — Poly STUCK',
    [
      `Strategy: ${meta.strategy ?? '?'}`,
      `BFA outcome: ${bfaRes?.reason ?? bfaRes?.error ?? 'failed'}`,
      `Poly bought: ${polyBuy.filledQty} @ ${polyBuy.avgPx?.toFixed(4)}`,
      `Poly sold: ${unwind.soldQty}/${polyBuy.filledQty} for $${unwind.realizedValue?.toFixed(2)}`,
      `Unwind loss: $${unwind.unwindLoss?.toFixed(2)}`,
      unwind.success ? '' : `RESIDUAL ${unwind.remainingQty} shares still held — manual action required.`,
    ].filter(Boolean).join('\n'),
    { attemptId }
  );

  return final;
}

/**
 * Risk-gated wrapper around executeArb. Every execution path (manual /execute
 * endpoint AND the auto-fire loop) MUST call this, not executeArb directly, so
 * the circuit breaker is enforced in exactly one place:
 *   1. precheck the candidate against the fire-time ceilings + sticky HALT
 *   2. run the arb
 *   3. record the outcome (may latch a HALT for the next attempt)
 */
async function executeArbGuarded({ bfa, poly, meta = {}, opts = {} }) {
  const gate = riskLimits.precheck({ bfaAmount: bfa?.amount });
  if (!gate.ok) {
    const final = eventLog.finalize({
      attemptId: crypto.randomUUID(), outcome: 'risk_blocked',
      reason: gate.reason, riskSnapshot: gate.snapshot ?? null, riskLimits: gate.limits ?? null, ...meta,
    });
    return final;
  }
  const result = await executeArb({ bfa, poly, meta, opts });
  try { riskLimits.recordOutcome(result); } catch (e) { console.error('riskLimits.recordOutcome threw:', e.message); }
  return result;
}

module.exports = { executeArb, executeArbGuarded };
