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
const { getBalance, getOpenBets, getSettledHistory } = require('../scripts/bfagaming/placeBet');

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
// Key: stable game+market identity → timestamp of last notification.
// Clears entries older than 12 hours so games can re-alert across days.
//
// The key deliberately does NOT use `strategy`: that string is rebuilt every scan
// from the current cheapest bet, so it embeds (a) the line via mtLabel and (b) the
// BFA/Poly direction (option1 vs option2). Both flip as prices/lines drift, which
// minted a fresh key for the same game and re-emailed it. We normalize team order
// (kills the direction flip) and key on marketType+line from the row fields, so a
// game only re-alerts when the line genuinely moves — not on every tick or flip.
//
// Persisted to disk so a pm2 restart doesn't wipe the map and re-alert everything.

const notified = new Map();
const DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
const DEDUP_PATH = path.join(OUT_DIR, 'notified.json');

// /pnl response cache (BFA browser context + full activity pull are slow)
const pnlCache = { body: null, at: 0 };

function dedupKey(result) {
  const teams = [result.awayTeam, result.homeTeam].sort().join('|');
  return `${result.sport}|${teams}|${result.marketType}|${result.line ?? ''}`;
}

function loadDedup() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEDUP_PATH, 'utf8'));
    const now = Date.now();
    for (const [key, ts] of Object.entries(raw)) {
      if (now - ts <= DEDUP_TTL_MS) notified.set(key, ts);
    }
    console.log(`Loaded ${notified.size} live dedup entries from disk.`);
  } catch { /* no prior state — first run */ }
}

