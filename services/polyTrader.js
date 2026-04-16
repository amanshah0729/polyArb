require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PolymarketUS } = require('polymarket-us');

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

async function getBBO(marketSlug) {
  const bbo = await client().markets.bbo(marketSlug);
  return {
    marketSlug,
    bestBid: num(bbo.bestBid),
    bestAsk: num(bbo.bestAsk),
    bidDepth: bbo.bidDepth ?? null,
    askDepth: bbo.askDepth ?? null,
    lastTradePx: num(bbo.lastTradePx),
  };
}

async function placeOrder({ marketSlug, intent, price, quantity, tif = 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL', orderType = 'ORDER_TYPE_LIMIT' }) {
  const params = {
    marketSlug,
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
    await client().orders.cancel(orderId, { marketSlug });
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
  const limit = roundTick(price + tolerance);
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
 * Unwind a long position via limit-sell ladder.
 *  Entry → same price limit (maker) → step down → market.
 *  Bails with alarm if cumulative loss would exceed maxLossPct.
 */
async function unwindLadder({ marketSlug, intent: buyIntent, entryPrice, quantity, maxLossPct = 0.06, stepCents = 0.01, stepTimeoutMs = 30000, steps = 3 }) {
  const sellIntent = OPPOSITE_INTENT[buyIntent];
  if (!sellIntent) return { success: false, error: `No opposite intent for ${buyIntent}`, soldQty: 0, realizedValue: 0 };

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
        const open = await client().orders.list({ slugs: [marketSlug] });
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

module.exports = { client, getBBO, buyIOC, placeOrder, cancelOrder, unwindLadder, OPPOSITE_INTENT, roundTick };

if (require.main === module) {
  (async () => {
    const slug = process.argv[2];
    if (!slug) { console.error('Usage: node polyTrader.js <marketSlug>'); process.exit(1); }
    const bbo = await getBBO(slug);
    console.log(JSON.stringify(bbo, null, 2));
  })().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
}
