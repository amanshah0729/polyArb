/**
 * Maker-fill SHADOW logger — Phase 1 of the maker-rebate viability experiment.
 *
 * Places NO orders and risks NO capital. On every scan tick it records, for each
 * maker-plausible market, the price it *would* rest a queue-jumping bid at (a new
 * best bid strictly inside the spread), then watches subsequent snapshots to see
 * whether that price would have been hit — and, if so, how far the BFA line drifted
 * in the meantime. That answers the one unknown blocking the maker strategy:
 *
 *   "Conditional on my resting Poly order filling, does the arb survive?"
 *
 * Fill proxy: we only watch orders posted STRICTLY INSIDE the spread and improving
 * on the current best bid (front-of-queue by price priority). For such an order any
 * trade at ≤ our price hits us, so `chosenAsk <= postPrice` at a later snapshot ⇒
 * we'd have filled. (This proxy is invalid for at-touch/behind-queue orders — which
 * are the non-viable case anyway — so we deliberately don't watch those.)
 *
 * Everything is logged to priv/maker-shadow/YYYY-MM-DD.jsonl as shadow_open /
 * shadow_close events. summary() aggregates fill rate, time-to-fill, BFA drift and
 * arb-survival for the /maker-shadow endpoint.
 */

const fs = require('fs');
const path = require('path');
const polyBook = require('./polyBook');

// ── Config ──────────────────────────────────────────────────────────────────
const TICK = 0.001;                        // Poly price tick (roundTick in polyTrader)
const MIN_SPREAD_TICKS = 3;                // need room to post a new best bid inside
const MIN_SPREAD = MIN_SPREAD_TICKS * TICK;
const MAX_SPREAD_TICKS = 30;               // beyond ~3¢ the book is dead/empty, not an opportunity
const MAX_SPREAD = MAX_SPREAD_TICKS * TICK;
const MIN_TOUCH_DEPTH = 50;                // shares resting at both touches — a real two-sided market
const EDGE_BUFFER = 0.002;                 // required maker profit per share to call it an arb
const COST_BAND_MAX = 1.02;               // only observe maker-plausible rows
const MIN_VOLUME_USD = 500;               // some liquidity (lifetime) to be a real market
const TTL_MS = 60 * 60 * 1000;            // watch a resting order up to 60 min
const MIN_LEAD_MS = 30 * 60 * 1000;       // don't post within 30 min of start / in-play
const MAX_CANDIDATES = 25;                // bound getDepth calls per tick
const BFA_MIN_STAKE = 5;                  // BFA hard minimums (per user)
const BFA_MIN_TOWIN = 5;

const LOG_DIR = path.join(__dirname, '..', 'priv', 'maker-shadow');

// In-memory open observations (this process): key → obs. Persisted opens are in the
// log too, but outcomes are only computed for orders opened in the current process.
const open = new Map();

function keyFor(r) {
  return `${r.polyMarketSlug}|${r.marketType}|${r.line || ''}|${r.polySide}`;
}

function logEvent(type, payload) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const d = new Date();
    const f = path.join(LOG_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({ type, ts: d.toISOString(), ...payload }) + '\n');
  } catch { /* never break the scan */ }
}

function makerRebate(p) { return 0.0125 * p * (1 - p); }

// Chosen-outcome bid/ask from the normalized long-side book + the buy intent.
// BUY_SHORT lives in (1 − longPx) space; recomputing every tick keeps the fill
// condition (ask ≤ postPrice) correct in both coordinate systems.
function chosenQuote(rawBook, intent) {
  const { bids, offers } = polyBook.normalizeBook(rawBook);
  const longBid = bids[0]?.px ?? null;
  const longAsk = offers[0]?.px ?? null;
  if (longBid == null || longAsk == null) return null;
  const longBidQty = bids[0]?.qty ?? 0;
  const longAskQty = offers[0]?.qty ?? 0;
  // Short lives in (1 − longPx) space: its bid maps to the long ask, its ask to the
  // long bid (and touch depths swap accordingly).
  if (intent === 'ORDER_INTENT_BUY_SHORT') {
    return { bid: 1 - longAsk, ask: 1 - longBid, bidQty: longAskQty, askQty: longBidQty };
  }
  return { bid: longBid, ask: longAsk, bidQty: longBidQty, askQty: longAskQty };
}

