'use client';
import { useState, useMemo, useEffect } from 'react';

export type ArbPayload = {
  strategy?: string;
  sport?: string;
  date?: string;
  marketType?: string;
  line?: string | number;
  awayTeam?: string;
  homeTeam?: string;
  bestCost?: number;
  profitPct?: number;
  guaranteedPnl?: number;
  netValue?: number;
  bfaBet?: number;

  bfaSide?: 'away' | 'home';
  polySide?: 'away' | 'home';

  bfaEventId?: number;
  bfaFixtureId?: number;
  bfaMarketTypeInt?: number;
  bfaPeriodNumber?: number;
  bfaAwaySide?: number;
  bfaHomeSide?: number;
  bfaAwayContestantId?: number;
  bfaHomeContestantId?: number;
  bfaAwayIndex?: number;
  bfaHomeIndex?: number;
  bfaAwayLine?: number;
  bfaHomeLine?: number;
  bfaAwayPrice?: number;
  bfaHomePrice?: number;

  polyMarketSlug?: string;
  polyAwayPrice?: number;
  polyHomePrice?: number;
  polyAwayIntent?: string;
  polyHomeIntent?: string;
  bfaImplied?: number;
  polyImplied?: number;
  isSeries?: boolean;
  truePositive?: boolean;
  truePnlAfterFees?: number | null;
};

type State =
  | { kind: 'idle' }
  | { kind: 'placing' }
  | { kind: 'done'; outcome: string; detail: string; ok: boolean }
  | { kind: 'error'; message: string };

// Mirror of server-side tier logic in services/betSizing.js. Keep in sync.
function tierForCost(cost: number): { bfaAmount: number; label: string } | null {
  if (cost <= 0.995) return { bfaAmount: 50, label: 'deep-arb' };
  if (cost <= 1.000) return { bfaAmount: 30, label: 'true-arb' };
  if (cost <= 1.005) return { bfaAmount: 10, label: 'near-arb' };
  if (cost <= 1.010) return { bfaAmount: 5,  label: 'edge' };
  return null;
}

type Preview = {
  tier: string | null;
  bfaAmount: number;
  polyNotional: number;
  polyQty: number;
  polyPrice: number;
  profitPct: number;
  guaranteedPnl: number;
  depthClamped: boolean;
};

// Polymarket US fee model (per share, at price p):
//   taker fee  = max($0.01, 0.05 × p × (1 − p))
//   maker rebate = 0.0125 × p × (1 − p)   (no floor)
function takerFeePerShare(p: number) { return Math.max(0.01, 0.05 * p * (1 - p)); }
function makerRebatePerShare(p: number) { return 0.0125 * p * (1 - p); }

// BFA promo: the whole $300 balance (deposit + bonus) is locked until $4800 of
// qualifying wagers. Marginal rollover credit λ = 300/4800 = 6.25¢ per $1 of BFA
// stake. Bets at −200 or shorter odds (implied ≥ 2/3) do NOT count toward the
// rollover and earn zero credit. Mirrors services/polyBook.js constants.
const BFA_LOCKED = 300;
const BFA_ROLLOVER_REMAINING = 4800;
const LAMBDA = BFA_LOCKED / BFA_ROLLOVER_REMAINING;
const QUALIFY_MAX_IMPLIED = 2 / 3;
function rolloverQualifies(bfaImplied: number) { return bfaImplied < QUALIFY_MAX_IMPLIED - 1e-9; }

type DepthInfo = {
  maxShares: number;
  maxBfaStake: number;
  vwapAtMax: number | null;
  expectedPnl: number;
  lastAcceptedPx: number | null;
  levelsAccepted: number;
  qualifies?: boolean;
  bonusCredit?: number;
  evAtMax?: number;
  venue?: string | null;       // 'pmus' = real tradeable book; 'clob' = old Polymarket fallback (indicative only)
  resolvedSlug?: string | null;
  topPrice?: number | null;    // live top-of-book per-share price in intent coords
} | null;

