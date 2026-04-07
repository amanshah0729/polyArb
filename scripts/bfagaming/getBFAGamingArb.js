/**
 * BFAGaming ↔ Polymarket Arbitrage Scanner — CLI
 *
 * Usage:  node scripts/bfagaming/getBFAGamingArb.js [--rollover-remaining N] [--bankroll N]
 */

const fs = require('fs');
const path = require('path');
const { runScan } = require('./scan');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const rolloverRemainingArg = args.indexOf('--rollover-remaining');
const rolloverRemaining = rolloverRemainingArg !== -1
  ? parseFloat(args[rolloverRemainingArg + 1]) || 4800
  : 4800;
const bankrollArg = args.indexOf('--bankroll');
const bankroll = bankrollArg !== -1
  ? parseFloat(args[bankrollArg + 1]) || 300
  : 300;

const OUT_DIR = path.join(__dirname, '..', '..', 'outputs', 'bfagaming');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  console.log('═'.repeat(60));
  console.log('  BFAGaming ↔ Polymarket Arbitrage Scanner (via Predexon)');
  console.log('═'.repeat(60));
  console.log(`  Rollover remaining: $${rolloverRemaining}  Bankroll: $${bankroll}`);

  const allResults = await runScan({ rolloverRemaining, bankroll });

  // Build CSV
  const csvHeader = [
    'Date', 'Time', 'Sport', 'Market Type', 'Line',
    'Away Team', 'Home Team', 'Status',
    'Arb Opportunity', 'Strategy',
    'BFAGaming Away Odds', 'BFAGaming Away Implied (%)',
    'BFAGaming Home Odds', 'BFAGaming Home Implied (%)',
    'Polymarket Away Implied (%)', 'Polymarket Home Implied (%)',
    'Profit %', 'Best Option Cost',
    'BFA Bet ($)', 'Poly Bet ($)', 'Guaranteed P&L ($)', 'Net Value ($)',
  ].join(',');

  const csvRows = allResults.map((r) => [
    `"${r.date}"`,
    `"${r.time}"`,
    `"${r.sport}"`,
    `"${r.marketType}"`,
    `"${r.line}"`,
    `"${r.awayTeam}"`,
    `"${r.homeTeam}"`,
    `"${r.status}"`,
    `"${r.hasArb ? 'YES' : 'NO'}"`,
    `"${r.strategy}"`,
    r.bfaAwayOdds,
    (r.bfaAwayImplied * 100).toFixed(2),
    r.bfaHomeOdds,
    (r.bfaHomeImplied * 100).toFixed(2),
    (r.polyAwayImplied * 100).toFixed(2),
    (r.polyHomeImplied * 100).toFixed(2),
    r.profitPct.toFixed(2),
    r.bestCost.toFixed(4),
    r.bfaBet.toFixed(2),
    r.polyBet.toFixed(2),
    r.guaranteedPnl.toFixed(2),
    r.netValue.toFixed(2),
  ].join(','));

  const today = new Date().toISOString().split('T')[0];
  const outPath = path.join(OUT_DIR, `arb_bfagaming_${today}.csv`);
  fs.writeFileSync(outPath, [csvHeader, ...csvRows].join('\n'), 'utf8');

  console.log(`\nSaved → ${outPath}`);
  console.log(`Total games: ${allResults.length}   Arb: ${allResults.filter((r) => r.hasArb).length}`);
}

main().catch((err) => { console.error('\nFatal:', err.message); process.exit(1); });
