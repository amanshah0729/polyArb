/**
 * Predexon Cross-Platform Arbitrage Scanner
 *
 * Finds arbitrage between Polymarket and Kalshi using the Predexon unified API.
 *
 * How it works:
 *   1. Fetch cross-platform matched pairs  →  GET /v2/matching-markets/pairs
 *   2. For each pair, get Polymarket market (YES/NO prices) + Kalshi market (YES/NO asks + bids)
 *   3. Arbitrage check (binary markets, outcomes pay $1):
 *        Option A: buy YES@Poly  + buy NO@Kalshi  →  cost = poly_yes_price + kalshi_no_ask
 *        Option B: buy NO@Poly   + buy YES@Kalshi →  cost = poly_no_price  + kalshi_yes_ask
 *      If either cost < 1.0, guaranteed profit = (1.0 - cost) per $1 at stake.
 *
 * Usage:
 *   node scripts/predexonArb.js [--min-profit 0.3] [--budget 100]
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const API_KEY = process.env.PREDEXON_API_KEY;
const HOST = 'api.predexon.com';
const BASE = '/v2';
const RATE_LIMIT_MS = 120; // ~8 req/s, safely under 30 req/min free tier

const args = process.argv.slice(2);
function argVal(flag, defaultVal) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? parseFloat(args[i + 1]) : defaultVal;
}
const MIN_PROFIT_PCT = argVal('--min-profit', 0.3);
const BUDGET = argVal('--budget', 100);

// ── HTTP client ───────────────────────────────────────────────────────────────

function get(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    ).toString();
    const fullPath = `${BASE}${endpoint}${qs ? '?' + qs : ''}`;

    const req = https.request(
      { hostname: HOST, path: fullPath, headers: { 'x-api-key': API_KEY } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 402) {
            reject(new Error(`Dev plan required (402): ${fullPath}`));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 150)}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Bad JSON from ${fullPath}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Predexon calls ────────────────────────────────────────────────────────────

async function fetchAllMatchedPairs() {
  const all = [];
  let cursor = null;

  while (true) {
    const params = { active_only: true, limit: 200 };
    if (cursor) params.cursor = cursor;

    const data = await get('/matching-markets/pairs', params);
    const pairs = data.pairs ?? data;
    if (!Array.isArray(pairs) || pairs.length === 0) break;

    all.push(...pairs);
    cursor = data.next_cursor ?? data.cursor ?? null;
    if (!cursor || pairs.length < 200) break;

    await sleep(RATE_LIMIT_MS);
  }

  return all;
}

/**
 * Fetch Polymarket market by condition_id.
 * Returns { yes: price, no: price } (0-1 decimals, last trade price).
 */
async function getPolyPrices(conditionId) {
  const data = await get('/polymarket/markets', { condition_id: conditionId });
  const market = data.markets?.[0];
  if (!market?.outcomes) return null;

  const yes = market.outcomes.find((o) => o.label === 'Yes');
  const no  = market.outcomes.find((o) => o.label === 'No');
  if (!yes || !no) return null;

  return { yes: yes.price, no: no.price };
}

/**
 * Fetch Kalshi market by ticker.
 * Returns ask/bid for both YES and NO (0-1 decimals).
 */
async function getKalshiPrices(ticker) {
  const data = await get('/kalshi/markets', { ticker });
  const market = data.markets?.[0];
  if (!market?.outcomes) return null;

  const yes = market.outcomes.find((o) => o.label === 'Yes');
  const no  = market.outcomes.find((o) => o.label === 'No');
  if (!yes || !no) return null;

  return {
    yes_ask: yes.ask ?? 0,
    yes_bid: yes.bid ?? 0,
    no_ask:  no.ask  ?? 0,
    no_bid:  no.bid  ?? 0,
  };
}

// ── Arbitrage math ────────────────────────────────────────────────────────────

/**
 * Only considers options where both legs have real liquidity (ask > 0, ask < 1).
 * Polymarket last-trade price used as buying-cost proxy.
 */
