# Agent Playbook — BFA Bonus Extraction via Polymarket Hedging

**Audience:** an autonomous agent with access to the frontend dashboard, the BFA
(BetFast/BFAGaming) betting API, and the Polymarket **US** API. This document is the
strategic + tax layer. For the mechanical per-bet stake calculator, see
[`bet_sizing_model.md`](./bet_sizing_model.md) — this doc explains *what game you are
playing and why*, so you can size, choose markets, and know when to stop.

> **One-line summary:** You are not gambling. You are converting a locked $200 BFA
> sign-up bonus into withdrawable Polymarket cash by placing **hedged (opposite-side)
> bets** on BFA and Poly. Each hedge bleeds a small vig; the bonus pays for the vig.
> The whole edge lives in (a) keeping the combined vig tiny and (b) **not** grinding so
> long that the tax on BFA winnings eats you. Escaping early is winning.

---

## 1. The setup (fixed facts)

| Fact | Value |
|---|---|
| BFA deposit (your cash) | $100 |
| BFA sign-up bonus (house money) | $200 |
| Starting BFA balance | **$300** |
| Rollover requirement | **16× = $4,800** of cumulative BFA wagering before BFA withdrawal is allowed |
| Poly venue | **Polymarket US** (CFTC-regulated → capital-gains tax treatment, issues tax forms) |
| User income tax bracket | **22%** (ordinary) |
| Other capital gains this year | **None** (but likely in future years — matters for loss carryforwards) |

### The key insight that makes the rollover almost irrelevant

The $4,800 rollover only gates the **BFA balance**. Polymarket has **no rollover**. When
a BFA bet **loses**, its hedge on Poly **wins**, and that money lands in Poly as
**freely withdrawable cash**. So:

- You do **not** need to complete $4,800 of wagering.
- The moment BFA loses a hedged bet, the money "escapes" to Poly and you cash out.
- **A BFA loss is the good outcome.** A BFA win traps money into another cycle.

This is the entire trick. Everything below quantifies it.

---

## 2. Core mechanic: the hedged cycle

Each cycle:

1. Bet the **entire current BFA balance** `B` on one side of an event on BFA (decimal
   odds `d_bfa`).
2. **Hedge** on Poly: bet the *opposite* outcome (decimal odds `d_poly`) with fresh
   cash `H`, sized so both legs pay the same:
   ```
   H = B · d_bfa / d_poly
   ```
3. Outcomes:
   - **BFA wins** (prob ≈ `p`) → BFA balance grows to `B · d_bfa` (still locked); the
     Poly hedge `H` is lost from pocket. **Continue** to next cycle with the bigger balance.
   - **BFA loses** (prob ≈ `1 − p`) → BFA balance → $0; Poly pays `B · d_bfa` into your
     pocket as withdrawable cash. **STOP — you have escaped.**

You keep cycling on BFA wins until either you escape (a BFA loss) or you clear $4,800
(see the "bomb" warning in §6 — clearing is the *worst* outcome, not the goal).

### Notation (matches `bet_sizing_model.md`)

| Symbol | Meaning |
|---|---|
| `d_bfa`, `d_poly` | decimal odds of the side you take on BFA / Poly (= 1 / implied prob) |
| `b`, `pl` | implied probabilities = `1/d_bfa`, `1/d_poly` |
| `C = b + pl` | combined cost (the scanner already computes this) |
| `v = C − 1` | **combined vig / overround**. `v < 0` is a true arb. Target `v ≤ 0.03`. |
| `p` | true prob the BFA side wins ≈ `b` (use implied unless you have a better estimate) |
| `B₀` | starting balance = $300; `bonus` = $200 |

---

## 3. The master formulas (use these for ANY market)

**Vig drag per dollar of BFA wagered** (this is the cost engine):
```
c = v · d_bfa = (C − 1) / b
```
Lower `d_bfa` (bigger BFA favorite) ⇒ less drag per rollover dollar. Same as the existing
doc's `(C−1)/b`.

**Balance after k winning cycles** (stake at cycle k): `Bₖ = 300 · d_bfa^(k−1)`

