require('dotenv').config();
const { execSync } = require('child_process');

console.log('='.repeat(60));
console.log('Sports Arbitrage Finder — Unified Pipeline');
console.log('='.repeat(60));

try {
  execSync('node scripts/sportsbookArb.js', {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('\nPipeline complete! Check outputs/final_arb/ for results.');
} catch (error) {
  console.error('\nPipeline failed:', error.message);
  process.exit(1);
}
