# Bet Sizing Model for BFAGaming Rollover Clearing

## Context

You deposited $100 to BFAGaming and received a $200 bonus (account credited to $300).
You must **risk $4,800 total** on BFAGaming before you can withdraw ("rollover requirement").
By hedging each BFA bet on Polymarket, you lock in a near-certain loss per bet — but the $200 bonus compensates for those losses if bets are sized correctly.

---

## Notation

| Symbol | Meaning |
|---|---|
| `B` | Bonus received = **$200** |
| `R` | Total rollover required = **$4,800** |
| `W` | BFA stake per bet (counts toward rollover) |
| `P` | Polymarket stake per bet (hedge, does NOT count toward rollover) |
| `b` | BFA side implied probability (e.g. −209 → 0.676) |
| `p` | Poly side implied probability (from Predexon price) |
| `C` | Best option cost = `b + p` (already computed by the scanner) |

---

## Perfect Hedge Formula

To guarantee the **same net P&L regardless of which side wins**, set:

```
P = W × (p / b)
```

**Why this works:**

- If BFA side wins: net = W × (1/b − 1) − P = W/b − W − W×p/b = W(1−p)/b − W
- If Poly side wins: net = P × (1/p − 1) − W = P/p − P − W = W/b − W×p/b − W

Both collapse to:

```
Guaranteed P&L per bet = W × (1 − C) / b
```

When `C > 1` this is a guaranteed loss. When `C < 1` (true arb) it is a guaranteed profit.

---

## Total Capital Deployed Per Bet

```
W + P = W × (1 + p/b) = W × (b + p) / b = W × C / b
```

With a heavy BFA favorite (`b → 1`), nearly all deployed capital counts toward rollover.
With even money (`b = 0.5`), only half the deployed capital is rollover-eligible.

---

## Net Profit Over Full Rollover

Each BFA-side bet of size `W` contributes `W` toward rollover. The bonus is amortized across the full rollover:

```
Net = B − Σ [ W_i × (C_i − 1) / b_i ]
```

### Breakeven Cost

The breakeven cost for a bet at BFA-side implied `b` is the value of `C` where the expected P&L from this bet equals its share of the bonus:

```
W × (C_break − 1) / b = W × B / R

C_break(b) = 1 + (B / R) × b = 1 + b / 24
```

The $200 bonus over $4,800 rollover = **4.17% amortized return per rollover dollar**. Since the hedge cost (C−1)/b is always diluted by `b < 1`, the actual hurdle on `C` varies:

| BFA implied `b` | Approx American odds | Theoretical breakeven `C` |
|---|---|---|
| 0.90 | −900 | 1.0375 |
| 0.80 | −400 | 1.0333 |
| 0.67 | −200 | 1.0279 |
| 0.50 | even | 1.0208 |

In practice we use a **flat 2% cap (C < 1.02)** as the sizing threshold — simpler, and conservative enough to ensure profitability across all realistic BFA-side implied probabilities.

---

## Edge Per Rollover Dollar

```
edge(b, C) = B/R − (C − 1)/b  =  1/24 − (C − 1)/b
```

- **Positive edge** → net-profitable after bonus amortization
- **Negative edge** → skip or bet the minimum floor

---

## Sizing Scale Factor

Linearly scale between `min_bet` (at the 2% overhead cap) and `max_bet` (at C ≤ 1, true arb):

```
MAX_COST = 1.02   // 2% loss threshold — net-profitable with $200 bonus over $4800 rollover

scale = (MAX_COST − C) / (MAX_COST − 1.0)
      = (1.02 − C) / 0.02
```

`scale ∈ [0, 1]`: 0 = floor (C ≥ 1.02), 1 = full size (true arb, C ≤ 1.0).
Above 2% overhead you still get `min_bet` — you always have a number to work with.

---

## Bet Sizing Algorithm

```
Inputs:
  b, p           — BFA and Poly side implied probabilities
  C = b + p      — best option cost (from scanner)
  r              — rollover remaining (default 4800)
  bankroll       — available funds (default 300)
  B = 200, R = 4800
  min_bet = 10, max_bet = 100, MAX_COST = 1.02

Steps:
  1.  if C >= MAX_COST (2% overhead):
        W = min_bet                      // always show a number
  2.  else:
        scale  = (MAX_COST − C) / (MAX_COST − 1.0)   // linear: 0 at 2%, 1 at true arb
        W_raw  = min_bet + (max_bet − min_bet) × scale
        W      = min(W_raw, r)           // don't over-roll
  3.  P        = W × (p / b)             // perfect hedge
  4.  if W + P > bankroll:               // bankroll cap
        factor = bankroll / (W + P)
        W, P   = W × factor, P × factor
  5.  W, P     = round to nearest $0.50
  6.  guaranteed_pnl  = W × (1 − C) / b
  7.  amortized_bonus = W × B / R        // = W / 24
  8.  net_value       = guaranteed_pnl + amortized_bonus
```

---

## Output Fields Per Bet

| Field | Formula |
|---|---|
| BFA Stake `W` | algorithm above |
| Poly Stake `P` | `W × p / b` |
| Guaranteed P&L | `W × (1 − C) / b` |
| Amortized Bonus | `W / 24` |
| Net Value | `guaranteed_pnl + W/24` |

Net Value > 0 means this bet is profitable after accounting for the bonus amortization.

---

## Worked Example

**Timberwolves @ BFA (−209, b = 0.676) + Warriors @ Poly (p = 0.335), C = 1.011**

```
C_break  = 1 + 0.676/24        = 1.0282
scale    = (1.0282 − 1.011) / (1.0282 − 1)
         = 0.0172 / 0.0282     = 0.610
W_raw    = $10 + $90 × 0.610   = $64.90  → W = $65.00
P        = $65.00 × (0.335/0.676) = $32.22

Total capital deployed = $65.00 + $32.22 = $97.22

Guaranteed P&L  = $65.00 × (1 − 1.011)/0.676  = −$1.06
Amortized bonus = $65.00 / 24                  = +$2.71
Net value                                       = +$1.65 ✓
```

---

## C vs. Bet Sizing Summary (B=$200, R=$4800, min=$10, max=$100)

| C | b = 0.9 | b = 0.7 | b = 0.5 |
|---|---|---|---|
| 1.000 | W=$100, P=$11 | W=$100, P=$43 | W=$100, P=$100 |
| 1.010 | W=$73, P=$8 | W=$66, P=$28 | W=$52, P=$52 |
| 1.020 | W=$45, P=$5 | W=$31, P=$13 | W=$10, P=$10 |
| 1.030 | W=$17, P=$2 | W=$10, P=$4 | W=$10, P=$10 |
| ≥ C_break | W=$10 (floor) | W=$10 (floor) | W=$10 (floor) |

---

## CLI Usage

```bash
# Default: rollover_remaining=4800, bankroll=300
node scripts/bfagaming/getBFAGamingArb.js

# After partial rollover completion
node scripts/bfagaming/getBFAGamingArb.js --rollover-remaining 2400

# Custom bankroll
node scripts/bfagaming/getBFAGamingArb.js --rollover-remaining 3000 --bankroll 250
```

The script outputs a CSV with 20 columns including:
- `BFA Bet ($)` — stake W to place on BFAGaming
- `Poly Bet ($)` — hedge stake P to place on Polymarket
- `Guaranteed P&L ($)` — locked-in P&L from the hedge
- `Net Value ($)` — P&L after amortized bonus (green = profitable)
