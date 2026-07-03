require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PolymarketUS } = require('polymarket-us');
const polyBook = require('./polyBook');

const KEY_ID = process.env.POLY_API_KEY3 || process.env.POLYMARKET_KEY_ID;
const SECRET = process.env.POLY_SECRET3 || process.env.POLYMARKET_SECRET_KEY;

let _client = null;
function client() {
  if (_client) return _client;
  if (!KEY_ID || !SECRET) throw new Error('POLY_API_KEY3/POLY_SECRET3 missing in .env');
  _client = new PolymarketUS({ keyId: KEY_ID, secretKey: SECRET });
  return _client;
}

const OPPOSITE_INTENT = {
  ORDER_INTENT_BUY_LONG:  'ORDER_INTENT_SELL_LONG',
  ORDER_INTENT_BUY_SHORT: 'ORDER_INTENT_SELL_SHORT',
  ORDER_INTENT_SELL_LONG:  'ORDER_INTENT_BUY_LONG',
  ORDER_INTENT_SELL_SHORT: 'ORDER_INTENT_BUY_SHORT',
};

function num(amt) {
  if (amt == null) return null;
  if (typeof amt === 'number') return amt;
  if (typeof amt === 'string') { const n = parseFloat(amt); return Number.isFinite(n) ? n : null; }
  if (amt.value != null) return parseFloat(amt.value);
  return null;
}

function roundTick(price) {
  return Math.round(price * 1000) / 1000; // Poly ticks at 0.001
}

// Polymarket-US uses separate event-slug vs market-slug namespaces (e.g. event
// "nhl-pit-phi-2026-04-22" has market "aec-nhl-pit-phi-2026-04-22"). Our
// scanner surfaces the event slug. Resolve to the real market slug once and
// cache — SDK endpoints (book/bbo/orders.create) require the market slug.
const _slugCache = new Map();

async function resolveMarketSlug(slug) {
  if (!slug) return slug;
  if (_slugCache.has(slug)) return _slugCache.get(slug);

  // Slug-only callers (BBO/depth/order helpers) go through the matcher's
  // low-context tiers (direct → event → token-substring fallback). Rich
  // resolution with team names happens upstream in arbExecutor before these
  // helpers are called, so the matcher's positive cache is usually warm.
  const matcher = require('./marketMatcher');
  const r = await matcher.resolveMarket(client(), { slug });
  const resolved = r?.resolvedSlug || slug;
  _slugCache.set(slug, resolved);
  return resolved;
}

async function getBBO(marketSlug) {
  const resolved = await resolveMarketSlug(marketSlug);
  try {
    const bbo = await client().markets.bbo(resolved);
    // SDK may return { marketData: {...} } or flat — handle both.
    const md = bbo?.marketData ?? bbo;
    if (md && (md.bestAsk != null || md.bestBid != null)) {
      return {
        marketSlug: resolved,
        bestBid: num(md.bestBid),
        bestAsk: num(md.bestAsk),
        bidDepth: md.bidDepth ?? null,
        askDepth: md.askDepth ?? null,
        lastTradePx: num(md.lastTradePx),
      };
    }
  } catch { /* SDK can't find it — fall through to CLOB */ }

  // Resolve slug → token IDs via Polymarket gamma API
  const gammaResp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`);
  if (!gammaResp.ok) throw new Error(`gamma API ${gammaResp.status} for ${marketSlug}`);
  const gammaData = await gammaResp.json();
  const mkt = Array.isArray(gammaData) ? gammaData[0] : gammaData;
  const rawTokens = mkt?.clobTokenIds;
  const tokenIds = typeof rawTokens === 'string' ? JSON.parse(rawTokens) : rawTokens;
  if (!tokenIds || tokenIds.length < 2) throw new Error(`market not found: ${marketSlug}`);

  // Fetch BUY (best bid) and SELL (best ask) prices for the first outcome token
  const [askResp, bidResp] = await Promise.all([
    fetch(`https://clob.polymarket.com/price?token_id=${tokenIds[0]}&side=SELL`),
    fetch(`https://clob.polymarket.com/price?token_id=${tokenIds[0]}&side=BUY`),
  ]);
  const askData = askResp.ok ? await askResp.json() : {};
  const bidData = bidResp.ok ? await bidResp.json() : {};

  return {
    marketSlug,
    bestBid: parseFloat(bidData.price) || null,
    bestAsk: parseFloat(askData.price) || null,
    bidDepth: null,
    askDepth: null,
    lastTradePx: null,
  };
}