const r3 = (x) => Math.round(x * 1000) / 1000;

function timeToGameMs(r) {
  if (!r.date || !r.time) return null;
  const t = Date.parse(`${r.date} ${r.time}`);
  return Number.isFinite(t) ? t - Date.now() : null;
}

// Min BFA stake satisfying both the $5 stake floor AND the $5 to-win floor.
// to-win = W(1−b)/b ≥ 5  ⇒  W ≥ 5b/(1−b). Favorites (large b) need a bigger stake.
function bfaSizing(b) {
  if (!(b > 0 && b < 1)) return null;
  const W = Math.max(BFA_MIN_STAKE, (BFA_MIN_TOWIN * b) / (1 - b));
  return { minStake: Math.round(W * 100) / 100, toWin: Math.round((W * (1 - b) / b) * 100) / 100 };
}

/**
 * Called once per scan tick with the scan results and the polyTrader module.
 * Reconciles open observations first, then opens new ones. Fully defensive —
 * any error is swallowed so it can never break the notifier's scan loop.
 */
async function tick(results, polyTrader) {
  const now = Date.now();

  // 1) Reconcile open observations.
  for (const [k, obs] of [...open.entries()]) {
    let quote = null;
    try { quote = chosenQuote((await polyTrader.getDepth(obs.slug)).raw, obs.intent); }
    catch { /* transient — retry next tick */ }

    const cur = results.find((r) => keyFor(r) === k);
    const bfaNow = cur && Number.isFinite(cur.bfaImplied) ? cur.bfaImplied : obs.bfaAtPost;

    let outcome = null;
    if (quote && quote.ask <= obs.postPrice + 1e-9) outcome = 'filled';
    else if (obs.gameStartTs && now >= obs.gameStartTs) outcome = 'expired_gamestart';
    else if (now - obs.postTs > TTL_MS) outcome = 'expired';

    if (!outcome) {
      if (quote) { obs.lastBid = quote.bid; obs.lastAsk = quote.ask; }
      continue;
    }

    const profitAtFill = 1 - obs.postPrice + makerRebate(obs.postPrice) - bfaNow; // per share
    logEvent('shadow_close', {
      key: k, slug: obs.slug, sport: obs.sport, marketType: obs.marketType,
      outcome,
      postPrice: obs.postPrice,
      postedAt: new Date(obs.postTs).toISOString(),
      timeOpenMs: now - obs.postTs,
      bfaAtPost: obs.bfaAtPost, bfaAtClose: bfaNow, bfaDrift: bfaNow - obs.bfaAtPost,
      profitPerShareAtPost: obs.profitAtPost,
      profitPerShareAtFill: profitAtFill,
      arbAliveAtClose: profitAtFill > EDGE_BUFFER,
      spreadAtPost: obs.spreadAtPost,
    });
    open.delete(k);
  }

  // 2) Open new observations for fresh maker-plausible candidates.
  const candidates = results
    .filter((r) => r.polyMarketSlug && Number.isFinite(r.bestCost) && r.bestCost <= COST_BAND_MAX
      && (r.volumeUsd || 0) >= MIN_VOLUME_USD
      && Number.isFinite(r.bfaImplied) && r.bfaImplied > 0 && r.bfaImplied < 1)
    .filter((r) => !open.has(keyFor(r)))
    .sort((a, b) => a.bestCost - b.bestCost)
    .slice(0, MAX_CANDIDATES);

  for (const r of candidates) {
    const intent = r.polySide === 'away' ? r.polyAwayIntent : r.polyHomeIntent;
    const ttg = timeToGameMs(r);
    if (ttg != null && ttg < MIN_LEAD_MS) continue; // in-play or too close to start

    let quote;
    try { quote = chosenQuote((await polyTrader.getDepth(r.polyMarketSlug)).raw, intent); }
    catch { continue; }
    if (!quote) continue;

    const b = r.bfaImplied;
    const spread = quote.ask - quote.bid;
    // Highest chosen-side price that still yields a maker arb: 1 − P + rebate − b > EDGE.
    const Pmax = 1 - b + makerRebate(quote.ask) - EDGE_BUFFER;
    // Rest as aggressively inside the spread as profit allows (front of queue).
    const postPrice = r3(Math.min(quote.ask - TICK, Pmax));
    const profitAtPost = 1 - postPrice + makerRebate(postPrice) - b;
    const sizing = bfaSizing(b);

    // Book must be a real, tradeable two-sided market — reject dead/empty books whose
    // absurd spread would otherwise mint a phantom edge (e.g. lone 10-share offer).
    let reason = null;
    if (spread < MIN_SPREAD) reason = 'spread_too_tight';
    else if (spread > MAX_SPREAD) reason = 'book_dead_wide';
    else if (quote.bidQty < MIN_TOUCH_DEPTH || quote.askQty < MIN_TOUCH_DEPTH) reason = 'touch_too_thin';
    else if (!(Pmax > quote.bid)) reason = 'no_profitable_price_above_bid';
    else if (!(postPrice > quote.bid + 1e-9)) reason = 'cannot_improve_bid';
    const makerRoom = reason == null;

    // Log EVERY candidate — how often there's "no room" (and why) is itself a key finding.
    logEvent('shadow_open', {
      key: keyFor(r), slug: r.polyMarketSlug, sport: r.sport,
      teams: `${r.awayTeam}@${r.homeTeam}`, marketType: r.marketType, line: r.line,
      polySide: r.polySide, intent,
      bestCost: r.bestCost, volumeUsd: r.volumeUsd, bfaImplied: b,
      chosenBid: r3(quote.bid), chosenAsk: r3(quote.ask),
      bidQty: Math.round(quote.bidQty), askQty: Math.round(quote.askQty),
      spread: r3(spread), spreadTicks: Math.round(spread / TICK),
      Pmax: r3(Pmax), postPrice, makerRoom, reason,
      profitPerShareAtPost: makerRoom ? r3(profitAtPost) : null,
      timeToGameMs: ttg,
      bfaMinStake: sizing?.minStake, bfaToWin: sizing?.toWin,
    });

    if (!makerRoom) continue; // no profitable improving price → nothing to watch
    open.set(keyFor(r), {
      slug: r.polyMarketSlug, intent, sport: r.sport, marketType: r.marketType,
      postPrice, postTs: now, bfaAtPost: b, profitAtPost, spreadAtPost: spread,
      gameStartTs: ttg != null ? now + ttg : null,
    });
  }
}

