Sports
List teams
GET
/
teams

Try it
Query Parameters
​
limit
integer
Required range: x >= 0
​
offset
integer
Required range: x >= 0
​
order
string
Comma-separated list of fields to order by

​
ascending
boolean
​
league
string[]
​
name
string[]
​
abbreviation
string[]
Response
200 - application/json
List of teams

​
id
integer
​
name
string | null
​
league
string | null
​
record
string | null
​
logo
string | null
​
abbreviation
string | null
​
alias
string | null
​
createdAt
string<date-time> | null
​
updatedAt
string<date-time> | null



curl --request GET \
  --url https://gamma-api.polymarket.com/teams

200
[
  {
    "id": 123,
    "name": "<string>",
    "league": "<string>",
    "record": "<string>",
    "logo": "<string>",
    "abbreviation": "<string>",
    "alias": "<string>",
    "createdAt": "2023-11-07T05:31:56Z",
    "updatedAt": "2023-11-07T05:31:56Z"
  }
]

curl --request GET \
  --url https://gamma-api.polymarket.com/sports

200
[
  {
    "sport": "<string>",
    "image": "<string>",
    "resolution": "<string>",
    "ordering": "<string>",
    "tags": "<string>",
    "series": "<string>"
  }
]

curl --request GET \
  --url https://gamma-api.polymarket.com/sports/market-types

200
{
  "marketTypes": [
    "<string>"
  ]
}