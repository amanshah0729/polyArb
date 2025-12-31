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
    let scriptName;
    if (sport === 'nba') {
      scriptName = 'getNBAGames.js';
    } else if (sport === 'nfl') {
      scriptName = 'nfl/getNFLGames.js';
    } else if (sport === 'nhl') {
      scriptName = 'nhl/getNHLGames.js';
    }
    execSync(`node ${scriptName}`, { 
      stdio: 'inherit',
      cwd: scriptsDir 
    });
    console.log(`✓ ${sportUpper} sportsbook data fetched successfully`);
  } catch (error) {
    console.error(`✗ Error fetching ${sportUpper} sportsbook data`);
    console.error(`  Error details: ${error.message}`);
    return false;
  }

  // Step 2: Fetch Polymarket lines
  console.log(`\nStep 2/3: Fetching current ${sportUpper} lines from Polymarket...`);
  console.log('─'.repeat(60));
  try {
    let scriptName;
    if (sport === 'nba') {
      scriptName = 'getPolymarketNBA.js';
    } else if (sport === 'nfl') {
      scriptName = 'nfl/getPolymarketNFL.js';
    } else if (sport === 'nhl') {
      scriptName = 'nhl/getPolymarketNHL.js';
    }
    execSync(`node ${scriptName}`, { 
      stdio: 'inherit',
      cwd: scriptsDir 
    });
    console.log(`✓ ${sportUpper} Polymarket data fetched successfully`);
  } catch (error) {
    console.error(`✗ Error fetching ${sportUpper} Polymarket data`);
    console.error(`  Error details: ${error.message}`);
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
    console.error(`  Error details: ${error.message}`);
    return false;
  }
  
  return true;
}

// Run NBA pipeline
const nbaSuccess = runSportPipeline('nba', scriptsDir);

// Run NFL pipeline
const nflSuccess = runSportPipeline('nfl', nflDir);

// Run NHL pipeline
const nhlSuccess = runSportPipeline('nhl', path.join(__dirname, 'scripts', 'nhl'));

console.log('\n' + '='.repeat(60));
console.log('PIPELINE SUMMARY');
console.log('='.repeat(60));
console.log(`NBA: ${nbaSuccess ? '✓ Success' : '✗ Failed'}`);
console.log(`NFL: ${nflSuccess ? '✓ Success' : '✗ Failed'}`);
console.log(`NHL: ${nhlSuccess ? '✓ Success' : '✗ Failed'}`);
console.log('='.repeat(60));
if (nbaSuccess && nflSuccess && nhlSuccess) {
  console.log('Pipeline complete! Check outputs/final_arb/ for results.');
  console.log('Files: arb_nba_YYYY-MM-DD.csv, arb_nfl_YYYY-MM-DD.csv, and arb_nhl_YYYY-MM-DD.csv');
} else {
  console.log('Pipeline completed with some errors. Check output above for details.');
  console.log('Only successfully completed sports will have output files.');
}
console.log('='.repeat(60));

