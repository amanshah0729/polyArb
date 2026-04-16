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
// 1.005 includes near-arbs so email pipeline is exercised before a true 1.000 arb lands.
// Near-arb in [1.000, 1.005] still has positive netValue once BFA bonus rollover is factored in.
const ARB_MAX_COST      = 1.005;
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
      `  P&L:       $${a.guaranteedPnl.toFixed(2)}`,
      `  Net value: $${a.netValue.toFixed(2)}`,
    ].join('\n');
  });

  const count = arbs.length;
  const subject = `Arb Detected – ${count} opportunit${count === 1 ? 'y' : 'ies'} found`;

  const body = [
    `${count} arb opportunit${count === 1 ? 'y' : 'ies'} (cost ${ARB_MIN_COST.toFixed(3)}–${ARB_MAX_COST.toFixed(3)}):`,
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
    latestResults = results;
    writeCSV(results);
    const arbs = results.filter((r) => r.hasArb && r.bestCost >= ARB_MIN_COST && r.bestCost <= ARB_MAX_COST);

    // Filter out already-notified arbs
    const newArbs = arbs.filter((a) => !alreadyNotified(a));

    console.log(`Scan done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${results.length} games, ${arbs.length} arbs, ${newArbs.length} new`);

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

  const { bfa: bfaIn, poly: polyIn, meta = {}, scaleFactor = 1 } = payload || {};
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
  const sized = sizeArb({
    bestCost, bfaImplied, polyImplied,
    polyPrice: Number(polyIn.expectedPrice),
    availableBalance: balance,
    scaleFactor: Number(scaleFactor),
  });
  if (!sized) return json(400, { error: 'cost_out_of_tier', bestCost });

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
    const result = await executeArb({ bfa, poly, meta: { ...meta, sizing: sized, availableBalance: balance } });
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
