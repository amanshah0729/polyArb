/**
 * One-time script to derive Polymarket CLOB API credentials from your Ethereum wallet.
 *
 * Usage:
 *   1. Set POLY_PRIVATE_KEY in .env (your Ethereum wallet private key, 0x...)
 *   2. node scripts/polymarket/deriveCredentials.js
 *   3. Copy the printed values into .env as POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { ethers } = require('ethers');
const { ClobClient } = require('@polymarket/clob-client');

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

async function main() {
  const privateKey = process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    console.error('Error: POLY_PRIVATE_KEY is not set in .env');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey);
  console.log('Wallet address:', wallet.address);

  const client = new ClobClient(HOST, CHAIN_ID, wallet);

  console.log('\nDeriving API credentials...');
  // createOrDeriveApiKey: creates a new key if none exists, otherwise derives the existing one
  const creds = await client.createOrDeriveApiKey();

  console.log('\n--- Add these to your .env ---');
  console.log(`POLY_ADDRESS=${wallet.address}`);
  console.log(`POLY_API_KEY=${creds.key}`);
  console.log(`POLY_SECRET=${creds.secret}`);
  console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
  console.log('------------------------------\n');
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