**Cumulative BFA wagered through cycle k:**
```
ΣBₖ = 300 · (d_bfa^k − 1) / (d_bfa − 1)
```

**Escape value** — cash you walk away with if BFA first *loses* at cycle k:
```
Wₖ = 200 − c · ΣBₖ
```
i.e. **you keep the $200 bonus minus all vig paid so far.** Clean and exact. (Derivation:
you always recover your own $100 through the hedge; the bonus is the prize; vig is the cost.)

**Cycles to clear rollover** `n` = smallest k with `ΣBₖ ≥ 4800`.

**Pre-tax EV** (play until escape or clear):
```
EV = Σ_{k=1}^{n} p^(k−1)·(1−p)·Wₖ   +   p^n · W_clear
        └─ escape at cycle k ─┘          └ win every cycle, clear $4800 ┘
```
`W_clear ≈ Wₙ` economically, **but its tax is far worse** (§5–6).

---

## 4. The three canonical lines (all at v = 3% vig)

These are the shapes you'll bet. **Which one to use is driven by where the low-vig arb
actually is** — do not hard-prefer one; compute EV per market. But as a default ranking
*at equal vig*, favorite-on-BFA (66/33) wins.

| Metric | **66/33** (favorite on BFA) | **50/50** (even) | **33/66** (underdog on BFA) |
|---|---|---|---|
| `d_bfa` / `d_poly` | 1.515 / 2.703 | 1.942 / 1.942 | 2.703 / 1.515 |
| `p` = P(BFA wins) | 0.65 | 0.50 | 0.35 |
| Escape prob / cycle | 35% | 50% | **65% (fastest)** |
| Vig drag `c` per $ | **0.0455 (lowest)** | 0.0583 | 0.0811 |
| Balance ×/win | 1.515 | 1.942 | 2.703 |
| Cycles to clear $4,800 | 6 | 5 | 4 |
| Max Poly cash to front | **$3.6k** | $8.5k | $16.5k |
| Best case (escape cycle 1) | +$186 | +$183 | +$176 |
| **Pre-tax EV** | **+$121** | +$118 | +$110 |
| **After-tax EV (22%)** | **+$67** | +$33 | +$19 |
| Worst case = "the bomb" (after-tax) | **−$166** | −$1,389 | −$3,345 |
| Bomb probability (win every cycle) | 7.5% | 3.1% | 1.5% |

### Escape-value tables (pre-tax `Wₖ`, and after-tax at 22%)

**66/33** (bet the ~66% favorite on BFA):

| Escape at cycle | Prob | Cum. Poly to front | Pre-tax | After-tax (22%) |
|---|---|---|---|---|
| 1 | 35% | $168 | +$186 | +$123 |
| 2 | 22.8% | $423 | +$166 | +$107 |
| 3 | 14.8% | $809 | +$134 | +$83 |
| 4 | 9.6% | $1,394 | +$87 | +$46 |
| 5 | 6.25% | $2,280 | +$15 | −$10 |
| 6 (lose) | 4.1% | $3,622 | −$94 | −$95 |
| **Win all 6 → clear $4,800 (BOMB)** | 7.5% | $3,622 | −$94 | **−$166** |

**50/50** (even-odds coin flip):

| Escape at cycle | Prob | Pre-tax | After-tax (22%) |
|---|---|---|---|
| 1 | 50% | +$183 | +$120 |
| 2 | 25% | +$149 | +$94 |
| 3 | 12.5% | +$83 | +$43 |
| 4 | 6.25% | −$45 | −$57 |
| 5 (lose) | 3.1% | −$292 | −$278 |
| **Win all 5 → clear (BOMB)** | 3.1% | −$292 | **−$1,389** |

**33/66** (bet the ~33% underdog on BFA — escapes fastest, but expensive vig + huge bomb):

| Escape at cycle | Prob | Pre-tax | After-tax (22%) |
|---|---|---|---|
| 1 | 65% | +$176 | +$115 |
| 2 | 22.8% | +$110 | +$64 |
| 3 | 8.0% | −$68 | −$75 |
| 4 (lose) | 2.8% | −$548 | −$514 |
| **Win all 4 → clear (BOMB)** | 1.5% | −$548 | **−$3,345** |

