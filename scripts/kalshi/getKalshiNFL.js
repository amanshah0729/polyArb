require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

// Note: Public endpoints don't require authentication
// Authentication will be needed for trading endpoints

const KALSHI_BASE_URL = 'api.elections.kalshi.com';
const API_BASE_PATH = '/trade-api/v2';

// Create outputs directory
const OUTPUTS_DIR = path.join(__dirname, '..', '..', 'outputs', 'kalshi');
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

/**
 * Make HTTPS request to Kalshi API
 */
function makeRequest(endpoint, queryParams = {}) {
  return new Promise((resolve, reject) => {
    // Build query string
    const queryString = Object.entries(queryParams)
      .filter(([_, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    
    const path = `${API_BASE_PATH}${endpoint}${queryString ? '?' + queryString : ''}`;
    
    const options = {
      hostname: KALSHI_BASE_URL,
      path: path,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    console.log(`Making request to: https://${KALSHI_BASE_URL}${path}`);

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`Error: API returned status code ${res.statusCode}`);
          console.error('Response:', data);
          reject(new Error(`API error: ${res.statusCode} - ${data}`));
          return;
        }

        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (error) {
          console.error('Failed to parse JSON:', error.message);
          console.error('Response preview:', data.substring(0, 200));
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

/**
 * Fetch NFL events first, then get head-to-head markets
 */
async function fetchNFLEvents() {
  const allEvents = [];
  let cursor = '';
  let hasMore = true;

  while (hasMore) {
    try {
      const params = {
        limit: 200,
        status: 'open',
        with_nested_markets: true // Include markets in event response
      };
      
      if (cursor) {
        params.cursor = cursor;
      }

      console.log(`Fetching events... cursor: ${cursor || 'none'}`);
      const response = await makeRequest('/events', params);

      if (!response.events || response.events.length === 0) {
        hasMore = false;
        break;
      }

      // Filter for NFL game events (head-to-head games)
      const nflEvents = response.events.filter(event => {
        const ticker = (event.event_ticker || '').toLowerCase();
        const seriesTicker = (event.series_ticker || '').toLowerCase();
        const title = (event.title || '').toLowerCase();
        
        // Look for NFL game events
        const isNFL = ticker.includes('nfl') || seriesTicker.includes('nfl');
        const isGame = title.includes(' vs ') || title.includes(' @ ') || ticker.includes('game');
        const isNotProp = !title.includes('mvp') && !title.includes('win the');
        
        return isNFL && isGame && isNotProp;
      });

      allEvents.push(...nflEvents);
      console.log(`Found ${nflEvents.length} NFL game events (total: ${allEvents.length})`);

      cursor = response.cursor || '';
      if (!cursor || response.events.length < 200) {
        hasMore = false;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error fetching events:`, error.message);
      hasMore = false;
    }
  }

  return allEvents;
}

/**
 * Extract head-to-head markets from events
 */
function extractHeadToHeadMarkets(events) {
  const h2hMarkets = [];
  
  events.forEach(event => {
    if (!event.markets || !Array.isArray(event.markets)) {
      return;
    }
    
    // Look for moneyline/head-to-head markets
    const gameMarkets = event.markets.filter(market => {
      const title = (market.title || '').toLowerCase();
      const marketType = (market.market_type || '').toLowerCase();
      
      // Exclude MVP, props, etc.
      const isExcluded = 
        title.includes('mvp') ||
        title.includes('win the') ||
        title.includes('will ') ||
        market.ticker?.toLowerCase().includes('mvp');
      
      // Look for binary markets that represent game outcomes
      const isBinary = marketType === 'binary';
      const hasTeamNames = title.includes(' vs ') || title.includes(' @ ');
      
      return !isExcluded && isBinary && (hasTeamNames || market.yes_sub_title || market.no_sub_title);
    });
    
    h2hMarkets.push(...gameMarkets);
  });
  
  return h2hMarkets;
}

/**
 * Fetch all NFL head-to-head markets
 */
async function fetchNFLMarkets() {
  console.log('Fetching NFL events with nested markets...');
  const events = await fetchNFLEvents();
  
  if (events.length === 0) {
    console.log('No NFL events found. Trying direct market fetch...');
    // Fallback: fetch markets directly
    return await fetchMarketsDirectly();
  }
  
  console.log(`Extracting head-to-head markets from ${events.length} events...`);
  const markets = extractHeadToHeadMarkets(events);
  
  if (markets.length === 0) {
    console.log('No head-to-head markets found in events. Trying direct market fetch...');
    return await fetchMarketsDirectly();
  }
  
  return markets;
}

/**
 * Fallback: Fetch markets directly with better filtering
 */
async function fetchMarketsDirectly() {
  const allMarkets = [];
  let cursor = '';
  let hasMore = true;

  while (hasMore) {
    try {
      const params = {
        limit: 100,
        status: 'open',
        mve_filter: 'exclude'
      };
      
      if (cursor) {
        params.cursor = cursor;
      }

      console.log(`Fetching markets directly... cursor: ${cursor || 'none'}`);
      const response = await makeRequest('/markets', params);

      if (!response.markets || response.markets.length === 0) {
        hasMore = false;
        break;
      }

      // Filter for NFL head-to-head game markets only
      const nflMarkets = response.markets.filter(market => {
        const ticker = (market.event_ticker || '').toLowerCase();
        const marketTicker = (market.ticker || '').toLowerCase();
        const title = (market.title || '').toLowerCase();
        const yesSub = (market.yes_sub_title || '').toLowerCase();
        const noSub = (market.no_sub_title || '').toLowerCase();
        
        // Exclude MVP markets, prop bets, and other non-game markets
        const isExcluded = 
          title.includes('mvp') ||
          title.includes('win the') ||
          title.includes('will ') ||
          marketTicker.includes('mvp') ||
          marketTicker.includes('sbmvp') ||
          title.includes('vaccine') ||
          title.includes('recommendation');
        
        if (isExcluded) {
          return false;
        }
        
        // Look for head-to-head game indicators
        const hasTeamVsTeam = 
          (title.includes(' vs ') || title.includes(' vs. ') || title.includes(' @ ')) &&
          !title.includes('win') &&
          !title.includes('mvp');
        
        // Check if yes/no subtitles contain team names (indicates game outcome market)
        const hasTeamInSubs = (yesSub && noSub) && 
          (yesSub.length > 2 && noSub.length > 2) &&
          !yesSub.includes('win') && !noSub.includes('win');
        
        // Look for NFL game series tickers
        const isNFLGame = ticker.includes('nfl') && 
          (ticker.includes('game') || ticker.includes('match') || hasTeamVsTeam || hasTeamInSubs);
        
        return isNFLGame || (hasTeamVsTeam && ticker.includes('nfl'));
      });

      allMarkets.push(...nflMarkets);
      console.log(`Found ${nflMarkets.length} NFL head-to-head markets (total: ${allMarkets.length})`);

      cursor = response.cursor || '';
      if (!cursor || response.markets.length < 100) {
        hasMore = false;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error fetching markets:`, error.message);
      hasMore = false;
    }
  }

  return allMarkets;
}

/**
 * Convert Kalshi price (in cents) to probability percentage
 */
function priceToProbability(priceCents) {
  return (priceCents / 100) * 100;
}

/**
 * Convert probability to American odds
 */
function probabilityToAmericanOdds(prob) {
  if (prob <= 0 || prob >= 100) {
    return null;
  }

  const decimal = prob / 100;
  
  if (decimal >= 0.5) {
    // Favorite (negative odds)
    return Math.round(-100 * decimal / (1 - decimal));
  } else {
    // Underdog (positive odds)
    return Math.round(100 * (1 - decimal) / decimal);
  }
}

/**
 * Process markets and create CSV
 */
function processMarkets(markets) {
  const csvRows = [];
  csvRows.push([
    'Date',
    'Time',
    'Market Ticker',
    'Event Ticker',
    'Title',
    'Away Team',
    'Home Team',
    'Status',
    'Yes Bid',
    'Yes Ask',
    'No Bid',
    'No Ask',
    'Yes Bid Prob (%)',
    'Yes Ask Prob (%)',
    'No Bid Prob (%)',
    'No Ask Prob (%)',
    'Yes American Odds',
    'No American Odds',
    'Last Price',
    'Volume'
  ].join(','));

  markets.forEach(market => {
    // Extract teams from market data
    const title = market.title || '';
    const teams = extractTeamsFromMarket(market);
    
    // Parse dates
    const closeTime = market.close_time ? new Date(market.close_time) : new Date();
    const dateStr = closeTime.toLocaleDateString();
    const timeStr = closeTime.toLocaleTimeString();

    // Get prices (in cents, convert to dollars)
    const yesBid = market.yes_bid ? market.yes_bid / 100 : null;
    const yesAsk = market.yes_ask ? market.yes_ask / 100 : null;
    const noBid = market.no_bid ? market.no_bid / 100 : null;
    const noAsk = market.no_ask ? market.no_ask / 100 : null;
    const lastPrice = market.last_price ? market.last_price / 100 : null;

    // Calculate probabilities
    const yesBidProb = yesBid ? priceToProbability(yesBid * 100) : '';
    const yesAskProb = yesAsk ? priceToProbability(yesAsk * 100) : '';
    const noBidProb = noBid ? priceToProbability(noBid * 100) : '';
    const noAskProb = noAsk ? priceToProbability(noAsk * 100) : '';

    // Convert to American odds
    const yesOdds = yesAskProb ? probabilityToAmericanOdds(yesAskProb) : '';
    const noOdds = noAskProb ? probabilityToAmericanOdds(noAskProb) : '';

    csvRows.push([
      `"${dateStr}"`,
      `"${timeStr}"`,
      `"${market.ticker || ''}"`,
      `"${market.event_ticker || ''}"`,
      `"${title}"`,
      `"${teams.away || ''}"`,
      `"${teams.home || ''}"`,
      `"${market.status || ''}"`,
      yesBid !== null ? yesBid.toFixed(4) : '',
      yesAsk !== null ? yesAsk.toFixed(4) : '',
      noBid !== null ? noBid.toFixed(4) : '',
      noAsk !== null ? noAsk.toFixed(4) : '',
      yesBidProb ? yesBidProb.toFixed(2) : '',
      yesAskProb ? yesAskProb.toFixed(2) : '',
      noBidProb ? noBidProb.toFixed(2) : '',
      noAskProb ? noAskProb.toFixed(2) : '',
      yesOdds !== null && yesOdds !== '' ? yesOdds : '',
      noOdds !== null && noOdds !== '' ? noOdds : '',
      lastPrice !== null ? lastPrice.toFixed(4) : '',
      market.volume || ''
    ].join(','));
  });

  return csvRows;
}

/**
 * Extract team names from market (improved version)
 */
function extractTeamsFromMarket(market) {
  const title = market.title || '';
  const yesSub = market.yes_sub_title || '';
  const noSub = market.no_sub_title || '';
  
  // First try: Extract from title (e.g., "Chiefs vs Bills")
  const titlePatterns = [
    /(.+?)\s+(?:vs|@|v\.|versus)\s+(.+)/i,
    /(.+?)\s+at\s+(.+)/i,
  ];

  for (const pattern of titlePatterns) {
    const match = title.match(pattern);
    if (match) {
      return {
        away: match[1].trim(),
        home: match[2].trim()
      };
    }
  }
  
  // Second try: Use yes/no subtitles if they look like team names
  if (yesSub && noSub && yesSub.length > 2 && noSub.length > 2) {
    // Check if they don't contain "win" or other prop bet language
    if (!yesSub.toLowerCase().includes('win') && 
        !noSub.toLowerCase().includes('win') &&
        !yesSub.toLowerCase().includes('will') &&
        !noSub.toLowerCase().includes('will')) {
      // Assume these are team names (order might vary)
      return {
        away: yesSub.trim(),
        home: noSub.trim()
      };
    }
  }
  
  // Third try: Extract from event ticker if it has team info
  const eventTicker = market.event_ticker || '';
  const tickerMatch = eventTicker.match(/([A-Z]+)-([A-Z]+)/);
  if (tickerMatch) {
    return {
      away: tickerMatch[1],
      home: tickerMatch[2]
    };
  }

  return { away: null, home: null };
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('='.repeat(60));
    console.log('Kalshi NFL Data Fetcher');
    console.log('='.repeat(60));
    console.log('');

    console.log('Fetching NFL markets from Kalshi...');
    const markets = await fetchNFLMarkets();

    if (markets.length === 0) {
      console.log('No NFL markets found. This might mean:');
      console.log('1. No NFL markets are currently open');
      console.log('2. The filter needs adjustment');
      console.log('3. Authentication failed');
      return;
    }

    console.log(`\nProcessing ${markets.length} NFL markets...`);
    const csvRows = processMarkets(markets);

    // Save raw JSON
    const timestamp = new Date().toISOString();
    const timestampStr = timestamp.replace(/[:.]/g, '-').split('T')[0];
    const timestampMs = Date.now();

    const rawFilename = `kalshi_nfl_raw_${timestampStr}_${timestampMs}.json`;
    const rawFilepath = path.join(OUTPUTS_DIR, rawFilename);
    fs.writeFileSync(rawFilepath, JSON.stringify(markets, null, 2), 'utf8');
    console.log(`Raw JSON saved to: ${rawFilepath}`);

    // Save CSV
    const csvFilename = `kalshi_nfl_${timestampStr}_${timestampMs}.csv`;
    const csvFilepath = path.join(OUTPUTS_DIR, csvFilename);
    fs.writeFileSync(csvFilepath, csvRows.join('\n'), 'utf8');
    console.log(`CSV saved to: ${csvFilepath}`);
    console.log(`\nTotal markets processed: ${csvRows.length - 1}`);

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

