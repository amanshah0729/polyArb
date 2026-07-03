/**
 * Pure helpers for walking a Polymarket US order book and solving for the
 * maximum Poly share count that keeps a BFA↔Poly arb profitable.
 *
 * Polymarket US DCM fee formula (per-contract, rounded per-share to $0.01):
 *   fee_per_share = max(0.01, Θ × p × (1 − p))     for taker (Θ = 0.05)
 *   rebate_per_share = Θ_maker × p × (1 − p)       for maker (Θ = 0.0125, no floor)
 * Source: https://www.polymarketexchange.com/fees-hours.html
 */

const THETA_TAKER = 0.05;
const THETA_MAKER = 0.0125;
const MIN_TAKER_FEE = 0.01; // per-share floor

// ── BFA rollover credit ───────────────────────────────────────────────────────
// The whole $300 BFA balance (deposit + bonus) is locked until $4800 of
// qualifying wagers. Marginal unlock value λ = 300/4800 = 6.25¢ per $1 staked.
// Bets at −200 or shorter odds (implied ≥ 2/3) do NOT count toward the
// rollover, so they earn zero credit.
const QUALIFY_MAX_IMPLIED = 2 / 3;
const DEFAULT_LAMBDA = Number(process.env.BFA_ROLLOVER_LAMBDA) > 0
  ? Number(process.env.BFA_ROLLOVER_LAMBDA)
  : 300 / 4800;

function rolloverQualifies(bfaImplied) {
  return Number.isFinite(bfaImplied) && bfaImplied < QUALIFY_MAX_IMPLIED - 1e-9;
}

// Credit per Poly share (= per $1 of payout): λ × bfaImplied when the BFA leg
// qualifies. The BFA stake behind each $1 of payout is bfaImplied dollars.
function rolloverCreditPerShare(bfaImplied, lambda = DEFAULT_LAMBDA) {
  return rolloverQualifies(bfaImplied) ? lambda * bfaImplied : 0;
}

function takerFeePerShare(p) {
  return Math.max(MIN_TAKER_FEE, THETA_TAKER * p * (1 - p));
}
function makerRebatePerShare(p) {
  // Positive number; net cost per share = p - rebate.
  return THETA_MAKER * p * (1 - p);
}
/**
 * Effective cost adder for one share at price p.
 *   feeMode 'taker': + fee (you pay)
 *   feeMode 'maker': − rebate (you receive)
 *   feeMode 'none' : 0
 */
function effectiveFeeAdder(p, feeMode = 'taker') {
  if (feeMode === 'maker') return -makerRebatePerShare(p);
  if (feeMode === 'none') return 0;
  return takerFeePerShare(p);
}

function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  if (v.value != null) return parseFloat(v.value);
  return null;
}

function normalizeBook(raw) {
  const md = raw?.marketData ?? raw ?? {};
  const toLevels = (arr) => (Array.isArray(arr) ? arr : [])
    .map((lvl) => ({ px: toNum(lvl.px), qty: toNum(lvl.qty) }))
    .filter((l) => Number.isFinite(l.px) && Number.isFinite(l.qty) && l.qty > 0);

  const bids = toLevels(md.bids).sort((a, b) => b.px - a.px);
  const offers = toLevels(md.offers).sort((a, b) => a.px - b.px);
  return { bids, offers };
}

/**
 * Walk the correct side of the book up to targetShares, reporting per-level
 * fills and cumulative VWAP.
 *   intent BUY_LONG  → consume offers ascending; pricePerShare = offer.px
 *   intent BUY_SHORT → consume bids descending; pricePerShare = 1 − bid.px
 */
function walkBook(raw, intent, targetShares) {
  const { bids, offers } = normalizeBook(raw);
  const isShort = intent === 'ORDER_INTENT_BUY_SHORT';
  const source = isShort ? bids : offers;

  const levels = [];
  let cumQty = 0;
  let cumNotional = 0;
  let depletedAt = null;

  for (const lvl of source) {
    const pps = isShort ? (1 - lvl.px) : lvl.px;
    if (!(pps > 0 && pps < 1)) continue;
    const remaining = targetShares - cumQty;
    if (remaining <= 0) break;
    const take = Math.min(lvl.qty, remaining);
    cumQty += take;
    cumNotional += take * pps;
    levels.push({ pricePerShare: pps, qty: take, cumQty, cumNotional });
    if (cumQty >= targetShares - 1e-9) { depletedAt = null; break; }
  }
  const fillable = cumQty >= targetShares - 1e-9;
  if (!fillable) depletedAt = cumQty;

  return {
    levels,
    vwap: cumQty > 0 ? cumNotional / cumQty : null,
    fillable,
    filledQty: cumQty,
    depletedAt,
  };
}