// ── Reporting ─────────────────────────────────────────────────────────────────
function readLog(type, sinceMs) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl')); } catch { return out; }
  for (const f of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const ln of lines) {
      try {
        const e = JSON.parse(ln);
        if (e.type === type && Date.parse(e.ts) >= sinceMs) out.push(e);
      } catch { /* skip bad line */ }
    }
  }
  return out;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summary(sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000) {
  const opens = readLog('shadow_open', sinceMs);
  const closes = readLog('shadow_close', sinceMs);

  const withRoom = opens.filter((o) => o.makerRoom);
  const filled = closes.filter((c) => c.outcome === 'filled');
  const survived = filled.filter((c) => c.arbAliveAtClose);
  const fillTimes = filled.map((c) => c.timeOpenMs).filter(Number.isFinite);
  const drifts = filled.map((c) => c.bfaDrift).filter(Number.isFinite);

  const watched = closes.length; // closed = watched-to-completion this run
  return {
    windowDays: Math.round((Date.now() - sinceMs) / 86400000),
    openNow: open.size,
    observations: opens.length,
    makerRoomRate: opens.length ? withRoom.length / opens.length : null, // how often a profitable inside price exists
    watched,
    filled: filled.length,
    fillRate: watched ? filled.length / watched : null,                  // of watched orders, fraction that would fill
    arbSurvivalRate: filled.length ? survived.length / filled.length : null, // of fills, fraction still profitable after BFA drift
    netHitRate: watched ? survived.length / watched : null,              // the money metric: watched → filled AND survived
    medianTimeToFillMinutes: fillTimes.length ? Math.round(median(fillTimes) / 60000) : null,
    avgBfaDriftAtFill: drifts.length ? drifts.reduce((s, d) => s + d, 0) / drifts.length : null,
    avgRealizedProfitPerShare: survived.length
      ? survived.reduce((s, c) => s + c.profitPerShareAtFill, 0) / survived.length
      : null,
  };
}

module.exports = { tick, summary, readLog, keyFor, LOG_DIR };
