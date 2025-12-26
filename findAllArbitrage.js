require('dotenv').config();
const { execSync } = require('child_process');
const path = require('path');

console.log('='.repeat(60));
console.log('NBA Arbitrage Finder - Complete Pipeline');
console.log('='.repeat(60));
console.log('');

const scriptsDir = path.join(__dirname, 'scripts');

// Step 1: Fetch sportsbook lines
console.log('Step 1/3: Fetching current NBA lines from sportsbooks...');
console.log('─'.repeat(60));
try {
  execSync('node getNBAGames.js', { 
    stdio: 'inherit',
    cwd: scriptsDir 
  });
  console.log('✓ Sportsbook data fetched successfully\n');
} catch (error) {
  console.error('✗ Error fetching sportsbook data');
  process.exit(1);
}

// Step 2: Fetch Polymarket lines
console.log('Step 2/3: Fetching current NBA lines from Polymarket...');
console.log('─'.repeat(60));
try {
  execSync('node getPolymarketNBA.js', { 
    stdio: 'inherit',
    cwd: scriptsDir 
  });
  console.log('✓ Polymarket data fetched successfully\n');
} catch (error) {
  console.error('✗ Error fetching Polymarket data');
  process.exit(1);
}

// Step 3: Find arbitrage opportunities
console.log('Step 3/3: Analyzing arbitrage opportunities...');
console.log('─'.repeat(60));
try {
  execSync('node findArbitrage.js', { 
    stdio: 'inherit',
    cwd: scriptsDir 
  });
  console.log('✓ Arbitrage analysis complete\n');
} catch (error) {
  console.error('✗ Error analyzing arbitrage opportunities');
  process.exit(1);
}

console.log('='.repeat(60));
console.log('Pipeline complete! Check outputs/final_arb/ for results.');
console.log('='.repeat(60));