/**
 * Solve for the largest quantity S such that every marginal share still has
 * positive score. Hedge: BFA stake B = S × bfaImplied (so both legs pay $S if
 * correct). Per-share score at level price p:
 *     (1 − p − fee − bfaImplied) + λ × bfaImplied × 𝟙(qualifies)
 * i.e. cash edge plus rollover credit. We accept levels entirely while the
 * marginal all-in cost stays below 1 + credit (minus safety buffer). Pass
 * lambda = 0 to recover the pure cash-arb sizing.
 */
function maxProfitableSize({ book, intent, bfaImplied, feeMode = 'taker', lambda = DEFAULT_LAMBDA, safetyBuffer = 0.002, eps = 1e-6 }) {
  const creditPerShare = rolloverCreditPerShare(bfaImplied, lambda);
  const empty = {
    maxShares: 0, vwapAtMax: null, maxBfaStake: 0, expectedPnl: 0,
    lastAcceptedPx: null, levelsAccepted: 0, feeMode, totalFees: 0,
    lambda, qualifies: rolloverQualifies(bfaImplied), rolloverCreditPerShare: creditPerShare,
    bonusCredit: 0, evAtMax: 0,
  };
  if (!Number.isFinite(bfaImplied) || bfaImplied <= 0 || bfaImplied >= 1) {
    return empty;
  }
  const { bids, offers } = normalizeBook(book);
  const isShort = intent === 'ORDER_INTENT_BUY_SHORT';
  const source = isShort ? bids : offers;

  let cumQty = 0;
  let cumNotional = 0;
  let cumFees = 0;
  let lastAcceptedPx = null;
  let levelsAccepted = 0;
  // Accept level while marginal all-in cost + bfa leg stays below $1 + rollover
  // credit, minus a safety buffer.
  const threshold = 1 + creditPerShare - bfaImplied - safetyBuffer - eps;

  for (const lvl of source) {
    const pps = isShort ? (1 - lvl.px) : lvl.px;
    if (!(pps > 0 && pps < 1)) continue;
    const feeAdder = effectiveFeeAdder(pps, feeMode);
    const allIn = pps + feeAdder;
    if (allIn > threshold) break; // marginal share has negative score — stop
    cumQty += lvl.qty;
    cumNotional += lvl.qty * pps;
    cumFees += lvl.qty * feeAdder;
    lastAcceptedPx = pps;
    levelsAccepted += 1;
  }

  const vwapAtMax = cumQty > 0 ? cumNotional / cumQty : null;
  const maxBfaStake = cumQty * bfaImplied;
  // Worst-case cash P&L (net of fees), before rollover credit:
  const expectedPnl = vwapAtMax != null
    ? cumQty * (1 - vwapAtMax - bfaImplied) - cumFees
    : 0;
  const bonusCredit = cumQty * creditPerShare;

  return {
    maxShares: cumQty,
    vwapAtMax,
    maxBfaStake,
    expectedPnl,
    lastAcceptedPx,
    levelsAccepted,
    feeMode,
    totalFees: cumFees, // negative if maker (rebate received)
    lambda,
    qualifies: rolloverQualifies(bfaImplied),
    rolloverCreditPerShare: creditPerShare,
    bonusCredit,
    evAtMax: expectedPnl + bonusCredit,
  };
}

module.exports = {
  normalizeBook, walkBook, maxProfitableSize,
  takerFeePerShare, makerRebatePerShare, effectiveFeeAdder,
  rolloverQualifies, rolloverCreditPerShare,
  THETA_TAKER, THETA_MAKER, MIN_TAKER_FEE,
  QUALIFY_MAX_IMPLIED, DEFAULT_LAMBDA,
};