async function getDepth(marketSlug) {
  const resolved = await resolveMarketSlug(marketSlug);
  try {
    const raw = await client().markets.book(resolved);
    const { bids, offers } = polyBook.normalizeBook(raw);
    if (bids.length || offers.length) {
      return { marketSlug: resolved, bids, offers, raw };
    }
  } catch { /* fall through to CLOB */ }

  const gammaResp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`);
  if (!gammaResp.ok) throw new Error(`gamma API ${gammaResp.status} for ${marketSlug}`);
  const gammaData = await gammaResp.json();
  const mkt = Array.isArray(gammaData) ? gammaData[0] : gammaData;
  const rawTokens = mkt?.clobTokenIds;
  const tokenIds = typeof rawTokens === 'string' ? JSON.parse(rawTokens) : rawTokens;
  if (!tokenIds || tokenIds.length < 2) throw new Error(`market not found: ${marketSlug}`);

  // Long-side token (tokenIds[0]); polyBook derives short-side via 1 - px.
  const bookResp = await fetch(`https://clob.polymarket.com/book?token_id=${tokenIds[0]}`);
  if (!bookResp.ok) throw new Error(`clob book ${bookResp.status} for ${marketSlug}`);
  const clob = await bookResp.json();

  const toLevel = (lvl) => ({ px: parseFloat(lvl.price), qty: parseFloat(lvl.size) });
  const raw = {
    bids: (clob.bids ?? []).map(toLevel),
    offers: (clob.asks ?? []).map(toLevel),
  };
  const { bids, offers } = polyBook.normalizeBook(raw);
  return { marketSlug, bids, offers, raw };
}