**Read the pattern:** you profit ~82–88% of the time (early escape), but the mean is
dragged down by the low-probability "clear the rollover" tail. The favorite line has the
smallest tail because its balance grows slowest (smallest taxable winnings — see §6).

---

## 5. Taxes — this is half the game (Polymarket US = capital gains)

Every leg is its **own taxable event**, and BFA and Poly sit in **different tax buckets
that do not net against each other**. This is the subtle trap.

### The rules (2026, this user)

1. **BFA winnings = ordinary gambling income @ 22%.** Taxed when the bet settles.
2. **BFA losses:** deductible **only against gambling winnings**, itemized, and capped at
   **90% of losses** (2026 OBBBA rule). Losing *bonus* money (not your own cash) is
   generally **not** deductible at all — treat BFA-loss deductions as optimistic.
3. **Poly gains = capital.** Prediction markets resolve fast ⇒ **short-term ⇒ taxed at
   ordinary 22%** for this user. (Long-term 15% essentially never applies here.)
4. **Poly losses = capital losses:** offset capital gains **unlimited**; otherwise only
   **$3,000/yr** against ordinary income, with the remainder **carried forward
   indefinitely.** User has **no other capital gains this year**, so a Poly loss is worth
   only $3k/yr now — *but the carryforward becomes valuable once future gains exist.*
5. **Cross-bucket mismatch (critical):** a BFA *gambling loss* **cannot** offset a Poly
   *capital gain*; a Poly *capital loss* can only shelter **$3k/yr** of BFA gambling income.

### What this does to each path

- **Escape paths (BFA loses at the end):** the final BFA **loss** offsets the accumulated
  BFA **wins** (at 90%), so BFA gambling tax ≈ **$0**. You mainly pay **22% on the net
  Poly capital gain**. After-tax escape ≈ `Wₖ − 0.22 × (net Poly gain)`. This is fine.
- **The clear-rollover path (win every cycle):** there is **no final BFA loss to offset**,
  so **all** BFA winnings are taxed as ordinary income, while the matching Poly losses are
  stuck in the capital bucket ($3k/yr only). This is the bomb.

---

## 6. ⚠️ The bomb: clearing the rollover is the WORST outcome

Intuition says "win my way to $4,800 and withdraw = success." **It is the opposite.**
When you win every BFA bet:

- Your BFA balance compounds into a large **taxable gambling win** (e.g. ~$3,300 for
  66/33, ~$8,000 for 50/50, ~$15,700 for 33/66).
- The offsetting Poly losses are capital losses you can only use $3k/yr of (this year).
- So you owe real ordinary tax on phantom winnings even though you're economically flat.

| Line | Taxable BFA winnings if you clear | Tax @22% | Poly capital loss (carries fwd) | After-tax result |
|---|---|---|---|---|
| 66/33 | ~$3,328 | ~$732 (−$660 from $3k offset) | ~$3,622 | **−$166** |
| 50/50 | ~$7,986 | ~$1,757 | ~$8,478 | **−$1,389** |
| 33/66 | ~$15,714 | ~$3,457 | ~$16,462 | **−$3,345** |

**Rule: never chase the $4,800.** If a win streak is dragging you toward clearing the
rollover, the correct move is usually to **stop and take the modest loss** rather than pay
the phantom-income tax. The bomb shrinks dramatically for favorite lines (slow balance
growth) and grows explosively for underdog lines (fast growth). The carryforward loss
recovers ~22% of its value *later* if/when the user has other capital gains.

---

## 7. Decision rules for the agent

1. **Only bet markets with combined vig `v = C − 1 ≤ 3%.`** Prefer the lowest vig you can
   find; `v < 0` is a true arb — size up. This is the single biggest lever on EV.
2. **Compute EV per market with the §3 formulas** — never assume a line type. A 33/66
   market at 0.5% vig can beat a 66/33 market at 4% vig. The scanner's `C` gives you `v`.
3. **At equal vig, prefer favorite-on-BFA (66/33):** lowest drag per rollover dollar and
   smallest tax bomb if you get trapped.
