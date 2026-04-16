'use client';
import { useEffect, useState } from 'react';

type Stats = {
  generatedAt: number;
  scans: {
    total: number;
    last24h: number;
    last1h: number;
    lastScanAt: string | null;
    lastScanGamesChecked: number | null;
    lastScanArbsFound: number | null;
  };
  arbsFound: { total: number; last24h: number; last1h: number };
  attempts: {
    total: number;
    filledBoth: number;
    polyOnlyUnwound: number;
    polyOnlyStuck: number;
    falseArb: number;
    skipped: number;
  };
  pnl: { grossPnl: number; realizedPnl: number; unwindLoss: number };
  alarmsCount: number;
  recentScans: Array<{
    t: number; timestamp: string;
    durationMs?: number; gamesChecked?: number; arbsFound?: number; newArbs?: number; cooldownActive?: boolean;
  }>;
  recentFills: Array<{
    t: number; timestamp: string; type: string;
    marketSlug?: string; filledQty?: number; avgPx?: number;
    idTransaction?: string; amount?: number; price?: number;
  }>;
  recentFinals: Array<{
    t: number; timestamp: string; outcome: string; reason?: string;
    strategy?: string; sport?: string;
    guaranteedPnl?: number; unwindLoss?: number;
  }>;
};

type Health = {
  status: string;
  scanning: boolean;
  lastScanTime: string | null;
  cooldown?: { active: boolean; remainingMs: number; reason: string | null; triggeredAt: string | null };
};

