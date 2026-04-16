'use client';
import { useState, useMemo } from 'react';

export type ArbPayload = {
  strategy?: string;
  sport?: string;
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
  profitPct: number;
  guaranteedPnl: number;
  netValue: number;
};

function previewSize(arb: ArbPayload, scale: number): Preview {
  const cost = arb.bestCost ?? 1.5;
  const tier = tierForCost(cost);
  if (!tier) return { tier: null, bfaAmount: 0, polyNotional: 0, polyQty: 0, profitPct: 0, guaranteedPnl: 0, netValue: 0 };

  const bfaImplied = arb.bfaImplied ?? 0.5;
  const polyImplied = arb.polyImplied ?? 0.5;
  const polyPrice = (arb.polySide === 'away' ? arb.polyAwayPrice : arb.polyHomePrice) ?? polyImplied;

  const W = tier.bfaAmount * scale;
  // Equal-payout hedge: W/bfaImplied = P/polyImplied  →  P = W × polyImplied/bfaImplied
  const P = W * (polyImplied / (bfaImplied || 1));
  const polyQty = polyPrice > 0 ? P / polyPrice : 0;

  // Profit pct is a property of the cost, not of the size
  const profitPct = cost > 0 ? (1 / cost - 1) * 100 : 0;

  // Guaranteed P&L = worst-case of the two outcomes (excluding BFA bonus)
  const pnlIfBfaWins  = (W / (bfaImplied || 1)) - W - P;
  const pnlIfPolyWins = (P / (polyImplied || 1)) - W - P;
  const guaranteedPnl = Math.min(pnlIfBfaWins, pnlIfPolyWins);

  // Net value = scan-time netValue (which includes BFA bonus rollover) scaled linearly by W ratio
  const origW = arb.bfaBet ?? 0;
  const origNet = arb.netValue ?? 0;
  const netValue = origW > 0 ? origNet * (W / origW) : guaranteedPnl;

  return { tier: tier.label, bfaAmount: W, polyNotional: P, polyQty, profitPct, guaranteedPnl, netValue };
}

function buildRequest(arb: ArbPayload, scale: number) {
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
    expectedPrice: polyAway ? arb.polyAwayPrice : arb.polyHomePrice,
  };
  const meta = {
    strategy: arb.strategy,
    sport: arb.sport,
    awayTeam: arb.awayTeam,
    homeTeam: arb.homeTeam,
    bestCost: arb.bestCost,
    profitPct: arb.profitPct,
    guaranteedPnl: arb.guaranteedPnl,
    bfaImplied: arb.bfaImplied,
    polyImplied: arb.polyImplied,
  };
  return { bfa, poly, meta, scaleFactor: scale };
}

export default function PlaceBetButton({ arb, hasArb }: { arb: ArbPayload | null; hasArb: boolean }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [scale, setScale] = useState(1.0);

  const preview: Preview | null = useMemo(() => (arb ? previewSize(arb, scale) : null), [arb, scale]);

  if (!arb) {
    return (
      <div className="mt-1 text-xs text-[#6b7280] italic">
        Execute button unavailable (local CSV — set <code>NOTIFIER_URL</code> in <code>.env.local</code>)
      </div>
    );
  }

  const built = buildRequest(arb, scale);
  const tierMissing = !preview?.tier;

  const place = async () => {
    if (tierMissing || 'error' in built) return;
    const cost = arb.bestCost ?? 0;
    const warning = !hasArb ? '\n\n⚠ THIS IS NOT AN ARB.' : '';
    const ok = window.confirm(
      `Place bet?\n\n` +
      `${arb.strategy ?? '?'}\n` +
      `Cost ${cost.toFixed(4)} · Scale ${scale.toFixed(2)}×\n` +
      `BFA $${preview!.bfaAmount.toFixed(2)}\n` +
      `Poly ${preview!.polyQty.toFixed(2)} shares (~$${preview!.polyNotional.toFixed(2)})\n` +
      `P&L $${preview!.guaranteedPnl.toFixed(2)}${warning}`
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
      else detail = r?.reason ?? '';
      setState({ kind: 'done', outcome, detail, ok: outcome === 'filled_both' });
    } catch (e: unknown) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'request failed' });
    }
  };

  // ── Stats row (live) ──
  const pnlColor = (preview?.guaranteedPnl ?? 0) >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]';
  const netColor = (preview?.netValue ?? 0) >= 0
    ? 'bg-[rgba(34,197,94,0.15)] text-[#22c55e]'
    : 'bg-[rgba(239,68,68,0.12)] text-[#f87171]';

  const statsRow = (
    <div className="flex items-center justify-between px-4 py-3 border-t border-[rgba(255,255,255,0.06)] text-xs">
      <div className="flex items-center gap-3">
        <span className={`font-mono ${hasArb ? 'text-[#22c55e] font-semibold' : 'text-[#9ca3af]'}`}>
          {preview ? preview.profitPct.toFixed(2) : '0.00'}%
        </span>
        <span className="text-[#9ca3af]">
          BFA <span className="font-mono text-[#e5e7eb]">${preview?.bfaAmount.toFixed(2) ?? '—'}</span>
        </span>
        <span className="text-[#9ca3af]">
          Poly <span className="font-mono text-[#a78bfa]">${preview?.polyNotional.toFixed(2) ?? '—'}</span>
        </span>
      </div>
      <div className="flex items-center gap-3">
        {preview && (
          <span className={`font-mono ${pnlColor}`}>
            P&L {preview.guaranteedPnl >= 0 ? '+' : ''}${preview.guaranteedPnl.toFixed(2)}
          </span>
        )}
        {preview && (
          <span className={`font-mono font-semibold px-2 py-0.5 rounded-full ${netColor}`}>
            {preview.netValue >= 0 ? '+' : ''}${preview.netValue.toFixed(2)}
          </span>
        )}
      </div>
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
    const btnStyle = tierMissing
      ? 'bg-[rgba(255,255,255,0.04)] text-[#4b5563] cursor-not-allowed'
      : hasArb
        ? 'bg-[#22c55e] text-[#0f172a] hover:bg-[#16a34a]'
        : 'bg-[rgba(96,165,250,0.18)] text-[#60a5fa] hover:bg-[rgba(96,165,250,0.28)] border border-[rgba(96,165,250,0.4)]';
    actionBlock = (
      <button
        onClick={place}
        disabled={tierMissing || 'error' in built}
        className={`w-full rounded-md px-3 py-2 text-xs font-semibold transition-colors ${btnStyle}`}
      >
        {tierMissing
          ? 'Out of tier (cost > 1.010)'
          : 'error' in built
            ? 'Missing identifiers'
            : hasArb ? 'Place Bet' : 'Place Bet (no arb)'}
      </button>
    );
  }

  return (
    <>
      <div className="px-4 pb-2 space-y-1.5">
        <div className="flex items-center gap-2 text-[10px] text-[#9ca3af]">
          <span className="font-mono w-10 text-right">{scale.toFixed(2)}×</span>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.05}
            value={scale}
            onChange={(e) => setScale(parseFloat(e.target.value))}
            disabled={tierMissing}
            className="flex-1 accent-[#22c55e]"
          />
          <span className="text-[10px] shrink-0 text-[#6b7280] font-mono">
            {preview?.tier ?? 'out'}
          </span>
        </div>
        {actionBlock}
      </div>
      {statsRow}
    </>
  );
}