function saveDedup() {
  try {
    fs.writeFileSync(DEDUP_PATH, JSON.stringify(Object.fromEntries(notified)), 'utf8');
  } catch (e) {
    console.warn(`dedup persist failed: ${e.message}`);
  }
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
  saveDedup();
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
    // Watchdog: a hung scan (dead socket, wedged API) must never freeze the
    // loop — `scanning` stays true and every future tick skips. Abandon the
    // scan after 12 min; per-request timeouts inside runScan make the orphaned
    // promise die on its own shortly after.
    const SCAN_TIMEOUT_MS = 12 * 60 * 1000;
    const results = await Promise.race([
      runScan(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`scan watchdog: exceeded ${SCAN_TIMEOUT_MS / 60000} min — abandoning`)), SCAN_TIMEOUT_MS)),
    ]);
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
  // Size and gate on the LIVE executable price, NOT the scanned row. meta.bestCost /
  // meta.polyImplied are a snapshot from scan and can be stale — the Poly ask drifts
  // between scan and click. expectedPrice is the live ask the frontend just fetched.
  // Sizing on the stale cost tiers a drifted bet as a deeper arb than it is: that's how
  // a row shown at 42% got sized as a deep-arb and executed at 44% (out of arb tier).
  const livePolyPrice = Number(polyIn.expectedPrice);
  const livePriceOk = Number.isFinite(livePolyPrice) && livePolyPrice > 0;
  // Fee-aware: include the PM.US taker fee (or maker rebate) in the cost the gate sees,
  // so what you're charged — ask + fee — is what's checked against the arb tier.
  const liveFee = livePriceOk ? polyBook.effectiveFeeAdder(livePolyPrice, feeMode) : 0;
  const liveCost = (Number.isFinite(bfaImplied) && livePriceOk) ? bfaImplied + livePolyPrice + liveFee : bestCost;
  const livePolyImplied = livePriceOk ? livePolyPrice : polyImplied;
  // Fetch Poly book so sizing can depth-clamp before we place anything.
  let depthRaw = null;
  try {
    const d = await polyTrader.getDepth(polyIn.marketSlug);
    depthRaw = d.raw;
  } catch (e) {
    console.warn(`[execute] depth fetch failed for ${polyIn.marketSlug}: ${e.message}`);
  }
  const sized = sizeArb({
    bestCost: liveCost, bfaImplied, polyImplied: livePolyImplied,
    polyPrice: livePolyPrice,
    availableBalance: balance,
    scaleFactor: Number(scaleFactor),
    polyBook: depthRaw,
    intent: polyIn.intent,
    feeMode,
  });
  if (!sized) {
    const tier = require('./betSizing').tierForCost(liveCost);
    if (!tier) return json(409, {
      error: 'arb_gone',
      hint: 'live Poly ask drifted out of the arb tier since the row was scanned — not placing',
      scannedCost: bestCost, liveCost, scannedPolyImplied: polyImplied, livePolyPrice,
    });
    return json(400, { error: 'below_bfa_minimum', hint: 'scaled BFA bet < $5 (BFA min) — raise scale or check balance', bestCost: liveCost, balance });
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
      // Log the live cost we actually gated/sized on; keep the scanned values for audit.
      meta: {
        ...meta, bestCost: liveCost, polyImplied: livePolyImplied,
        scannedCost: bestCost, scannedPolyImplied: polyImplied,
        sizing: sized, availableBalance: balance, execMode,
      },
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
    const lambdaStr = u.searchParams.get('lambda');
    const lambdaRaw = lambdaStr != null && lambdaStr !== '' ? Number(lambdaStr) : NaN;
    const lambda = Number.isFinite(lambdaRaw) && lambdaRaw >= 0 ? lambdaRaw : undefined;
    if (!slug || !intent) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: 'missing slug or intent' }));
    }
    try {
      // Rich resolution first when the caller supplies name context — the
      // Predexon slug often isn't a PM.US slug (fighter/team abbreviations
      // differ), and slug-only resolution can silently fall back to the old
      // CLOB book, which is not tradeable via the polymarket-us SDK.
      let depthSlug = slug;
      const awayTeam = u.searchParams.get('awayTeam');
      const homeTeam = u.searchParams.get('homeTeam');
      if (awayTeam && homeTeam) {
        try {
          const matcher = require('./marketMatcher');
          const r = await matcher.resolveMarket(polyTrader.client(), {
            slug,
            sport: u.searchParams.get('sport') || undefined,
            date: u.searchParams.get('date') || undefined,
            awayTeam, homeTeam,
            polyTeam: u.searchParams.get('polyTeam') || undefined,
            isSeries: u.searchParams.get('isSeries') === '1',
            marketType: u.searchParams.get('marketType') || undefined,
            line: u.searchParams.get('line') || undefined,
          });
          if (r?.resolvedSlug) depthSlug = r.resolvedSlug;
        } catch (e) {
          console.warn(`[depth] rich resolve failed for ${slug}: ${e.message}`);
        }
      }
      const d = await polyTrader.getDepth(depthSlug);
      const bfaImplied = Number(bfaImpliedRaw);
      const mp = Number.isFinite(bfaImplied) && bfaImplied > 0 && bfaImplied < 1
        ? polyBook.maxProfitableSize({ book: d.raw, intent, bfaImplied, feeMode, ...(lambda != null ? { lambda } : {}) })
        : null;
      // Top-of-book per-share price in intent coords (what you'd pay right now):
      // BUY_LONG consumes offers; BUY_SHORT consumes bids at (1 − px).
      const topPrice = intent === 'ORDER_INTENT_BUY_SHORT'
        ? (d.bids?.[0]?.px != null ? 1 - d.bids[0].px : null)
        : (d.offers?.[0]?.px ?? null);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({
        slug, intent, bfaImplied: Number.isFinite(bfaImplied) ? bfaImplied : null,
        feeMode,
        resolvedSlug: d.marketSlug ?? depthSlug,
        venue: d.venue ?? null,
        topPrice,
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
          // effectivePx = intent-coord price actually paid (avgPx is long-side;
          // wrong for BUY_SHORT fills). Older events only have avgPx.
          const avgPx = Number(e.polyBuy.effectivePx ?? e.polyBuy.avgPx) || 0;
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
  } else if (req.url?.startsWith('/pnl')) {
    // Combined cash P&L across both venues for the arb strategy. Pure cash —
    // deliberately NO rollover/bonus credit here.
    //   Poly side: PM.US activities filtered to markets our app traded
    //   (matched by order IDs recorded in the event log).
    //   BFA side: settled wager history + open bets from the BFA API.
    try {
      const now = Date.now();
      if (pnlCache.body && now - pnlCache.at < 60_000) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        return res.end(pnlCache.body);
      }

      // 1. Our Poly order IDs, from the full event log
      const events = eventLog.readTypes(['poly_filled', 'final', 'unwind'], 0);
      const ourOrderIds = new Set();
      const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        for (const [k, val] of Object.entries(v)) {
          if (/orderid/i.test(k) && typeof val === 'string' && val) ourOrderIds.add(val);
          else if (val && typeof val === 'object') walk(val);
        }
      };
      events.forEach(walk);

      // 2. PM.US activities → arb market slugs → per-slug cash flows
      const num = (v) => { const n = Number(v?.value ?? v); return Number.isFinite(n) ? n : 0; };
      const acts = await polyTrader.listActivities();
      const tradeActs = acts.filter((a) => a.type === 'ACTIVITY_TYPE_TRADE' && a.trade?.aggressorExecution?.order);
      const arbSlugs = new Set();
      for (const a of tradeActs) {
        const o = a.trade.aggressorExecution.order;
        if (o.id && ourOrderIds.has(o.id) && o.marketSlug) arbSlugs.add(o.marketSlug);
      }

      const bySlug = new Map();
      const rowFor = (slug, metaSrc) => {
        if (!bySlug.has(slug)) {
          bySlug.set(slug, {
            slug,
            title: metaSrc?.title ?? slug,
            outcome: metaSrc?.outcome ?? null,
            trades: [], cash: 0, fees: 0, resolved: false, resolutionCash: null,
            firstTime: null,
          });
        }
        return bySlug.get(slug);
      };

      const feeCountedOrders = new Set();
      for (const a of tradeActs) {
        const ex = a.trade.aggressorExecution;
        const o = ex.order;
        if (!o.marketSlug || !arbSlugs.has(o.marketSlug)) continue;
        const px = num(ex.lastPx);
        const sh = Number(ex.lastShares) || 0;
        let fee = ex.commissionNotionalCollected != null ? num(ex.commissionNotionalCollected) : null;
        if (fee == null) {
          // Fall back to the order-level total, counted once per order
          fee = feeCountedOrders.has(o.id) ? 0 : num(o.commissionNotionalTotalCollected);
          feeCountedOrders.add(o.id);
        }
        const isBuy = o.intent === 'ORDER_INTENT_BUY_LONG' || o.intent === 'ORDER_INTENT_BUY_SHORT';
        const isShort = typeof o.intent === 'string' && o.intent.includes('SHORT');
        const perShare = isShort ? 1 - px : px;   // price actually paid/received per share
        const cash = (isBuy ? -1 : 1) * perShare * sh - fee;
        const row = rowFor(o.marketSlug, o.marketMetadata);
        row.trades.push({
          time: o.insertTime, intent: o.intent, longPx: px, effectivePx: perShare,
          qty: sh, fee, cash: Math.round(cash * 10000) / 10000,
        });
        row.cash += cash;
        row.fees += fee;
        if (!row.firstTime || (o.insertTime && o.insertTime < row.firstTime)) row.firstTime = o.insertTime;
      }

      for (const a of acts) {
        if (a.type !== 'ACTIVITY_TYPE_POSITION_RESOLUTION') continue;
        const pr = a.positionResolution;
        if (!pr?.marketSlug || !arbSlugs.has(pr.marketSlug)) continue;
        const before = pr.beforePosition || {};
        const after = pr.afterPosition || {};
        // Settlement pays $1/share when the held side won, else $0. PM.US's
        // `realized` magnitude is inconsistent across record vintages (pre-fee
        // vs all-in cost basis, sometimes absent), so only its SIGN is trusted
        // to infer win/loss — the payout itself comes from position size.
        const dRealized = num(after.realized) - num(before.realized);
        const heldQty = Math.abs(Number(before.netPositionDecimal ?? before.netPosition) || 0);
        const cashReceived = dRealized > 1e-9 ? heldQty : 0;
        const row = rowFor(pr.marketSlug, before.marketMetadata);
        row.cash += cashReceived;
        row.resolved = true;
        row.resolutionCash = Math.round(cashReceived * 10000) / 10000;
      }

      // Fee rebates are account-level and can't be attributed per-market —
      // reported separately, NOT added into strategy P&L.
      const feeRebates = acts
        .filter((a) => a.type === 'ACTIVITY_TYPE_TAKER_FEE_REBATE')
        .reduce((s, a) => s + num(a.accountBalanceChange?.amount), 0);

      // Open positions on arb markets (mark = exchange cashValue). Used only to
      // mark still-open legs — NOT to decide settled vs open (that's trade/resolution
      // based below), so a failed positions fetch can't misclassify realized P&L.
      let positions = {};
      try { positions = await polyTrader.getPositions(); } catch { /* non-fatal */ }
      const openPositions = [];
      for (const [slug, p] of Object.entries(positions)) {
        if (!arbSlugs.has(slug)) continue;
        const net = Number(p.netPositionDecimal ?? p.netPosition) || 0;
        if (net === 0) continue;
        openPositions.push({
          slug,
          title: p.marketMetadata?.title ?? slug,
          outcome: p.marketMetadata?.outcome ?? null,
          netPosition: net,
          costBasis: num(p.cost),
          mark: num(p.cashValue),
        });
      }
      const marksBySlug = new Map(openPositions.map((p) => [p.slug, p.mark]));

      // Settled vs open is determined purely by whether the bet actually concluded:
      // a leg is SETTLED only if the market resolved (payout known) or we fully closed
      // it by trading (net shares ≈ 0). A leg we still hold that hasn't resolved is
      // IN PLAY — never booked into realized P&L. This keeps Settled P&L to bets that
      // truly hit, and is independent of the (flaky) positions fetch.
      const polyRows = [...bySlug.values()]
        .map((r) => {
          const netShares = r.trades.reduce(
            (s, t) => s + (t.intent.startsWith('ORDER_INTENT_BUY') ? t.qty : -t.qty), 0);
          const stillHolding = Math.abs(netShares) > 1e-6;
          const open = !r.resolved && stillHolding;
          return { ...r, cash: Math.round(r.cash * 10000) / 10000, open, mark: open ? (marksBySlug.get(r.slug) ?? null) : null };
        })
        .sort((a, b) => (b.firstTime || '').localeCompare(a.firstTime || ''));
      const polySettledNet = polyRows.filter((r) => !r.open).reduce((s, r) => s + r.cash, 0);
      const polyOpenCashSoFar = polyRows.filter((r) => r.open).reduce((s, r) => s + r.cash, 0);
      const polyOpenMark = polyRows.filter((r) => r.open).reduce((s, r) => s + (r.mark || 0), 0);

      let polyBalance = null;
      try { polyBalance = await polyTrader.getAccountBalance(); } catch { /* non-fatal */ }

      // 3. BFA side
      // Personal straight bets (not arb-strategy) excluded per user:
      //   346769641 = Orlando Magic +2 −110 (4/14), 346824787 = Calgary Flames +115 (4/15)
      const BFA_EXCLUDED_TICKETS = new Set([346769641, 346824787]);
      // BFA descriptions look like "[953] TOTAL o9½-120 (PIT vrs WSH)\r(pitchers) [Sport:…]".
      // Keep the pick, drop the rotation number, pitcher line, and sport suffix.
      const cleanDesc = (s) => {
        // Some descriptions prefix a venue line ending in "<br>" — keep only the pick.
        const parts = String(s || '').split(/<br\s*\/?>/i);
        return parts[parts.length - 1]
          .replace(/\r[\s\S]*$/, '')
          .replace(/\s*\[Sport:[^\]]*\]\s*$/, '')
          .replace(/^\s*\[\d+\]\s*/, '')
          .trim();
      };
      let bfa = { settled: [], open: [], settledNet: 0, openRisk: 0, balance: null, error: null };
      // Fetch balance / settled / open independently — one failing endpoint must not
      // blank the others (previously a history 401 also wiped the balance and open bets,
      // hiding the winning BFA half of every hedged pair and making P&L look like a loss).
      try {
        const bal = await getBalance();
        bfa.balance = Number(bal?.availableBalance ?? null);
      } catch (e) { bfa.error = e.message; }
      try {
        const hist = await getSettledHistory({ startDate: '2026-01-01' });
        bfa.settled = (hist?.wagers || []).filter((w) => !BFA_EXCLUDED_TICKETS.has(w.id)).map((w) => ({
          id: w.id, description: cleanDesc(w.description), placedDate: w.placedDate, settledDate: w.settledDate,
          risk: w.risk, result: w.result, amount: w.amount,
        }));
        bfa.settledNet = bfa.settled.reduce((s, w) => s + (Number(w.amount) || 0), 0);
      } catch (e) { bfa.error = bfa.error || e.message; }
      try {
        const open = await getOpenBets();
        bfa.open = (Array.isArray(open) ? open : []).map((w) => ({
          id: w.ticketNumber ?? w.idWager,
          // The real pick lives in betDetails[]; the top-level header is just "STRAIGHT BET".
          description: (w.betDetails || []).map((d) => cleanDesc(d.detailDescription)).filter(Boolean).join(' + ')
            || cleanDesc(w.description) || w.headerDescription,
          placedDate: w.placedDate, risk: w.ifBetRiskAmount ?? w.riskAmount ?? null,
          toWin: w.winAmount ?? null,
        }));
        bfa.openRisk = bfa.open.reduce((s, w) => s + (Number(w.risk) || 0), 0);
      } catch (e) { bfa.error = bfa.error || e.message; }

      const body = JSON.stringify({
        generatedAt: new Date().toISOString(),
        poly: {
          balance: polyBalance ? { current: polyBalance.currentBalance, buyingPower: polyBalance.buyingPower, marginHeld: polyBalance.marginRequirement } : null,
          rows: polyRows,
          openPositions,
          settledNet: Math.round(polySettledNet * 100) / 100,
          openCashSoFar: Math.round(polyOpenCashSoFar * 100) / 100,
          openMark: Math.round(polyOpenMark * 100) / 100,
          feeRebates: Math.round(feeRebates * 100) / 100,
        },
        bfa,
        combined: {
          settledNet: Math.round((polySettledNet + bfa.settledNet) * 100) / 100,
          // Open pairs valued at Poly mark + BFA risk still at stake
          openPolyMark: Math.round(polyOpenMark * 100) / 100,
          openBfaRisk: Math.round(bfa.openRisk * 100) / 100,
        },
      });
      pnlCache.body = body;
      pnlCache.at = now;
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      return res.end(body);
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
  loadDedup();
  console.log('Starting first scan...\n');
  tick();
});