function fmt$(n: number | undefined | null) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function timeAgo(iso: string | null | undefined) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export default function StatsPanel({ notifierUrl }: { notifierUrl: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, h] = await Promise.all([
          fetch(`${notifierUrl}/stats`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
          fetch(`${notifierUrl}/health`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : null),
        ]);
        if (!cancelled) { setStats(s); setHealth(h); setErr(null); }
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'fetch failed');
      }
    };
    load();
    const id = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [notifierUrl]);

  if (err && !stats) {
    return <div className="px-6 py-4 text-sm text-[#9ca3af]">Stats unavailable: {err}</div>;
  }
  if (!stats) {
    return <div className="px-6 py-4 text-sm text-[#9ca3af]">Loading stats…</div>;
  }

  const a = stats.attempts;
  const cdActive = health?.cooldown?.active;
  const cdMins = cdActive ? ((health?.cooldown?.remainingMs ?? 0) / 60000).toFixed(1) : null;
  const pnlColor = stats.pnl.realizedPnl >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]';

  return (
    <div className="px-6 pt-6 pb-2 space-y-4">
      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className={`px-2 py-1 rounded-full ${health?.scanning ? 'bg-[rgba(34,197,94,0.2)] text-[#22c55e]' : 'bg-[rgba(96,165,250,0.15)] text-[#60a5fa]'}`}>
          {health?.scanning ? '● Scanning…' : '● Idle'}
        </span>
        <span className="text-[#9ca3af]">Last scan: {timeAgo(stats.scans.lastScanAt)}</span>
        <span className="text-[#9ca3af]">Scans/24h: <span className="text-white font-mono">{stats.scans.last24h}</span></span>
        <span className="text-[#9ca3af]">Arbs/24h: <span className="text-white font-mono">{stats.arbsFound.last24h}</span></span>
        {cdActive && (
          <span className="px-2 py-1 rounded-full bg-[rgba(251,146,60,0.18)] text-[#fb923c]">
            BFA cooldown {cdMins}m
          </span>
        )}
        {stats.alarmsCount > 0 && (
          <span className="px-2 py-1 rounded-full bg-[rgba(239,68,68,0.18)] text-[#f87171]">
            {stats.alarmsCount} alarm{stats.alarmsCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile label="Bets Filled" value={a.filledBoth} sub={`${a.total} attempts`} />
        <Tile label="False Arbs" value={a.falseArb} sub="price moved before fill" />
        <Tile label="Unwound" value={a.polyOnlyUnwound} sub="BFA failed → poly sold" />
        <Tile label="Stuck Legs" value={a.polyOnlyStuck} danger={a.polyOnlyStuck > 0} sub="manual action needed" />
        <Tile label="Realized PnL" value={fmt$(stats.pnl.realizedPnl)} valueClass={pnlColor} sub={`gross ${fmt$(stats.pnl.grossPnl)}, unwind −${fmt$(stats.pnl.unwindLoss).replace('−', '')}`} />
        <Tile label="Arbs/hr" value={(stats.arbsFound.last1h).toFixed(0)} sub={`${stats.scans.last1h} scans/hr`} />
      </div>

      {/* Recent scans + recent finals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#111827] p-4">
          <div className="text-sm font-semibold text-[#e5e7eb] mb-2">Recent scans</div>
          {stats.recentScans.length === 0 ? (
            <p className="text-xs text-[#6b7280]">No scans recorded yet.</p>
          ) : (
            <ul className="space-y-1 text-xs font-mono">
              {stats.recentScans.slice(0, 10).map((s, i) => (
                <li key={i} className="flex items-center justify-between text-[#9ca3af]">
                  <span>{timeAgo(s.timestamp).padEnd(8)}</span>
                  <span>{s.gamesChecked ?? 0} games</span>
                  <span className={`${(s.arbsFound ?? 0) > 0 ? 'text-[#22c55e]' : 'text-[#6b7280]'}`}>
                    {s.arbsFound ?? 0} arbs
                  </span>
                  <span className="text-[#6b7280]">{Math.round((s.durationMs ?? 0) / 1000)}s</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#111827] p-4">
          <div className="text-sm font-semibold text-[#e5e7eb] mb-2">Recent attempts</div>
          {stats.recentFinals.length === 0 ? (
            <p className="text-xs text-[#6b7280]">No bet attempts yet.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {stats.recentFinals.slice(0, 10).map((f, i) => (
                <li key={i} className="flex items-center justify-between gap-3">
                  <span className="text-[#6b7280] font-mono shrink-0 w-16">{timeAgo(f.timestamp)}</span>
                  <span className="text-[#9ca3af] truncate flex-1">{f.strategy ?? '—'}</span>
                  <OutcomeBadge outcome={f.outcome} />
                  <span className={`font-mono shrink-0 ${
                    (f.guaranteedPnl ?? -(f.unwindLoss ?? 0)) >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]'
                  }`}>
                    {f.outcome === 'filled_both' ? `+${fmt$(f.guaranteedPnl).replace('$', '')}` :
                     f.outcome === 'poly_unwound' ? fmt$(-(f.unwindLoss ?? 0)) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, danger, valueClass }: { label: string; value: React.ReactNode; sub?: string; danger?: boolean; valueClass?: string }) {
  return (
    <div className={`rounded-lg border ${danger ? 'border-[rgba(239,68,68,0.4)] bg-[rgba(239,68,68,0.05)]' : 'border-[rgba(255,255,255,0.08)] bg-[#111827]'} p-3`}>
      <div className="text-[10px] uppercase tracking-wider text-[#6b7280]">{label}</div>
      <div className={`text-xl font-semibold ${valueClass ?? (danger ? 'text-[#f87171]' : 'text-[#e5e7eb]')}`}>{value}</div>
      {sub && <div className="text-[10px] text-[#6b7280] mt-0.5">{sub}</div>}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const style =
    outcome === 'filled_both' ? 'bg-[rgba(34,197,94,0.18)] text-[#22c55e]' :
    outcome === 'poly_unwound' ? 'bg-[rgba(251,146,60,0.18)] text-[#fb923c]' :
    outcome === 'poly_stuck' ? 'bg-[rgba(239,68,68,0.2)] text-[#f87171]' :
    outcome === 'false_arb' ? 'bg-[rgba(156,163,175,0.18)] text-[#9ca3af]' :
    'bg-[rgba(96,165,250,0.15)] text-[#60a5fa]';
  const label =
    outcome === 'filled_both' ? 'filled' :
    outcome === 'poly_unwound' ? 'unwound' :
    outcome === 'poly_stuck' ? 'stuck' :
    outcome === 'false_arb' ? 'false' :
    outcome;
  return <span className={`px-2 py-0.5 rounded text-[10px] font-semibold shrink-0 ${style}`}>{label}</span>;
}