function previewSize(arb: ArbPayload, scale: number, depth: DepthInfo): Preview {
  const cost = arb.bestCost ?? 1.5;
  const tier = tierForCost(cost);
  const tierBase = tier?.bfaAmount ?? arb.bfaBet ?? 10;
  const tierLabel = tier?.label ?? 'manual';

  const bfaImplied = arb.bfaImplied ?? 0.5;
  const polyImplied = arb.polyImplied ?? 0.5;
  // Prefer the live PM.US top-of-book over the scan-time quote (scan prices
  // come from the old CLOB and can sit a venue apart from what actually fills).
  const livePolyPrice = depth?.venue === 'pmus' && depth.topPrice != null && depth.topPrice > 0 ? depth.topPrice : null;
  const polyPrice = livePolyPrice ?? (arb.polySide === 'away' ? arb.polyAwayPrice : arb.polyHomePrice) ?? polyImplied;

  let W = tierBase * scale;
  // Equal-payout hedge: W/bfaImplied = P/polyImplied  →  P = W × polyImplied/bfaImplied
  let P = W * (polyImplied / (bfaImplied || 1));
  let polyQty = polyPrice > 0 ? P / polyPrice : 0;

  let depthClamped = false;
  if (depth && Number.isFinite(depth.maxShares) && depth.maxShares > 0 && polyQty > depth.maxShares + 1e-6) {
    polyQty = depth.maxShares;
    P = polyQty * polyPrice;
    // Keep the equal-payout hedge ratio (BFA leg shrinks proportionally).
    W = polyQty * bfaImplied;
    depthClamped = true;
  }

  // Profit pct is a property of the cost, not of the size
  const profitPct = cost > 0 ? (1 / cost - 1) * 100 : 0;

  // Guaranteed P&L = worst-case of the two outcomes (excluding fees and BFA bonus)
  const pnlIfBfaWins  = (W / (bfaImplied || 1)) - W - P;
  const pnlIfPolyWins = (P / (polyImplied || 1)) - W - P;
  const guaranteedPnl = Math.min(pnlIfBfaWins, pnlIfPolyWins);

  return { tier: tierLabel, bfaAmount: W, polyNotional: P, polyQty, polyPrice, profitPct, guaranteedPnl, depthClamped };
}

function buildRequest(arb: ArbPayload, scale: number, livePolyPrice: number | null = null) {
  if (!arb.bfaSide || !arb.polySide) return { error: 'missing sides' };
  if (!arb.polyMarketSlug) return { error: 'missing poly slug' };
  if (arb.bfaEventId == null || arb.bfaFixtureId == null || arb.bfaMarketTypeInt == null) {
    return { error: 'missing bfa identifiers' };
  }

  const bfaAway = arb.bfaSide === 'away';
  const polyAway = arb.polySide === 'away';

  const bfa = {
    eventId: arb.bfaEventId,
    fixtureId: arb.bfaFixtureId,
    marketType: arb.bfaMarketTypeInt,
    periodNumber: arb.bfaPeriodNumber ?? 0,
    side: bfaAway ? arb.bfaAwaySide : arb.bfaHomeSide,
    contestantId: bfaAway ? arb.bfaAwayContestantId : arb.bfaHomeContestantId,
    index: bfaAway ? arb.bfaAwayIndex : arb.bfaHomeIndex,
    line: bfaAway ? arb.bfaAwayLine : arb.bfaHomeLine,
    price: bfaAway ? arb.bfaAwayPrice : arb.bfaHomePrice,
    isLive: false,
  };
  const poly = {
    marketSlug: arb.polyMarketSlug,
    intent: polyAway ? arb.polyAwayIntent : arb.polyHomeIntent,
    // Live PM.US top-of-book beats the scan-time quote — the executor's drift
    // guard compares against a fresh PM.US BBO, so a stale/wrong-venue price
    // here systematically trips "poly_price_moved".
    expectedPrice: livePolyPrice ?? (polyAway ? arb.polyAwayPrice : arb.polyHomePrice),
  };
  const meta = {
    strategy: arb.strategy,
    sport: arb.sport,
    date: arb.date,
    marketType: arb.marketType,
    line: arb.line,
    awayTeam: arb.awayTeam,
    homeTeam: arb.homeTeam,
    polySide: arb.polySide,
    polyTeam: polyAway ? arb.awayTeam : arb.homeTeam,
    bestCost: arb.bestCost,
    profitPct: arb.profitPct,
    guaranteedPnl: arb.guaranteedPnl,
    bfaImplied: arb.bfaImplied,
    polyImplied: arb.polyImplied,
    isSeries: !!arb.isSeries,
  };
  return { bfa, poly, meta, scaleFactor: scale };
}

