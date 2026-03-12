events
Get Events
Get all events. This endpoint excludes multivariate events. To retrieve multivariate events, use the GET /events/multivariate endpoint.

GET
/
events

Try it
Query Parameters
​
limit
integerdefault:200
Parameter to specify the number of results per page. Defaults to 200. Maximum value is 200.

Required range: 1 <= x <= 200
​
cursor
string
Parameter to specify the pagination cursor. Use the cursor value returned from the previous response to get the next page of results. Leave empty for the first page.

​
with_nested_markets
booleandefault:false
Parameter to specify if nested markets should be included in the response. When true, each event will include a 'markets' field containing a list of Market objects associated with that event.

​
with_milestones
booleandefault:false
If true, includes related milestones as a field alongside events.

​
status
enum<string>
Filter by event status. Possible values are 'open', 'closed', 'settled'. Leave empty to return events with any status.

Available options: open, closed, settled 
​
series_ticker
string
Filter by series ticker

​
min_close_ts
integer<int64>
Filter events with at least one market with close timestamp greater than this Unix timestamp (in seconds).

Response

200

application/json
Events retrieved successfully

​
events
object[]required
Array of events matching the query criteria.

Show child attributes

​
cursor
stringrequired
Pagination cursor for the next page. Empty if there are no more results.

​
milestones
object[]
Array of milestones related to the events.

Show child attributes

Get Event Candlesticks
Get Multivariate Events


RESPONSE:
{
  "events": [
    {
      "event_ticker": "<string>",
      "series_ticker": "<string>",
      "sub_title": "<string>",
      "title": "<string>",
      "collateral_return_type": "<string>",
      "mutually_exclusive": true,
      "category": "<string>",
      "available_on_brokers": true,
      "product_metadata": {},
      "strike_date": "2023-11-07T05:31:56Z",
      "strike_period": "<string>",
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
      ]
    }
  ],
  "cursor": "<string>",
  "milestones": [
    {
      "id": "<string>",
      "category": "<string>",
      "type": "<string>",
      "start_date": "2023-11-07T05:31:56Z",
      "related_event_tickers": [
        "<string>"
      ],
      "title": "<string>",
      "notification_message": "<string>",
      "details": {},
      "primary_event_tickers": [
        "<string>"
      ],
      "last_updated_ts": "2023-11-07T05:31:56Z",
      "end_date": "2023-11-07T05:31:56Z",
      "source_id": "<string>"
    }
  ]
}