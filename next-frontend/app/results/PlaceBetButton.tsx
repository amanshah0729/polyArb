'use client';
import { useState } from 'react';

export type ArbPayload = {
  strategy?: string;
  sport?: string;
  awayTeam?: string;
  homeTeam?: string;
  bestCost?: number;
  profitPct?: number;
  guaranteedPnl?: number;
  netValue?: number;

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

function buildRequest(arb: ArbPayload) {
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
  return { bfa, poly, meta };
}

export default function PlaceBetButton({ arb, hasArb }: { arb: ArbPayload | null; hasArb: boolean }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  if (!hasArb || !arb) {
    return (
      <button
        disabled
        className="w-full mt-2 rounded-md bg-[rgba(255,255,255,0.04)] px-3 py-2 text-xs font-semibold text-[#4b5563] cursor-not-allowed"
      >
        No arb
      </button>
    );
  }

  const built = buildRequest(arb);
  if ('error' in built) {
    return (
      <button
        disabled
        className="w-full mt-2 rounded-md bg-[rgba(239,68,68,0.08)] px-3 py-2 text-xs font-semibold text-[#9ca3af] cursor-not-allowed"
        title={built.error}
      >
        Missing identifiers
      </button>
    );
  }

  const place = async () => {
    const costStr = (arb.bestCost ?? 0).toFixed(4);
    const pnlStr = (arb.guaranteedPnl ?? 0).toFixed(2);
    const confirm = window.confirm(
      `Place arb?\n\nStrategy: ${arb.strategy ?? '?'}\nCost: ${costStr}\nExpected P&L: $${pnlStr}\n\nSize is computed server-side by tier (cap 10% of balance).`
    );
    if (!confirm) return;

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
      if (outcome === 'filled_both') {
        detail = `P&L +$${(r?.guaranteedPnl ?? 0).toFixed?.(2) ?? '?'}`;
      } else if (outcome === 'poly_unwound') {
        detail = `unwind loss −$${Math.abs(r?.unwindLoss ?? 0).toFixed?.(2) ?? '?'}`;
      } else if (outcome === 'poly_stuck') {
        detail = `STUCK — manual action on ${arb.polyMarketSlug}`;
      } else if (outcome === 'false_arb') {
        detail = `reason: ${r?.reason ?? 'price_moved'}`;
      } else {
        detail = r?.reason ?? '';
      }
      setState({ kind: 'done', outcome, detail, ok: outcome === 'filled_both' });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'request failed';
      setState({ kind: 'error', message });
    }
  };

  if (state.kind === 'placing') {
    return (
      <button disabled className="w-full mt-2 rounded-md bg-[rgba(251,146,60,0.2)] px-3 py-2 text-xs font-semibold text-[#fb923c]">
        Placing…
      </button>
    );
  }
  if (state.kind === 'done') {
    const style = state.ok
      ? 'bg-[rgba(34,197,94,0.2)] text-[#22c55e]'
      : state.outcome === 'poly_unwound'
        ? 'bg-[rgba(251,146,60,0.2)] text-[#fb923c]'
        : 'bg-[rgba(239,68,68,0.2)] text-[#f87171]';
    return (
      <div className={`w-full mt-2 rounded-md px-3 py-2 text-xs font-semibold ${style}`}>
        {state.outcome} — {state.detail}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <button
        onClick={place}
        className="w-full mt-2 rounded-md bg-[rgba(239,68,68,0.15)] px-3 py-2 text-xs font-semibold text-[#f87171] hover:bg-[rgba(239,68,68,0.25)]"
        title={state.message}
      >
        Failed: {state.message} — retry
      </button>
    );
  }

  return (
    <button
      onClick={place}
      className="w-full mt-2 rounded-md bg-[#22c55e] px-3 py-2 text-xs font-semibold text-[#0f172a] hover:bg-[#16a34a] transition-colors"
    >
      Place Bet
    </button>
  );
}
