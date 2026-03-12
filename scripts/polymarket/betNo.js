/**
 * Place a BUY NO order on: "Will the US confirm that aliens exist before 2027?"
 * https://polymarket.com/event/will-the-us-confirm-that-aliens-exist-before-2027
 *
 * Usage:
 *   node scripts/polymarket/betNo.js
 *   node scripts/polymarket/betNo.js --size 25
 *   node scripts/polymarket/betNo.js --price 0.80 --size 10
 *
 * Requires .env:
 *   POLY_PRIVATE_KEY, POLY_ADDRESS, POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE
 *   (run scripts/polymarket/deriveCredentials.js first if you don't have L2 creds)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { ethers } = require('ethers');
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

// Market: "Will the US confirm that aliens exist before 2027?"
const CONDITION_ID = '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75';
const NO_TOKEN_ID  = '7305630249804085635496399869905769372294302716159034447326228509068694952392';
const TICK_SIZE    = '0.01';

// Parse CLI args: --size <n> --price <n>
function parseArgs() {
  const args = process.argv.slice(2);
  let size  = 5;     // default: 5 shares (minimum)
  let price = null;  // null = fetch live ask price

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--size'  && args[i + 1]) size  = parseFloat(args[++i]);
    if (args[i] === '--price' && args[i + 1]) price = parseFloat(args[++i]);
  }
  return { size, price };
}

async function main() {
  const { size, price: cliPrice } = parseArgs();

  // Validate credentials
  for (const key of ['POLY_PRIVATE_KEY', 'POLY_ADDRESS', 'POLY_API_KEY', 'POLY_SECRET', 'POLY_PASSPHRASE']) {
    if (!process.env[key]) {
      console.error(`Error: ${key} is not set in .env`);
      if (key === 'POLY_API_KEY') console.error('Run: node scripts/polymarket/deriveCredentials.js');
      process.exit(1);
    }
  }

  const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY);
  const creds = {
    key:        process.env.POLY_API_KEY,
    secret:     process.env.POLY_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
  };

  const client = new ClobClient(HOST, CHAIN_ID, wallet, creds);

  // Confirm market is open and get live price if not specified
  console.log('Fetching market data...');
  const market = await client.getMarket(CONDITION_ID);
  if (!market || !market.active) {
    console.error('Market is not active or not found.');
    process.exit(1);
  }
  console.log(`Market: ${market.question}`);
  console.log(`Status: ${market.closed ? 'CLOSED' : 'OPEN'} | Accepting orders: ${market.accepting_orders}`);

  if (!market.accepting_orders) {
    console.error('Market is not currently accepting orders.');
    process.exit(1);
  }

  // Find NO token price from market tokens
  const noToken = (market.tokens || []).find(t => t.outcome === 'No');
  const liveNoPrice = noToken ? noToken.price : null;

  // Use CLI price, or live price rounded to tick, or fallback to 0.82
  let price = cliPrice;
  if (!price) {
    if (liveNoPrice) {
      price = Math.round(liveNoPrice / 0.01) * 0.01;
      console.log(`Live NO price: ${liveNoPrice} → using ${price}`);
    } else {
      price = 0.82;
      console.log(`Could not fetch live price, using fallback: ${price}`);
    }
  }

  console.log(`\nPlacing order:`);
  console.log(`  Token:  NO (${NO_TOKEN_ID.slice(0, 16)}...)`);
  console.log(`  Side:   BUY`);
  console.log(`  Price:  ${price}`);
  console.log(`  Size:   ${size} shares`);
  console.log(`  Cost:   ~$${(price * size).toFixed(2)}`);
  console.log(`  Type:   GTC (limit order)\n`);

  const order = {
    tokenID: NO_TOKEN_ID,
    price,
    size,
    side: Side.BUY,
  };

  const options = {
    tickSize: TICK_SIZE,
    negRisk: false,
  };

  const result = await client.createAndPostOrder(order, options, OrderType.GTC);

  if (result && result.orderID) {
    console.log('Order placed successfully!');
    console.log(`  Order ID: ${result.orderID}`);
    console.log(`  Status:   ${result.status}`);
    if (result.takingAmount) console.log(`  Filled:   ${result.takingAmount} shares`);
  } else {
    console.log('Response:', JSON.stringify(result, null, 2));
  }
}

main().catch(err => {
  console.error('Error:', err.message || err);
  if (err.response) console.error('API response:', JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
