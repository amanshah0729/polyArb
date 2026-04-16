const eventLog = require('./eventLog');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function aggregate(sinceMs = Date.now() - 7 * DAY) {
  const events = eventLog.readRange(sinceMs);

  const scans = events.filter((e) => e.type === 'scan');
  const arbsFound = events.filter((e) => e.type === 'arb_found');
  const attempts = events.filter((e) => e.type === 'attempt');
  const finals = events.filter((e) => e.type === 'final');
  const alarms = events.filter((e) => e.type === 'alarm');

  // Tally finals
  let filledBoth = 0, polyOnlyUnwound = 0, polyOnlyStuck = 0, falseArb = 0, skipped = 0;
  let grossPnl = 0, realizedPnl = 0, unwindLoss = 0;
  const recentFinals = [];
  for (const f of finals) {
    if (f.outcome === 'filled_both') {
      filledBoth++;
      grossPnl += Number(f.guaranteedPnl ?? 0);
      realizedPnl += Number(f.guaranteedPnl ?? 0);
    } else if (f.outcome === 'poly_unwound') {
      polyOnlyUnwound++;
      unwindLoss += Number(f.unwindLoss ?? 0);
      realizedPnl -= Number(f.unwindLoss ?? 0);
    } else if (f.outcome === 'poly_stuck') {
      polyOnlyStuck++;
    } else if (f.outcome === 'false_arb') {
      falseArb++;
    } else if (f.outcome === 'skipped') {
      skipped++;
    }
    if (recentFinals.length < 50) recentFinals.push(f);
  }

  // Scan cadence + recent scans
  const now = Date.now();
  const scans24h = scans.filter((s) => now - s.t < DAY).length;
  const scans1h = scans.filter((s) => now - s.t < HOUR).length;
  const arbs24h = arbsFound.filter((a) => now - a.t < DAY).length;
  const arbs1h  = arbsFound.filter((a) => now - a.t < HOUR).length;
  const lastScan = scans[scans.length - 1] ?? null;
  const recentScans = scans.slice(-20).reverse();

  // Fill details
  const polyFilled = events.filter((e) => e.type === 'poly_filled');
  const bfaFilled = events.filter((e) => e.type === 'bfa_filled');
  const recentFills = [...polyFilled, ...bfaFilled]
    .sort((a, b) => b.t - a.t).slice(0, 30);

  return {
    windowFromMs: sinceMs,
    generatedAt: now,

    scans: {
      total: scans.length,
      last24h: scans24h,
      last1h: scans1h,
      lastScanAt: lastScan?.timestamp ?? null,
      lastScanGamesChecked: lastScan?.gamesChecked ?? null,
      lastScanArbsFound: lastScan?.arbsFound ?? null,
    },
    arbsFound: {
      total: arbsFound.length,
      last24h: arbs24h,
      last1h: arbs1h,
    },
    attempts: {
      total: attempts.length,
      filledBoth,
      polyOnlyUnwound,
      polyOnlyStuck,
      falseArb,
      skipped,
    },
    pnl: {
      grossPnl,
      realizedPnl,
      unwindLoss,
    },
    alarmsCount: alarms.length,
    recentScans,
    recentFills,
    recentFinals,
  };
}

module.exports = { aggregate };
