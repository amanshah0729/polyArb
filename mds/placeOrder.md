# Placing Orders on Polymarket

## Two Separate Systems

| | polymarket.com (CLOB) | polymarket.us (Retail) |
|---|---|---|
| **Who it's for** | Global / desktop / DeFi users | US users via iOS app |
| **Auth method** | EIP-712 (Ethereum) + HMAC-SHA256 | Ed25519 signing |
| **Credentials** | Wallet private key → derive apiKey + secret + passphrase | API Key (base64) + Key ID (UUID) |
| **Order URL** | `https://clob.polymarket.com` | `https://api.polymarket.us` |
| **Market data URL** | `https://gamma-api.polymarket.com` | `https://api.polymarket.us` |
| **SDK available** | Yes (`@polymarket/clob-client`) | No official SDK |

> **Current `.env` credentials** look like **polymarket.us** credentials (Ed25519 key + UUID Key ID).
> If you want to use your desktop account, you'd use the **polymarket.com** CLOB API instead.

---

## Option A: polymarket.us (current .env credentials)

### Credentials in .env
```
POLYMARKET_KEY_ID=<UUID>       # goes in X-PM-Access-Key header
POLYMARKET_API_KEY=<base64>    # Ed25519 private key, used to sign requests
```

### Auth: Sign Every Request

Message to sign = `timestamp (ms) + METHOD + path`

Example: `1705420800000POST/v1/orders`

Required headers:
```
X-PM-Access-Key:  <POLYMARKET_KEY_ID>
X-PM-Timestamp:   <unix ms>
X-PM-Signature:   <base64 Ed25519 signature>
Content-Type:     application/json
```

### Place Order Endpoint
```
POST https://api.polymarket.us/v1/orders
```

### Request Body
```json
{
  "marketSlug": "nba-celtics-vs-knicks-2026-02-26",
  "type": "ORDER_TYPE_LIMIT",
  "price": { "value": "0.62", "currency": "USD" },
  "quantity": 50,
  "tif": "TIME_IN_FORCE_GOOD_TILL_CANCEL",
  "intent": "ORDER_INTENT_BUY_LONG",
  "manualOrderIndicator": "MANUAL_ORDER_INDICATOR_AUTOMATIC"
}
```

`intent` options: `ORDER_INTENT_BUY_LONG`, `ORDER_INTENT_SELL_LONG`, `ORDER_INTENT_BUY_SHORT`, `ORDER_INTENT_SELL_SHORT`

`tif` options: `TIME_IN_FORCE_GOOD_TILL_CANCEL`, `TIME_IN_FORCE_IMMEDIATE_OR_CANCEL`, `TIME_IN_FORCE_FILL_OR_KILL`

**YES vs NO pricing:** `price.value` is always the YES side. To buy NO: set `price.value = 1 - noPrice` with `ORDER_INTENT_BUY_SHORT`.

---

## Option B: polymarket.com CLOB (desktop account with wallet)

### Credentials needed
```
POLY_PRIVATE_KEY=<ethereum wallet private key>    # used for L1 signing + deriving L2 creds
# L2 creds derived from L1 (one-time setup):
POLY_API_KEY=<UUID>
POLY_SECRET=<base64 string>
POLY_PASSPHRASE=<string>
POLY_ADDRESS=<0x wallet address>
```

### Install SDK
```bash
npm install @polymarket/clob-client ethers
```

### Auth Flow (L1 → L2)

**Step 1 — Derive L2 credentials once (first time only):**
```js
const { ethers } = require('ethers');
const { ClobClient } = require('@polymarket/clob-client');

const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY);
const client = new ClobClient('https://clob.polymarket.com', 137, wallet);

// Derive and save these — you only need to do this once
const creds = await client.createApiKey();
console.log(creds); // { apiKey, secret, passphrase }
```

**Step 2 — Use L2 credentials for trading:**
```js
const client = new ClobClient(
  'https://clob.polymarket.com',
  137,            // Polygon mainnet chain ID
  wallet,
  {
    key: process.env.POLY_API_KEY,
    secret: process.env.POLY_SECRET,
    passphrase: process.env.POLY_PASSPHRASE
  }
);
```

### Place Order
```js
// Get token IDs from market data first
const market = await client.getMarket('<conditionId>');
const tokenId = market.tokens[0].token_id; // YES token

const order = await client.createAndPostOrder({
  tokenID: tokenId,
  price: 0.62,
  size: 50,
  side: 'BUY',
  feeRateBps: 0,
  nonce: 0,
  expiration: 0,    // 0 = GTC
  taker: '0x0000000000000000000000000000000000000000'
});
```

### L2 Request Headers (for manual HTTP requests)
```
POLY_ADDRESS:    <wallet address>
POLY_API_KEY:    <apiKey>
POLY_PASSPHRASE: <passphrase>
POLY_TIMESTAMP:  <unix seconds>
POLY_SIGNATURE:  <HMAC-SHA256 of timestamp+method+path+body using secret>
```

---

## Finding the marketSlug / conditionId

Both systems need you to identify the market. Your existing scripts hit `gamma-api.polymarket.com` which returns:
- `slug` → used as `marketSlug` in polymarket.us
- `conditionId` / `clobTokenIds` → used with polymarket.com CLOB

---

## Order Management (both systems)

### polymarket.us
| Method | Endpoint |
|---|---|
| POST | `/v1/order/preview` — validate before submitting |
| GET | `/v1/orders/open` |
| POST | `/v1/order/{id}/cancel` |
| POST | `/v1/orders/open/cancel` |

### polymarket.com CLOB
```js
await client.cancelOrder({ orderID: '<id>' });
await client.cancelAll();
const openOrders = await client.getOpenOrders();
```

---

## Rate Limits (polymarket.us)
- Global: 2,000 req / 10s
- Order placement: 400 req / 10s

---

## Which to use?

- **Phone/US account** → `polymarket.us` → credentials already in `.env`
- **Desktop/computer account** → `polymarket.com` CLOB → need wallet private key, then derive L2 creds
- For arbitrage, both work — polymarket.com CLOB has more liquidity and a better SDK
