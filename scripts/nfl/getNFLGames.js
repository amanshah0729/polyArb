require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');
const { deVigOdds } = require('../../utils/deVig');
const { findArbitrageOpportunities } = require('../../utils/arbitrage');

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('Error: API_KEY not found in .env file');
  process.exit(1);
}

const BASE_URL = 'https://api.the-odds-api.com';
const SPORT = 'americanfootball_nfl';
const REGIONS = 'us';
const MARKETS = 'h2h';
const ODDS_FORMAT = 'american';

const ENDPOINT = `/v4/sports/${SPORT}/odds/?apiKey=${API_KEY}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=${ODDS_FORMAT}`;

const url = `${BASE_URL}${ENDPOINT}`;

// Create outputs directory structure (go up two levels from scripts/nfl/ to root)
const OUTPUTS_DIR = path.join(__dirname, '..', '..', 'outputs', 'nfl');
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

https.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`Error: API returned status code ${res.statusCode}`);
      console.error('Response:', data);
      return;
    }

    try {
      const games = JSON.parse(data);
      const timestamp = new Date().toISOString();
      const timestampStr = timestamp.replace(/[:.]/g, '-').split('T')[0];
      const timestampMs = Date.now();
      
      // Save raw JSON
      const rawFilename = `nfl_games_raw_${timestampStr}_${timestampMs}.json`;
      const rawFilepath = path.join(OUTPUTS_DIR, rawFilename);
      fs.writeFileSync(rawFilepath, JSON.stringify(games, null, 2), 'utf8');
      console.log(`Raw JSON saved to: ${rawFilepath}`);
      
      // Build output string for formatted text
      let output = '\n=== NFL Games with De-Vigged Moneyline Odds ===\n\n';
      
      if (games.length === 0) {
        output += 'No NFL games found.\n';
        console.log(output);
        return;
      }

      // Build CSV data
      const csvRows = [];
      csvRows.push([
        'Date',
        'Time',
        'Game ID',
        'Away Team',
        'Home Team',
        'Status',
        'Bookmaker',
        'Away Odds',
        'Home Odds',
        'Away Implied Prob (%)',
        'Home Implied Prob (%)',
        'Away True Prob (%)',
        'Home True Prob (%)',
        'Vig (%)'
      ].join(','));

      // Build arbitrage CSV
      const arbCsvRows = [];
      arbCsvRows.push([
        'Date',
        'Time',
        'Game ID',
        'Away Team',
        'Home Team',
        'Bet 1 Bookmaker',
        'Bet 1 Team',
        'Bet 1 Odds',
        'Bet 1 Stake ($)',
        'Bet 2 Bookmaker',
        'Bet 2 Team',
        'Bet 2 Odds',
        'Bet 2 Stake ($)',
        'Total Stake ($)',
        'Guaranteed Return ($)',
        'Profit ($)',
        'Profit (%)',
        'Arb Margin (%)'
      ].join(','));

      games.forEach((game, gameIndex) => {
        const commenceTime = new Date(game.commence_time);
        const isLive = commenceTime < new Date();
        const dateStr = commenceTime.toLocaleDateString();
        const timeStr = commenceTime.toLocaleTimeString();
        
        output += `${gameIndex + 1}. ${game.away_team} @ ${game.home_team}\n`;
        output += `   Game ID: ${game.id}\n`;
        output += `   Commence Time: ${commenceTime.toLocaleString()}\n`;
        output += `   Status: ${isLive ? 'LIVE' : 'Upcoming'}\n\n`;
        
        // Process each bookmaker
        if (game.bookmakers && game.bookmakers.length > 0) {
          game.bookmakers.forEach((bookmaker, bookIndex) => {
            const h2hMarket = bookmaker.markets.find(m => m.key === 'h2h');
            
            if (h2hMarket && h2hMarket.outcomes) {
              output += `   Bookmaker: ${bookmaker.title}\n`;
              
              // De-vig the odds
              const deVigged = deVigOdds(h2hMarket.outcomes);
              
              // Find away and home team outcomes
              const awayOutcome = deVigged.find(o => o.name === game.away_team);
              const homeOutcome = deVigged.find(o => o.name === game.home_team);
              
              if (awayOutcome && homeOutcome) {
                const awayOdds = awayOutcome.price > 0 ? `+${awayOutcome.price}` : `${awayOutcome.price}`;
                const homeOdds = homeOutcome.price > 0 ? `+${homeOutcome.price}` : `${homeOutcome.price}`;
                
                // Add to CSV
                csvRows.push([
                  `"${dateStr}"`,
                  `"${timeStr}"`,
                  `"${game.id}"`,
                  `"${game.away_team}"`,
                  `"${game.home_team}"`,
                  `"${isLive ? 'LIVE' : 'Upcoming'}"`,
                  `"${bookmaker.title}"`,
                  awayOdds,
                  homeOdds,
                  awayOutcome.impliedProb.toFixed(2),
                  homeOutcome.impliedProb.toFixed(2),
                  awayOutcome.deVigProb.toFixed(2),
                  homeOutcome.deVigProb.toFixed(2),
                  awayOutcome.vig.toFixed(2)
                ].join(','));
                
                // Add to formatted output
                output += `     ${game.away_team}:\n`;
                output += `       Odds: ${awayOdds}\n`;
                output += `       Implied Prob (with vig): ${awayOutcome.impliedProb.toFixed(2)}%\n`;
                output += `       True Prob (de-vigged): ${awayOutcome.deVigProb.toFixed(2)}%\n\n`;
                
                output += `     ${game.home_team}:\n`;
                output += `       Odds: ${homeOdds}\n`;
                output += `       Implied Prob (with vig): ${homeOutcome.impliedProb.toFixed(2)}%\n`;
                output += `       True Prob (de-vigged): ${homeOutcome.deVigProb.toFixed(2)}%\n`;
                
                if (awayOutcome.vig !== undefined) {
                  output += `       Vig: ${awayOutcome.vig.toFixed(2)}%\n`;
                }
                output += '\n';
              }
            }
          });
        } else {
          output += '   No bookmakers available for this game.\n\n';
        }

        // Find arbitrage opportunities
        if (game.bookmakers && game.bookmakers.length > 1) {
          const arbs = findArbitrageOpportunities(game.bookmakers, game);
          
          if (arbs.length > 0) {
            output += `   🎯 ARBITRAGE OPPORTUNITIES FOUND: ${arbs.length}\n\n`;
            
            arbs.forEach((arb, arbIndex) => {
              output += `   Opportunity ${arbIndex + 1} (${arb.profitPercent.toFixed(2)}% profit):\n`;
              output += `     Bet $${arb.bet1.stake.toFixed(2)} on ${arb.bet1.team} at ${arb.bet1.bookmaker} (${arb.bet1.odds > 0 ? '+' : ''}${arb.bet1.odds})\n`;
              output += `     Bet $${arb.bet2.stake.toFixed(2)} on ${arb.bet2.team} at ${arb.bet2.bookmaker} (${arb.bet2.odds > 0 ? '+' : ''}${arb.bet2.odds})\n`;
              output += `     Total Stake: $${arb.totalStake.toFixed(2)}\n`;
              output += `     Guaranteed Return: $${arb.guaranteedReturn.toFixed(2)}\n`;
              output += `     Profit: $${arb.profit.toFixed(2)} (${arb.profitPercent.toFixed(2)}%)\n`;
              output += `     Arb Margin: ${arb.arbMargin.toFixed(2)}%\n\n`;

              // Add to arbitrage CSV
              arbCsvRows.push([
                `"${dateStr}"`,
                `"${timeStr}"`,
                `"${game.id}"`,
                `"${game.away_team}"`,
                `"${game.home_team}"`,
                `"${arb.bet1.bookmaker}"`,
                `"${arb.bet1.team}"`,
                arb.bet1.odds > 0 ? `+${arb.bet1.odds}` : `${arb.bet1.odds}`,
                arb.bet1.stake.toFixed(2),
                `"${arb.bet2.bookmaker}"`,
                `"${arb.bet2.team}"`,
                arb.bet2.odds > 0 ? `+${arb.bet2.odds}` : `${arb.bet2.odds}`,
                arb.bet2.stake.toFixed(2),
                arb.totalStake.toFixed(2),
                arb.guaranteedReturn.toFixed(2),
                arb.profit.toFixed(2),
                arb.profitPercent.toFixed(2),
                arb.arbMargin.toFixed(2)
              ].join(','));
            });
          }
        }
        
        output += `${'─'.repeat(60)}\n\n`;
      });

      output += `\nTotal: ${games.length} game(s)\n\n`;

      // Display quota info from response headers if available
      const remaining = res.headers['x-requests-remaining'];
      const used = res.headers['x-requests-used'];
      const lastCost = res.headers['x-requests-last'];
      
      if (remaining !== undefined) {
        output += `API Usage:\n`;
        output += `  Requests remaining: ${remaining}\n`;
        output += `  Requests used: ${used}\n`;
        if (lastCost !== undefined) {
          output += `  Last request cost: ${lastCost} credit(s)\n`;
        }
        output += '\n';
      }

      // Add timestamp header
      const header = `Generated: ${timestamp}\n${'='.repeat(60)}\n`;
      const fullOutput = header + output;

      // Display to console
      console.log(fullOutput);

      // Save formatted text file
      const txtFilename = `nfl_games_${timestampStr}_${timestampMs}.txt`;
      const txtFilepath = path.join(OUTPUTS_DIR, txtFilename);
      fs.writeFileSync(txtFilepath, fullOutput, 'utf8');
      console.log(`Formatted text saved to: ${txtFilepath}`);

      // Save CSV file
      const csvFilename = `nfl_games_${timestampStr}_${timestampMs}.csv`;
      const csvFilepath = path.join(OUTPUTS_DIR, csvFilename);
      fs.writeFileSync(csvFilepath, csvRows.join('\n'), 'utf8');
      console.log(`CSV saved to: ${csvFilepath}`);

      // Save arbitrage CSV file
      if (arbCsvRows.length > 1) {
        const arbCsvFilename = `nfl_arbitrage_${timestampStr}_${timestampMs}.csv`;
        const arbCsvFilepath = path.join(OUTPUTS_DIR, arbCsvFilename);
        fs.writeFileSync(arbCsvFilepath, arbCsvRows.join('\n'), 'utf8');
        console.log(`Arbitrage CSV saved to: ${arbCsvFilepath}`);
      } else {
        console.log('No arbitrage opportunities found.');
      }
      console.log('');

    } catch (error) {
      console.error('Error parsing JSON response:', error.message);
      console.error('Response data:', data);
    }
  });
}).on('error', (error) => {
  console.error('Error making request:', error.message);
});