function evalArb(polyYes, polyNo, kalshiYesAsk, kalshiNoAsk) {
  const candidates = [];

  if (kalshiNoAsk > 0 && kalshiNoAsk < 1.0 && polyYes > 0) {
    candidates.push({
      label: 'YES@Polymarket + NO@Kalshi',
      cost: polyYes + kalshiNoAsk,
      leg1: polyYes,
      leg2: kalshiNoAsk,
    });
  }

  if (kalshiYesAsk > 0 && kalshiYesAsk < 1.0 && polyNo > 0) {
    candidates.push({
      label: 'NO@Polymarket + YES@Kalshi',
      cost: polyNo + kalshiYesAsk,
      leg1: polyNo,
      leg2: kalshiYesAsk,
    });
  }

  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => (a.cost < b.cost ? a : b));
  if (best.cost >= 1.0) return null;

  const profitPct = ((1 - best.cost) / best.cost) * 100;
  const stake1    = (BUDGET * best.leg1) / best.cost;
  const stake2    = (BUDGET * best.leg2) / best.cost;
  const payout    = BUDGET / best.cost;
  const profit    = payout - BUDGET;

  return { strategy: best.label, totalCost: best.cost, profitPct, stake1, stake2, payout, profit };
}

// ── ASCII table printer ───────────────────────────────────────────────────────

function padR(s, n) { return String(s).slice(0, n).padEnd(n); }
function padL(s, n) { return String(s).slice(0, n).padStart(n); }

