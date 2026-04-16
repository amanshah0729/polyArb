/**
 * Bet sizing policy for BFA↔Polymarket arbs.
 *
 * Tiered on bestCost (lower cost = more certain arb = larger bet):
 *   cost ≤ 0.995 → $50 BFA
 *   0.995 < cost ≤ 1.000 → $30
 *   1.000 < cost ≤ 1.005 → $10
 *   1.005 < cost ≤ 1.010 → $5
 *   cost > 1.010 → reject (not worth BFA bonus drag)
 *
 * Concentration cap: bfaAmount ≤ 10% of availableBalance (if provided).
 *
 * Poly quantity derived from BFA dollar exposure:
 *   polyNotional = bfaAmount * (bfaImplied / polyImplied)
 *   polyQuantity = polyNotional / polyPrice     (in shares)
 * If polyPrice not provided, fall back to polyImplied.
 */

function tierForCost(bestCost) {
  if (bestCost <= 0.995) return { bfaAmount: 50, label: 'deep-arb' };
  if (bestCost <= 1.000) return { bfaAmount: 30, label: 'true-arb' };
  if (bestCost <= 1.005) return { bfaAmount: 10, label: 'near-arb' };
  if (bestCost <= 1.010) return { bfaAmount: 5,  label: 'edge-near-arb' };
  return null;
}

function sizeArb({ bestCost, bfaImplied, polyImplied, polyPrice, availableBalance }) {
  if (!Number.isFinite(bestCost) || !Number.isFinite(bfaImplied) || !Number.isFinite(polyImplied)) {
    return null;
  }
  if (bfaImplied <= 0 || polyImplied <= 0) return null;

  const tier = tierForCost(bestCost);
  if (!tier) return null;

  let bfaAmount = tier.bfaAmount;
  const rationale = [`tier=${tier.label} ($${tier.bfaAmount} base)`];

  if (Number.isFinite(availableBalance) && availableBalance > 0) {
    const cap = Math.floor(availableBalance * 0.10 * 100) / 100;
    if (cap < bfaAmount) {
      bfaAmount = Math.max(1, cap);
      rationale.push(`capped to 10% of balance ($${cap.toFixed(2)})`);
    }
  }

  const px = Number.isFinite(polyPrice) && polyPrice > 0 ? polyPrice : polyImplied;
  const polyNotional = bfaAmount * (bfaImplied / polyImplied);
  const polyQuantity = Math.round((polyNotional / px) * 100) / 100;

  return {
    bfaAmount: Math.round(bfaAmount * 100) / 100,
    polyQuantity,
    polyNotional: Math.round(polyNotional * 100) / 100,
    polyPriceUsed: px,
    tier: tier.label,
    rationale: rationale.join('; '),
  };
}

module.exports = { sizeArb, tierForCost };
