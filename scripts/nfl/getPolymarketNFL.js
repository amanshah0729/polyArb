require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');
const { deVigOdds } = require('../../utils/deVig');

const POLYMARKET_BASE_URL = 'https://gamma-api.polymarket.com';

// Create outputs directory structure (go up two levels from scripts/nfl/ to root)
const OUTPUTS_DIR = path.join(__dirname, '..', '..', 'outputs', 'polymarket');
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

/**
 * Make HTTP GET request
 */
function makeRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API returned status code ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }

        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (error) {
          console.error(`Failed to parse JSON. Response preview: ${data.substring(0, 200)}`);
          reject(new Error(`Failed to parse JSON: ${error.message}`));
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Convert Polymarket probability (0-1) to American odds
 */
function probabilityToAmericanOdds(prob) {
  if (prob <= 0 || prob >= 1) {
    return null;
  }

  if (prob >= 0.5) {
    // Favorite (negative odds)
    return Math.round(-100 * prob / (1 - prob));
  } else {
    // Underdog (positive odds)
    return Math.round(100 * (1 - prob) / prob);
  }
}

/**
 * Extract team names from event title
 * Common formats: "Team A vs Team B", "Team A @ Team B", etc.
 */
function extractTeamsFromTitle(title) {
  if (!title) return { away: null, home: null };

  // Try different patterns
  const patterns = [
    /(.+?)\s+(?:vs|@|v\.|versus)\s+(.+)/i,
    /(.+?)\s+at\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      return {
        away: match[1].trim(),
        home: match[2].trim()
      };
    }
  }

  // If no pattern matches, try to split by common delimiters
  const parts = title.split(/[vs@]/i);
  if (parts.length === 2) {
    return {
      away: parts[0].trim(),
      home: parts[1].trim()
    };
  }

  return { away: null, home: null };
}

/**
 * Get NFL tag ID from sports endpoint
 */
async function getNFLTagId() {
  try {
    const sports = await makeRequest(`${POLYMARKET_BASE_URL}/sports`);
    
    // Find NFL sport
    const nflSport = sports.find(sport => 
      sport.sport && sport.sport.toLowerCase() === 'nfl'
    );

    if (!nflSport || !nflSport.tags) {
      throw new Error('NFL sport not found in sports data');
    }

    // Parse tags - it's a comma-separated string like "1,745,100639"
    let tagIds;
    if (typeof nflSport.tags === 'string') {
      // Check if it's JSON or comma-separated
      if (nflSport.tags.startsWith('[') || nflSport.tags.startsWith('{')) {
        try {
          tagIds = JSON.parse(nflSport.tags);
        } catch (e) {
          // Not JSON, treat as comma-separated string
          tagIds = nflSport.tags.split(',').map(t => t.trim());
        }
      } else {
        // Comma-separated string
        tagIds = nflSport.tags.split(',').map(t => t.trim());
      }
    } else if (Array.isArray(nflSport.tags)) {
      tagIds = nflSport.tags;
    } else {
      throw new Error('Unexpected tags format');
    }

    // Use the NFL-specific tag (usually the second one, first is often a general sports tag)
    const tagId = Array.isArray(tagIds) ? tagIds[1] || tagIds[0] : tagIds;

    if (!tagId) {
      throw new Error('Could not extract NFL tag ID');
    }

    console.log(`Found NFL sport: ${nflSport.sport}, tag IDs: ${nflSport.tags}, using: ${tagId}`);
    return tagId;
  } catch (error) {
    console.error('Error fetching NFL tag ID:', error.message);
    throw error;
  }
}

/**
 * Fetch all NFL events with pagination
 */