export default function PlaceBetButton({ arb, hasArb }: { arb: ArbPayload | null; hasArb: boolean }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [scale, setScale] = useState(1.0);
  const [depth, setDepth] = useState<DepthInfo>(null);
  const [depthLoading, setDepthLoading] = useState(false);
  const [makerMode, setMakerMode] = useState(false);

  // Fetch Poly book + max-profitable-size whenever the arb (or its poly leg) changes.
  const depthKey = arb ? `${arb.polyMarketSlug ?? ''}|${arb.polySide ?? ''}|${arb.bfaImplied ?? ''}` : '';
  useEffect(() => {
    let cancelled = false;
    if (!arb?.polyMarketSlug || !arb.polySide || arb.bfaImplied == null) { setDepth(null); return; }
    const intent = arb.polySide === 'away' ? arb.polyAwayIntent : arb.polyHomeIntent;
    if (!intent) { setDepth(null); return; }
    setDepthLoading(true);
    const qs = new URLSearchParams({
      slug: arb.polyMarketSlug, intent, bfaImplied: String(arb.bfaImplied),
      feeMode: makerMode ? 'maker' : 'taker',
      lambda: String(LAMBDA),
    });
    // Name context lets the server resolve the real PM.US market (Predexon
    // slugs often differ) instead of falling back to the old CLOB book.
    if (arb.awayTeam) qs.set('awayTeam', arb.awayTeam);
    if (arb.homeTeam) qs.set('homeTeam', arb.homeTeam);
    if (arb.sport) qs.set('sport', arb.sport);
    if (arb.date) qs.set('date', arb.date);
    if (arb.marketType) qs.set('marketType', arb.marketType);
    if (arb.line != null && arb.line !== '') qs.set('line', String(arb.line));
    if (arb.isSeries) qs.set('isSeries', '1');
    const polyTeam = arb.polySide === 'away' ? arb.awayTeam : arb.homeTeam;
    if (polyTeam) qs.set('polyTeam', polyTeam);
    fetch(`/api/poly-depth?${qs.toString()}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (cancelled) return;
        if (data && data.max && Number.isFinite(data.max.maxShares)) {
          setDepth({
            ...(data.max as NonNullable<DepthInfo>),
            venue: data.venue ?? null,
            resolvedSlug: data.resolvedSlug ?? null,
            topPrice: typeof data.topPrice === 'number' ? data.topPrice : null,
          });
        } else setDepth(null);
      })
      .catch(() => { if (!cancelled) setDepth(null); })
      .finally(() => { if (!cancelled) setDepthLoading(false); });
    return () => { cancelled = true; };
  }, [depthKey, arb, makerMode]);

  const preview: Preview | null = useMemo(() => (arb ? previewSize(arb, scale, depth) : null), [arb, scale, depth]);

  const minScale = 0.1;

  if (!arb) {
    return (
      <div className="mt-1 text-xs text-[#6b7280] italic">
        Execute button unavailable (local CSV — set <code>NOTIFIER_URL</code> in <code>.env.local</code>)
      </div>
    );
  }

  const livePolyPrice = depth?.venue === 'pmus' && depth.topPrice != null && depth.topPrice > 0 ? depth.topPrice : null;
  const builtBase = buildRequest(arb, scale, livePolyPrice);
  const built = 'error' in builtBase ? builtBase : { ...builtBase, execMode: makerMode ? 'maker' : 'ioc' };

  // ── P&L chain: dry → after fees → EV (fees + rollover credit) ──
  const feeP = preview?.polyPrice ?? 0;
  const feeQty = preview?.polyQty ?? 0;
  const takerFee = takerFeePerShare(feeP) * feeQty;
  const makerRebate = makerRebatePerShare(feeP) * feeQty;
  const activeFee = makerMode ? -makerRebate : takerFee; // maker = credit (negative cost)
  const dryPnl = preview?.guaranteedPnl ?? 0;
  const pnlAfterFees = dryPnl - activeFee;
  const bfaImp = arb.bfaImplied ?? 0.5;
  const qualifies = rolloverQualifies(bfaImp);
  const bonusCredit = qualifies ? (preview?.bfaAmount ?? 0) * LAMBDA : 0;
  const evTotal = pnlAfterFees + bonusCredit;
  // Score per $1 of payout at top-of-book price: (1 − C_eff) + λ·b·𝟙(qualifies).
  // Size-independent — the apples-to-apples number for comparing opportunities.
  const feePerShareNow = feeP > 0
    ? (makerMode ? -makerRebatePerShare(feeP) : takerFeePerShare(feeP))
    : 0;
  const score = feeP > 0
    ? (1 - (bfaImp + feeP + feePerShareNow)) + (qualifies ? LAMBDA * bfaImp : 0)
    : null;

  const place = async () => {
    if ('error' in built) return;
    const cost = arb.bestCost ?? 0;
    const warning = !hasArb ? '\n\n⚠ THIS IS NOT AN ARB.' : '';
    const ok = window.confirm(
      `Place bet?\n\n` +
      `${arb.strategy ?? '?'}\n` +
      `Cost ${cost.toFixed(4)} · Scale ${scale.toFixed(2)}×\n` +
      `BFA $${preview!.bfaAmount.toFixed(2)}\n` +
      `Poly ${preview!.polyQty.toFixed(2)} shares (~$${preview!.polyNotional.toFixed(2)})\n` +
      `P&L dry $${dryPnl.toFixed(2)} · after ${makerMode ? 'rebate' : 'fees'} $${pnlAfterFees.toFixed(2)} · EV $${evTotal.toFixed(2)}${qualifies ? '' : '\n(no rollover credit — BFA odds −200 or shorter)'}${warning}`
    );
    if (!ok) return;

    setState({ kind: 'placing' });
    try {
      const res = await fetch('/api/place-arb', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(built),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ kind: 'error', message: data?.error ?? `HTTP ${res.status}` });
        return;
      }
      const r = data?.result;
      const outcome = r?.outcome ?? 'unknown';
      let detail = '';
      if (outcome === 'filled_both') detail = `P&L +$${(r?.guaranteedPnl ?? 0).toFixed?.(2) ?? '?'}`;
      else if (outcome === 'poly_unwound') detail = `unwind loss −$${Math.abs(r?.unwindLoss ?? 0).toFixed?.(2) ?? '?'}`;
      else if (outcome === 'poly_stuck') detail = `STUCK — manual action on ${arb.polyMarketSlug}`;
      else if (outcome === 'false_arb') detail = `reason: ${r?.reason ?? 'price_moved'}`;
      else if (outcome === 'unsupported') detail = r?.hint ?? r?.reason ?? 'SDK can\'t trade this market';
      else detail = r?.reason ?? '';
      setState({ kind: 'done', outcome, detail, ok: outcome === 'filled_both' });
    } catch (e: unknown) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'request failed' });
    }
  };

  // ── Stats row (live) ──
  const signColor = (v: number) => (v >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]');
  const pillColor = (v: number) =>
    v >= 0
      ? 'bg-[rgba(34,197,94,0.15)] text-[#22c55e]'
      : 'bg-[rgba(239,68,68,0.12)] text-[#f87171]';
  const fmtPnl = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;

  const statsRow = (
    <div className="flex items-center justify-between px-4 py-3 border-t border-[rgba(255,255,255,0.06)] text-xs">
      <div className="flex items-center gap-3">
        <span
          className={`font-mono font-semibold ${score != null && score > 0 ? 'text-[#22c55e]' : 'text-[#9ca3af]'}`}
          title="Score: EV per $100 of payout = 100 × [(1 − cost after fees) + λ·b if rollover-qualifying]. Size-independent — compare opportunities with this."
        >
          {score != null ? `EV/$100 ${fmtPnl(score * 100)}` : '—'}
        </span>
        <span className="text-[#9ca3af]">
          BFA <span className="font-mono text-[#e5e7eb]">${preview?.bfaAmount.toFixed(2) ?? '—'}</span>
        </span>
        <span className="text-[#9ca3af]">
          Poly <span className="font-mono text-[#a78bfa]">${preview?.polyNotional.toFixed(2) ?? '—'}</span>
        </span>
      </div>
      {preview && (
        <div className="flex items-center gap-1.5 font-mono">
          <span
            className={signColor(dryPnl)}
            title="Dry P&L — worst-case outcome, before Polymarket fees and rollover credit."
          >
            dry {fmtPnl(dryPnl)}
          </span>
          <span className="text-[#4b5563]">›</span>
          <span
            className={signColor(pnlAfterFees)}
            title={makerMode
              ? 'P&L including Polymarket maker rebate (0.0125 × p × (1−p) per share).'
              : 'P&L after Polymarket taker fees (max($0.01, 0.05 × p × (1−p)) per share).'}
          >
            {makerMode ? 'rebate' : 'fees'} {fmtPnl(pnlAfterFees)}
          </span>
          <span className="text-[#4b5563]">›</span>
          <span
            className={`font-semibold px-2 py-0.5 rounded-full ${pillColor(evTotal)}`}
            title={qualifies
              ? `EV = P&L after fees + rollover credit (BFA stake × ${(LAMBDA * 100).toFixed(2)}% = $${BFA_LOCKED} locked / $${BFA_ROLLOVER_REMAINING} remaining rollover).`
              : 'EV = P&L after fees. No rollover credit: BFA odds are −200 or shorter, so this bet does not count toward the wagering requirement.'}
          >
            EV {fmtPnl(evTotal)}
          </span>
        </div>
      )}
    </div>
  );

  // ── Slider + Button ──
  let actionBlock: React.ReactNode;
  if (state.kind === 'placing') {
    actionBlock = (
      <button disabled className="w-full rounded-md bg-[rgba(251,146,60,0.2)] px-3 py-2 text-xs font-semibold text-[#fb923c]">
        Placing…
      </button>
    );
  } else if (state.kind === 'done') {
    const badgeStyle = state.ok
      ? 'bg-[rgba(34,197,94,0.2)] text-[#22c55e]'
      : state.outcome === 'poly_unwound'
        ? 'bg-[rgba(251,146,60,0.2)] text-[#fb923c]'
        : 'bg-[rgba(239,68,68,0.2)] text-[#f87171]';
    actionBlock = (
      <div className={`w-full rounded-md px-3 py-2 text-xs font-semibold ${badgeStyle}`}>
        {state.outcome} — {state.detail}
      </div>
    );
  } else if (state.kind === 'error') {
    actionBlock = (
      <button
        onClick={place}
        className="w-full rounded-md bg-[rgba(239,68,68,0.15)] px-3 py-2 text-xs font-semibold text-[#f87171] hover:bg-[rgba(239,68,68,0.25)]"
        title={state.message}
      >
        Failed: {state.message} — retry
      </button>
    );
  } else {
    const btnStyle = hasArb
      ? 'bg-[#22c55e] text-[#0f172a] hover:bg-[#16a34a]'
      : 'bg-[rgba(96,165,250,0.18)] text-[#60a5fa] hover:bg-[rgba(96,165,250,0.28)] border border-[rgba(96,165,250,0.4)]';
    actionBlock = (
      <button
        onClick={place}
        disabled={'error' in built}
        className={`w-full rounded-md px-3 py-2 text-xs font-semibold transition-colors ${btnStyle}`}
      >
        {'error' in built
          ? 'Missing identifiers'
          : hasArb ? 'Place Bet' : 'Place Bet (no arb)'}
      </button>
    );
  }

  // Solve for the slider scale that would exactly produce `depth.maxShares`
  // (given current tier base and poly/bfa implieds).
  const autoMaxScale: number | null = (() => {
    if (!depth || !arb) return null;
    const tierBase = tierForCost(arb.bestCost ?? 1.5)?.bfaAmount ?? 0;
    if (tierBase <= 0) return null;
    const bfaImplied = arb.bfaImplied ?? 0.5;
    const polyImplied = arb.polyImplied ?? 0.5;
    const polyPrice = livePolyPrice ?? (arb.polySide === 'away' ? arb.polyAwayPrice : arb.polyHomePrice) ?? polyImplied;
    if (polyPrice <= 0 || bfaImplied <= 0) return null;
    // polyQty(scale) = tierBase * scale * (polyImplied / bfaImplied) / polyPrice  (pre-clamp)
    // Solve for scale where polyQty == maxShares:
    const raw = (depth.maxShares * polyPrice * bfaImplied) / (tierBase * polyImplied);
    return Math.max(minScale, Math.min(3, raw));
  })();
  const autoMaxCapped = autoMaxScale != null && depth && arb
    ? (() => {
        const tierBase = tierForCost(arb.bestCost ?? 1.5)?.bfaAmount ?? 0;
        const bfaImplied = arb.bfaImplied ?? 0.5;
        const polyImplied = arb.polyImplied ?? 0.5;
        const polyPrice = livePolyPrice ?? (arb.polySide === 'away' ? arb.polyAwayPrice : arb.polyHomePrice) ?? polyImplied;
        const rawNeeded = (depth.maxShares * polyPrice * bfaImplied) / (tierBase * polyImplied);
        return rawNeeded > 3 + 1e-9; // tier ceiling hit before reaching maxShares
      })()
    : false;

  const feeRow = preview && preview.polyPrice > 0 && preview.polyQty > 0 ? (
    <div className="px-4 pb-1.5 flex items-center justify-between text-[10px] font-mono">
      <span className="text-[#9ca3af]">
        Taker fee: <span className="text-[#f87171]">−${takerFee.toFixed(2)}</span>
        <span className="text-[#6b7280]"> · Maker rebate: </span>
        <span className="text-[#22c55e]">+${makerRebate.toFixed(2)}</span>
      </span>
      {qualifies ? (
        <span
          className="text-[#9ca3af]"
          title={`Rollover credit: BFA stake × λ, where λ = $${BFA_LOCKED} locked / $${BFA_ROLLOVER_REMAINING} remaining qualifying rollover = ${(LAMBDA * 100).toFixed(2)}¢ per $1 staked.`}
        >
          Rollover credit: <span className="text-[#22c55e]">+${bonusCredit.toFixed(2)}</span>
          <span className="text-[#6b7280]"> (stake × {(LAMBDA * 100).toFixed(2)}%)</span>
        </span>
      ) : (
        <span
          className="text-[#fbbf24]"
          title="BFA odds are −200 or shorter (implied ≥ 66.7%) — this bet does not count toward the $4800 wagering requirement, so it earns no rollover credit. Only worth taking as a pure cash arb."
        >
          no rollover credit (−200 or shorter)
        </span>
      )}
    </div>
  ) : null;

  const depthRow = depth ? (
    <div className="px-4 pb-1.5 flex items-center justify-between text-[10px] text-[#9ca3af] font-mono">
      <span title="Largest size where the marginal share still has positive score: cost after fees < 1 + rollover credit. Bigger than this is −EV; smaller leaves EV on the table.">
        Ideal size: <span className="text-[#e5e7eb]">{depth.maxShares.toFixed(0)} sh</span>
        {depth.vwapAtMax != null && <span className="text-[#6b7280]"> @ ${depth.vwapAtMax.toFixed(3)}</span>}
        <span className="text-[#6b7280]"> · BFA ≤ ${depth.maxBfaStake.toFixed(2)}</span>
        {typeof depth.evAtMax === 'number' && (
          <span title="Total EV at ideal size: worst-case cash P&L after fees + rollover credit.">
            <span className="text-[#6b7280]"> · EV </span>
            <span className={depth.evAtMax >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}>
              {fmtPnl(depth.evAtMax)}
            </span>
          </span>
        )}
        {depth.venue === 'clob' && (
          <span
            className="ml-1.5 px-1.5 py-0.5 rounded bg-[rgba(251,191,36,0.15)] text-[#fbbf24]"
            title="This book came from the old Polymarket CLOB fallback (PM.US market didn't resolve) — prices are indicative only and NOT what your order will fill against."
          >
            ⚠ CLOB fallback
          </span>
        )}
      </span>
      {autoMaxScale != null && (
        <button
          onClick={() => autoMaxScale != null && setScale(autoMaxScale)}
          className="px-2 py-0.5 rounded bg-[rgba(96,165,250,0.15)] text-[#60a5fa] hover:bg-[rgba(96,165,250,0.25)]"
          title={autoMaxCapped ? 'Capped by 3× tier ceiling (book is deeper than slider allows)' : 'Snap slider to ideal size'}
        >
          Size to ideal{autoMaxCapped ? ' (capped)' : ''}
        </button>
      )}
    </div>
  ) : depthLoading ? (
    <div className="px-4 pb-1.5 text-[10px] text-[#6b7280] font-mono">checking book depth…</div>
  ) : null;

  return (
    <>
      <div className="px-4 pb-2 space-y-1.5">
        <div className="flex items-center gap-2 text-[10px] text-[#9ca3af]">
          <span className="font-mono w-10 text-right">{scale.toFixed(2)}×</span>
          <input
            type="range"
            min={minScale}
            max={3}
            step={0.05}
            value={Math.max(scale, minScale)}
            onChange={(e) => setScale(parseFloat(e.target.value))}
            className="flex-1 accent-[#22c55e]"
          />
          <span className="text-[10px] shrink-0 text-[#6b7280] font-mono">
            {preview?.depthClamped ? 'clamped' : (preview?.tier ?? 'out')}
          </span>
          {arb?.isSeries && (
            <span
              className="text-[10px] shrink-0 font-mono px-1.5 py-0.5 rounded bg-[rgba(168,85,247,0.15)] text-[#a855f7] border border-[rgba(168,85,247,0.35)]"
              title="Series-winner market — resolver matches series-only candidates on Polymarket.US."
            >
              SERIES
            </span>
          )}
        </div>
        <div className="flex items-center justify-between text-[10px] text-[#9ca3af]">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={makerMode}
              onChange={(e) => setMakerMode(e.target.checked)}
              className="accent-[#a78bfa]"
            />
            <span className={makerMode ? 'text-[#a78bfa]' : 'text-[#6b7280]'}>
              Maker mode {makerMode ? '(rebate, rests on book)' : '(taker IOC)'}
            </span>
          </label>
        </div>
        {actionBlock}
      </div>
      {depthRow}
      {feeRow}
      {statsRow}
    </>
  );
}
