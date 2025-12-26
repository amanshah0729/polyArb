require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Create outputs directory structure (go up one level from scripts/ to root)
const OUTPUTS_DIR = path.join(__dirname, '..', 'outputs', 'final_arb');
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

/**
 * Normalize team name for matching
 */
function normalizeTeamName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/^los\s+angeles\s+/i, 'lakers')
    .replace(/^houston\s+/i, 'rockets')
    .replace(/^minnesota\s+/i, 'timberwolves')
    .replace(/^denver\s+/i, 'nuggets')
    .replace(/^miami\s+/i, 'heat')
    .replace(/^atlanta\s+/i, 'hawks')
    .replace(/^charlotte\s+/i, 'hornets')
    .replace(/^orlando\s+/i, 'magic')
    .replace(/^toronto\s+/i, 'raptors')
    .replace(/^washington\s+/i, 'wizards')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two team names match (fuzzy matching)
 */
function teamsMatch(team1, team2) {
  const norm1 = normalizeTeamName(team1);
  const norm2 = normalizeTeamName(team2);
  
  // Exact match
  if (norm1 === norm2) return true;
  
  // One contains the other
  if (norm1.includes(norm2) || norm2.includes(norm1)) return true;
  
  return false;
}

/**
 * Find matching Polymarket game for a sportsbook game
 */
function findMatchingPolyGame(sbGame, polyGames) {
  const sbAway = normalizeTeamName(sbGame['Away Team']);
  const sbHome = normalizeTeamName(sbGame['Home Team']);
  
  for (const polyGame of polyGames) {
    const polyAway = normalizeTeamName(polyGame['Away Team']);
    const polyHome = normalizeTeamName(polyGame['Home Team']);
    
    // Check both directions (away/home might be swapped)
    if ((teamsMatch(sbAway, polyAway) && teamsMatch(sbHome, polyHome)) ||
        (teamsMatch(sbAway, polyHome) && teamsMatch(sbHome, polyAway))) {
      return polyGame;
    }
  }
  
  return null;
}

/**
 * Find lowest and highest sportsbook implied probabilities for each team
 */
function findSportsbookLines(sportsbookGames) {
  let lowestAway = null;
  let highestAway = null;
  let lowestHome = null;
  let highestHome = null;
  let lowestAwayBookmaker = '';
  let highestAwayBookmaker = '';
  let lowestHomeBookmaker = '';
  let highestHomeBookmaker = '';
  
  for (const game of sportsbookGames) {
    const awayImplied = parseFloat(game['Away Implied Prob (%)']);
    const homeImplied = parseFloat(game['Home Implied Prob (%)']);
    
    // Lowest = worst odds (lowest implied prob)
    if (lowestAway === null || awayImplied < lowestAway) {
      lowestAway = awayImplied;
      lowestAwayBookmaker = game.Bookmaker;
    }
    
    // Highest = best odds (highest implied prob)
    if (highestAway === null || awayImplied > highestAway) {
      highestAway = awayImplied;
      highestAwayBookmaker = game.Bookmaker;
    }
    
    if (lowestHome === null || homeImplied < lowestHome) {
      lowestHome = homeImplied;
      lowestHomeBookmaker = game.Bookmaker;
    }
    
    if (highestHome === null || homeImplied > highestHome) {
      highestHome = homeImplied;
      highestHomeBookmaker = game.Bookmaker;
    }
  }
  
  return {
    lowestAwayImplied: lowestAway,
    highestAwayImplied: highestAway,
    lowestHomeImplied: lowestHome,
    highestHomeImplied: highestHome,
    lowestAwayBookmaker,
    highestAwayBookmaker,
    lowestHomeBookmaker,
    highestHomeBookmaker
  };
}

/**
 * Check for arbitrage opportunity
 * Arbitrage exists if: polyPrice1 + sportsbookPrice2 < 1.0 OR sportsbookPrice1 + polyPrice2 < 1.0
 */
function checkArbitrage(polyAwayPct, polyHomePct, sbAwayPct, sbHomePct) {
  // Convert percentages to decimals
  const polyAway = polyAwayPct / 100;
  const polyHome = polyHomePct / 100;
  const sbAway = sbAwayPct / 100;
  const sbHome = sbHomePct / 100;
  
  // Option 1: Buy away on Polymarket + buy home on sportsbook
  const option1 = polyAway + sbHome;
  
  // Option 2: Buy away on sportsbook + buy home on Polymarket
  const option2 = sbAway + polyHome;
  
  const bestOption = Math.min(option1, option2);
  const hasArb = bestOption < 1.0;
  
  return {
    hasArb,
    bestOption,
    profitPercent: hasArb ? ((1.0 - bestOption) / bestOption) * 100 : 0
  };
}

/**
 * Parse CSV file
 */
function parseCSV(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim());
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  
  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    if (values.length === headers.length) {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index].replace(/"/g, '');
      });
      data.push(row);
    }
  }
  
  return data;
}

/**
 * Group sportsbook games by game ID
 */
function groupSportsbookGames(sportsbookGames) {
  const grouped = {};
  
  for (const game of sportsbookGames) {
    const gameId = game['Game ID'];
    if (!grouped[gameId]) {
      grouped[gameId] = [];
    }
    grouped[gameId].push(game);
  }
  
  return grouped;
}

/**
 * Main function
 */
