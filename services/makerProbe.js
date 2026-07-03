/**
 * Maker-fill PROBE — Phase 2 of the maker-rebate viability experiment.
 *
 * Places REAL but TINY Polymarket orders to measure what the shadow logger can't:
 * do resting maker bids actually fill, and — conditional on filling — are they
 * adversely selected? The trick that makes this safe and self-contained:
 *
 *   post a maker bid inside the spread → on fill, IMMEDIATELY unwind it.
 *
 * The round-trip P&L is a direct, BFA-free measurement of adverse selection in
 * Poly's own price space:
 *   • round-trips near breakeven  → fills are "clean", the maker rebate is real profit
 *   • round-trips lose ~1¢/share  → adverse selection eats the rebate; maker not viable
 * We also log the rebate you'd have earned, so net = rebate − roundTripLoss is the
 * realized maker edge per attempt. No BFA leg ⇒ no partial-fill hedge hazard.
 *
 * SAFETY: nothing places an order unless invoked with `--yes`. Real probes also
 * require PROBE_ENABLED=true and are bounded by a persistent ledger: max $/order,
 * max cumulative realized loss (kill switch), and max attempts. One order at a time.
 *
 * CLI:
 *   node services/makerProbe.js smoke <slug> [--yes]          # plumbing test (non-marketable, auto-cancel)
 *   node services/makerProbe.js probe <slug> <intent> <postPrice> [sizeUsd] [--yes]
 *   node services/makerProbe.js auto [--yes]                  # probe the closest-to-gametime room market from the shadow log
 *   node services/makerProbe.js status                        # show ledger + caps
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const polyTrader = require('./polyTrader');
const polyBook = require('./polyBook');
const makerShadow = require('./makerShadow');

// ── Caps ────────────────────────────────────────────────────────────────────
const MAX_PER_ORDER_USD = Number(process.env.PROBE_MAX_ORDER_USD || 8);
const MAX_TOTAL_LOSS_USD = Number(process.env.PROBE_MAX_LOSS_USD || 25);   // kill switch
const MAX_ATTEMPTS = Number(process.env.PROBE_MAX_ATTEMPTS || 10);
const MAKER_TTL_MS = Number(process.env.PROBE_TTL_MS || 20 * 60 * 1000);   // rest up to 20 min
const POLL_MS = 5000;
const TICK = 0.001;

const DIR = path.join(__dirname, '..', 'priv', 'maker-probe');
const LEDGER = path.join(DIR, 'ledger.json');

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); }
  catch { return { attempts: 0, realizedPnl: 0, fills: 0 }; }
}
function saveLedger(l) { ensureDir(); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }

function logEvent(type, payload) {
  try {
    ensureDir();
    const d = new Date();
    const f = path.join(DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({ type, ts: d.toISOString(), ...payload }) + '\n');
  } catch { /* never crash on logging */ }
}

const makerRebate = (p) => 0.0125 * p * (1 - p);
const r3 = (x) => Math.round(x * 1000) / 1000;

// Chosen-outcome bid/ask from the long-side book (mirrors makerShadow).
function chosenQuote(rawBook, intent) {
  const { bids, offers } = polyBook.normalizeBook(rawBook);
  const longBid = bids[0]?.px ?? null;
  const longAsk = offers[0]?.px ?? null;
  if (longBid == null || longAsk == null) return null;
  if (intent === 'ORDER_INTENT_BUY_SHORT') return { bid: 1 - longAsk, ask: 1 - longBid };
  return { bid: longBid, ask: longAsk };
}
// buyMaker/placeOrder want a LONG-side price; convert from chosen-outcome coords.
const toLongPrice = (chosenPrice, intent) =>
  intent === 'ORDER_INTENT_BUY_SHORT' ? r3(1 - chosenPrice) : r3(chosenPrice);

function checkCaps(ledger) {
  if (ledger.realizedPnl <= -MAX_TOTAL_LOSS_USD) return `kill switch: cumulative loss $${(-ledger.realizedPnl).toFixed(2)} ≥ $${MAX_TOTAL_LOSS_USD}`;
  if (ledger.attempts >= MAX_ATTEMPTS) return `attempt cap: ${ledger.attempts}/${MAX_ATTEMPTS} used`;
  return null;
}

