# NFL Arbitrage Implementation Plan

## Overview
Extend the arbitrage finder to support NFL in addition to NBA, allowing `findAllArbitrage.js` to find opportunities for both sports.

## Current Architecture

### NBA Scripts (in `scripts/`):
- `getNBAGames.js` - Fetches NBA lines from sportsbooks (The Odds API)
- `getPolymarketNBA.js` - Fetches NBA lines from Polymarket
- `findArbitrage.js` - Finds arbitrage (currently hardcoded for NBA)

### Master Script:
- `findAllArbitrage.js` - Orchestrates NBA pipeline

## Implementation Strategy

### Phase 1: Create NFL Scripts (in `scripts/nfl/`)
1. **`getNFLGames.js`**
   - Similar to `getNBAGames.js`
   - Change SPORT from `basketball_nba` to `americanfootball_nfl`
   - Output to `outputs/nfl/` directory
   - Same CSV format as NBA

2. **`getPolymarketNFL.js`**
   - Similar to `getPolymarketNBA.js`
   - Get NFL tag ID from Polymarket sports endpoint
   - Output to `outputs/polymarket/` (can share with NBA or separate)
   - Same CSV format

### Phase 2: Make findArbitrage Generic
1. **Update `findArbitrage.js`** to accept sport parameter
   - Accept `sport` argument (e.g., 'nba' or 'nfl')
   - Dynamically set file paths based on sport:
     - Sportsbook: `outputs/{sport}/nba_games_*.csv` or `outputs/{sport}/nfl_games_*.csv`
     - Polymarket: `outputs/polymarket/polymarket_{sport}.csv`
   - Output: `outputs/final_arb/arb_{sport}_{date}.csv` or combined

### Phase 3: Update Master Script
1. **Update `findAllArbitrage.js`**
   - Run NBA pipeline (existing)
   - Run NFL pipeline (new)
   - Optionally combine results or keep separate

## File Structure

```
scripts/
├── getNBAGames.js
├── getPolymarketNBA.js
├── findArbitrage.js (make generic)
└── nfl/
    ├── getNFLGames.js
    └── getPolymarketNFL.js
```

## Output Structure

```
outputs/
├── nba/
│   ├── nba_games_*.csv
│   └── nba_games_*.json
├── nfl/
│   ├── nfl_games_*.csv
│   └── nfl_games_*.json
├── polymarket/
│   ├── polymarket_nba.csv
│   └── polymarket_nfl.csv
└── final_arb/
    ├── arb_nba_YYYY-MM-DD.csv
    └── arb_nfl_YYYY-MM-DD.csv
```

## Key Differences NFL vs NBA

1. **The Odds API**: 
   - Sport key: `americanfootball_nfl` (vs `basketball_nba`)
   - Same endpoint structure

2. **Polymarket**:
   - Different tag ID (need to find NFL tag from `/sports` endpoint)
   - Same API structure

3. **Team Names**:
   - Different team name formats (e.g., "Kansas City Chiefs" vs "Lakers")
   - May need sport-specific normalization

## Testing Strategy

1. Test NFL scripts individually first
2. Test findArbitrage with NFL data
3. Test full pipeline with both sports
4. Verify team name matching works for NFL