async function fetchNFLEvents(tagId) {
  const allEvents = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    try {
      const url = `${POLYMARKET_BASE_URL}/events?tag_id=${tagId}&closed=false&limit=${limit}&offset=${offset}&order=id&ascending=false`;
      console.log(`Fetching events: offset=${offset}, limit=${limit}`);
      
      const events = await makeRequest(url);

      if (!Array.isArray(events) || events.length === 0) {
        hasMore = false;
        break;
      }

      allEvents.push(...events);
      console.log(`Fetched ${events.length} events (total: ${allEvents.length})`);

      if (events.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error fetching events at offset ${offset}:`, error.message);
      hasMore = false;
    }
  }

  return allEvents;
}

/**
 * Process events and extract moneyline markets
 */
function processEvents(events) {
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

  events.forEach(event => {
    if (!event.markets || !Array.isArray(event.markets)) {
      return;
    }

    // Find moneyline market
    const moneylineMarket = event.markets.find(market => 
      market.sportsMarketType === 'moneyline'
    );

    if (!moneylineMarket || !moneylineMarket.outcomes) {
      return;
    }

    // Check if we have bid/ask data (more accurate than mid prices)
    const hasBidAsk = moneylineMarket.bestBid !== undefined && moneylineMarket.bestAsk !== undefined;

    // Only process head-to-head games (must have exactly 2 outcomes)
    let outcomes;
    if (typeof moneylineMarket.outcomes === 'string') {
      try {
        outcomes = JSON.parse(moneylineMarket.outcomes);
      } catch (e) {
        return;
      }
    } else {
      outcomes = moneylineMarket.outcomes;
    }

    if (!Array.isArray(outcomes) || outcomes.length !== 2) {
      return;
    }

    // Use bid/ask prices if available (more accurate), otherwise fall back to outcomePrices (mid)
    let price0, price1;
    
    if (hasBidAsk) {
      // bestBid and bestAsk are for the first outcome (outcomes[0])
      // For binary markets: if outcome 0 ask = bestAsk, then outcome 1 ask = 1 - bestBid
      // We use ASK prices (what you pay to buy) for accurate pricing
      const bestBid = parseFloat(moneylineMarket.bestBid);
      const bestAsk = parseFloat(moneylineMarket.bestAsk);
      
      if (isNaN(bestBid) || isNaN(bestAsk)) {
        return;
      }
      
      // Outcome 0: use ask price (what you pay to buy)
      price0 = bestAsk;
      // Outcome 1: ask price is 1 - bestBid (to buy the other side)
      price1 = 1 - bestBid;
    } else {
      // Fall back to outcomePrices (mid prices) if bid/ask not available
      let outcomePrices;
      if (typeof moneylineMarket.outcomePrices === 'string') {
        try {
          outcomePrices = JSON.parse(moneylineMarket.outcomePrices);
        } catch (e) {
          return;
        }
      } else {
        outcomePrices = moneylineMarket.outcomePrices;
      }

      if (!Array.isArray(outcomePrices) || outcomes.length !== outcomePrices.length) {
        return;
      }

      price0 = parseFloat(outcomePrices[0]);
      price1 = parseFloat(outcomePrices[1]);

      if (isNaN(price0) || isNaN(price1)) {
        return;
      }
    }

    // Determine away/home teams from title if possible, otherwise use outcomes order
    let awayTeam, homeTeam, awayPrice, homePrice;
    const teams = extractTeamsFromTitle(event.title);
    
    if (teams.away && teams.home) {
      // Try to match title teams to outcomes array
      const outcome0Lower = outcomes[0].toLowerCase();
      const outcome1Lower = outcomes[1].toLowerCase();
      const awayLower = teams.away.toLowerCase();
      const homeLower = teams.home.toLowerCase();

      // Check if first outcome matches away team from title
      if (outcome0Lower.includes(awayLower) || awayLower.includes(outcome0Lower)) {
        awayTeam = outcomes[0];
        homeTeam = outcomes[1];
        awayPrice = price0;
        homePrice = price1;
      } else if (outcome1Lower.includes(awayLower) || awayLower.includes(outcome1Lower)) {
        awayTeam = outcomes[1];
        homeTeam = outcomes[0];
        awayPrice = price1;
        homePrice = price0;
      } else {
        // Title parsing didn't match, just use outcomes order
        awayTeam = outcomes[0];
        homeTeam = outcomes[1];
        awayPrice = price0;
        homePrice = price1;
      }
    } else {
      // Title parsing failed, use outcomes order directly
      awayTeam = outcomes[0];
      homeTeam = outcomes[1];
      awayPrice = price0;
      homePrice = price1;
    }

    // Convert to American odds
    const awayOdds = probabilityToAmericanOdds(awayPrice);
    const homeOdds = probabilityToAmericanOdds(homePrice);

    if (awayOdds === null || homeOdds === null) {
      return;
    }

    // Calculate implied probabilities
    const awayImpliedProb = awayPrice * 100;
    const homeImpliedProb = homePrice * 100;
    const totalImpliedProb = awayImpliedProb + homeImpliedProb;

    // De-vig probabilities
    const awayTrueProb = (awayImpliedProb / totalImpliedProb) * 100;
    const homeTrueProb = (homeImpliedProb / totalImpliedProb) * 100;
    const vig = totalImpliedProb - 100;

    // Format date/time
    const startDate = event.startDate ? new Date(event.startDate) : new Date();
    const dateStr = startDate.toLocaleDateString();
    const timeStr = startDate.toLocaleTimeString();
    const status = event.live ? 'LIVE' : (event.closed ? 'CLOSED' : 'Upcoming');

    // Add to CSV
    csvRows.push([
      `"${dateStr}"`,
      `"${timeStr}"`,
      `"${event.id}"`,
      `"${awayTeam}"`,
      `"${homeTeam}"`,
      `"${status}"`,
      '"Polymarket"',
      awayOdds,
      homeOdds,
      awayImpliedProb.toFixed(2),
      homeImpliedProb.toFixed(2),
      awayTrueProb.toFixed(2),
      homeTrueProb.toFixed(2),
      vig.toFixed(2)
    ].join(','));
  });

  return csvRows;
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('Fetching NFL tag ID...');
    const nflTagId = await getNFLTagId();

    console.log('Fetching NFL events...');
    const events = await fetchNFLEvents(nflTagId);

    console.log(`\nProcessing ${events.length} events...`);
    const csvRows = processEvents(events);

    // Save raw JSON
    const timestamp = new Date().toISOString();
    const timestampStr = timestamp.replace(/[:.]/g, '-').split('T')[0];
    const timestampMs = Date.now();

    const rawFilename = `polymarket_nfl_raw_${timestampStr}_${timestampMs}.json`;
    const rawFilepath = path.join(OUTPUTS_DIR, rawFilename);
    fs.writeFileSync(rawFilepath, JSON.stringify(events, null, 2), 'utf8');
    console.log(`Raw JSON saved to: ${rawFilepath}`);

    // Save CSV (overwrites previous file)
    const csvFilename = 'polymarket_nfl.csv';
    const csvFilepath = path.join(OUTPUTS_DIR, csvFilename);
    fs.writeFileSync(csvFilepath, csvRows.join('\n'), 'utf8');
    console.log(`CSV saved to: ${csvFilepath}`);
    console.log(`\nTotal markets found: ${csvRows.length - 1}`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();