// ── Smoke test: place a deliberately non-marketable maker order, then cancel ──
// Verifies the Poly order path (place + cancel) with ~zero fill risk.
async function smoke(slug, live) {
  const depth = await polyTrader.getDepth(slug);
  const q = chosenQuote(depth.raw, 'ORDER_INTENT_BUY_LONG');
  if (!q) throw new Error('no book for ' + slug);
  const price = r3(Math.max(0.01, q.bid - 0.05)); // 5¢ below best bid → will not fill
  const quantity = Math.max(1, Math.floor(2 / price)); // ~$2 notional
  console.log(`[smoke] ${slug}  bestBid=${q.bid} → posting non-marketable BUY_LONG ${quantity}@${price} (auto-cancel)`);
  if (!live) { console.log('[smoke] DRY RUN (pass --yes to place). Plumbing not exercised.'); return; }

  const res = await polyTrader.buyMaker({
    marketSlug: slug, intent: 'ORDER_INTENT_BUY_LONG', price, quantity,
    timeoutMs: 4000, pollMs: 1500, iocFallback: false,
  });
  logEvent('smoke', { slug, price, quantity, result: res });
  if (res.error) { console.log(`[smoke] ❌ order path FAILED: ${res.error}`); return; }
  console.log(`[smoke] ✅ placed orderId=${res.orderId}, filled=${res.filledQty} (expected 0), then cancelled. Poly order path works.`);
}

// ── Real probe: post maker inside the spread, unwind on fill, measure round-trip ─
async function probe({ slug, intent, postPrice, sizeUsd, label }, live) {
  const ledger = loadLedger();
  const capMsg = checkCaps(ledger);
  if (capMsg) { console.log(`[probe] BLOCKED — ${capMsg}`); return; }
  if (live && process.env.PROBE_ENABLED !== 'true') {
    console.log('[probe] BLOCKED — set PROBE_ENABLED=true to place real probe orders'); return;
  }

  // Re-validate against the live book: still inside the spread, still a maker.
  const depth = await polyTrader.getDepth(slug);
  const q = chosenQuote(depth.raw, intent);
  if (!q) { console.log('[probe] no book — abort'); return; }
  if (!(postPrice > q.bid && postPrice < q.ask)) {
    console.log(`[probe] postPrice ${postPrice} no longer strictly inside spread [${r3(q.bid)}, ${r3(q.ask)}] — abort (market moved)`);
    return;
  }

  const usd = Math.min(sizeUsd || MAX_PER_ORDER_USD, MAX_PER_ORDER_USD);
  const quantity = Math.max(1, Math.floor(usd / postPrice));
  const longPrice = toLongPrice(postPrice, intent);
  const rebateExpected = makerRebate(postPrice) * quantity;

  console.log(`[probe] ${label || slug} ${intent}`);
  console.log(`  spread=[${r3(q.bid)}, ${r3(q.ask)}]  post chosen=${postPrice} (long=${longPrice})  qty=${quantity} (~$${(quantity * postPrice).toFixed(2)})  TTL=${MAKER_TTL_MS / 60000}min`);
  console.log(`  rebate if filled ≈ $${rebateExpected.toFixed(3)}`);
  if (!live) { console.log('  DRY RUN (pass --yes to place).'); return; }

  ledger.attempts += 1; saveLedger(ledger);
  const postTs = Date.now();
  const buy = await polyTrader.buyMaker({
    marketSlug: slug, intent, price: longPrice, quantity,
    timeoutMs: MAKER_TTL_MS, pollMs: POLL_MS, iocFallback: false,
  });

  if (buy.error) {
    console.log(`  ❌ order error: ${buy.error}`);
    logEvent('probe', { slug, intent, postPrice, quantity, outcome: 'error', buy });
    return;
  }

  if (!buy.filledQty || buy.filledQty <= 0) {
    console.log(`  ⏳ NO FILL in ${MAKER_TTL_MS / 60000}min — cancelled. (order rested, nobody hit it)`);
    logEvent('probe', {
      slug, intent, postPrice, quantity, outcome: 'no_fill',
      restedMs: Date.now() - postTs, buy,
    });
    return;
  }

  // Filled (maybe partially) → immediately unwind to stay flat and measure adverse selection.
  const filled = buy.filledQty;
  console.log(`  ✅ FILLED ${filled}/${quantity} @ ${buy.avgPx} after ${((Date.now() - postTs) / 1000).toFixed(0)}s — unwinding…`);
  const unwind = await polyTrader.unwindLadder({
    marketSlug: slug, intent, entryPrice: buy.avgPx, quantity: filled,
  });

  const roundTripLoss = unwind.unwindLoss != null ? unwind.unwindLoss : (buy.notional - (unwind.realizedValue || 0));
  const rebateEarned = makerRebate(buy.avgPx) * filled;
  const netEdge = rebateEarned - roundTripLoss; // realized maker edge on this fill
  ledger.fills += 1;
  ledger.realizedPnl += netEdge;
  saveLedger(ledger);

  console.log(`  round-trip loss=$${roundTripLoss?.toFixed(3)}  rebate earned≈$${rebateEarned.toFixed(3)}  NET EDGE=$${netEdge.toFixed(3)}  ${unwind.success ? '' : '⚠ UNWIND INCOMPLETE — residual held!'}`);
  console.log(`  ledger: attempts=${ledger.attempts} fills=${ledger.fills} cumulativePnl=$${ledger.realizedPnl.toFixed(3)}`);
  logEvent('probe', {
    slug, intent, postPrice, quantity, outcome: 'filled',
    filledQty: filled, avgPx: buy.avgPx, timeToFillMs: Date.now() - postTs,
    unwind, roundTripLoss, rebateEarned, netEdge,
    unwindSuccess: unwind.success, residualQty: unwind.remainingQty,
  });
}

