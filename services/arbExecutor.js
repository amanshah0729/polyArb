require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const { Resend } = require('resend');
const eventLog = require('./eventLog');
const polyTrader = require('./polyTrader');
const { placeBet } = require('../scripts/bfagaming/placeBet');
const cooldown = require('./bfaCooldown');

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

  // 2. Check cooldown + BFA balance up front (belt-and-suspenders; placeBet also checks)
  if (cooldown.isInCooldown()) {
    const final = { attemptId, outcome: 'skipped', reason: 'bfa_cooldown', ...meta };
    eventLog.finalize(final);
    return final;
  }

  // 3. Buy Poly leg (IOC at quoted ask + slippage)
  const polyBuy = await polyTrader.buyIOC({
    marketSlug: poly.marketSlug,
    intent: poly.intent,
    price: actualAsk,
    quantity: poly.quantity,
    tolerance: POLY_BUY_SLIPPAGE,
  });

  if (!polyBuy.filledQty || polyBuy.filledQty <= 0) {
    eventLog.polyFailed({ attemptId, ...polyBuy });
    const final = { attemptId, outcome: 'false_arb', reason: 'poly_no_fill', polyBuy, ...meta };
    eventLog.finalize(final);
    return final;
  }

  // Verify fill matches expected
  const fillSlippage = (polyBuy.avgPx ?? polyBuy.limitPrice) - poly.expectedPrice;
  eventLog.polyFilled({
    attemptId, marketSlug: poly.marketSlug, orderId: polyBuy.orderId,
    filledQty: polyBuy.filledQty, avgPx: polyBuy.avgPx, notional: polyBuy.notional,
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
      polyBuy: { orderId: polyBuy.orderId, filledQty: polyBuy.filledQty, avgPx: polyBuy.avgPx },
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
    entryPrice: polyBuy.avgPx ?? poly.expectedPrice,
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

module.exports = { executeArb };