async function placeOrder({ marketSlug, intent, price, quantity, tif = 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL', orderType = 'ORDER_TYPE_LIMIT' }) {
  const resolved = await resolveMarketSlug(marketSlug);
  const params = {
    marketSlug: resolved,
    intent,
    type: orderType,
    price: { value: roundTick(price).toFixed(3), currency: 'USD' },
    quantity,
    tif,
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true,
  };
  const resp = await client().orders.create(params);
  return normalizeOrderResp(resp);
}

function normalizeOrderResp(resp) {
  const executions = resp.executions ?? [];
  let filledQty = 0;
  let notional = 0;
  for (const ex of executions) {
    const shares = parseFloat(ex.lastShares ?? '0') || 0;
    const px = num(ex.lastPx) ?? 0;
    filledQty += shares;
    notional += shares * px;
  }
  const avgPx = filledQty > 0 ? notional / filledQty : null;
  const terminal = executions.find((e) => e.type === 'EXECUTION_TYPE_FILL' || e.type === 'EXECUTION_TYPE_REJECTED' || e.type === 'EXECUTION_TYPE_EXPIRED' || e.type === 'EXECUTION_TYPE_CANCELED');
  const state = terminal?.order?.state ?? executions[executions.length - 1]?.order?.state ?? null;
  return {
    orderId: resp.id,
    state,
    filledQty,
    avgPx,
    notional,
    executions,
    rejectReason: terminal?.orderRejectReason ?? null,
  };
}

async function cancelOrder(orderId, marketSlug) {
  try {
    const resolved = await resolveMarketSlug(marketSlug);
    await client().orders.cancel(orderId, { marketSlug: resolved });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Buy leg: IOC at target price. Returns fill details or failure reason.
 * On partial fill, returns what did fill; caller decides what to do with residual.
 */
async function buyIOC({ marketSlug, intent, price, quantity, tolerance = 0.005 }) {
  // `price` is in the intent's natural coords (long-side px for BUY_LONG,
  // short-side px for BUY_SHORT). The SDK always wants a long-side limit.
  // For BUY_SHORT (internal SELL), we need limit ≤ bestBid to cross, so
  // translate px to long-side and subtract tolerance (more aggressive).
  // For BUY_LONG, add tolerance so limit ≥ bestAsk crosses.
  const limit = intent === 'ORDER_INTENT_BUY_SHORT'
    ? roundTick((1 - price) - tolerance)
    : roundTick(price + tolerance);
  try {
    const result = await placeOrder({
      marketSlug, intent, price: limit, quantity,
      tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    });
    return { ...result, marketSlug, intent, requestedPrice: price, limitPrice: limit, requestedQty: quantity };
  } catch (e) {
    return { orderId: null, filledQty: 0, avgPx: null, state: 'ERROR', error: e.message, marketSlug, intent, requestedPrice: price, limitPrice: limit, requestedQty: quantity };
  }
}

/**
 * Maker-mode buy: post a GTC limit at a non-crossing price to earn the maker
 * rebate instead of paying the taker fee. Polls for fills up to `timeoutMs`,
 * then cancels residual. If `iocFallback` is true and some qty is unfilled,
 * crosses the book IOC at `fallbackPrice` to finish.
 *
 * `price` is expressed in long-side coords (same as buyIOC). For BUY_SHORT
 * (side=SELL internally), a HIGHER long-coord price = safer maker posting
 * (further from best bid). For BUY_LONG, a LOWER long-coord price = safer.
 */
async function buyMaker({ marketSlug, intent, price, quantity, timeoutMs = 30000, pollMs = 2000, iocFallback = false, fallbackPrice = null, fallbackTolerance = 0.005 }) {
  const resolved = await resolveMarketSlug(marketSlug);
  const makerPx = roundTick(price);
  let order;
  try {
    order = await placeOrder({
      marketSlug: resolved, intent, price: makerPx, quantity,
      tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
    });
  } catch (e) {
    return { orderId: null, filledQty: 0, avgPx: null, state: 'ERROR', error: e.message, marketSlug: resolved, intent, requestedPrice: price, makerPrice: makerPx, requestedQty: quantity, mode: 'maker' };
  }

  let filledQty = order.filledQty || 0;
  let realizedNotional = order.notional || 0;
  const deadline = Date.now() + timeoutMs;

  while (filledQty < quantity && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const open = await client().orders.list({ slugs: [resolved] });
      const o = (open.orders ?? []).find((x) => x.id === order.orderId);
      if (!o) break; // order no longer open — fully filled or cancelled
      const cum = parseFloat(o.cumQuantity ?? 0) || 0;
      if (cum > filledQty) {
        const delta = cum - filledQty;
        const avg = num(o.avgPx) ?? makerPx;
        realizedNotional += delta * avg;
        filledQty = cum;
      }
    } catch { /* transient — retry next tick */ }
  }

  if (filledQty < quantity) {
    await cancelOrder(order.orderId, marketSlug);
  }

  const avgPx = filledQty > 0 ? realizedNotional / filledQty : null;
  const makerResult = {
    orderId: order.orderId, state: filledQty >= quantity ? 'ORDER_STATE_FILLED' : 'ORDER_STATE_PARTIAL',
    filledQty, avgPx, notional: realizedNotional,
    marketSlug, intent, requestedPrice: price, makerPrice: makerPx, requestedQty: quantity, mode: 'maker',
  };

  if (filledQty >= quantity || !iocFallback) return makerResult;

  // IOC the remainder at taker price
  const residual = quantity - filledQty;
  const tolerance = intent === 'ORDER_INTENT_BUY_SHORT' ? -fallbackTolerance : fallbackTolerance;
  const iocPrice = fallbackPrice != null ? fallbackPrice : price;
  const ioc = await buyIOC({ marketSlug, intent, price: iocPrice, quantity: residual, tolerance });
  const totalFilled = filledQty + (ioc.filledQty || 0);
  const totalNotional = realizedNotional + (ioc.notional || 0);
  return {
    orderId: order.orderId, iocOrderId: ioc.orderId,
    state: totalFilled >= quantity ? 'ORDER_STATE_FILLED' : 'ORDER_STATE_PARTIAL',
    filledQty: totalFilled,
    avgPx: totalFilled > 0 ? totalNotional / totalFilled : null,
    notional: totalNotional,
    marketSlug, intent, requestedPrice: price, makerPrice: makerPx, requestedQty: quantity,
    mode: 'maker+ioc',
    makerFilled: filledQty, makerAvg: avgPx,
    iocFilled: ioc.filledQty, iocAvg: ioc.avgPx,
  };
}

/**
 * Unwind a long position via limit-sell ladder.
 *  Entry → same price limit (maker) → step down → market.
 *  Bails with alarm if cumulative loss would exceed maxLossPct.
 */
async function unwindLadder({ marketSlug, intent: buyIntent, entryPrice, quantity, maxLossPct = 0.06, stepCents = 0.01, stepTimeoutMs = 30000, steps = 3 }) {
  const sellIntent = OPPOSITE_INTENT[buyIntent];
  if (!sellIntent) return { success: false, error: `No opposite intent for ${buyIntent}`, soldQty: 0, realizedValue: 0 };
  const resolved = await resolveMarketSlug(marketSlug);

  let remaining = quantity;
  let realizedValue = 0;
  const attempts = [];
  const floorPrice = Math.max(0.01, entryPrice - maxLossPct);

  for (let i = 0; i < steps && remaining > 0; i++) {
    const targetPrice = roundTick(Math.max(floorPrice, entryPrice - i * stepCents));
    if (targetPrice <= floorPrice && i > 0) break;

    let order;
    try {
      order = await placeOrder({
        marketSlug, intent: sellIntent, price: targetPrice, quantity: remaining,
        tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
      });
    } catch (e) {
      attempts.push({ step: i, price: targetPrice, error: e.message });
      continue;
    }

    // Any immediate execution?
    if (order.filledQty > 0) {
      realizedValue += order.notional;
      remaining -= order.filledQty;
      attempts.push({ step: i, price: targetPrice, filled: order.filledQty, avgPx: order.avgPx, orderId: order.orderId });
      if (remaining <= 0) break;
    }

    // Wait up to stepTimeoutMs for the rest to fill
    const deadline = Date.now() + stepTimeoutMs;
    let stepFilled = order.filledQty;
    while (Date.now() < deadline && remaining > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const open = await client().orders.list({ slugs: [resolved] });
        const o = (open.orders ?? []).find((x) => x.id === order.orderId);
        if (!o) break; // no longer open — fully filled or cancelled
        const cum = o.cumQuantity ?? 0;
        if (cum > stepFilled) {
          const delta = cum - stepFilled;
          const avg = num(o.avgPx) ?? targetPrice;
          realizedValue += delta * avg;
          remaining -= delta;
          stepFilled = cum;
        }
      } catch {}
    }
    attempts.push({ step: i, price: targetPrice, orderId: order.orderId, stepFilled });

    if (remaining > 0) await cancelOrder(order.orderId, marketSlug);
  }

  // Market-sell residual if we still have shares AND not at loss cap
  if (remaining > 0) {
    try {
      const mkt = await placeOrder({
        marketSlug, intent: sellIntent, price: floorPrice, quantity: remaining,
        tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
      });
      if (mkt.filledQty > 0) {
        realizedValue += mkt.notional;
        remaining -= mkt.filledQty;
        attempts.push({ step: 'market', price: floorPrice, filled: mkt.filledQty, avgPx: mkt.avgPx, orderId: mkt.orderId });
      } else {
        attempts.push({ step: 'market', price: floorPrice, filled: 0, state: mkt.state });
      }
    } catch (e) {
      attempts.push({ step: 'market', error: e.message });
    }
  }

  const soldQty = quantity - remaining;
  const entryCost = quantity * entryPrice;
  const unwindLoss = entryCost - realizedValue - (remaining * entryPrice); // residual valued at entry (still held)
  return {
    success: remaining === 0,
    soldQty, remainingQty: remaining,
    realizedValue, entryCost,
    unwindLoss,
    attempts,
  };
}

module.exports = { client, resolveMarketSlug, getBBO, getDepth, buyIOC, buyMaker, placeOrder, cancelOrder, unwindLadder, OPPOSITE_INTENT, roundTick };

if (require.main === module) {
  (async () => {
    const slug = process.argv[2];
    if (!slug) { console.error('Usage: node polyTrader.js <marketSlug> [--depth LONG|SHORT [--bfa <implied>]]'); process.exit(1); }
    const depthIdx = process.argv.indexOf('--depth');
    if (depthIdx < 0) {
      const bbo = await getBBO(slug);
      console.log(JSON.stringify(bbo, null, 2));
      return;
    }
    const side = (process.argv[depthIdx + 1] || '').toUpperCase();
    const intent = side === 'LONG' ? 'ORDER_INTENT_BUY_LONG' : side === 'SHORT' ? 'ORDER_INTENT_BUY_SHORT' : null;
    if (!intent) { console.error('--depth requires LONG or SHORT'); process.exit(1); }
    const bfaIdx = process.argv.indexOf('--bfa');
    const bfaImplied = bfaIdx >= 0 ? parseFloat(process.argv[bfaIdx + 1]) : null;
    const depth = await getDepth(slug);
    const book = depth.raw;
    const side5 = intent === 'ORDER_INTENT_BUY_SHORT' ? depth.bids.slice(0, 10) : depth.offers.slice(0, 10);
    console.log(`\nTop 10 ${intent === 'ORDER_INTENT_BUY_SHORT' ? 'bids (long-side)' : 'offers (long-side)'}:`);
    side5.forEach((l) => {
      const eff = intent === 'ORDER_INTENT_BUY_SHORT' ? (1 - l.px) : l.px;
      console.log(`  long_px=${l.px.toFixed(3)}  eff=${eff.toFixed(3)}  qty=${l.qty}`);
    });
    if (bfaImplied != null && Number.isFinite(bfaImplied)) {
      const r = polyBook.maxProfitableSize({ book, intent, bfaImplied });
      console.log('\nmaxProfitableSize @ bfaImplied=', bfaImplied);
      console.log('  maxShares      :', r.maxShares);
      console.log('  vwapAtMax      :', r.vwapAtMax?.toFixed(4));
      console.log('  maxBfaStake    : $', r.maxBfaStake?.toFixed(2));
      console.log('  expectedPnl    : $', r.expectedPnl?.toFixed(2));
      console.log('  lastAcceptedPx :', r.lastAcceptedPx?.toFixed(4));
      console.log('  levelsAccepted :', r.levelsAccepted);
    }
  })().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
}
