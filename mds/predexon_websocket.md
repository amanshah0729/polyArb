> ## Documentation Index
> Fetch the complete documentation index at: https://docs.predexon.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Overview

> Real-time Polymarket trade, activity, and lifecycle events via WebSocket

<Info>
  **Get your API key** at [dashboard.predexon.com](https://dashboard.predexon.com) — required for WebSocket connections.
</Info>

Real-time streaming of Polymarket on-chain events including trades, position activity, and market lifecycle events. Subscribe to specific wallets, markets, or the entire platform with wildcard subscriptions.

## Use Cases

<CardGroup cols={2}>
  <Card title="Copytrading" icon="users">
    Subscribe to top traders' wallets and get instant notifications when they make trades to mirror their positions.
  </Card>

  <Card title="Market Monitoring" icon="chart-line">
    Track specific markets for price movements, trading activity, and resolution events in real-time.
  </Card>

  <Card title="Portfolio Alerts" icon="bell">
    Monitor your own wallet for trade confirmations, splits, merges, and redemptions.
  </Card>

  <Card title="Analytics & Research" icon="magnifying-glass-chart">
    Stream all events with wildcard subscriptions (Pro) to build datasets, analyze market dynamics, and identify trends.
  </Card>
</CardGroup>

## Quick Start

```javascript  theme={null}
const ws = new WebSocket('wss://wss.predexon.com/v1/your_api_key');

ws.onopen = () => {
  ws.send(JSON.stringify({
    action: 'subscribe',
    platform: 'polymarket',
    version: 1,
    type: 'orders',
    filters: { users: ['0x1234...'] }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'event') {
    console.log('Trade:', msg.data);
  }
};
```

## Connection

### Endpoint

```
wss://wss.predexon.com/v1/YOUR_API_KEY
```

On successful connection, the server sends:

```json  theme={null}
{
  "type": "connected",
  "message": "Connected to Predexon WebSocket"
}
```

### Connection Errors

| HTTP Status | Reason                                       |
| ----------- | -------------------------------------------- |
| 401         | Missing or invalid API key                   |
| 403         | WebSocket access requires Dev plan or higher |
| 429         | Connection limit exceeded for your plan      |
| 503         | Server at capacity                           |

## Channels

| Channel   | `type` value  | Description                                                                                  |
| --------- | ------------- | -------------------------------------------------------------------------------------------- |
| Trades    | `"orders"`    | Order fills and fee refunds. Supports [pending (mempool) events](/websocket/pending-trades). |
| Activity  | `"activity"`  | Position splits, merges, and redemptions                                                     |
| Lifecycle | `"lifecycle"` | New market registration and condition resolution                                             |

### Filter Availability by Channel

| Filter           | Trades (`orders`) | Activity (`activity`) | Lifecycle (`lifecycle`) |
| ---------------- | :---------------: | :-------------------: | :---------------------: |
| `users`          |        Yes        |          Yes          |            No           |
| `condition_ids`  |        Yes        |          Yes          |           Yes           |
| `market_slugs`   |        Yes        |           No          |            No           |
| Wildcard `["*"]` |        Yes        |          Yes          |           Yes           |

## Plan Limits

| Limit                                | Dev         | Pro           | Enterprise |
| ------------------------------------ | ----------- | ------------- | ---------- |
| Subscriptions per connection         | 10          | 100           | Custom     |
| Items per subscription               | 10          | 500           | Custom     |
| Total items across all subscriptions | 100         | 50,000        | Custom     |
| Wildcard subscriptions               | Not allowed | 2 per channel | Allowed    |
| Priority routing (dedicated node)    | No          | No            | Yes        |

<Note>
  **Free tier does not include WebSocket access.** Upgrade to Dev (\$49/mo) or higher to use WebSocket streaming.
</Note>

Subscription and item limits are global across all channels — not per-channel. Wildcard connections are tracked per-channel (e.g. a wildcard on `orders` does not count against your `activity` wildcard limit).

<Warning>
  A wildcard connection cannot mix wildcard and regular subscriptions on the same channel.
</Warning>

## Keepalive & Connection Management

* The server sends a WebSocket **ping every 30 seconds**. Your client must respond with a pong (most WebSocket libraries handle this automatically).
* If no pong is received within **60 seconds**, the connection is closed.
* If a connection has **zero active subscriptions for 2 minutes**, it is closed with close code `4000`.
* If the client is consuming events too slowly and the server-side outbound buffer exceeds **1 MB**, new events will be dropped. If it exceeds **4 MB**, the connection is terminated.

## Error Handling

All errors follow this format:

```json  theme={null}
{
  "type": "error",
  "code": "ERROR_CODE",
  "message": "Human-readable error message"
}
```

### Error Codes

| Code                        | Description                                                            |
| --------------------------- | ---------------------------------------------------------------------- |
| `AUTH_REQUIRED`             | No API key provided                                                    |
| `AUTH_FAILED`               | API key not found or invalid                                           |
| `CONNECTION_LIMIT`          | Server-wide connection cap reached                                     |
| `WILDCARD_CONNECTION_LIMIT` | Wildcard connection limit for your key exceeded                        |
| `SUBSCRIPTION_LIMIT`        | Maximum subscriptions reached                                          |
| `ITEMS_PER_SUB_LIMIT`       | Too many items in single subscription                                  |
| `ITEMS_LIMIT`               | Maximum total items reached                                            |
| `WILDCARD_NOT_ALLOWED`      | Your plan does not support wildcard subscriptions                      |
| `INVALID_FILTERS`           | Missing or invalid filter, or filter not supported on this channel     |
| `SUBSCRIPTION_NOT_FOUND`    | Subscription ID doesn't exist                                          |
| `PARSE_ERROR`               | Invalid JSON message                                                   |
| `UNKNOWN_ACTION`            | Unrecognized action field                                              |
| `PLAN_REQUIRED`             | Feature requires a higher plan (e.g. pending trade events require Pro) |
| `RATE_LIMIT`                | Client is sending messages too fast                                    |


Built with [Mintlify](https://mintlify.com).