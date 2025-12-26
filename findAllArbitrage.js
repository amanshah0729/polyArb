require('dotenv').config();
const { execSync } = require('child_process');
const path = require('path');

console.log('='.repeat(60));
console.log('Sports Arbitrage Finder - Complete Pipeline');
console.log('='.repeat(60));
console.log('');

const scriptsDir = path.join(__dirname, 'scripts');
const nflDir = path.join(__dirname, 'scripts', 'nfl');

/**
 * Run pipeline for a specific sport
 */
function runSportPipeline(sport, sportDir) {
  const sportUpper = sport.toUpperCase();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${sportUpper} PIPELINE`);
  console.log('='.repeat(60));
  
  // Step 1: Fetch sportsbook lines
  console.log(`\nStep 1/3: Fetching current ${sportUpper} lines from sportsbooks...`);
  console.log('─'.repeat(60));
  try {
    const scriptName = sport === 'nba' ? 'getNBAGames.js' : 'nfl/getNFLGames.js';
    execSync(`node ${scriptName}`, { 
      stdio: 'inherit',
      cwd: scriptsDir 
    });
    console.log(`✓ ${sportUpper} sportsbook data fetched successfully`);
  } catch (error) {
    console.error(`✗ Error fetching ${sportUpper} sportsbook data`);
    return false;
  }

  // Step 2: Fetch Polymarket lines
  console.log(`\nStep 2/3: Fetching current ${sportUpper} lines from Polymarket...`);
  console.log('─'.repeat(60));
  try {
    const scriptName = sport === 'nba' ? 'getPolymarketNBA.js' : 'nfl/getPolymarketNFL.js';
    execSync(`node ${scriptName}`, { 
      stdio: 'inherit',
      cwd: scriptsDir 
    });
    console.log(`✓ ${sportUpper} Polymarket data fetched successfully`);
  } catch (error) {
    console.error(`✗ Error fetching ${sportUpper} Polymarket data`);
    return false;
  }

  // Step 3: Find arbitrage opportunities
  console.log(`\nStep 3/3: Analyzing ${sportUpper} arbitrage opportunities...`);
  console.log('─'.repeat(60));
  try {
    execSync(`node findArbitrage.js ${sport}`, { 
      stdio: 'inherit',
      cwd: scriptsDir 
    });
    console.log(`✓ ${sportUpper} arbitrage analysis complete`);
  } catch (error) {
    console.error(`✗ Error analyzing ${sportUpper} arbitrage opportunities`);
    return false;
  }
  
  return true;
}

// Run NBA pipeline
const nbaSuccess = runSportPipeline('nba', scriptsDir);

// Run NFL pipeline
const nflSuccess = runSportPipeline('nfl', nflDir);

console.log('\n' + '='.repeat(60));
if (nbaSuccess && nflSuccess) {
  console.log('Pipeline complete! Check outputs/final_arb/ for results.');
  console.log('Files: arb_nba_YYYY-MM-DD.csv and arb_nfl_YYYY-MM-DD.csv');
} else {
  console.log('Pipeline completed with some errors. Check output above.');
}
console.log('='.repeat(60));

