/**
 * Calculate arbitrage opportunity between two bookmakers
 * 
 * @param {Object} bet1 - First bet: { bookmaker, team, odds (American), impliedProb }
 * @param {Object} bet2 - Second bet: { bookmaker, team, odds (American), impliedProb }
 * @returns {Object|null} Arbitrage details or null if no arb opportunity
 */
function calculateArbitrage(bet1, bet2) {
  // Check if bets are on opposite outcomes
  if (bet1.team === bet2.team) {
    return null; // Same team, no arbitrage
  }

  // Calculate total implied probability
  const totalImpliedProb = bet1.impliedProb + bet2.impliedProb;

  // Arbitrage exists if total implied probability < 100%
  if (totalImpliedProb >= 100) {
    return null; // No arbitrage opportunity
  }

  // Calculate optimal bet sizes for $100 total investment
  // We want: bet1_return = bet2_return regardless of outcome
  
  // Convert American odds to decimal odds for easier calculation
  const decimal1 = bet1.odds > 0 ? (bet1.odds / 100) + 1 : (100 / Math.abs(bet1.odds)) + 1;
  const decimal2 = bet2.odds > 0 ? (bet2.odds / 100) + 1 : (100 / Math.abs(bet2.odds)) + 1;

  // Calculate stake ratios
  // stake1 * decimal1 = stake2 * decimal2
  // stake1 + stake2 = 100
  const stake1 = (100 * decimal2) / (decimal1 + decimal2);
  const stake2 = 100 - stake1;

  // Calculate returns (should be equal)
  const return1 = stake1 * decimal1;
  const return2 = stake2 * decimal2;
  const guaranteedReturn = Math.min(return1, return2);

  // Profit
  const profit = guaranteedReturn - 100;
  const profitPercent = (profit / 100) * 100;

  return {
    exists: true,
    bet1: {
      bookmaker: bet1.bookmaker,
      team: bet1.team,
      odds: bet1.odds,
      stake: stake1,
      return: return1
    },
    bet2: {
      bookmaker: bet2.bookmaker,
      team: bet2.team,
      odds: bet2.odds,
      stake: stake2,
      return: return2
    },
    totalStake: 100,
    guaranteedReturn: guaranteedReturn,
    profit: profit,
    profitPercent: profitPercent,
    totalImpliedProb: totalImpliedProb,
    arbMargin: 100 - totalImpliedProb
  };
}

/**
 * Find all arbitrage opportunities across all bookmakers for a game
 * 
 * @param {Array} bookmakers - Array of bookmaker data with odds
 * @param {Object} game - Game object with away_team and home_team
 * @returns {Array} Array of arbitrage opportunities
 */
function findArbitrageOpportunities(bookmakers, game) {
  const opportunities = [];

  // Get all bookmaker odds
  const oddsData = [];
  
  bookmakers.forEach(bookmaker => {
    const h2hMarket = bookmaker.markets?.find(m => m.key === 'h2h');
    if (h2hMarket && h2hMarket.outcomes) {
      const awayOutcome = h2hMarket.outcomes.find(o => o.name === game.away_team);
      const homeOutcome = h2hMarket.outcomes.find(o => o.name === game.home_team);
      
      if (awayOutcome && homeOutcome) {
        // Calculate implied probabilities
        const awayImplied = awayOutcome.price > 0 
          ? 100 / (awayOutcome.price + 100)
          : Math.abs(awayOutcome.price) / (Math.abs(awayOutcome.price) + 100);
        
        const homeImplied = homeOutcome.price > 0
          ? 100 / (homeOutcome.price + 100)
          : Math.abs(homeOutcome.price) / (Math.abs(homeOutcome.price) + 100);

        oddsData.push({
          bookmaker: bookmaker.title,
          away: {
            team: game.away_team,
            odds: awayOutcome.price,
            impliedProb: awayImplied * 100
          },
          home: {
            team: game.home_team,
            odds: homeOutcome.price,
            impliedProb: homeImplied * 100
          }
        });
      }
    }
  });

  // Check all combinations
  for (let i = 0; i < oddsData.length; i++) {
    for (let j = i + 1; j < oddsData.length; j++) {
      // Check away team from bookmaker i vs home team from bookmaker j
      const arb1 = calculateArbitrage(
        {
          bookmaker: oddsData[i].bookmaker,
          team: oddsData[i].away.team,
          odds: oddsData[i].away.odds,
          impliedProb: oddsData[i].away.impliedProb
        },
        {
          bookmaker: oddsData[j].bookmaker,
          team: oddsData[j].home.team,
          odds: oddsData[j].home.odds,
          impliedProb: oddsData[j].home.impliedProb
        }
      );

      if (arb1) {
        opportunities.push(arb1);
      }

      // Check home team from bookmaker i vs away team from bookmaker j
      const arb2 = calculateArbitrage(
        {
          bookmaker: oddsData[i].bookmaker,
          team: oddsData[i].home.team,
          odds: oddsData[i].home.odds,
          impliedProb: oddsData[i].home.impliedProb
        },
        {
          bookmaker: oddsData[j].bookmaker,
          team: oddsData[j].away.team,
          odds: oddsData[j].away.odds,
          impliedProb: oddsData[j].away.impliedProb
        }
      );

      if (arb2) {
        opportunities.push(arb2);
      }
    }
  }

  // Sort by profit percentage (highest first)
  opportunities.sort((a, b) => b.profitPercent - a.profitPercent);

  return opportunities;
}

module.exports = {
  calculateArbitrage,
  findArbitrageOpportunities
};