4. **Escaping early is winning.** Best expected outcome is a BFA loss on cycle 1–3. Don't
   fear BFA losses — they're the payout.
5. **Never grind toward $4,800.** Clearing the rollover is the bomb (§6). Cap how deep you
   cycle; if balance has grown past ~$1,500–2,000 (cycle 4–5), strongly consider stopping.
6. **Size the Poly hedge exactly** `H = B · d_bfa / d_poly` so payouts match. Confirm Poly
   book depth first (thin reward-tick queues → worse fills → broken hedge). See
   `polyBook.js` / the poly-depth endpoint.
7. **Watch capital.** You must have enough free cash to front cumulative Poly stakes on a
   win streak (66/33 up to ~$3.6k; 50/50 ~$8.5k; 33/66 ~$16.5k). A failed/partial Poly
   fill un-hedges you and turns the position directional — the one way to actually lose big.
8. **Track for taxes:** log every BFA win/loss (gambling) and every Poly gain/loss
   (short-term capital) separately. They do not net across buckets. The escape paths are
   near-tax-free; only the bomb generates a real bill.
9. **BFA execution:** use `services/bfaBrowser.js` + `ctx.request.post` with fixed
   `IdWagerType: 80982`; `{"state":0}` responses are normal; verify placement via balance
   delta (see project memory on BFA betting).

---

## 8. Formula cheat sheet

```
v      = C − 1                         # combined vig (C = BFA implied + Poly implied)
c      = v · d_bfa = (C−1)/b           # vig drag per $ of BFA wagered
H      = B · d_bfa / d_poly            # Poly hedge stake (equalizes payouts)
Bₖ     = 300 · d_bfa^(k−1)             # BFA stake at cycle k
ΣBₖ    = 300 · (d_bfa^k − 1)/(d_bfa−1) # cumulative BFA wagered
Wₖ     = 200 − c · ΣBₖ                 # escape cash if BFA first loses at cycle k
n      = min k : ΣBₖ ≥ 4800            # cycles to clear rollover (the bomb point)
EV     = Σ p^(k−1)(1−p)·Wₖ + p^n·W_clear
after-tax escape ≈ Wₖ − 0.22·(net Poly capital gain)   # BFA tax ≈ 0 on escapes
```

Positive-EV as long as you (a) keep `v` small and (b) never let a win streak carry you
into clearing the rollover. Break-even hurdle on cost is `C_break ≈ 1 + b/24` (the $200
bonus amortized over $4,800; see `bet_sizing_model.md`).

---

## 9. Background — why this even works (market structure)

Polymarket liquidity comes from professional/quant market makers and reward-farming
algos, **not** informed insiders. MMs profit from spread + Polymarket's liquidity-rewards
program (paid for resting orders near mid), **not** from knowing outcomes — an informed
trader is their enemy, not their peer. That's why you can extract value without any
outcome edge: you are exploiting a **bonus + price inconsistency**, exactly like an
arbitrageur, not making a directional bet. The BFA bonus (4.17% of stake amortized over
rollover) is the engine; the hedge just neutralizes outcome risk.

---

## 10. Caveats / open unknowns

- **Vig estimates assume 3%.** Real vig varies per market — always recompute from `C`.
- **Bonus-money loss deductibility** is treated optimistically; if disallowed, escape
  paths are slightly worse. Confirm how BFA credits a losing bonus bet.
- **Poly US tax form / exact characterization** (ordinary vs §1256) is not fully pinned;
  §1256 would blend to a lower rate (~better). Confirm what form Polymarket US issues.
- **BFA arbitrage detection:** crypto sportsbooks may void bonuses for obvious matched
  betting. Vary sizing/markets; don't place perfectly mirrored bets at identical times if
  avoidable.
- **`p` is approximated by implied prob.** EV shifts if the true probability differs; the
  hedge makes EV fairly insensitive to `p`, but the *number of cycles* (and thus vig and
  bomb risk) depends on it.
- **Not tax advice** — these are modeled estimates at a 22% bracket with no current
  capital gains. Recompute if the bracket or capital-gains situation changes.
```