// Pick the closest-to-gametime room market from the shadow log and probe it.
async function auto(live) {
  const opens = makerShadow.readLog('shadow_open', Date.now() - 60 * 60 * 1000)
    .filter((o) => o.makerRoom && o.postPrice > 0);
  if (!opens.length) { console.log('[auto] no room markets in the last hour of shadow logs'); return; }
  // Smallest positive timeToGame = most trade flow.
  opens.sort((a, b) => (a.timeToGameMs ?? Infinity) - (b.timeToGameMs ?? Infinity));
  const o = opens[0];
  const hrs = o.timeToGameMs != null ? (o.timeToGameMs / 3600000).toFixed(1) : '?';
  console.log(`[auto] chose ${o.teams} (${o.sport}) — ${hrs}h to game, spread ${o.spreadTicks}tk`);
  if (o.timeToGameMs != null && o.timeToGameMs > 24 * 3600 * 1000) {
    console.log('[auto] ⚠ closest room market is >24h out — likely no flow, fill unlikely. Proceeding anyway since you asked.');
  }
  await probe({ slug: o.slug, intent: o.intent, postPrice: o.postPrice, label: o.teams }, live);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--yes');
  const cmd = args[0];
  const pos = args.filter((a) => a !== '--yes');

  if (cmd === 'status') {
    const l = loadLedger();
    console.log('Ledger:', JSON.stringify(l));
    console.log(`Caps: $${MAX_PER_ORDER_USD}/order, $${MAX_TOTAL_LOSS_USD} max loss, ${MAX_ATTEMPTS} attempts, TTL ${MAKER_TTL_MS / 60000}min`);
    console.log(`PROBE_ENABLED=${process.env.PROBE_ENABLED === 'true'}`);
    return;
  }
  if (cmd === 'smoke') { await smoke(pos[1], live); return; }
  if (cmd === 'auto') { await auto(live); return; }
  if (cmd === 'probe') {
    const [, slug, intent, postPrice, sizeUsd] = pos;
    if (!slug || !intent || !postPrice) { console.log('usage: probe <slug> <intent> <postPrice> [sizeUsd] [--yes]'); return; }
    await probe({ slug, intent, postPrice: Number(postPrice), sizeUsd: sizeUsd ? Number(sizeUsd) : undefined }, live);
    return;
  }
  console.log('commands: smoke <slug> | probe <slug> <intent> <postPrice> [sizeUsd] | auto | status   (add --yes to place real orders)');
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

module.exports = { smoke, probe, auto, loadLedger };
