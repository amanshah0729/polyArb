market
Get Markets
Filter by market status. Possible values: unopened, open, closed, settled. Leave empty to return markets with any status.

Only one status filter may be supplied at a time.
Timestamp filters will be mutually exclusive from other timestamp filters and certain status filters.
Compatible Timestamp Filters	Additional Status Filters	Extra Notes
min_created_ts, max_created_ts	unopened, open, empty	
min_close_ts, max_close_ts	closed, empty	
min_settled_ts, max_settled_ts	settled, empty	
min_updated_ts	empty	Incompatible with all filters besides mve_filter=exclude
GET
/
markets

Try it
Query Parameters
​
limit
integer<int64>default:100
Number of results per page. Defaults to 100. Maximum value is 1000.

Required range: 1 <= x <= 1000
​
cursor
string
Pagination cursor. Use the cursor value returned from the previous response to get the next page of results. Leave empty for the first page.

​
event_ticker
string
Event ticker of desired positions. Multiple event tickers can be provided as a comma-separated list (maximum 10).

​
series_ticker
string
Filter by series ticker

​
min_created_ts
integer<int64>
Filter items that created after this Unix timestamp

​
max_created_ts
integer<int64>
Filter items that created before this Unix timestamp

​
min_updated_ts
integer<int64>
Return markets updated later than this Unix timestamp. Incompatible with any other filters.

​
max_close_ts
integer<int64>
Filter items that close before this Unix timestamp

​
min_close_ts
integer<int64>
Filter items that close after this Unix timestamp

​
min_settled_ts
integer<int64>
Filter items that settled after this Unix timestamp

​
max_settled_ts
integer<int64>
Filter items that settled before this Unix timestamp

​
status
enum<string>
Filter by market status. Leave empty to return markets with any status.

Available options: unopened, open, paused, closed, settled 
​
tickers
string
Filter by specific market tickers. Comma-separated list of market tickers to retrieve.

​
mve_filter
enum<string>
Filter by multivariate events (combos). 'only' returns only multivariate events, 'exclude' excludes multivariate events.

Available options: only, exclude 
Response

200

application/json
Markets retrieved successfully

​
markets
object[]required
Show child attributes

​
cursor
stringrequired



RESPONSE:
{
  "markets": [
    {
      "ticker": "<string>",
      "event_ticker": "<string>",
      "market_type": "binary",
      "title": "<string>",
      "subtitle": "<string>",
      "yes_sub_title": "<string>",
      "no_sub_title": "<string>",
      "created_time": "2023-11-07T05:31:56Z",
      "updated_time": "2023-11-07T05:31:56Z",
      "open_time": "2023-11-07T05:31:56Z",
      "close_time": "2023-11-07T05:31:56Z",
      "expiration_time": "2023-11-07T05:31:56Z",
      "latest_expiration_time": "2023-11-07T05:31:56Z",
      "settlement_timer_seconds": 123,
      "status": "initialized",
      "response_price_units": "usd_cent",
      "yes_bid": 123,
      "yes_bid_dollars": "0.5600",
      "yes_ask": 123,
      "yes_ask_dollars": "0.5600",
      "no_bid": 123,
      "no_bid_dollars": "0.5600",
      "no_ask": 123,
      "no_ask_dollars": "0.5600",
      "last_price": 123,
      "last_price_dollars": "0.5600",
      "volume": 123,
      "volume_fp": "10.00",
      "volume_24h": 123,
      "volume_24h_fp": "10.00",
      "result": "yes",
      "can_close_early": true,
      "open_interest": 123,
      "open_interest_fp": "10.00",
      "notional_value": 123,
      "notional_value_dollars": "0.5600",
      "previous_yes_bid": 123,
      "previous_yes_bid_dollars": "0.5600",
      "previous_yes_ask": 123,
      "previous_yes_ask_dollars": "0.5600",
      "previous_price": 123,
      "previous_price_dollars": "0.5600",
      "liquidity": 123,
      "liquidity_dollars": "0.5600",
      "expiration_value": "<string>",
      "tick_size": 123,
      "rules_primary": "<string>",
      "rules_secondary": "<string>",
      "price_level_structure": "<string>",
      "price_ranges": [
        {
          "start": "<string>",
          "end": "<string>",
          "step": "<string>"
        }
      ],
      "expected_expiration_time": "2023-11-07T05:31:56Z",
      "settlement_value": 123,
      "settlement_value_dollars": "0.5600",
      "settlement_ts": "2023-11-07T05:31:56Z",
      "fee_waiver_expiration_time": "2023-11-07T05:31:56Z",
      "early_close_condition": "<string>",
      "strike_type": "greater",
      "floor_strike": 123,
      "cap_strike": 123,
      "functional_strike": "<string>",
      "custom_strike": {},
      "mve_collection_ticker": "<string>",
      "mve_selected_legs": [
        {
          "event_ticker": "<string>",
          "market_ticker": "<string>",
          "side": "<string>",
          "yes_settlement_value_dollars": "0.5600"
        }
      ],
      "primary_participant_key": "<string>",
      "is_provisional": true
    }
  ],
  "cursor": "<string>"
}

curl call:
curl --request GET \
  --url 'https://api.elections.kalshi.com/trade-api/v2/markets?limit=100'