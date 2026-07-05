// Strategy cash P&L panel — both venues, pure cash, deliberately NO
// rollover/bonus credit. Poly rows are the markets this app traded (matched
// by order IDs from the event log); BFA rows come from BFA's own history API.

type PolyTrade = {
  time: string | null;
  intent: string;
  longPx: number;
  effectivePx: number;
  qty: number;
  fee: number;
  cash: number;
};

type PolyRow = {
  slug: string;
  title: string;
  outcome: string | null;
  trades: PolyTrade[];
  cash: number;
  fees: number;
  resolved: boolean;
  resolutionCash: number | null;
  firstTime: string | null;
  open: boolean;
};

type OpenPosition = {
  slug: string;
  title: string;
  outcome: string | null;
  netPosition: number;
  costBasis: number;
  mark: number;
};

type BfaBet = {
  id: number;
  description: string;
  placedDate?: string;
  settledDate?: string;
  risk: number | null;
  result?: string;
  amount?: number;
};

type PnlData = {
  generatedAt: string;
  poly: {
    balance: { current: number; buyingPower: number; marginHeld: number } | null;
    rows: PolyRow[];
    openPositions: OpenPosition[];
    settledNet: number;
    openCashSoFar: number;
    openMark: number;
    feeRebates: number;
  };
  bfa: {
    settled: BfaBet[];
    open: BfaBet[];
    settledNet: number;
    openRisk: number;
    balance: number | null;
    error: string | null;
  };
  combined: { settledNet: number; openPolyMark: number; openBfaRisk: number };
};