function main() {
  try {
    // Get sport from command line argument (default to 'nba')
    const sport = process.argv[2] || 'nba';
    const sportUpper = sport.toUpperCase();
    
    console.log(`\nAnalyzing ${sportUpper} arbitrage opportunities...`);
    
    // File paths (go up one level from scripts/ to root)
    const polyPath = path.join(__dirname, '..', 'outputs', 'polymarket', `polymarket_${sport}.csv`);
    
    // Find the most recent sportsbook CSV file
    const sportDir = path.join(__dirname, '..', 'outputs', sport);
    const files = fs.readdirSync(sportDir)
      .filter(f => f.startsWith(`${sport}_games_`) && f.endsWith('.csv'))
      .sort()
      .reverse();
    
    if (files.length === 0) {
      throw new Error(`No sportsbook CSV files found in outputs/${sport}/`);
    }
    
    const sportsbookPath = path.join(sportDir, files[0]);
    console.log(`Using sportsbook file: ${files[0]}`);
    
    console.log('Reading Polymarket data...');
    const polyGames = parseCSV(polyPath);
    console.log(`Found ${polyGames.length} Polymarket games`);
    
    console.log('Reading sportsbook data...');
    const sportsbookGames = parseCSV(sportsbookPath);
    console.log(`Found ${sportsbookGames.length} sportsbook lines`);
    
    // Group sportsbook games by Game ID
    const groupedSBGames = groupSportsbookGames(sportsbookGames);
    const uniqueGameIds = Object.keys(groupedSBGames);
    console.log(`Found ${uniqueGameIds.length} unique games in sportsbook data`);
    
    // Process each unique game from sportsbook data
    const results = [];
    
    for (const gameId of uniqueGameIds) {
      const sbGamesForGame = groupedSBGames[gameId];
      const firstSBGame = sbGamesForGame[0];
      
      // Find matching Polymarket game
      const polyGame = findMatchingPolyGame(firstSBGame, polyGames);
      
      if (!polyGame) {
        console.log(`No Polymarket match found for: ${firstSBGame['Away Team']} @ ${firstSBGame['Home Team']}`);
        continue;
      }
      
      // Find sportsbook lines (lowest and highest)
      const sbLines = findSportsbookLines(sbGamesForGame);
      
      // Get Polymarket prices
      const polyAwayPct = parseFloat(polyGame['Away Implied Prob (%)']);
      const polyHomePct = parseFloat(polyGame['Home Implied Prob (%)']);
      
      if (isNaN(polyAwayPct) || isNaN(polyHomePct)) {
        continue;
      }
      
      // Check arbitrage using lowest sportsbook implied probs (best odds for bettor)
      // Option 1: Buy away on sportsbook (lowest = best odds) + buy home on Polymarket
      // Option 2: Buy away on Polymarket + buy home on sportsbook (lowest = best odds)
      const arb = checkArbitrage(
        polyAwayPct,
        polyHomePct,
        sbLines.lowestAwayImplied,
        sbLines.lowestHomeImplied
      );
      
      results.push({
        date: firstSBGame.Date,
        time: firstSBGame.Time,
        awayTeam: firstSBGame['Away Team'],
        homeTeam: firstSBGame['Home Team'],
        status: firstSBGame.Status,
        hasArb: arb.hasArb ? 'YES' : 'NO',
        lowestAwayBookmaker: sbLines.lowestAwayBookmaker,
        lowestAwayImplied: sbLines.lowestAwayImplied.toFixed(2),
        lowestHomeBookmaker: sbLines.lowestHomeBookmaker,
        lowestHomeImplied: sbLines.lowestHomeImplied.toFixed(2),
        polyAwayImplied: polyAwayPct.toFixed(2),
        polyHomeImplied: polyHomePct.toFixed(2),
        profitPercent: arb.profitPercent.toFixed(2),
        bestOption: arb.bestOption.toFixed(4)
      });
    }
    
    // Sort: YES first, then by profit percent descending
    results.sort((a, b) => {
      if (a.hasArb === 'YES' && b.hasArb === 'NO') return -1;
      if (a.hasArb === 'NO' && b.hasArb === 'YES') return 1;
      if (a.hasArb === 'YES' && b.hasArb === 'YES') {
        return parseFloat(b.profitPercent) - parseFloat(a.profitPercent);
      }
      return 0;
    });
    
    // Generate CSV output
    const csvRows = [];
    csvRows.push([
      'Date',
      'Time',
      'Away Team',
      'Home Team',
      'Status',
      'Arb Opportunity',
      'Lowest Away Bookmaker',
      'Lowest Away Implied Prob (%)',
      'Lowest Home Bookmaker',
      'Lowest Home Implied Prob (%)',
      'Polymarket Away Implied Prob (%)',
      'Polymarket Home Implied Prob (%)',
      'Profit %',
      'Best Option Cost'
    ].join(','));
    
    results.forEach(result => {
      csvRows.push([
        `"${result.date}"`,
        `"${result.time}"`,
        `"${result.awayTeam}"`,
        `"${result.homeTeam}"`,
        `"${result.status}"`,
        result.hasArb,
        `"${result.lowestAwayBookmaker}"`,
        result.lowestAwayImplied,
        `"${result.lowestHomeBookmaker}"`,
        result.lowestHomeImplied,
        result.polyAwayImplied,
        result.polyHomeImplied,
        result.profitPercent,
        result.bestOption
      ].join(','));
    });
    
    // Save output
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `arb_${sport}_${timestamp}.csv`;
    const filepath = path.join(OUTPUTS_DIR, filename);
    
    fs.writeFileSync(filepath, csvRows.join('\n'), 'utf8');
    
    console.log(`\nResults saved to: ${filepath}`);
    console.log(`Total games analyzed: ${results.length}`);
    console.log(`Arbitrage opportunities found: ${results.filter(r => r.hasArb === 'YES').length}`);
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
