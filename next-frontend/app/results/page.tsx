import fs from 'fs';
import path from 'path';

// Force dynamic rendering to prevent caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function Results() {
  const dir = path.join('c:', 'Users', '21rah', 'OneDrive', 'Documents', 'polyArb', 'outputs', 'final_arb');
  let files: string[] = [];
  try {
    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0];
    
    // Only read files from today
    const allFiles = fs.readdirSync(dir).filter((f: string) => f.startsWith('arb_') && f.endsWith('.csv'));
    
    // Filter to only today's files
    files = allFiles.filter((f: string) => f.includes(today)).sort();
    
    // If no files for today, get the most recent files for each sport
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
  } catch (error) {
    return (
      <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
        <div className="max-w-[1200px] mx-auto px-4">
          <div className="bg-[#111827] rounded-xl shadow-2xl border border-[rgba(255,255,255,0.08)] p-8 text-center">
            <h1 className="text-2xl font-bold text-[#e5e7eb] mb-2">Arbitrage Results</h1>
            <p className="text-[#9ca3af]">Error reading results directory.</p>
          </div>
        </div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
        <div className="max-w-[1200px] mx-auto px-4">
          <div className="bg-[#111827] rounded-xl shadow-2xl border border-[rgba(255,255,255,0.08)] p-8 text-center">
            <h1 className="text-2xl font-bold text-[#e5e7eb] mb-2">Arbitrage Results</h1>
            <p className="text-[#9ca3af]">No results found yet.</p>
          </div>
        </div>
      </div>
    );
  }

  // Combine all arbitrage data from all files
  const allRows: string[][] = [];
  let originalHeaders: string[] = [];

  files.forEach((file: string) => {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      if (lines.length > 0) {
        if (originalHeaders.length === 0) {
          originalHeaders = lines[0].split(',');
        }
        // Skip header and add data rows
        const dataRows = lines.slice(1).map((line: string) => line.split(','));
        allRows.push(...dataRows);
      }
    } catch (error) {
      console.error(`Error reading file ${file}:`, error);
    }
  });

  // Find column indices
  const getColumnIndex = (name: string) => {
    return originalHeaders.findIndex(h => h.replace(/"/g, '').trim() === name);
  };

  const bestOptionCostIdx = getColumnIndex('Best Option Cost');
  const awayTeamIdx = getColumnIndex('Away Team');
  const homeTeamIdx = getColumnIndex('Home Team');
  const dateIdx = getColumnIndex('Date');
  const timeIdx = getColumnIndex('Time');
  const statusIdx = getColumnIndex('Status');
  const arbOppIdx = getColumnIndex('Arb Opportunity');
  const lowestAwayBookIdx = getColumnIndex('Lowest Away Bookmaker');
  const lowestAwayImpliedIdx = getColumnIndex('Lowest Away Implied Prob (%)');
  const lowestHomeBookIdx = getColumnIndex('Lowest Home Bookmaker');
  const lowestHomeImpliedIdx = getColumnIndex('Lowest Home Implied Prob (%)');
  const polyAwayImpliedIdx = getColumnIndex('Polymarket Away Implied Prob (%)');
  const polyHomeImpliedIdx = getColumnIndex('Polymarket Home Implied Prob (%)');
  const profitIdx = getColumnIndex('Profit %');

  // Create new headers with Best Option Cost first, and Game instead of Away/Home Team
  const headers = [
    'Best Option Cost',
    'Date',
    'Time',
    'Game',
    'Status',
    'Arb Opportunity',
    'Lowest Away Bookmaker',
    'Lowest Away Implied Prob (%)',
    'Lowest Home Bookmaker',
    'Lowest Home Implied Prob (%)',
    'Polymarket Away Implied Prob (%)',
    'Polymarket Home Implied Prob (%)',
    'Profit %'
  ];

  // Transform rows to match new column order
  const transformedRows = allRows.map((row: string[]) => {
    const cleanCell = (cell: string) => cell.replace(/"/g, '').trim();
    
    return [
      bestOptionCostIdx >= 0 ? cleanCell(row[bestOptionCostIdx]) : '',
      dateIdx >= 0 ? cleanCell(row[dateIdx]) : '',
      timeIdx >= 0 ? cleanCell(row[timeIdx]).replace(/:00 /, ' ') : '',
      awayTeamIdx >= 0 && homeTeamIdx >= 0 
        ? `${cleanCell(row[awayTeamIdx])} vs ${cleanCell(row[homeTeamIdx])}`
        : '',
      statusIdx >= 0 ? cleanCell(row[statusIdx]) : '',
      arbOppIdx >= 0 ? cleanCell(row[arbOppIdx]) : '',
      lowestAwayBookIdx >= 0 ? cleanCell(row[lowestAwayBookIdx]) : '',
      lowestAwayImpliedIdx >= 0 ? cleanCell(row[lowestAwayImpliedIdx]) : '',
      lowestHomeBookIdx >= 0 ? cleanCell(row[lowestHomeBookIdx]) : '',
      lowestHomeImpliedIdx >= 0 ? cleanCell(row[lowestHomeImpliedIdx]) : '',
      polyAwayImpliedIdx >= 0 ? cleanCell(row[polyAwayImpliedIdx]) : '',
      polyHomeImpliedIdx >= 0 ? cleanCell(row[polyHomeImpliedIdx]) : '',
      profitIdx >= 0 ? cleanCell(row[profitIdx]) : ''
    ];
  });

  if (allRows.length === 0) {
    return (
      <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
        <div className="max-w-[1200px] mx-auto px-4">
          <div className="bg-[#111827] rounded-xl shadow-2xl border border-[rgba(255,255,255,0.08)] p-8 text-center">
            <h1 className="text-2xl font-bold text-[#e5e7eb] mb-2">Arbitrage Results</h1>
            <p className="text-[#9ca3af]">No arbitrage data found.</p>
          </div>
        </div>
      </div>
    );
  }

  // Sort rows so YES opportunities come first (Arb Opportunity is now at index 5)
  transformedRows.sort((a: string[], b: string[]) => {
    const aIsYes = a[5] === 'YES';
    const bIsYes = b[5] === 'YES';
    if (aIsYes && !bIsYes) return -1;
    if (!aIsYes && bIsYes) return 1;
    return 0;
  });

  return (
    <div className="min-h-screen bg-[#0f172a] py-12 px-4">
      <div className="max-w-[1200px] mx-auto">
        <div className="bg-[#111827] rounded-xl shadow-2xl border border-[rgba(255,255,255,0.08)] transition-all">
          <div className="bg-[#1f2937] px-8 py-6 border-b border-[rgba(255,255,255,0.08)]">
            <h1 className="text-4xl font-bold text-[#e5e7eb] mb-2 tracking-tight">Arbitrage Results</h1>
            <p className="text-[#9ca3af] text-sm font-medium">NFL, NHL, NBA</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-full" style={{ tableLayout: 'auto' }}>
              <thead className="sticky top-0 z-10">
                <tr className="bg-[#1f2937] border-b border-[rgba(255,255,255,0.08)]">
                  {headers.map((h: string, i: number) => (
                    <th 
                      key={i} 
                      className="px-[18px] py-[14px] text-left text-[0.9rem] font-medium text-[#e5e7eb] uppercase tracking-wider whitespace-nowrap leading-[1.4]"
                    >
                      {h.replace('Arb Opportunity', 'Arbitrage Opportunity')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transformedRows.map((row: string[], i: number) => {
                  const isOpportunity = row[5] === 'YES';
                  
                  // Calculate which combination has the smallest sum
                  // Column indices: 7=Lowest Away, 9=Lowest Home, 10=Poly Away, 11=Poly Home
                  const lowestAway = parseFloat(row[7]) || 0;
                  const lowestHome = parseFloat(row[9]) || 0;
                  const polyAway = parseFloat(row[10]) || 0;
                  const polyHome = parseFloat(row[11]) || 0;
                  
                  // Combination A: Lowest Away + Polymarket Home
                  const combinationA = lowestAway + polyHome;
                  // Combination B: Polymarket Away + Lowest Home
                  const combinationB = polyAway + lowestHome;
                  
                  // Determine which columns to highlight based on smallest combination
                  const highlightColumns: number[] = [];
                  if (combinationA < combinationB) {
                    // Highlight: Lowest Away (7) and Polymarket Home (11)
                    highlightColumns.push(7, 11);
                  } else {
                    // Highlight: Polymarket Away (10) and Lowest Home (9)
                    highlightColumns.push(10, 9);
                  }
                  
                  return (
                    <tr 
                      key={i} 
                      className={`border-b border-[rgba(255,255,255,0.08)] transition-[background-color] duration-200 ease-in-out ${
                        isOpportunity 
                          ? 'bg-[rgba(34,197,94,0.1)] hover:bg-[rgba(56,189,248,0.08)]' 
                          : i % 2 === 0 
                            ? 'bg-[#111827] hover:bg-[rgba(56,189,248,0.08)]' 
                            : 'bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(56,189,248,0.08)]'
                      }`}
                    >
                      {row.map((cell: string, j: number) => {
                        let cellClass = "px-[18px] py-5 text-sm text-[#e5e7eb] whitespace-nowrap";
                        if (isOpportunity) {
                          cellClass += " font-semibold text-[#22c55e]";
                        }
                        // Highlight the columns that form the best combination (smallest sum)
                        if (isOpportunity && highlightColumns.includes(j)) {
                          cellClass += " text-[#fbbf24]";
                        }
                        return (
                          <td key={j} className={cellClass}>
                            {cell}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}