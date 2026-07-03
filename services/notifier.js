/**
 * BFA ↔ Polymarket Arb Notifier
 *
 * Standalone service that:
 *   1. Runs an Express health server (for Render + uptime pings)
 *   2. Scans BFA↔Polymarket for arb on a jittered 4–8 min interval
 *   3. Emails via Resend when cost ≤ 1.000
 *   4. Deduplicates so you don't get spammed for the same game
 *
 * Env vars required:
 *   PREDEXON_API_KEY, RESEND_API_KEY, NOTIFICATION_EMAIL
 *
 * Usage:  node services/notifier.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { runScan } = require('../scripts/bfagaming/scan');
const eventLog = require('./eventLog');
const stats = require('./stats');
const cooldown = require('./bfaCooldown');
const { executeArb } = require('./arbExecutor');
const { sizeArb } = require('./betSizing');
const polyTrader = require('./polyTrader');
const polyBook = require('./polyBook');
const makerShadow = require('./makerShadow');
const { getBalance } = require('../scripts/bfagaming/placeBet');

const OUT_DIR = path.join(__dirname, '..', 'outputs', 'bfagaming');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Config ────────────────────────────────────────────────────────────────────

const PORT              = process.env.PORT || 3001;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL;
const EXECUTION_ENABLED  = process.env.EXECUTION_ENABLED === 'true';
const EXECUTION_TOKEN    = process.env.EXECUTION_TOKEN || '';
const MAX_LEG_NOTIONAL   = 200;
const ARB_MIN_COST      = 0.95;
const ARB_MAX_COST      = 1.000;
const MIN_INTERVAL_MS   = 4 * 60 * 1000;  // 4 minutes
const MAX_INTERVAL_MS   = 8 * 60 * 1000;  // 8 minutes

if (!RESEND_API_KEY) { console.error('RESEND_API_KEY not set'); process.exit(1); }
if (!NOTIFICATION_EMAIL) { console.error('NOTIFICATION_EMAIL not set'); process.exit(1); }

const resend = new Resend(RESEND_API_KEY);

// ── Dedup ─────────────────────────────────────────────────────────────────────
// Key: "awayTeam|homeTeam|strategy" → timestamp of last notification
// Clears entries older than 12 hours so games can re-alert across days.

const notified = new Map();
const DEDUP_TTL_MS = 12 * 60 * 60 * 1000;

function dedupKey(result) {
  return `${result.awayTeam}|${result.homeTeam}|${result.strategy}`;
}

function alreadyNotified(result) {
  const key = dedupKey(result);
  const last = notified.get(key);
  if (!last) return false;
  if (Date.now() - last > DEDUP_TTL_MS) {
    notified.delete(key);
    return false;
  }
  return true;
}

function markNotified(result) {
  notified.set(dedupKey(result), Date.now());
}

function pruneDedup() {
  const now = Date.now();
  for (const [key, ts] of notified) {
    if (now - ts > DEDUP_TTL_MS) notified.delete(key);
  }
}

// ── True P&L after Polymarket taker fees (pre-bonus) ─────────────────────────
// Uses scan-time numbers (bfaBet, polyBet, bfaImplied, chosen polyImplied) and
// the PM.US DCM fee formula (taker per-share = max($0.01, 0.05·p·(1−p))).
// This is the "is this actually positive after fees?" filter used to gate
// emails and highlight rows. Pre-bonus on purpose — the bonus is amortized
// promo credit, not realized cash on this single bet.
function computeTruePnl(r) {
  const W = Number(r.bfaBet);
  const P = Number(r.polyBet);
  const bfaImp = Number(r.bfaImplied);
  const polyImp = Number(r.polyImplied);
  if (![W, P, bfaImp, polyImp].every(Number.isFinite) || polyImp <= 0 || bfaImp <= 0) {
    return { truePnlAfterFees: null, truePositive: false };
  }
  const qty = P / polyImp;
  const feePerShare = Math.max(0.01, 0.05 * polyImp * (1 - polyImp));
  const polyFees = qty * feePerShare;
  const polyAllInCost = P + polyFees;
  const pnlIfBfaWins  = W / bfaImp - W - polyAllInCost;
  const pnlIfPolyWins = qty - W - polyAllInCost;
  const truePnlAfterFees = Math.min(pnlIfBfaWins, pnlIfPolyWins);
  return { truePnlAfterFees, truePositive: truePnlAfterFees > 0 };
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendArbEmail(arbs) {
  const lines = arbs.map((a) => {
    const profitStr = a.profitPct.toFixed(2);
    const costStr = a.bestCost.toFixed(4);
    return [
      `${a.sport}: ${a.awayTeam} vs ${a.homeTeam}`,
      `  Strategy:  ${a.strategy}`,
      `  Cost:      ${costStr}`,
      `  Profit:    ${profitStr}%`,
      `  BFA bet:   $${a.bfaBet.toFixed(2)}`,
      `  Poly bet:  $${a.polyBet.toFixed(2)}`,
      `  P&L (pre-fee): $${a.guaranteedPnl.toFixed(2)}`,
      `  P&L after fees: $${(a.truePnlAfterFees ?? 0).toFixed(2)}`,
      `  Net value (incl. bonus): $${a.netValue.toFixed(2)}`,
    ].join('\n');
  });

  const count = arbs.length;
  const subject = `Arb Detected – ${count} opportunit${count === 1 ? 'y' : 'ies'} found (after fees)`;

  const body = [
    `${count} arb opportunit${count === 1 ? 'y' : 'ies'} with positive P&L after Polymarket taker fees:`,
    '',
    ...lines.join('\n\n───────────────────────────\n\n').split('\n'),
    '',
    `Scanned at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT`,
  ].join('\n');

  try {
    const { error } = await resend.emails.send({
      from: 'polyArb <onboarding@resend.dev>',
      to: [NOTIFICATION_EMAIL],
      subject,
      text: body,
    });
    if (error) {
      console.error('Resend error:', error);
    } else {
      console.log(`  ✉ Email sent: ${subject}`);
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

// ── Maker shadow experiment: end-of-window summary email ───────────────────────
// Fires once when the shadow window closes so the experiment can't run unnoticed
// forever — you get the verdict in your inbox and logging stops.

async function sendShadowSummaryEmail(s) {
  const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const body = [
    'The maker-rebate viability experiment (Phase 1 shadow) has ended. Results:',
    '',
    `  Observations logged:     ${s.observations}`,
    `  Maker-room rate:         ${pct(s.makerRoomRate)}   (how often a profitable inside bid even exists)`,
    `  Orders watched to close: ${s.watched}`,
    `  Would-have-filled:       ${s.filled}  (fill rate ${pct(s.fillRate)})`,
    `  Arb survived at fill:    ${pct(s.arbSurvivalRate)}   (of fills, still profitable after BFA drift)`,
    `  Net hit rate:            ${pct(s.netHitRate)}   ← the verdict (watched → filled AND profitable)`,
    `  Median time-to-fill:     ${s.medianTimeToFillMinutes == null ? 'n/a' : s.medianTimeToFillMinutes + ' min'}`,
    `  Avg BFA drift at fill:   ${s.avgBfaDriftAtFill == null ? 'n/a' : s.avgBfaDriftAtFill.toFixed(4)}`,
    `  Avg realized $/share:    ${s.avgRealizedProfitPerShare == null ? 'n/a' : '$' + s.avgRealizedProfitPerShare.toFixed(4)}`,
    '',
    'Read: high net-hit-rate + positive $/share ⇒ maker is viable, proceed to Phase 2.',
    'Near-zero fills or negative $/share ⇒ maker not viable here.',
    'Shadow logging has now stopped. The notifier keeps scanning/emailing arbs as usual.',
  ].join('\n');
  try {
    const { error } = await resend.emails.send({
      from: 'polyArb <onboarding@resend.dev>',
      to: [NOTIFICATION_EMAIL],
      subject: 'Maker shadow experiment ended — results',
      text: body,
    });
    if (error) console.error('Shadow summary email error:', error);
    else console.log('  ✉ Maker shadow summary emailed.');
  } catch (err) {
    console.error('Shadow summary email failed:', err.message);
  }
}

// ── CSV output (for dashboard) ────────────────────────────────────────────────

function writeCSV(results) {
  const csvHeader = [
    'Date', 'Time', 'Sport', 'Market Type', 'Line',
    'Away Team', 'Home Team', 'Status',
    'Arb Opportunity', 'Strategy',
    'BFAGaming Away Odds', 'BFAGaming Away Implied (%)',
    'BFAGaming Home Odds', 'BFAGaming Home Implied (%)',
    'Polymarket Away Implied (%)', 'Polymarket Home Implied (%)',
    'Profit %', 'Best Option Cost',
    'BFA Bet ($)', 'Poly Bet ($)', 'Guaranteed P&L ($)', 'Net Value ($)', 'Volume ($)',
  ].join(',');

  const csvRows = results.map((r) => [
    `"${r.date}"`,
    `"${r.time}"`,
    `"${r.sport}"`,
    `"${r.marketType}"`,
    `"${r.line}"`,
    `"${r.awayTeam}"`,
    `"${r.homeTeam}"`,
    `"${r.status}"`,
    `"${r.hasArb ? 'YES' : 'NO'}"`,
    `"${r.strategy}"`,
    r.bfaAwayOdds,
    (r.bfaAwayImplied * 100).toFixed(2),
    r.bfaHomeOdds,
    (r.bfaHomeImplied * 100).toFixed(2),
    (r.polyAwayImplied * 100).toFixed(2),
    (r.polyHomeImplied * 100).toFixed(2),
    r.profitPct.toFixed(2),
    r.bestCost.toFixed(4),
    r.bfaBet.toFixed(2),
    r.polyBet.toFixed(2),
    r.guaranteedPnl.toFixed(2),
    r.netValue.toFixed(2),
    Math.round(r.volumeUsd ?? 0),
  ].join(','));

  const today = new Date().toISOString().split('T')[0];
  const outPath = path.join(OUT_DIR, `arb_bfagaming_${today}.csv`);
  fs.writeFileSync(outPath, [csvHeader, ...csvRows].join('\n'), 'utf8');
  console.log(`  CSV updated → ${outPath}`);
}

// ── Scan loop ─────────────────────────────────────────────────────────────────

let scanning = false;
let lastScanTime = null;
let lastScanArbs = 0;
let latestResults = [];

async function tick() {
  if (scanning) {
    console.log('Scan still running, skipping this tick.');
    scheduleNext();
    return;
  }

  scanning = true;
  const start = Date.now();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Scan starting at ${new Date().toLocaleString()}`);

  try {
    const results = await runScan();
    // Decorate each row with after-fee P&L so the frontend and email filter
    // share one source of truth.
    for (const r of results) Object.assign(r, computeTruePnl(r));
    latestResults = results;
    writeCSV(results);
    const arbs = results.filter((r) => r.hasArb && r.bestCost >= ARB_MIN_COST && r.bestCost <= ARB_MAX_COST);
    // Email only on arbs that are actually positive after Polymarket taker
    // fees (pre-bonus). Use truePositive instead of the pre-fee cost band.
    const trueArbs = arbs.filter((r) => r.truePositive);

    // Filter out already-notified arbs
    const newArbs = trueArbs.filter((a) => !alreadyNotified(a));

    console.log(`Scan done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${results.length} games, ${arbs.length} pre-fee arbs, ${trueArbs.length} positive after fees, ${newArbs.length} new`);

    eventLog.scan({
      durationMs: Date.now() - start,
      gamesChecked: results.length,
      arbsFound: arbs.length,
      newArbs: newArbs.length,
      cooldownActive: cooldown.isInCooldown(),
    });
    for (const a of arbs) {
      eventLog.arbFound({
        sport: a.sport, awayTeam: a.awayTeam, homeTeam: a.homeTeam,
        strategy: a.strategy, marketType: a.marketType, line: a.line,
        bestCost: a.bestCost, profitPct: a.profitPct,
        bfaBet: a.bfaBet, polyBet: a.polyBet, netValue: a.netValue,
      });
    }

    if (newArbs.length > 0) {
      await sendArbEmail(newArbs);
      newArbs.forEach(markNotified);
    }

    // Phase 1 maker-fill shadow experiment — logs only, places no orders.
    // Runs for a bounded window then auto-stops; emails the summary once when it
    // ends so it can't silently run forever. Defensive: never break the scan loop.
    try {
      if (makerShadow.isActive()) {
        await makerShadow.tick(results, polyTrader);
      } else if (!makerShadow.hasFinalized()) {
        await sendShadowSummaryEmail(makerShadow.summary());
        makerShadow.markFinalized();
        console.log('Maker shadow experiment window ended — summary emailed, logging stopped.');
      }
    } catch (e) {
      console.error('makerShadow error:', e.message);
    }

    lastScanTime = new Date().toISOString();
    lastScanArbs = arbs.length;
    pruneDedup();
  } catch (err) {
    console.error('Scan error:', err.message);
  } finally {
    scanning = false;
    scheduleNext();
  }
}

function scheduleNext() {
  const jitter = MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
  const mins = (jitter / 60000).toFixed(1);
  console.log(`Next scan in ${mins} min`);
  setTimeout(tick, jitter);
}

// ── Health server ─────────────────────────────────────────────────────────────

function readJsonBody(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleExecute(req, res, cors) {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  };

  if (!EXECUTION_ENABLED) return json(503, { error: 'execution_disabled', hint: 'Set EXECUTION_ENABLED=true on the notifier' });

  const authHeader = req.headers['authorization'] || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!EXECUTION_TOKEN || provided !== EXECUTION_TOKEN) return json(401, { error: 'unauthorized' });

  let payload;
  try { payload = await readJsonBody(req); }
  catch (e) { return json(400, { error: 'bad_body', message: e.message }); }

  const { bfa: bfaIn, poly: polyIn, meta = {}, scaleFactor = 1, execMode: execModeIn, iocFallback: iocFallbackIn } = payload || {};
  const execMode = execModeIn === 'maker' ? 'maker' : 'ioc';
  const feeMode = execMode === 'maker' ? 'maker' : 'taker';
  if (!bfaIn || !polyIn) return json(400, { error: 'missing_bfa_or_poly' });

  const requiredBfa = ['eventId', 'fixtureId', 'marketType', 'side', 'contestantId', 'price'];
  for (const k of requiredBfa) if (bfaIn[k] == null) return json(400, { error: `missing_bfa_field:${k}` });
  const requiredPoly = ['marketSlug', 'intent', 'expectedPrice'];
  for (const k of requiredPoly) if (polyIn[k] == null) return json(400, { error: `missing_poly_field:${k}` });

  if (cooldown.isInCooldown()) {
    return json(409, { error: 'bfa_cooldown', cooldown: cooldown.status() });
  }

  let balance = null;
  try {
    const bal = await getBalance();
    balance = Number(bal?.availableBalance ?? 0);
  } catch (e) {
    return json(502, { error: 'balance_fetch_failed', message: e.message });
  }

  const bestCost = Number(meta.bestCost);
  const bfaImplied = Number(meta.bfaImplied);
  const polyImplied = Number(meta.polyImplied);
  // Fetch Poly book so sizing can depth-clamp before we place anything.
  let depthRaw = null;
  try {
    const d = await polyTrader.getDepth(polyIn.marketSlug);
    depthRaw = d.raw;
  } catch (e) {
    console.warn(`[execute] depth fetch failed for ${polyIn.marketSlug}: ${e.message}`);
  }
  const sized = sizeArb({
    bestCost, bfaImplied, polyImplied,
    polyPrice: Number(polyIn.expectedPrice),
    availableBalance: balance,
    scaleFactor: Number(scaleFactor),
    polyBook: depthRaw,
    intent: polyIn.intent,
    feeMode,
  });
  if (!sized) {
    const tier = require('./betSizing').tierForCost(bestCost);
    if (!tier) return json(400, { error: 'cost_out_of_tier', bestCost });
    return json(400, { error: 'below_bfa_minimum', hint: 'scaled BFA bet < $5 (BFA min) — raise scale or check balance', bestCost, balance });
  }

  if (sized.bfaAmount > MAX_LEG_NOTIONAL) return json(400, { error: 'bfa_leg_too_large', bfaAmount: sized.bfaAmount });
  const polyNotional = sized.polyQuantity * Number(polyIn.expectedPrice);
  if (polyNotional > MAX_LEG_NOTIONAL) return json(400, { error: 'poly_leg_too_large', polyNotional });

  const bfa = {
    eventId: bfaIn.eventId,
    fixtureId: bfaIn.fixtureId,
    marketType: bfaIn.marketType,
    periodNumber: bfaIn.periodNumber ?? 0,
    side: bfaIn.side,
    index: bfaIn.index ?? 0,
    contestantId: bfaIn.contestantId,
    line: bfaIn.line ?? 0,
    price: Number(bfaIn.price),
    amount: sized.bfaAmount,
    isLive: !!bfaIn.isLive,
  };
  const poly = {
    marketSlug: polyIn.marketSlug,
    intent: polyIn.intent,
    expectedPrice: Number(polyIn.expectedPrice),
    quantity: sized.polyQuantity,
  };

  try {
    const result = await executeArb({
      bfa, poly,
      meta: { ...meta, sizing: sized, availableBalance: balance, execMode },
      opts: { execMode, iocFallback: !!iocFallbackIn },
    });
    return json(200, { ok: true, sizing: sized, result });
  } catch (e) {
    console.error('executeArb threw:', e);
    return json(500, { error: 'execute_threw', message: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/execute') {
    return handleExecute(req, res, cors);
  }

  if (req.method === 'GET' && req.url?.startsWith('/depth')) {
    const u = new URL(req.url, 'http://localhost');
    const slug = u.searchParams.get('slug');
    const intent = u.searchParams.get('intent');
    const bfaImpliedRaw = u.searchParams.get('bfaImplied');
    const feeModeRaw = u.searchParams.get('feeMode');
    const feeMode = feeModeRaw === 'maker' ? 'maker' : feeModeRaw === 'none' ? 'none' : 'taker';
    const lambdaRaw = Number(u.searchParams.get('lambda'));
    const lambda = Number.isFinite(lambdaRaw) && lambdaRaw >= 0 ? lambdaRaw : undefined;
    if (!slug || !intent) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: 'missing slug or intent' }));
    }
    try {
      const d = await polyTrader.getDepth(slug);
      const bfaImplied = Number(bfaImpliedRaw);
      const mp = Number.isFinite(bfaImplied) && bfaImplied > 0 && bfaImplied < 1
        ? polyBook.maxProfitableSize({ book: d.raw, intent, bfaImplied, feeMode, ...(lambda != null ? { lambda } : {}) })
        : null;
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({
        slug, intent, bfaImplied: Number.isFinite(bfaImplied) ? bfaImplied : null,
        feeMode,
        bids: d.bids, offers: d.offers, max: mp,
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: 'depth_fetch_failed', message: e.message }));
    }
  }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({
      status: 'ok',
      scanning,
      lastScanTime,
      lastScanArbs,
      notifiedCount: notified.size,
      cooldown: cooldown.status(),
      executionEnabled: EXECUTION_ENABLED,
    }));
  } else if (req.url === '/results') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({
      lastScanTime,
      results: latestResults,
    }));
  } else if (req.url === '/stats') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(stats.aggregate()));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url?.startsWith('/bets-history')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const days = Math.max(1, Math.min(30, parseInt(u.searchParams.get('days'), 10) || 7));
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const finals = eventLog.readTypes(['final'], since);

      // BFA promo: $200 bonus / $4800 rollover. Mirror scan.js constants.
      const BONUS = 200, ROLLOVER = 4800;
      const americanToImplied = (a) => {
        const n = Number(a);
        if (!Number.isFinite(n) || n === 0) return null;
        return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
      };

      const rows = finals
        .filter(e => e.outcome === 'filled_both' && e.bfa?.idTransaction && e.polyBuy?.filledQty > 0)
        .map(e => {
          const W = Number(e.bfa.amount) || 0;
          const american = e.bfa.price;
          const bfaImplied = americanToImplied(american);
          const qty = Number(e.polyBuy.filledQty) || 0;
          const avgPx = Number(e.polyBuy.avgPx) || 0;
          const polyNotional = qty * avgPx;

          // Polymarket.US fee. Maker gets a rebate (negative fee).
          // taker per-share: max($0.01, 0.05 × p × (1-p))
          // maker rebate per-share: 0.0125 × p × (1-p)  (no floor)
          const execMode = e.execMode === 'maker' ? 'maker' : 'taker';
          const feePerShare = execMode === 'maker'
            ? -(0.0125 * avgPx * (1 - avgPx))
            : Math.max(0.01, 0.05 * avgPx * (1 - avgPx));
          const polyFees = qty * feePerShare;             // signed: positive=cost, negative=rebate
          const polyAllInCost = polyNotional + polyFees;  // cash actually debited

          const pnlIfBfaWins  = bfaImplied ? (W / bfaImplied) - W - polyAllInCost : null;
          const pnlIfPolyWins = qty - W - polyAllInCost;
          const rawPnl = (pnlIfBfaWins != null) ? Math.min(pnlIfBfaWins, pnlIfPolyWins) : pnlIfPolyWins;
          const bonusCredit = W * BONUS / ROLLOVER;
          const pnlWithBonus = rawPnl + bonusCredit;
          return {
            attemptId: e.attemptId,
            timestamp: e.timestamp,
            sport: e.sport,
            date: e.date,
            strategy: e.strategy,
            awayTeam: e.awayTeam,
            homeTeam: e.homeTeam,
            marketType: e.marketType,
            line: e.line,
            bfa: { stake: W, americanOdds: american, idTransaction: e.bfa.idTransaction, impliedProb: bfaImplied },
            poly: {
              qty, avgPx,
              notional: polyNotional,
              feePerShare, fees: polyFees,
              allInCost: polyAllInCost,
              effectivePrice: qty > 0 ? polyAllInCost / qty : null,
              execMode,
              orderId: e.polyBuy.orderId,
            },
            scanGuaranteedPnl: e.guaranteedPnl ?? null,
            rawPnl,
            bonusCredit,
            pnlWithBonus,
            outcomeIfBfaWins: pnlIfBfaWins,
            outcomeIfPolyWins: pnlIfPolyWins,
          };
        })
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      const totals = rows.reduce((acc, r) => ({
        bets: acc.bets + 1,
        bfaStake: acc.bfaStake + r.bfa.stake,
        polyNotional: acc.polyNotional + r.poly.notional,
        polyFees: acc.polyFees + r.poly.fees,
        polyAllInCost: acc.polyAllInCost + r.poly.allInCost,
        rawPnl: acc.rawPnl + r.rawPnl,
        bonusCredit: acc.bonusCredit + r.bonusCredit,
        pnlWithBonus: acc.pnlWithBonus + r.pnlWithBonus,
      }), { bets: 0, bfaStake: 0, polyNotional: 0, polyFees: 0, polyAllInCost: 0, rawPnl: 0, bonusCredit: 0, pnlWithBonus: 0 });

      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ days, rows, totals }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url?.startsWith('/maker-shadow')) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const days = Math.max(1, Math.min(30, parseInt(u.searchParams.get('days'), 10) || 7));
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const recent = u.searchParams.get('recent') === '1';
      const body = { summary: makerShadow.summary(since) };
      if (recent) {
        body.closes = makerShadow.readLog('shadow_close', since).slice(-100);
        body.opens = makerShadow.readLog('shadow_open', since).slice(-100);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url?.startsWith('/events')) {
    const u = new URL(req.url, 'http://localhost');
    const hours = parseInt(u.searchParams.get('hours'), 10) || 24;
    const typesCsv = u.searchParams.get('types');
    const since = Date.now() - hours * 60 * 60 * 1000;
    const events = typesCsv ? eventLog.readTypes(typesCsv.split(','), since) : eventLog.readRange(since);
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ events: events.slice(-500) }));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`Notifier health server on :${PORT}`);
  console.log(`Threshold: ${ARB_MIN_COST.toFixed(3)} ≤ cost ≤ ${ARB_MAX_COST.toFixed(3)}`);
  console.log(`Email: ${NOTIFICATION_EMAIL.replace(/(.{3}).*(@.*)/, '$1***$2')}`);
  console.log(`Execution: ${EXECUTION_ENABLED ? 'ENABLED' : 'disabled'} (token ${EXECUTION_TOKEN ? 'set' : 'MISSING'})`);
  console.log('Starting first scan...\n');
  tick();
});