async function fetchPnl(): Promise<PnlData | null> {
  const url = process.env.NOTIFIER_URL?.trim();
  if (!url) return null;
  try {
    const res = await fetch(`${url}/pnl`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(45000), // BFA browser context is slow on cold cache
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function fmt(n: number | null | undefined, sign = false) {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = Math.abs(n).toFixed(2);
  if (n < 0) return `-$${s}`;
  return sign ? `+$${s}` : `$${s}`;
}

function pnlClass(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return 'text-[#9ca3af]';
  return n >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]';
}

function when(d?: string | null) {
  if (!d) return '—';
  const t = new Date(d);
  if (isNaN(t.getTime())) return '—';
  return t.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

function resultBadge(result?: string) {
  const r = (result || 'OPEN').toUpperCase();
  const cls = r === 'WIN'
    ? 'bg-[rgba(34,197,94,0.15)] text-[#22c55e]'
    : r === 'LOSE'
      ? 'bg-[rgba(239,68,68,0.12)] text-[#f87171]'
      : 'bg-[rgba(251,191,36,0.12)] text-[#fbbf24]';
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${cls}`}>{r}</span>;
}

export default async function PnlPanel() {
  const data = await fetchPnl();
  if (!data) return null;

  const { poly, bfa, combined } = data;
  const openExposure = combined.openPolyMark + combined.openBfaRisk;

  return (
    <div className="bg-[#0b1220] border-b border-[rgba(255,255,255,0.08)]">
      <details className="group" open>
        <summary className="px-8 py-4 flex items-center justify-between cursor-pointer list-none hover:bg-[rgba(255,255,255,0.02)]">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-semibold text-[#e5e7eb] uppercase tracking-wider">
              Strategy P&amp;L · cash only
            </h2>
            <span
              className="text-[#6b7280] text-[10px]"
              title="Excludes BFA rollover/bonus credit entirely. Poly rows = markets this app traded."
            >
              no bonus credit
            </span>
          </div>
          <div className="flex items-center gap-5 text-xs font-mono">
            <div>
              <span className="text-[#9ca3af] mr-1.5">Poly bal</span>
              <span className="text-[#e5e7eb]">{fmt(poly.balance?.current)}</span>
            </div>
            <div>
              <span className="text-[#9ca3af] mr-1.5">BFA bal</span>
              <span className="text-[#e5e7eb]">{fmt(bfa.balance)}</span>
            </div>
            <div title="Settled bets only: BFA net + Poly net (fees included).">
              <span className="text-[#9ca3af] mr-1.5">Settled P&amp;L</span>
              <span className={`font-semibold ${pnlClass(combined.settledNet)}`}>{fmt(combined.settledNet, true)}</span>
            </div>
            <div title={`Poly open marked at ${fmt(combined.openPolyMark)} + BFA open risk ${fmt(combined.openBfaRisk)}`}>
              <span className="text-[#9ca3af] mr-1.5">In play</span>
              <span className="text-[#fbbf24]">{fmt(openExposure)}</span>
            </div>
            <span className="text-[#6b7280] ml-1 group-open:rotate-180 transition-transform">▾</span>
          </div>
        </summary>

        <div className="grid grid-cols-1 lg:grid-cols-2 border-t border-[rgba(255,255,255,0.06)]">
          {/* BFA ledger */}
          <div className="border-r border-[rgba(255,255,255,0.06)]">
            <div className="px-4 py-2 flex items-center justify-between bg-[#0f172a]">
              <span className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider">BFA bets</span>
              <span className={`text-xs font-mono font-semibold ${pnlClass(bfa.settledNet)}`}>
                settled {fmt(bfa.settledNet, true)}
                {bfa.openRisk > 0 && <span className="text-[#fbbf24] font-normal"> · {fmt(bfa.openRisk)} open</span>}
              </span>
            </div>
            {bfa.error && bfa.settled.length === 0 && bfa.open.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[#f87171]">BFA history unavailable: {bfa.error}</div>
            ) : (
              <table className="w-full text-xs font-mono">
                {bfa.error && (
                  <caption className="px-4 py-1.5 text-left text-[11px] text-[#f87171] caption-top">
                    partial data — {bfa.error}
                  </caption>
                )}
                <tbody>
                  {[...bfa.open.map((w) => ({ ...w, _open: true })), ...bfa.settled.map((w) => ({ ...w, _open: false }))].map((w) => (
                    <tr key={w.id} className="border-t border-[rgba(255,255,255,0.04)]">
                      <td className="px-4 py-1.5 text-[#6b7280] whitespace-nowrap">{when(w.placedDate)}</td>
                      <td className="px-2 py-1.5 text-[#e5e7eb] max-w-[260px] truncate" title={w.description}>
                        {(w.description || '').replace(/\[\d+\]\s*/, '').replace(/\r/g, ' ')}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#9ca3af] whitespace-nowrap">{fmt(w.risk)}</td>
                      <td className="px-2 py-1.5 text-center">{resultBadge(w._open ? 'OPEN' : w.result)}</td>
                      <td className={`px-4 py-1.5 text-right font-semibold whitespace-nowrap ${w._open ? 'text-[#9ca3af]' : pnlClass(w.amount)}`}>
                        {w._open ? '—' : fmt(w.amount, true)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Poly ledger */}
          <div>
            <div className="px-4 py-2 flex items-center justify-between bg-[#0f172a]">
              <span className="text-[10px] font-semibold text-[#9ca3af] uppercase tracking-wider">Polymarket bets (via app)</span>
              <span className={`text-xs font-mono font-semibold ${pnlClass(poly.settledNet)}`}>
                settled {fmt(poly.settledNet, true)}
                {poly.feeRebates > 0 && (
                  <span className="text-[#6b7280] font-normal" title="Account-level taker-fee rebates — not attributed to individual bets, not included in settled P&L.">
                    {' '}· rebates {fmt(poly.feeRebates, true)}
                  </span>
                )}
              </span>
            </div>
            <table className="w-full text-xs font-mono">
              <tbody>
                {poly.rows.map((r) => {
                  const qty = r.trades.reduce((s, t) => s + (t.intent.startsWith('ORDER_INTENT_BUY') ? t.qty : 0), 0);
                  const avgEff = qty > 0
                    ? r.trades.filter((t) => t.intent.startsWith('ORDER_INTENT_BUY')).reduce((s, t) => s + t.effectivePx * t.qty, 0) / qty
                    : null;
                  const openPos = poly.openPositions.find((p) => p.slug === r.slug);
                  return (
                    <tr key={r.slug} className="border-t border-[rgba(255,255,255,0.04)]">
                      <td className="px-4 py-1.5 text-[#6b7280] whitespace-nowrap">{when(r.firstTime)}</td>
                      <td className="px-2 py-1.5 text-[#e5e7eb] max-w-[240px] truncate" title={r.slug}>
                        {r.title}
                        {r.outcome && <span className="text-[#a78bfa]"> · {r.outcome}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#9ca3af] whitespace-nowrap" title={`fees ${fmt(r.fees)}`}>
                        {qty > 0 ? `${qty.toFixed(0)}sh${avgEff != null ? ` @ ${avgEff.toFixed(2)}` : ''}` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {r.open
                          ? resultBadge('OPEN')
                          : resultBadge(r.cash >= 0 ? 'WIN' : 'LOSE')}
                      </td>
                      <td
                        className={`px-4 py-1.5 text-right font-semibold whitespace-nowrap ${r.open ? 'text-[#9ca3af]' : pnlClass(r.cash)}`}
                        title={r.open && openPos ? `cost so far ${fmt(r.cash)} · marked ${fmt(openPos.mark)}` : undefined}
                      >
                        {r.open ? `mark ${fmt(openPos?.mark)}` : fmt(r.cash, true)}
                      </td>
                    </tr>
                  );
                })}
                {poly.rows.length === 0 && (
                  <tr><td className="px-4 py-3 text-[#6b7280]" colSpan={5}>No app-placed Polymarket bets found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="px-8 py-2 border-t border-[rgba(255,255,255,0.06)] text-[10px] text-[#6b7280]">
          Cash accounting only — BFA rollover/bonus credit intentionally excluded. Poly &quot;WIN/LOSE&quot; is the
          net cash of that leg alone (a losing leg inside a profitable arb pair is normal). Settled P&amp;L =
          BFA settled net + Poly settled net, fees included. Refreshes at most once a minute.
        </div>
      </details>
    </div>
  );
}
