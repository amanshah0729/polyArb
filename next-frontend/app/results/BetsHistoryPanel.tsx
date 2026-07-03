type Row = {
  attemptId: string;
  timestamp: string;
  sport?: string;
  date?: string;
  awayTeam?: string;
  homeTeam?: string;
  marketType?: string;
  bfa: { stake: number; americanOdds: number; impliedProb: number | null };
  poly: {
    qty: number;
    avgPx: number;
    notional: number;
    fees: number;
    feePerShare: number;
    allInCost: number;
    effectivePrice: number | null;
    execMode: 'taker' | 'maker';
  };
  scanGuaranteedPnl: number | null;
  rawPnl: number;
  bonusCredit: number;
  pnlWithBonus: number;
  outcomeIfBfaWins: number | null;
  outcomeIfPolyWins: number;
};

type Totals = {
  bets: number;
  bfaStake: number;
  polyNotional: number;
  polyFees: number;
  polyAllInCost: number;
  rawPnl: number;
  bonusCredit: number;
  pnlWithBonus: number;
};

async function fetchHistory(): Promise<{ rows: Row[]; totals: Totals } | null> {
  const url = process.env.NOTIFIER_URL?.trim();
  if (!url) return null;
  try {
    const res = await fetch(`${url}/bets-history?days=14`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function fmt(n: number, sign = false) {
  if (!Number.isFinite(n)) return '—';
  const s = n.toFixed(2);
  return sign && n >= 0 ? `+$${s}` : (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${s}`);
}

function pnlClass(n: number) {
  if (!Number.isFinite(n)) return 'text-[#9ca3af]';
  return n >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]';
}

function americanFmt(a: number) {
  if (!Number.isFinite(a)) return '—';
  return a > 0 ? `+${a}` : `${a}`;
}

export default async function BetsHistoryPanel() {
  const data = await fetchHistory();
  if (!data || !data.rows || data.rows.length === 0) return null;

  const { rows, totals } = data;

  return (
    <div className="bg-[#0b1220] border-b border-[rgba(255,255,255,0.08)]">
      <details className="group" open>
        <summary className="px-8 py-4 flex items-center justify-between cursor-pointer list-none hover:bg-[rgba(255,255,255,0.02)]">
          <div className="flex items-center gap-6">
            <h2 className="text-sm font-semibold text-[#e5e7eb] uppercase tracking-wider">
              Placed Bets · last 14 days
            </h2>
            <span className="text-[#9ca3af] text-xs">
              {totals.bets} bet{totals.bets === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm font-mono">
            <div>
              <span className="text-[#9ca3af] text-xs mr-2">P&amp;L (after fees)</span>
              <span className={pnlClass(totals.rawPnl)}>{fmt(totals.rawPnl, true)}</span>
            </div>
            <div>
              <span className="text-[#9ca3af] text-xs mr-2">+ Bonus</span>
              <span className={pnlClass(totals.pnlWithBonus)}>{fmt(totals.pnlWithBonus, true)}</span>
            </div>
            <div className="text-[#9ca3af] text-xs">
              Poly fees: {fmt(totals.polyFees)} · Bonus credit: {fmt(totals.bonusCredit)}
            </div>
            <span className="text-[#6b7280] text-xs ml-2 group-open:rotate-180 transition-transform">▾</span>
          </div>
        </summary>

        <div className="overflow-x-auto border-t border-[rgba(255,255,255,0.06)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0f172a] text-[#9ca3af]">
                <th className="px-4 py-2 text-left font-medium">When</th>
                <th className="px-4 py-2 text-left font-medium">Match</th>
                <th className="px-4 py-2 text-left font-medium">Mkt</th>
                <th className="px-4 py-2 text-right font-medium">BFA Stake</th>
                <th className="px-4 py-2 text-right font-medium">Odds</th>
                <th className="px-4 py-2 text-right font-medium">Poly Qty</th>
                <th className="px-4 py-2 text-right font-medium">Poly Ask</th>
                <th className="px-4 py-2 text-right font-medium">Eff. Px (w/fee)</th>
                <th className="px-4 py-2 text-right font-medium">All-in Cost</th>
                <th className="px-4 py-2 text-right font-medium">If BFA</th>
                <th className="px-4 py-2 text-right font-medium">If Poly</th>
                <th className="px-4 py-2 text-right font-medium">P&amp;L (fees)</th>
                <th className="px-4 py-2 text-right font-medium">+ Bonus</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ts = new Date(r.timestamp);
                const when = ts.toLocaleString(undefined, {
                  month: 'numeric', day: 'numeric',
                  hour: 'numeric', minute: '2-digit',
                });
                return (
                  <tr key={r.attemptId} className="border-t border-[rgba(255,255,255,0.04)] font-mono">
                    <td className="px-4 py-2 text-[#9ca3af]">{when}</td>
                    <td className="px-4 py-2 text-[#e5e7eb]">
                      <div className="flex flex-col">
                        <span>{r.awayTeam} @ {r.homeTeam}</span>
                        <span className="text-[#6b7280] text-[10px]">{r.sport} · {r.date}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-[#9ca3af]">{r.marketType ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-[#e5e7eb]">{fmt(r.bfa.stake)}</td>
                    <td className="px-4 py-2 text-right text-[#e5e7eb]">{americanFmt(r.bfa.americanOdds)}</td>
                    <td className="px-4 py-2 text-right text-[#e5e7eb]">{r.poly.qty}</td>
                    <td className="px-4 py-2 text-right text-[#e5e7eb]">{r.poly.avgPx.toFixed(3)}</td>
                    <td className="px-4 py-2 text-right text-[#e5e7eb]" title={`fee/share: ${r.poly.feePerShare.toFixed(4)} (${r.poly.execMode})`}>
                      {r.poly.effectivePrice != null ? r.poly.effectivePrice.toFixed(3) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-[#e5e7eb]">{fmt(r.poly.allInCost)}</td>
                    <td className={`px-4 py-2 text-right ${pnlClass(r.outcomeIfBfaWins ?? NaN)}`}>
                      {r.outcomeIfBfaWins != null ? fmt(r.outcomeIfBfaWins, true) : '—'}
                    </td>
                    <td className={`px-4 py-2 text-right ${pnlClass(r.outcomeIfPolyWins)}`}>{fmt(r.outcomeIfPolyWins, true)}</td>
                    <td className={`px-4 py-2 text-right font-semibold ${pnlClass(r.rawPnl)}`}>{fmt(r.rawPnl, true)}</td>
                    <td className={`px-4 py-2 text-right font-semibold ${pnlClass(r.pnlWithBonus)}`}>{fmt(r.pnlWithBonus, true)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-[#0f172a] border-t border-[rgba(255,255,255,0.08)] font-mono">
                <td className="px-4 py-2 text-[#9ca3af] text-xs uppercase tracking-wider" colSpan={3}>Totals</td>
                <td className="px-4 py-2 text-right text-[#e5e7eb]">{fmt(totals.bfaStake)}</td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2 text-right text-[#e5e7eb]" title={`Fees: ${fmt(totals.polyFees)}`}>{fmt(totals.polyAllInCost)}</td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2"></td>
                <td className={`px-4 py-2 text-right font-semibold ${pnlClass(totals.rawPnl)}`}>{fmt(totals.rawPnl, true)}</td>
                <td className={`px-4 py-2 text-right font-semibold ${pnlClass(totals.pnlWithBonus)}`}>{fmt(totals.pnlWithBonus, true)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </details>
    </div>
  );
}