function printTable(opportunities) {
  if (opportunities.length === 0) {
    console.log('  No arbitrage opportunities found above the threshold.\n');
    return;
  }

  const cols = [
    { label: '#',         w: 4  },
    { label: 'Market',    w: 44 },
    { label: 'Strategy',  w: 28 },
    { label: 'Profit%',   w: 9  },
    { label: 'Profit$',   w: 9  },
    { label: 'PolyYES',   w: 9  },
    { label: 'PolyNO',    w: 8  },
    { label: 'K-YESAsk',  w: 10 },
    { label: 'K-NOAsk',   w: 9  },
    { label: 'K-YESBid',  w: 10 },
    { label: 'K-NOBid',   w: 9  },
    { label: 'Cost',      w: 7  },
    { label: 'Sim',       w: 5  },
    { label: 'Expires',   w: 10 },
  ];

  const sep = cols.map(c => '─'.repeat(c.w)).join('┼');
  const header = cols.map(c => padR(c.label, c.w)).join('│');

  console.log('┌' + cols.map(c => '─'.repeat(c.w)).join('┬') + '┐');
  console.log('│' + header + '│');
  console.log('├' + sep + '┤');

  opportunities.forEach((op, i) => {
    const row = [
      padL(i + 1, cols[0].w),
      padR(op.title.length > 43 ? op.title.slice(0, 42) + '…' : op.title, cols[1].w),
      padR(op.arb.strategy.replace('@Polymarket', '@Poly').replace('@Kalshi', '@K'), cols[2].w),
      padL(op.arb.profitPct.toFixed(2) + '%', cols[3].w),
      padL('$' + op.arb.profit.toFixed(2), cols[4].w),
      padL(op.polyPrices.yes.toFixed(4), cols[5].w),
      padL(op.polyPrices.no.toFixed(4), cols[6].w),
      padL(op.kalshiPrices.yes_ask.toFixed(4), cols[7].w),
      padL(op.kalshiPrices.no_ask.toFixed(4), cols[8].w),
      padL(op.kalshiPrices.yes_bid.toFixed(4), cols[9].w),
      padL(op.kalshiPrices.no_bid.toFixed(4), cols[10].w),
      padL(op.arb.totalCost.toFixed(4), cols[11].w),
      padL(op.similarity + '%', cols[12].w),
      padR(op.expires, cols[13].w),
    ];
    console.log('│' + row.join('│') + '│');
  });

  console.log('└' + cols.map(c => '─'.repeat(c.w)).join('┴') + '┘');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(70));
  console.log('  Predexon Cross-Platform Arbitrage Scanner  (Polymarket ↔ Kalshi)');
  console.log('═'.repeat(70));
  console.log(`  Min profit : ${MIN_PROFIT_PCT}%   Budget : $${BUDGET}   Key : ${API_KEY ? API_KEY.slice(0, 8) + '...' : '!! MISSING !!'}\n`);

  if (!API_KEY) { console.error('ERROR: Set PREDEXON_API_KEY in .env'); process.exit(1); }

  // 1. Fetch all matched pairs
  console.log('Fetching cross-platform matched pairs...');
  let pairs;
  try {
    pairs = await fetchAllMatchedPairs();
    console.log(`Found ${pairs.length} matched pairs\n`);
  } catch (err) {
    console.error('Failed to fetch pairs:', err.message);
    process.exit(1);
  }

  // 2. Scan each pair
  const opportunities = [];
  const skipped = [];
  let scanned = 0;

  process.stdout.write('Scanning ');

  for (const pair of pairs) {
    const poly   = pair.POLYMARKET;
    const kalshi = pair.KALSHI;
    if (!poly?.condition_id || !kalshi?.market_ticker) continue;

    try {
      const [polyPrices, kalshiPrices] = await Promise.all([
        getPolyPrices(poly.condition_id),
        getKalshiPrices(kalshi.market_ticker),
      ]);

      if (!polyPrices || !kalshiPrices) {
        skipped.push({ title: poly.title, reason: 'missing prices' });
        continue;
      }

      if (!(kalshiPrices.yes_ask > 0 && kalshiPrices.yes_ask < 1.0) &&
          !(kalshiPrices.no_ask  > 0 && kalshiPrices.no_ask  < 1.0)) {
        skipped.push({ title: poly.title, reason: 'no Kalshi liquidity' });
        continue;
      }

      const arb = evalArb(polyPrices.yes, polyPrices.no, kalshiPrices.yes_ask, kalshiPrices.no_ask);

      if (arb && arb.profitPct >= MIN_PROFIT_PCT) {
        // Format expiry
        const expTs = pair.earliest_expiration_ts ?? poly.expiration_ts;
        const expires = expTs
          ? new Date(expTs * 1000).toISOString().slice(0, 10) // YYYY-MM-DD
          : '—';

        opportunities.push({
          title:        poly.title,
          similarity:   pair.similarity ?? '?',
          polyTokenId:  poly.condition_id,
          kalshiTicker: kalshi.market_ticker,
          expires,
          arb,
          polyPrices,
          kalshiPrices,
        });
      }

      scanned++;
      if (scanned % 10 === 0) process.stdout.write('.');
    } catch (err) {
      skipped.push({ title: poly.title, reason: err.message.slice(0, 80) });
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(' done\n');

  // 3. Sort + display
  opportunities.sort((a, b) => b.arb.profitPct - a.arb.profitPct);

  console.log(`Pairs scanned : ${scanned} / ${pairs.length}   Skipped : ${skipped.length}   Opportunities : ${opportunities.length}\n`);

  printTable(opportunities);

  // 4. Save CSV
  const outDir = path.join(__dirname, '..', 'outputs', 'predexon');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(outDir, `arb_predexon_${ts}.csv`);

  const header = [
    'Title', 'Similarity%', 'Strategy', 'Arb Cost', 'Profit%',
    'Poly YES', 'Poly NO',
    'Kalshi YES Ask', 'Kalshi NO Ask',
    'Kalshi YES Bid', 'Kalshi NO Bid',
    `Leg1 Stake ($${BUDGET})`, `Leg2 Stake ($${BUDGET})`,
    `Payout ($${BUDGET})`, `Profit$ ($${BUDGET})`,
    'Kalshi Ticker', 'Poly Condition ID', 'Expires',
  ].join(',');

  const rows = opportunities.map((op) =>
    [
      `"${op.title}"`,
      op.similarity,
      `"${op.arb.strategy}"`,
      op.arb.totalCost.toFixed(4),
      op.arb.profitPct.toFixed(2),
      op.polyPrices.yes.toFixed(4),
      op.polyPrices.no.toFixed(4),
      op.kalshiPrices.yes_ask.toFixed(4),
      op.kalshiPrices.no_ask.toFixed(4),
      op.kalshiPrices.yes_bid.toFixed(4),
      op.kalshiPrices.no_bid.toFixed(4),
      op.arb.stake1.toFixed(2),
      op.arb.stake2.toFixed(2),
      op.arb.payout.toFixed(2),
      op.arb.profit.toFixed(2),
      op.kalshiTicker,
      op.polyTokenId,
      op.expires,
    ].join(',')
  );

  fs.writeFileSync(csvPath, [header, ...rows].join('\n'));
  console.log(`\nSaved → ${csvPath}\n`);
}

main().catch((err) => { console.error('\nFatal:', err.message); process.exit(1); });
