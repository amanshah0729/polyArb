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
  let files: string[] = [];
  let lastPulledTimestamp: Date | undefined;

  try {
    const today = new Date().toISOString().split('T')[0];
    const allFiles = fs.readdirSync(dir).filter((f: string) => f.startsWith('arb_') && f.endsWith('.csv'));
    files = allFiles.filter((f: string) => f.includes(today)).sort();

    if (files.length === 0) {
      const sportFiles: { [key: string]: string } = {};
      allFiles.forEach((file: string) => {
        const match = file.match(/arb_(nba|nfl|nhl)_(\d{4}-\d{2}-\d{2})\.csv/);
        if (match) {
          const sport = match[1];
          const date = match[2];
          if (!sportFiles[sport] || date > sportFiles[sport].split('_')[2].replace('.csv', '')) {
            sportFiles[sport] = file;
          }
        }
      });
      files = Object.values(sportFiles).sort();
    }

    if (files.length > 0) {
      let mostRecentTime = 0;
      files.forEach((file: string) => {
        const stats = fs.statSync(path.join(dir, file));
        if (stats.mtime.getTime() > mostRecentTime) {
          mostRecentTime = stats.mtime.getTime();
          lastPulledTimestamp = stats.mtime;
        }
      });
    }
  } catch {
    return <EmptyState message="Error reading sportsbook results directory." />;
  }

  if (files.length === 0) return <EmptyState message="No sportsbook results found. Click Recalculate Arb to run the scanner." />;

  const allRows: Array<{ row: string[]; sport: string }> = [];
  let originalHeaders: string[] = [];

  files.forEach((file: string) => {
    try {
      const sportMatch = file.match(/arb_(nba|nfl|nhl)_/);
      const sport = sportMatch ? sportMatch[1].toUpperCase() : 'UNKNOWN';
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      if (lines.length > 0) {
        if (originalHeaders.length === 0) originalHeaders = lines[0].split(',');
        allRows.push(...lines.slice(1).map((line: string) => ({ row: line.split(','), sport })));
      }
    } catch { /* skip bad file */ }
  });

  if (allRows.length === 0) return <EmptyState message="No arbitrage data found." />;

  const idx = (name: string) => originalHeaders.findIndex(h => h.replace(/"/g, '').trim() === name);
  const bestOptionCostIdx   = idx('Best Option Cost');
  const awayTeamIdx         = idx('Away Team');
  const homeTeamIdx         = idx('Home Team');
  const dateIdx             = idx('Date');
  const timeIdx             = idx('Time');
  const statusIdx           = idx('Status');
  const arbOppIdx           = idx('Arb Opportunity');
  const lowestAwayBookIdx   = idx('Lowest Away Bookmaker');
  const lowestAwayImpliedIdx = idx('Lowest Away Implied Prob (%)');
  const lowestHomeBookIdx   = idx('Lowest Home Bookmaker');
  const lowestHomeImpliedIdx = idx('Lowest Home Implied Prob (%)');
  const polyAwayImpliedIdx  = idx('Polymarket Away Implied Prob (%)');
  const polyHomeImpliedIdx  = idx('Polymarket Home Implied Prob (%)');
  const profitIdx           = idx('Profit %');

  const headers = [
    'Best Option Cost', 'Date', 'Time', 'Game', 'Status', 'Arb Opportunity',
    'Lowest Away Bookmaker', 'Lowest Away Implied Prob (%)',
    'Lowest Home Bookmaker', 'Lowest Home Implied Prob (%)',
    'Polymarket Away Implied Prob (%)', 'Polymarket Home Implied Prob (%)', 'Profit %',
  ];

  const transformedRows = allRows.map(({ row, sport }) => ({
    data: [
      bestOptionCostIdx >= 0 ? cleanCell(row[bestOptionCostIdx]) : '',
      dateIdx >= 0 ? cleanCell(row[dateIdx]) : '',
      timeIdx >= 0 ? cleanCell(row[timeIdx]).replace(/:00 /, ' ') : '',
      awayTeamIdx >= 0 && homeTeamIdx >= 0 ? `${cleanCell(row[awayTeamIdx])} (A) @ ${cleanCell(row[homeTeamIdx])} (H)` : '',
      statusIdx >= 0 ? cleanCell(row[statusIdx]) : '',
      arbOppIdx >= 0 ? cleanCell(row[arbOppIdx]) : '',
      lowestAwayBookIdx >= 0 ? cleanCell(row[lowestAwayBookIdx]) : '',
      lowestAwayImpliedIdx >= 0 ? cleanCell(row[lowestAwayImpliedIdx]) : '',
      lowestHomeBookIdx >= 0 ? cleanCell(row[lowestHomeBookIdx]) : '',
      lowestHomeImpliedIdx >= 0 ? cleanCell(row[lowestHomeImpliedIdx]) : '',
      polyAwayImpliedIdx >= 0 ? cleanCell(row[polyAwayImpliedIdx]) : '',
      polyHomeImpliedIdx >= 0 ? cleanCell(row[polyHomeImpliedIdx]) : '',
      profitIdx >= 0 ? cleanCell(row[profitIdx]) : '',
    ],
    sport,
  }));

  transformedRows.sort((a, b) => {
    const aYes = a.data[5] === 'YES', bYes = b.data[5] === 'YES';
    return aYes === bYes ? 0 : aYes ? -1 : 1;
  });

  return (
    <>
      <div className="bg-[#1f2937] px-8 py-5 flex items-center justify-between border-b border-[rgba(255,255,255,0.08)]">
        <div>
          <p className="text-[#9ca3af] text-sm font-medium">NFL · NHL · NBA</p>
          {lastPulledTimestamp && (
            <p className="text-[#9ca3af] text-xs mt-1">Last pulled: {lastPulledTimestamp.toLocaleString()}</p>
          )}
        </div>
        <RerunButton />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-full" style={{ tableLayout: 'auto' }}>
          <thead className="sticky top-0 z-10">
            <tr className="bg-[#1f2937] border-b border-[rgba(255,255,255,0.08)]">
              {headers.map((h, i) => (
                <th key={i} className="px-[18px] py-[14px] text-left text-[0.9rem] font-medium text-[#e5e7eb] uppercase tracking-wider whitespace-nowrap">
                  {h.replace('Arb Opportunity', 'Arbitrage Opportunity')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {transformedRows.map(({ data: row, sport }, i) => {
              const isOpportunity = row[5] === 'YES';
              const lowestAway = parseFloat(row[7]) || 0;
              const lowestHome = parseFloat(row[9]) || 0;
              const polyAway   = parseFloat(row[10]) || 0;
              const polyHome   = parseFloat(row[11]) || 0;
              const highlightCols = lowestAway + polyHome < polyAway + lowestHome ? [7, 11] : [10, 9];

              return (
                <tr key={i} className={`border-b border-[rgba(255,255,255,0.08)] transition-colors duration-150 ${
                  isOpportunity ? 'bg-[rgba(34,197,94,0.1)] hover:bg-[rgba(56,189,248,0.08)]'
                    : i % 2 === 0 ? 'bg-[#111827] hover:bg-[rgba(56,189,248,0.08)]'
                    : 'bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(56,189,248,0.08)]'
                }`}>
                  {row.map((cell, j) => {
                    let cls = 'px-[18px] py-5 text-sm text-[#e5e7eb] whitespace-nowrap';
                    if (isOpportunity) cls += ' font-semibold text-[#22c55e]';
                    if (isOpportunity && highlightCols.includes(j)) cls += ' text-[#fbbf24]';

                    if (j === 3) {
                      const parts = cell.split(' (A) @ ');
                      if (parts.length === 2) {
                        const away = parts[0], home = parts[1].replace(' (H)', '');
                        return (
                          <td key={j} className={cls}>
                            <span className="text-[#60a5fa] font-semibold mr-2">[{sport}]</span>
                            <span className="text-[#9ca3af]">{away}</span>
                            <span className="text-[#6b7280] mx-2">(A) @</span>
                            <span className="text-[#9ca3af]">{home}</span>
                            <span className="text-[#6b7280] ml-1">(H)</span>
                          </td>
                        );
                      }
                    }
                    return <td key={j} className={cls}>{cell}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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

function BetFastContent() {
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

  const idx = (name: string) => headers.indexOf(name);
  const dateIdx         = idx('Date');
  const timeIdx         = idx('Time');
  const sportIdx        = idx('Sport');
  const awayIdx         = idx('Away Team');
  const homeIdx         = idx('Home Team');
  const statusIdx       = idx('Status');
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

  const sportBadgeClass = (sport: string) => {
    if (sport === 'NBA') return 'bg-[rgba(96,165,250,0.2)] text-[#60a5fa]';
    if (sport === 'NHL') return 'bg-[rgba(20,184,166,0.2)] text-[#2dd4bf]';
    return 'bg-[rgba(251,146,60,0.2)] text-[#fb923c]'; // NFL
  };

  /** "Bulls@BFA + Clippers@Poly" → two styled spans */
  function renderStrategy(raw: string) {
    const parts = raw.split(' + ');
    if (parts.length !== 2) return <span className="text-[#9ca3af]">{raw}</span>;
    return (
      <div className="flex flex-col gap-0.5">
        {parts.map((part, i) => {
          const atIdx = part.lastIndexOf('@');
          if (atIdx === -1) return <span key={i} className="text-[#9ca3af]">{part}</span>;
          const team = part.slice(0, atIdx);
          const platform = part.slice(atIdx + 1);
          return (
            <span key={i} className="text-[#9ca3af]">
              <span className="font-semibold text-[#e5e7eb]">{team}</span>
              <span className="text-[#6b7280] text-xs"> @{platform}</span>
            </span>
          );
        })}
      </div>
    );
  }

  const tableHeaders = [
    'Best Option Cost', 'Date / Time', 'Sport', 'Game', 'Status', 'Arb Opportunity',
    'Strategy',
    'BFA Away', 'BFA Home',
    'Poly Away %', 'Poly Home %', 'Profit %',
    'BFA Bet ($)', 'Poly Bet ($)', 'Guar. P&L', 'Net Value',
  ];

  const cellBase = 'px-[18px] py-5 text-sm text-[#e5e7eb] whitespace-nowrap';

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
                const isOpportunity = (row[arbIdx] ?? '') === 'YES';
                const sport = row[sportIdx] ?? '';
                const away = row[awayIdx] ?? '';
                const home = row[homeIdx] ?? '';

                const rowCls = `border-b border-[rgba(255,255,255,0.08)] transition-colors duration-150 ${
                  isOpportunity
                    ? 'bg-[rgba(34,197,94,0.1)] hover:bg-[rgba(56,189,248,0.08)]'
                    : i % 2 === 0
                    ? 'bg-[#111827] hover:bg-[rgba(56,189,248,0.08)]'
                    : 'bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(56,189,248,0.08)]'
                }`;

                const textCls = isOpportunity ? `${cellBase} font-semibold text-[#22c55e]` : cellBase;

                return (
                  <tr key={i} className={rowCls}>
                    {/* Best Option Cost */}
                    <td className={`${textCls} font-mono`}>{row[costIdx] ?? '—'}</td>

                    {/* Date / Time */}
                    <td className={cellBase}>
                      <div className="text-[#e5e7eb]">{row[dateIdx] ?? ''}</div>
                      <div className="text-[#6b7280] text-xs">{(row[timeIdx] ?? '').replace(/:00 /, ' ')}</div>
                    </td>

                    {/* Sport badge */}
                    <td className={cellBase}>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${sportBadgeClass(sport)}`}>
                        {sport}
                      </span>
                    </td>

                    {/* Game */}
                    <td className={cellBase}>
                      <span className="text-[#9ca3af]">{away}</span>
                      <span className="text-[#6b7280] mx-2">(A) @</span>
                      <span className="text-[#9ca3af]">{home}</span>
                      <span className="text-[#6b7280] ml-1">(H)</span>
                    </td>

                    {/* Status */}
                    <td className={cellBase}>{row[statusIdx] ?? ''}</td>

                    {/* Arb Opportunity */}
                    <td className={textCls}>{row[arbIdx] ?? ''}</td>

                    {/* Strategy */}
                    <td className={cellBase}>
                      {strategyIdx >= 0 && row[strategyIdx]
                        ? renderStrategy(row[strategyIdx])
                        : <span className="text-[#6b7280]">—</span>}
                    </td>

                    {/* BFA Away: odds + implied combined */}
                    <td className={`${cellBase} font-mono`}>
                      {bfaAwayOddsIdx >= 0 && row[bfaAwayOddsIdx] ? (
                        <div>
                          <span className={parseFloat(row[bfaAwayOddsIdx]) > 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}>
                            {parseFloat(row[bfaAwayOddsIdx]) > 0 ? '+' : ''}{row[bfaAwayOddsIdx]}
                          </span>
                          <span className="text-[#6b7280] text-xs ml-1">({row[bfaAwayImpIdx]}%)</span>
                        </div>
                      ) : '—'}
                    </td>

                    {/* BFA Home: odds + implied combined */}
                    <td className={`${cellBase} font-mono`}>
                      {bfaHomeOddsIdx >= 0 && row[bfaHomeOddsIdx] ? (
                        <div>
                          <span className={parseFloat(row[bfaHomeOddsIdx]) > 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}>
                            {parseFloat(row[bfaHomeOddsIdx]) > 0 ? '+' : ''}{row[bfaHomeOddsIdx]}
                          </span>
                          <span className="text-[#6b7280] text-xs ml-1">({row[bfaHomeImpIdx]}%)</span>
                        </div>
                      ) : '—'}
                    </td>

                    {/* Poly Away */}
                    <td className={`${cellBase} font-mono text-[#a78bfa]`}>{row[polyAwayIdx] ?? '—'}</td>

                    {/* Poly Home */}
                    <td className={`${cellBase} font-mono text-[#a78bfa]`}>{row[polyHomeIdx] ?? '—'}</td>

                    {/* Profit % */}
                    <td className={`${textCls} font-mono`}>{row[profitIdx] ?? '—'}</td>

                    {/* BFA Bet ($) */}
                    <td className={`${cellBase} font-mono text-[#e5e7eb]`}>
                      {bfaBetIdx >= 0 && row[bfaBetIdx] ? `$${row[bfaBetIdx]}` : '—'}
                    </td>

                    {/* Poly Bet ($) */}
                    <td className={`${cellBase} font-mono text-[#a78bfa]`}>
                      {polyBetIdx >= 0 && row[polyBetIdx] ? `$${row[polyBetIdx]}` : '—'}
                    </td>

                    {/* Guaranteed P&L */}
                    <td className={`${cellBase} font-mono`}>
                      {pnlIdx >= 0 && row[pnlIdx] ? (() => {
                        const v = parseFloat(row[pnlIdx]);
                        return (
                          <span className={v >= 0 ? 'text-[#22c55e]' : 'text-[#f87171]'}>
                            {v >= 0 ? '+' : ''}${v.toFixed(2)}
                          </span>
                        );
                      })() : '—'}
                    </td>

                    {/* Net Value */}
                    <td className={`${cellBase} font-mono`}>
                      {netValIdx >= 0 && row[netValIdx] ? (() => {
                        const v = parseFloat(row[netValIdx]);
                        return v >= 0 ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[rgba(34,197,94,0.15)] text-[#22c55e]">
                            +${v.toFixed(2)}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[rgba(239,68,68,0.12)] text-[#f87171]">
                            ${v.toFixed(2)}
                          </span>
                        );
                      })() : '—'}
                    </td>
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
