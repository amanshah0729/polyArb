import fs from 'fs';
import path from 'path';
import { Suspense } from 'react';
import ResultsClient from './ResultsClient';
import RerunButton from './RerunButton';
import TabBar from './TabBar';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ── Shared helpers ────────────────────────────────────────────────────────────

function cleanCell(cell: string) {
  return cell.replace(/"/g, '').trim();
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="p-12 text-center">
      <p className="text-[#9ca3af]">{message}</p>
    </div>
  );
}

// ── Sportsbook tab ────────────────────────────────────────────────────────────

function SportsbookContent() {
  const projectRoot = path.resolve(process.cwd(), '..');
  const dir = path.join(projectRoot, 'outputs', 'final_arb');
  let lastPulledTimestamp: Date | null = null;

  let rows: string[][] = [];
  let headers: string[] = [];
  let emptyMessage: string | null = null;

  try {
    const allFiles = fs.readdirSync(dir)
      .filter((f: string) => f.startsWith('arb_') && f.endsWith('.csv'))
      .sort()
      .reverse();

    // Prefer arb_all_ files (new unified format), fall back to old per-sport files
    const unified = allFiles.find((f: string) => f.startsWith('arb_all_'));
    const targetFile = unified ?? allFiles[0];

    if (!targetFile) {
      emptyMessage = "No sportsbook results found. Click 'Recalculate Arb' to run the scanner.";
    } else {
      const stats = fs.statSync(path.join(dir, targetFile));
      lastPulledTimestamp = stats.mtime;

      const content = fs.readFileSync(path.join(dir, targetFile), 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim());

      if (lines.length < 2) {
        emptyMessage = "No games found. Try running the scanner.";
      } else {
        headers = lines[0].split(',').map((h: string) => cleanCell(h));

        for (let i = 1; i < lines.length; i++) {
          const cells: string[] = [];
          let cur = '';
          let inQuote = false;
          for (const ch of lines[i]) {
            if (ch === '"') { inQuote = !inQuote; }
            else if (ch === ',' && !inQuote) { cells.push(cur); cur = ''; }
            else cur += ch;
          }
          cells.push(cur);
          if (cells.length >= headers.length) rows.push(cells.map((c: string) => c.replace(/"/g, '').trim()));
        }

        if (rows.length === 0) emptyMessage = "No games found. Try running the scanner.";
      }
    }
  } catch {
    emptyMessage = "Error reading sportsbook results directory.";
  }

  const idx = (name: string) => headers.indexOf(name);
  const dateIdx          = idx('Date');
  const timeIdx          = idx('Time');
  const sportIdx         = idx('Sport');
  const marketTypeIdx    = idx('Market Type');
  const lineIdx          = idx('Line');
  const awayIdx          = idx('Away Team');
  const homeIdx          = idx('Home Team');
  const arbIdx           = idx('Arb Opportunity');
  const strategyIdx      = idx('Strategy');
  const sbAwayBookIdx    = idx('Best Bookmaker Away');
  const sbAwayOddsIdx    = idx('SB Away Odds');
  const sbAwayImpIdx     = idx('SB Away Implied (%)');
  const sbHomeBookIdx    = idx('Best Bookmaker Home');
  const sbHomeOddsIdx    = idx('SB Home Odds');
  const sbHomeImpIdx     = idx('SB Home Implied (%)');
  const polyAwayIdx      = idx('Polymarket Away Implied (%)');
  const polyHomeIdx      = idx('Polymarket Home Implied (%)');
  const profitIdx        = idx('Profit %');
  const costIdx          = idx('Best Option Cost');
  const volumeIdx        = idx('Volume ($)');

  const sportBadgeClass = (sport: string) => {
    if (sport === 'NBA') return 'bg-[rgba(96,165,250,0.2)] text-[#60a5fa]';
    if (sport === 'NHL') return 'bg-[rgba(20,184,166,0.2)] text-[#2dd4bf]';
    if (sport === 'NFL') return 'bg-[rgba(251,146,60,0.2)] text-[#fb923c]';
    if (sport === 'MLB') return 'bg-[rgba(239,68,68,0.2)] text-[#f87171]';
    if (sport === 'UFC') return 'bg-[rgba(168,85,247,0.2)] text-[#a855f7]';
    if (sport === 'EPL') return 'bg-[rgba(52,211,153,0.2)] text-[#34d399]';
    if (sport === 'MLS') return 'bg-[rgba(251,191,36,0.2)] text-[#fbbf24]';
    if (sport === 'BOX') return 'bg-[rgba(244,114,182,0.2)] text-[#f472b6]';
    return 'bg-[rgba(156,163,175,0.2)] text-[#9ca3af]';
  };

  function getSideLabels(row: string[]) {
    const marketType = row[marketTypeIdx] ?? 'moneyline';
    const line = row[lineIdx] ?? '';
    const away = row[awayIdx] ?? '';
    const home = row[homeIdx] ?? '';

    if (marketType === 'total') {
      return { side1: `Over ${line}`, side2: `Under ${line}` };
    }
    if (marketType === 'spread' && line) {
      const num = parseFloat(line);
      const oppLine = num > 0 ? `-${Math.abs(num)}` : `+${Math.abs(num)}`;
      return { side1: `${away} ${line}`, side2: `${home} ${oppLine}` };
    }
    return { side1: away, side2: home };
  }

  function getMarketLabel(row: string[]) {
    const marketType = row[marketTypeIdx] ?? 'moneyline';
    const line = row[lineIdx] ?? '';
    if (marketType === 'total') return `Total O/U ${line}`;
    if (marketType === 'spread') return `Spread ${line}`;
    return 'Moneyline';
  }

  function renderStrategy(raw: string) {
    const parts = raw.split(' + ');
    if (parts.length !== 2) return <span className="text-[#9ca3af] text-sm">{raw}</span>;
    return (
      <div className="flex flex-col gap-0.5">
        {parts.map((part, i) => {
          const atIdx = part.lastIndexOf('@');
          if (atIdx === -1) return <span key={i} className="text-[#9ca3af] text-sm">{part}</span>;
          const team = part.slice(0, atIdx);
          const platform = part.slice(atIdx + 1);
          return (
            <span key={i} className="text-sm">
              <span className="font-semibold text-[#e5e7eb]">{team}</span>
              <span className="text-[#6b7280] text-xs"> @{platform}</span>
            </span>
          );
        })}
      </div>
    );
  }

  function formatOdds(odds: string) {
    const v = parseFloat(odds);
    if (isNaN(v)) return odds;
    return v > 0 ? `+${odds}` : odds;
  }

  return (
    <>
      <div className="bg-[#1f2937] px-8 py-5 flex items-center justify-between border-b border-[rgba(255,255,255,0.08)]">
        <div>
          <p className="text-[#9ca3af] text-sm font-medium">All Sportsbooks ↔ Polymarket · all sports · all markets</p>
          {lastPulledTimestamp && (
            <p className="text-[#9ca3af] text-xs mt-1">Last pulled: {lastPulledTimestamp.toLocaleString()}</p>
          )}
        </div>
        <RerunButton />
      </div>

      {emptyMessage ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-6">
          {rows.map((row, i) => {
            const isArb = (row[arbIdx] ?? '') === 'YES';
            const sport = row[sportIdx] ?? '';
            const { side1, side2 } = getSideLabels(row);
            const marketLabel = getMarketLabel(row);
            const cost = row[costIdx] ?? '';
            const profit = row[profitIdx] ?? '';
            const sbAwayOdds = row[sbAwayOddsIdx] ?? '';
            const sbAwayImp = row[sbAwayImpIdx] ?? '';
            const sbHomeOdds = row[sbHomeOddsIdx] ?? '';
            const sbHomeImp = row[sbHomeImpIdx] ?? '';
            const sbAwayBook = row[sbAwayBookIdx] ?? '';
            const sbHomeBook = row[sbHomeBookIdx] ?? '';
            const polyAway = row[polyAwayIdx] ?? '';
            const polyHome = row[polyHomeIdx] ?? '';
            const volume = volumeIdx >= 0 ? row[volumeIdx] ?? '' : '';

            return (
              <div
                key={i}
                className={`rounded-xl border transition-colors duration-150 ${
                  isArb
                    ? 'border-[rgba(34,197,94,0.4)] bg-[rgba(34,197,94,0.06)]'
                    : 'border-[rgba(255,255,255,0.08)] bg-[#111827]'
                } ${isArb ? 'ring-1 ring-[rgba(34,197,94,0.2)]' : ''}`}
              >
                {/* Header: sport + date + cost */}
                <div className="flex items-center justify-between px-4 pt-4 pb-2">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${sportBadgeClass(sport)}`}>
                      {sport}
                    </span>
                    <span className="text-[#6b7280] text-xs">
                      {row[dateIdx] ?? ''} · {(row[timeIdx] ?? '').replace(/:00 /, ' ')}
                    </span>
                  </div>
                  <span className={`font-mono text-xs ${isArb ? 'text-[#22c55e] font-semibold' : 'text-[#6b7280]'}`}>
                    {cost}
                  </span>
                </div>

                {/* Game title + market type */}
                <div className="px-4 pb-3">
                  <div className="text-[#e5e7eb] font-semibold text-base">
                    {row[awayIdx] ?? ''} vs {row[homeIdx] ?? ''}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-[rgba(255,255,255,0.06)] text-[#9ca3af]">
                      {marketLabel}
                    </span>
                    {volume && (
                      <span className="text-[#6b7280] text-xs">
                        vol: ${Number(volume).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>

                {/* Two side-by-side odds boxes */}
                <div className="grid grid-cols-2 gap-2 px-4 pb-3">
                  {/* Side 1 (away / over) */}
                  <div className="rounded-lg bg-[rgba(255,255,255,0.04)] p-3">
                    <div className="text-[#e5e7eb] font-semibold text-sm mb-1.5">{side1}</div>
                    <div className="space-y-1">
                      <div className="flex items-baseline gap-1 flex-wrap">
                        <span className="text-[#6b7280] text-xs">{sbAwayBook}</span>
                        <span className={`font-mono text-sm ${parseFloat(sbAwayOdds) > 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}`}>
                          {formatOdds(sbAwayOdds)}
                        </span>
                        <span className="text-[#6b7280] text-xs">({sbAwayImp}%)</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-[#6b7280] text-xs">Poly</span>
                        <span className="font-mono text-sm text-[#a78bfa]">{polyAway}%</span>
                      </div>
                    </div>
                  </div>

                  {/* Side 2 (home / under) */}
                  <div className="rounded-lg bg-[rgba(255,255,255,0.04)] p-3">
                    <div className="text-[#e5e7eb] font-semibold text-sm mb-1.5">{side2}</div>
                    <div className="space-y-1">
                      <div className="flex items-baseline gap-1 flex-wrap">
                        <span className="text-[#6b7280] text-xs">{sbHomeBook}</span>
                        <span className={`font-mono text-sm ${parseFloat(sbHomeOdds) > 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}`}>
                          {formatOdds(sbHomeOdds)}
                        </span>
                        <span className="text-[#6b7280] text-xs">({sbHomeImp}%)</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-[#6b7280] text-xs">Poly</span>
                        <span className="font-mono text-sm text-[#a78bfa]">{polyHome}%</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Strategy */}
                {strategyIdx >= 0 && row[strategyIdx] && (
                  <div className="px-4 pb-2">
                    {renderStrategy(row[strategyIdx])}
                  </div>
                )}

                {/* Bottom stats row */}
                <div className="flex items-center justify-between px-4 py-3 border-t border-[rgba(255,255,255,0.06)] text-xs">
                  <span className={`font-mono ${isArb ? 'text-[#22c55e] font-semibold' : 'text-[#9ca3af]'}`}>
                    {profit ? `${profit}%` : ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Pred Market tab ───────────────────────────────────────────────────────────

function PredMarketContent() {
  const projectRoot = path.resolve(process.cwd(), '..');
  const dir = path.join(projectRoot, 'outputs', 'predexon');
  let lastPulledTimestamp: Date | null = null;

  let rows: string[][] = [];
  let headers: string[] = [];
  let emptyMessage: string | null = null;

  try {
    const allFiles = fs.readdirSync(dir)
      .filter((f: string) => f.startsWith('arb_predexon_') && f.endsWith('.csv'))
      .sort()
      .reverse(); // most recent first

    if (allFiles.length === 0) {
      emptyMessage = "No pred market results yet. Click 'Refresh Pred Market Arb' to scan.";
    } else {
      const latestFile = allFiles[0];
      const stats = fs.statSync(path.join(dir, latestFile));
      lastPulledTimestamp = stats.mtime;

      const content = fs.readFileSync(path.join(dir, latestFile), 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim());

      if (lines.length < 2) {
        emptyMessage = "No arbitrage opportunities found. Try running the scanner.";
      } else {
        headers = lines[0].split(',').map(h => cleanCell(h));

        // Parse CSV rows (handle quoted commas in title)
        for (let i = 1; i < lines.length; i++) {
          const cells: string[] = [];
          let cur = '';
          let inQuote = false;
          for (const ch of lines[i]) {
            if (ch === '"') { inQuote = !inQuote; }
            else if (ch === ',' && !inQuote) { cells.push(cur); cur = ''; }
            else cur += ch;
          }
          cells.push(cur);
          if (cells.length >= headers.length) rows.push(cells.map(c => c.replace(/"/g, '').trim()));
        }

        if (rows.length === 0) emptyMessage = "No arbitrage opportunities found. Try running the scanner.";
      }
    }
  } catch {
    emptyMessage = "Error reading pred market results directory.";
  }

  const idx = (name: string) => headers.indexOf(name);
  const titleIdx     = idx('Title');
  const simIdx       = idx('Similarity%');
  const stratIdx     = idx('Strategy');
  const profitPctIdx = idx('Profit%');
  const polyYesIdx   = idx('Poly YES');
  const polyNoIdx    = idx('Poly NO');
  const kYesAskIdx   = idx('Kalshi YES Ask');
  const kNoAskIdx    = idx('Kalshi NO Ask');
  const kYesBidIdx   = idx('Kalshi YES Bid');
  const kNoBidIdx    = idx('Kalshi NO Bid');
  const costIdx      = idx('Arb Cost');
  const expiresIdx   = idx('Expires');
  const tickerIdx    = idx('Kalshi Ticker');

  // APY = (1 + profit%)^(365/days) - 1
  // Returns null if expiry unknown or already passed
  function calcAPY(profitPct: number, expiresStr: string): number | null {
    if (!expiresStr || expiresStr === '—') return null;
    const expiry = new Date(expiresStr);
    const days = (expiry.getTime() - Date.now()) / 86400000;
    if (days <= 0) return null;
    return (Math.pow(1 + profitPct / 100, 365 / days) - 1) * 100;
  }

  const STABLECOIN_APY = 5; // % benchmark

  const tableHeaders = [
    '#', 'Profit %', 'APY (ann.)', 'Market', 'Strategy',
    'Poly YES', 'Poly NO',
    'Kalshi Ask (Y / N)', 'Kalshi Bid (Y / N)',
    'Arb Cost', 'Sim', 'Expires',
  ];

  return (
    <>
      <div className="bg-[#1f2937] px-8 py-5 flex items-center justify-between border-b border-[rgba(255,255,255,0.08)]">
        <div>
          <p className="text-[#9ca3af] text-sm font-medium">Polymarket ↔ Kalshi · buy &amp; hold to resolution · ask prices only</p>
          {lastPulledTimestamp && (
            <p className="text-[#9ca3af] text-xs mt-1">Last pulled: {lastPulledTimestamp.toLocaleString()}</p>
          )}
        </div>
        <RerunButton
          apiRoute="/api/run-predexon-arb"
          label="Refresh Pred Market Arb"
          loadingLabel="Scanning..."
        />
      </div>
      {emptyMessage ? (
        <EmptyState message={emptyMessage} />
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-full" style={{ tableLayout: 'auto' }}>
          <thead className="sticky top-0 z-10">
            <tr className="bg-[#1f2937] border-b border-[rgba(255,255,255,0.08)]">
              {tableHeaders.map((h, i) => (
                <th key={i} className="px-[18px] py-[14px] text-left text-[0.9rem] font-medium text-[#e5e7eb] uppercase tracking-wider whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const profitPct = parseFloat(row[profitPctIdx] ?? '0');
              const expiresStr = row[expiresIdx] ?? '—';
              const apy = calcAPY(profitPct, expiresStr);
              const beatsStablecoin = apy !== null && apy >= STABLECOIN_APY;

              const rowBg = i % 2 === 0
                ? 'bg-[#111827] hover:bg-[rgba(56,189,248,0.08)]'
                : 'bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(56,189,248,0.08)]';

              const cellBase = 'px-[18px] py-4 text-sm text-[#e5e7eb] whitespace-nowrap';
              const title = row[titleIdx] ?? '';
              const strategy = (row[stratIdx] ?? '')
                .replace('@Polymarket', '@Poly')
                .replace('@Kalshi', '@K');

              return (
                <tr key={i} className={`border-b border-[rgba(255,255,255,0.08)] transition-colors duration-150 ${rowBg}`}>
                  {/* # */}
                  <td className={`${cellBase} text-[#6b7280] font-medium`}>{i + 1}</td>

                  {/* Profit % */}
                  <td className={`${cellBase} font-semibold text-[#e5e7eb]`}>
                    {profitPct.toFixed(2)}%
                  </td>

                  {/* APY */}
                  <td className={cellBase}>
                    {apy === null ? (
                      <span className="text-[#6b7280]">—</span>
                    ) : beatsStablecoin ? (
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[rgba(34,197,94,0.15)] text-[#22c55e]">
                        {apy.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[rgba(239,68,68,0.12)] text-[#f87171]">
                        {apy.toFixed(1)}%
                      </span>
                    )}
                  </td>

                  {/* Market title */}
                  <td className={`${cellBase} max-w-[300px]`}>
                    <span className="block truncate text-[#e5e7eb]" title={title}>
                      {title}
                    </span>
                    {tickerIdx >= 0 && (
                      <span className="block text-[#60a5fa] text-xs mt-0.5 font-mono">
                        {row[tickerIdx]}
                      </span>
                    )}
                  </td>

                  {/* Strategy */}
                  <td className={`${cellBase} text-[#9ca3af]`}>{strategy}</td>

                  {/* Poly YES */}
                  <td className={`${cellBase} font-mono text-[#a78bfa]`}>{row[polyYesIdx] ?? '—'}</td>

                  {/* Poly NO */}
                  <td className={`${cellBase} font-mono text-[#a78bfa]`}>{row[polyNoIdx] ?? '—'}</td>

                  {/* Kalshi Ask YES / NO */}
                  <td className={cellBase}>
                    <div className="flex gap-3 font-mono text-[#fbbf24]">
                      <span><span className="text-[#6b7280] text-xs">Y </span>{row[kYesAskIdx] ?? '—'}</span>
                      <span><span className="text-[#6b7280] text-xs">N </span>{row[kNoAskIdx] ?? '—'}</span>
                    </div>
                  </td>

                  {/* Kalshi Bid YES / NO (liquidity reference only) */}
                  <td className={cellBase}>
                    <div className="flex gap-3 font-mono text-[#6b7280]">
                      <span><span className="text-xs">Y </span>{row[kYesBidIdx] ?? '—'}</span>
                      <span><span className="text-xs">N </span>{row[kNoBidIdx] ?? '—'}</span>
                    </div>
                  </td>

                  {/* Arb Cost */}
                  <td className={`${cellBase} font-mono text-[#e5e7eb]`}>{row[costIdx] ?? '—'}</td>

                  {/* Similarity */}
                  <td className={cellBase}>
                    <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[rgba(96,165,250,0.15)] text-[#60a5fa]">
                      {row[simIdx] ?? '?'}%
                    </span>
                  </td>

                  {/* Expires */}
                  <td className={`${cellBase} text-[#9ca3af] font-mono`}>{expiresStr}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </>
  );
}

// ── BetFast tab ───────────────────────────────────────────────────────────────

async function fetchRemoteResults(): Promise<{ lastScanTime: string | null; results: any[] } | null> {
  const url = process.env.NOTIFIER_URL;
  if (!url) return null;
  try {
    const res = await fetch(`${url}/results`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function resultsToRows(results: any[]): { headers: string[]; rows: string[][] } {
  const headers = [
    'Date', 'Time', 'Sport', 'Market Type', 'Line',
    'Away Team', 'Home Team', 'Status',
    'Arb Opportunity', 'Strategy',
    'BFAGaming Away Odds', 'BFAGaming Away Implied (%)',
    'BFAGaming Home Odds', 'BFAGaming Home Implied (%)',
    'Polymarket Away Implied (%)', 'Polymarket Home Implied (%)',
    'Profit %', 'Best Option Cost',
    'BFA Bet ($)', 'Poly Bet ($)', 'Guaranteed P&L ($)', 'Net Value ($)', 'Volume ($)',
  ];
  const rows = results.map((r: any) => [
    r.date ?? '',
    r.time ?? '',
    r.sport ?? '',
    r.marketType ?? '',
    r.line ?? '',
    r.awayTeam ?? '',
    r.homeTeam ?? '',
    r.status ?? '',
    r.hasArb ? 'YES' : 'NO',
    r.strategy ?? '',
    String(r.bfaAwayOdds ?? ''),
    ((r.bfaAwayImplied ?? 0) * 100).toFixed(2),
    String(r.bfaHomeOdds ?? ''),
    ((r.bfaHomeImplied ?? 0) * 100).toFixed(2),
    ((r.polyAwayImplied ?? 0) * 100).toFixed(2),
    ((r.polyHomeImplied ?? 0) * 100).toFixed(2),
    (r.profitPct ?? 0).toFixed(2),
    (r.bestCost ?? 0).toFixed(4),
    (r.bfaBet ?? 0).toFixed(2),
    (r.polyBet ?? 0).toFixed(2),
    (r.guaranteedPnl ?? 0).toFixed(2),
    (r.netValue ?? 0).toFixed(2),
    String(Math.round(r.volumeUsd ?? 0)),
  ]);
  return { headers, rows };
}

function readLocalCSV(): { headers: string[]; rows: string[][]; lastPulledTimestamp: Date | null; emptyMessage: string | null } {
  const projectRoot = path.resolve(process.cwd(), '..');
  const dir = path.join(projectRoot, 'outputs', 'bfagaming');
  let lastPulledTimestamp: Date | null = null;
  let rows: string[][] = [];
  let headers: string[] = [];
  let emptyMessage: string | null = null;

  try {
    const allFiles = fs.readdirSync(dir)
      .filter((f: string) => f.startsWith('arb_bfagaming_') && f.endsWith('.csv'))
      .sort()
      .reverse();

    if (allFiles.length === 0) {
      emptyMessage = "No BetFast results yet. Click 'Run BetFast Scanner' to scan.";
    } else {
      const latestFile = allFiles[0];
      const stats = fs.statSync(path.join(dir, latestFile));
      lastPulledTimestamp = stats.mtime;

      const content = fs.readFileSync(path.join(dir, latestFile), 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim());

      if (lines.length < 2) {
        emptyMessage = "No games found. Try running the scanner.";
      } else {
        headers = lines[0].split(',').map((h: string) => cleanCell(h));

        for (let i = 1; i < lines.length; i++) {
          const cells: string[] = [];
          let cur = '';
          let inQuote = false;
          for (const ch of lines[i]) {
            if (ch === '"') { inQuote = !inQuote; }
            else if (ch === ',' && !inQuote) { cells.push(cur); cur = ''; }
            else cur += ch;
          }
          cells.push(cur);
          if (cells.length >= headers.length) rows.push(cells.map((c: string) => c.replace(/"/g, '').trim()));
        }

        if (rows.length === 0) emptyMessage = "No games found. Try running the scanner.";
      }
    }
  } catch {
    emptyMessage = "Error reading BetFast results directory.";
  }

  return { headers, rows, lastPulledTimestamp, emptyMessage };
}

async function BetFastContent() {
  let rows: string[][] = [];
  let headers: string[] = [];
  let lastPulledTimestamp: Date | null = null;
  let emptyMessage: string | null = null;

  // Try remote notifier first, fall back to local CSV
  const remote = await fetchRemoteResults();
  if (remote && remote.results && remote.results.length > 0) {
    const parsed = resultsToRows(remote.results);
    headers = parsed.headers;
    rows = parsed.rows;
    lastPulledTimestamp = remote.lastScanTime ? new Date(remote.lastScanTime) : null;
  } else {
    const local = readLocalCSV();
    headers = local.headers;
    rows = local.rows;
    lastPulledTimestamp = local.lastPulledTimestamp;
    emptyMessage = local.emptyMessage;
  }

  const idx = (name: string) => headers.indexOf(name);
  const dateIdx         = idx('Date');
  const timeIdx         = idx('Time');
  const sportIdx        = idx('Sport');
  const marketTypeIdx   = idx('Market Type');
  const lineIdx         = idx('Line');
  const awayIdx         = idx('Away Team');
  const homeIdx         = idx('Home Team');
  const arbIdx          = idx('Arb Opportunity');
  const strategyIdx     = idx('Strategy');
  const bfaAwayOddsIdx  = idx('BFAGaming Away Odds');
  const bfaAwayImpIdx   = idx('BFAGaming Away Implied (%)');
  const bfaHomeOddsIdx  = idx('BFAGaming Home Odds');
  const bfaHomeImpIdx   = idx('BFAGaming Home Implied (%)');
  const polyAwayIdx     = idx('Polymarket Away Implied (%)');
  const polyHomeIdx     = idx('Polymarket Home Implied (%)');
  const profitIdx       = idx('Profit %');
  const costIdx         = idx('Best Option Cost');
  const bfaBetIdx       = idx('BFA Bet ($)');
  const polyBetIdx      = idx('Poly Bet ($)');
  const pnlIdx          = idx('Guaranteed P&L ($)');
  const netValIdx       = idx('Net Value ($)');
  const volumeIdx       = idx('Volume ($)');

  const sportBadgeClass = (sport: string) => {
    if (sport === 'NBA') return 'bg-[rgba(96,165,250,0.2)] text-[#60a5fa]';
    if (sport === 'NHL') return 'bg-[rgba(20,184,166,0.2)] text-[#2dd4bf]';
    if (sport === 'NFL') return 'bg-[rgba(251,146,60,0.2)] text-[#fb923c]';
    if (sport === 'MLB') return 'bg-[rgba(239,68,68,0.2)] text-[#f87171]';
    if (sport === 'UFC') return 'bg-[rgba(168,85,247,0.2)] text-[#a855f7]';
    return 'bg-[rgba(156,163,175,0.2)] text-[#9ca3af]';
  };

  function getSideLabels(row: string[]) {
    const marketType = row[marketTypeIdx] ?? 'moneyline';
    const line = row[lineIdx] ?? '';
    const away = row[awayIdx] ?? '';
    const home = row[homeIdx] ?? '';

    if (marketType === 'total') {
      return { side1: `Over ${line}`, side2: `Under ${line}` };
    }
    if (marketType === 'spread' && line) {
      const num = parseFloat(line);
      const oppLine = num > 0 ? `-${Math.abs(num)}` : `+${Math.abs(num)}`;
      return { side1: `${away} ${line}`, side2: `${home} ${oppLine}` };
    }
    return { side1: away, side2: home };
  }

  function getMarketLabel(row: string[]) {
    const marketType = row[marketTypeIdx] ?? 'moneyline';
    const line = row[lineIdx] ?? '';
    if (marketType === 'total') return `Total O/U ${line}`;
    if (marketType === 'spread') return `Spread ${line}`;
    return 'Moneyline';
  }

  /** "Bulls@BFA + Clippers@Poly" → two styled spans */
  function renderStrategy(raw: string) {
    const parts = raw.split(' + ');
    if (parts.length !== 2) return <span className="text-[#9ca3af] text-sm">{raw}</span>;
    return (
      <div className="flex flex-col gap-0.5">
        {parts.map((part, i) => {
          const atIdx = part.lastIndexOf('@');
          if (atIdx === -1) return <span key={i} className="text-[#9ca3af] text-sm">{part}</span>;
          const team = part.slice(0, atIdx);
          const platform = part.slice(atIdx + 1);
          return (
            <span key={i} className="text-sm">
              <span className="font-semibold text-[#e5e7eb]">{team}</span>
              <span className="text-[#6b7280] text-xs"> @{platform}</span>
            </span>
          );
        })}
      </div>
    );
  }

  function formatOdds(odds: string) {
    const v = parseFloat(odds);
    if (isNaN(v)) return odds;
    return v > 0 ? `+${odds}` : odds;
  }

  return (
    <>
      <div className="bg-[#1f2937] px-8 py-5 flex items-center justify-between border-b border-[rgba(255,255,255,0.08)]">
        <div>
          <p className="text-[#9ca3af] text-sm font-medium">BetFast (bfagaming.com) ↔ Polymarket · all sports · all markets</p>
          {lastPulledTimestamp && (
            <p className="text-[#9ca3af] text-xs mt-1">Last pulled: {lastPulledTimestamp.toLocaleString()}</p>
          )}
        </div>
        <RerunButton
          apiRoute="/api/run-bfagaming-arb"
          label="Run BetFast Scanner"
          loadingLabel="Scanning..."
        />
      </div>

      {emptyMessage ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-6">
          {rows.map((row, i) => {
            const isArb = (row[arbIdx] ?? '') === 'YES';
            const sport = row[sportIdx] ?? '';
            const { side1, side2 } = getSideLabels(row);
            const marketLabel = getMarketLabel(row);
            const cost = row[costIdx] ?? '';
            const profit = row[profitIdx] ?? '';
            const bfaAwayOdds = row[bfaAwayOddsIdx] ?? '';
            const bfaAwayImp = row[bfaAwayImpIdx] ?? '';
            const bfaHomeOdds = row[bfaHomeOddsIdx] ?? '';
            const bfaHomeImp = row[bfaHomeImpIdx] ?? '';
            const polyAway = row[polyAwayIdx] ?? '';
            const polyHome = row[polyHomeIdx] ?? '';
            const volume = volumeIdx >= 0 ? row[volumeIdx] ?? '' : '';

            return (
              <div
                key={i}
                className={`rounded-xl border transition-colors duration-150 ${
                  isArb
                    ? 'border-[rgba(34,197,94,0.4)] bg-[rgba(34,197,94,0.06)]'
                    : 'border-[rgba(255,255,255,0.08)] bg-[#111827]'
                } ${isArb ? 'ring-1 ring-[rgba(34,197,94,0.2)]' : ''}`}
              >
                {/* Header: sport + date + cost */}
                <div className="flex items-center justify-between px-4 pt-4 pb-2">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${sportBadgeClass(sport)}`}>
                      {sport}
                    </span>
                    <span className="text-[#6b7280] text-xs">
                      {row[dateIdx] ?? ''} · {(row[timeIdx] ?? '').replace(/:00 /, ' ')}
                    </span>
                  </div>
                  <span className={`font-mono text-xs ${isArb ? 'text-[#22c55e] font-semibold' : 'text-[#6b7280]'}`}>
                    {cost}
                  </span>
                </div>

                {/* Game title + market type */}
                <div className="px-4 pb-3">
                  <div className="text-[#e5e7eb] font-semibold text-base">
                    {row[awayIdx] ?? ''} vs {row[homeIdx] ?? ''}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-[rgba(255,255,255,0.06)] text-[#9ca3af]">
                      {marketLabel}
                    </span>
                    {volume && (
                      <span className="text-[#6b7280] text-xs">
                        vol: ${Number(volume).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>

                {/* Two side-by-side odds boxes */}
                <div className="grid grid-cols-2 gap-2 px-4 pb-3">
                  {/* Side 1 (away / over) */}
                  <div className="rounded-lg bg-[rgba(255,255,255,0.04)] p-3">
                    <div className="text-[#e5e7eb] font-semibold text-sm mb-1.5">{side1}</div>
                    <div className="space-y-1">
                      <div className="flex items-baseline gap-1">
                        <span className="text-[#6b7280] text-xs w-8">BFA</span>
                        <span className={`font-mono text-sm ${parseFloat(bfaAwayOdds) > 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}`}>
                          {formatOdds(bfaAwayOdds)}
                        </span>
                        <span className="text-[#6b7280] text-xs">({bfaAwayImp}%)</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-[#6b7280] text-xs w-8">Poly</span>
                        <span className="font-mono text-sm text-[#a78bfa]">{polyAway}%</span>
                      </div>
                    </div>
                  </div>

                  {/* Side 2 (home / under) */}
                  <div className="rounded-lg bg-[rgba(255,255,255,0.04)] p-3">
                    <div className="text-[#e5e7eb] font-semibold text-sm mb-1.5">{side2}</div>
                    <div className="space-y-1">
                      <div className="flex items-baseline gap-1">
                        <span className="text-[#6b7280] text-xs w-8">BFA</span>
                        <span className={`font-mono text-sm ${parseFloat(bfaHomeOdds) > 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}`}>
                          {formatOdds(bfaHomeOdds)}
                        </span>
                        <span className="text-[#6b7280] text-xs">({bfaHomeImp}%)</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-[#6b7280] text-xs w-8">Poly</span>
                        <span className="font-mono text-sm text-[#a78bfa]">{polyHome}%</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Strategy */}
                {strategyIdx >= 0 && row[strategyIdx] && (
                  <div className="px-4 pb-2">
                    {renderStrategy(row[strategyIdx])}
                  </div>
                )}

                {/* Bottom stats row */}
                <div className="flex items-center justify-between px-4 py-3 border-t border-[rgba(255,255,255,0.06)] text-xs">
                  <div className="flex items-center gap-3">
                    {profit && (
                      <span className={`font-mono ${isArb ? 'text-[#22c55e] font-semibold' : 'text-[#9ca3af]'}`}>
                        {profit}%
                      </span>
                    )}
                    {bfaBetIdx >= 0 && row[bfaBetIdx] && (
                      <span className="text-[#9ca3af]">
                        BFA <span className="font-mono text-[#e5e7eb]">${row[bfaBetIdx]}</span>
                      </span>
                    )}
                    {polyBetIdx >= 0 && row[polyBetIdx] && (
                      <span className="text-[#9ca3af]">
                        Poly <span className="font-mono text-[#a78bfa]">${row[polyBetIdx]}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {pnlIdx >= 0 && row[pnlIdx] && (() => {
                      const v = parseFloat(row[pnlIdx]);
                      return (
                        <span className={`font-mono ${v >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}`}>
                          P&L {v >= 0 ? '+' : ''}${v.toFixed(2)}
                        </span>
                      );
                    })()}
                    {netValIdx >= 0 && row[netValIdx] && (() => {
                      const v = parseFloat(row[netValIdx]);
                      return (
                        <span className={`font-mono font-semibold px-2 py-0.5 rounded-full ${
                          v >= 0
                            ? 'bg-[rgba(34,197,94,0.15)] text-[#22c55e]'
                            : 'bg-[rgba(239,68,68,0.12)] text-[#f87171]'
                        }`}>
                          {v >= 0 ? '+' : ''}${v.toFixed(2)}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function Results({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const isPredMarket = tab === 'predmarket';
  const isBetFast = tab === 'betfast';

  return (
    <ResultsClient>
      <div className="min-h-screen bg-[#0f172a] py-12 px-4">
        <div className="max-w-[1400px] mx-auto">
          <div className="bg-[#111827] rounded-xl shadow-2xl border border-[rgba(255,255,255,0.08)]">

            {/* Header */}
            <div className="bg-[#1f2937] px-8 pt-6 border-b-0 rounded-t-xl">
              <h1 className="text-4xl font-bold text-[#e5e7eb] tracking-tight">
                Arbitrage Results
              </h1>
            </div>

            {/* Tabs */}
            <Suspense fallback={null}>
              <TabBar />
            </Suspense>

            {/* Tab content */}
            {isBetFast ? <BetFastContent /> : isPredMarket ? <PredMarketContent /> : <SportsbookContent />}

          </div>
        </div>
      </div>
    </ResultsClient>
  );
}
