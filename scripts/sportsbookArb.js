/**
 * Unified Sportsbook ↔ Polymarket Arbitrage Scanner
 *
 * Fetches odds from The Odds API (all major sportsbooks), matches to Polymarket
 * via Predexon + CLOB ask prices, and finds arbitrage opportunities.
 *
 * Usage: node scripts/sportsbookArb.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const {
  get, sleep, americanToImplied, normalizeTeam,
  SPORT_SLUG_PREFIXES, matchPredexonMarket, searchPredexon,
  getPolyAskPrice, RATE_LIMIT_MS,
} = require('./bfagaming/scan');

// ── Config ──────────────────────────────────────────────────────────────────

const ODDS_API_KEY = process.env.OPENAPI_API_KEY;
if (!ODDS_API_KEY) {
  console.error('Error: OPENAPI_API_KEY not found in .env');
  process.exit(1);
}

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// Sports to scan — The Odds API keys → display names + Predexon prefixes
const SPORTS_CONFIG = {
  'basketball_nba':             { display: 'NBA',  prefixes: ['nba-'] },
  'icehockey_nhl':              { display: 'NHL',  prefixes: ['nhl-'] },
  'baseball_mlb':               { display: 'MLB',  prefixes: ['mlb-'] },
  'mma_mixed_martial_arts':     { display: 'UFC',  prefixes: [] },
  'soccer_epl':                 { display: 'EPL',  prefixes: ['epl-', 'soccer-'] },
  'soccer_usa_mls':             { display: 'MLS',  prefixes: ['mls-', 'soccer-'] },
  'soccer_uefa_champs_league':  { display: 'UCL',  prefixes: ['soccer-', 'ucl-'] },
  'americanfootball_nfl':       { display: 'NFL',  prefixes: ['nfl-'] },
  'americanfootball_ncaaf':     { display: 'NCAAF', prefixes: ['ncaaf-'] },
  'boxing_boxing':              { display: 'BOX',  prefixes: [] },
};

const OUT_DIR = path.join(__dirname, '..', 'outputs', 'final_arb');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Odds API ────────────────────────────────────────────────────────────────

/**
 * Fetch odds for a sport from The Odds API.
 * Returns one entry per game+market-type combo with the BEST bookmaker odds per side.
 */
async function fetchOddsAPI(sportKey) {
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
  try {
    const games = await get(url);
    if (!Array.isArray(games)) return [];
    return games;
  } catch (err) {
    console.warn(`  Odds API ${sportKey} error: ${err.message}`);
    return [];
  }
}

/**
 * Parse Odds API games into per-market-type entries with the best bookmaker odds.
 * For each game+market combo, finds the bookmaker offering the lowest implied prob
 * (= best odds for the bettor) on each side.
 */
function parseOddsGames(games, sportDisplay) {
  const entries = [];

  for (const game of games) {
    const awayTeam = game.away_team;
    const homeTeam = game.home_team;
    const startDate = game.commence_time;
    const bookmakers = game.bookmakers ?? [];

    // Collect all odds per market type across bookmakers
    const marketOdds = { h2h: [], spreads: [], totals: [] };

    for (const bk of bookmakers) {
      for (const mkt of bk.markets ?? []) {
        if (!marketOdds[mkt.key]) continue;
        marketOdds[mkt.key].push({ bookmaker: bk.title, outcomes: mkt.outcomes });
      }
    }

    // ── h2h (moneyline) ──
    if (marketOdds.h2h.length > 0) {
      let bestAway = null, bestHome = null;
      for (const { bookmaker, outcomes } of marketOdds.h2h) {
        const awayOut = outcomes.find(o => o.name === awayTeam);
        const homeOut = outcomes.find(o => o.name === homeTeam);
        if (!awayOut || !homeOut) continue;
        const awayImp = americanToImplied(awayOut.price);
        const homeImp = americanToImplied(homeOut.price);
        if (!bestAway || awayImp < bestAway.implied) {
          bestAway = { odds: awayOut.price, implied: awayImp, bookmaker };
        }
        if (!bestHome || homeImp < bestHome.implied) {
          bestHome = { odds: homeOut.price, implied: homeImp, bookmaker };
        }
      }
      if (bestAway && bestHome) {
        entries.push({
          sport: sportDisplay, awayTeam, homeTeam, startDate,
          marketType: 'moneyline', line: null,
          awayOdds: bestAway.odds, awayImplied: bestAway.implied, awayBookmaker: bestAway.bookmaker,
          homeOdds: bestHome.odds, homeImplied: bestHome.implied, homeBookmaker: bestHome.bookmaker,
        });
      }
    }

    // ── spreads ──
    if (marketOdds.spreads.length > 0) {
      // Group by point value (line) — different books may have different lines
      const lineGroups = {};
      for (const { bookmaker, outcomes } of marketOdds.spreads) {
        const awayOut = outcomes.find(o => o.name === awayTeam);
        const homeOut = outcomes.find(o => o.name === homeTeam);
        if (!awayOut || !homeOut) continue;
        const line = homeOut.point; // home spread point
        const key = String(line);
        if (!lineGroups[key]) lineGroups[key] = [];
        lineGroups[key].push({ bookmaker, awayOut, homeOut });
      }

      for (const [lineStr, group] of Object.entries(lineGroups)) {
        let bestAway = null, bestHome = null;
        for (const { bookmaker, awayOut, homeOut } of group) {
          const awayImp = americanToImplied(awayOut.price);
          const homeImp = americanToImplied(homeOut.price);
          if (!bestAway || awayImp < bestAway.implied) {
            bestAway = { odds: awayOut.price, implied: awayImp, bookmaker };
          }
          if (!bestHome || homeImp < bestHome.implied) {
            bestHome = { odds: homeOut.price, implied: homeImp, bookmaker };
          }
        }
        if (bestAway && bestHome) {
          entries.push({
            sport: sportDisplay, awayTeam, homeTeam, startDate,
            marketType: 'spread', line: parseFloat(lineStr),
            awayOdds: bestAway.odds, awayImplied: bestAway.implied, awayBookmaker: bestAway.bookmaker,
            homeOdds: bestHome.odds, homeImplied: bestHome.implied, homeBookmaker: bestHome.bookmaker,
          });
        }
      }
    }

    // ── totals ──
    if (marketOdds.totals.length > 0) {
      const lineGroups = {};
      for (const { bookmaker, outcomes } of marketOdds.totals) {
        const overOut = outcomes.find(o => o.name === 'Over');
        const underOut = outcomes.find(o => o.name === 'Under');
        if (!overOut || !underOut) continue;
        const line = overOut.point;
        const key = String(line);
        if (!lineGroups[key]) lineGroups[key] = [];
        lineGroups[key].push({ bookmaker, overOut, underOut });
      }

      for (const [lineStr, group] of Object.entries(lineGroups)) {
        let bestOver = null, bestUnder = null;
        for (const { bookmaker, overOut, underOut } of group) {
          const overImp = americanToImplied(overOut.price);
          const underImp = americanToImplied(underOut.price);
          if (!bestOver || overImp < bestOver.implied) {
            bestOver = { odds: overOut.price, implied: overImp, bookmaker };
          }
          if (!bestUnder || underImp < bestUnder.implied) {
            bestUnder = { odds: underOut.price, implied: underImp, bookmaker };
          }
        }
        if (bestOver && bestUnder) {
          entries.push({
            sport: sportDisplay, awayTeam, homeTeam, startDate,
            marketType: 'total', line: parseFloat(lineStr),
            awayOdds: bestOver.odds, awayImplied: bestOver.implied, awayBookmaker: bestOver.bookmaker,
            homeOdds: bestUnder.odds, homeImplied: bestUnder.implied, homeBookmaker: bestUnder.bookmaker,
            _isTotal: true,
          });
        }
      }
    }
  }

  return entries;
}

// ── Arb calculation ─────────────────────────────────────────────────────────

function checkArb(sbEntry, polyPrices) {
  const sbAway = sbEntry.awayImplied;
  const sbHome = sbEntry.homeImplied;
  const polyAway = polyPrices.awayImplied;
  const polyHome = polyPrices.homeImplied;

  // Option 1: bet away on sportsbook + home on Polymarket
  const option1 = sbAway + polyHome;
  // Option 2: bet away on Polymarket + home on sportsbook
  const option2 = polyAway + sbHome;

  const bestCost = Math.min(option1, option2);
  const hasArb = bestCost < 1.0;
  const profitPct = hasArb ? ((1.0 - bestCost) / bestCost) * 100 : 0;

  let strategy = '';
  const mt = sbEntry.marketType;
  const mtTag = mt !== 'moneyline' ? ` [${mt}${sbEntry.line != null ? ' (' + sbEntry.line + ')' : ''}]` : '';

  if (mt === 'total') {
    if (option1 <= option2) {
      strategy = `Over@${sbEntry.awayBookmaker} + Under@Poly${mtTag}`;
    } else {
      strategy = `Over@Poly + Under@${sbEntry.homeBookmaker}${mtTag}`;
    }
  } else {
    const away = sbEntry.awayTeam;
    const home = sbEntry.homeTeam;
    if (option1 <= option2) {
      strategy = `${away}@${sbEntry.awayBookmaker} + ${home}@Poly${mtTag}`;
    } else {
      strategy = `${away}@Poly + ${home}@${sbEntry.homeBookmaker}${mtTag}`;
    }
  }

  return { hasArb, bestCost, profitPct, strategy, sbAway, sbHome, polyAway, polyHome };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60));
  console.log('  Sportsbook ↔ Polymarket Arbitrage Scanner');
  console.log('═'.repeat(60));

  const allResults = [];

  // Step 1: Fetch odds from The Odds API for all sports
  const allEntries = [];
  for (const [sportKey, config] of Object.entries(SPORTS_CONFIG)) {
    console.log(`\nFetching ${config.display} odds...`);
    await sleep(300); // avoid Odds API rate limit
    const games = await fetchOddsAPI(sportKey);
    if (games.length === 0) {
      console.log(`  No games found for ${config.display}`);
      continue;
    }
    const entries = parseOddsGames(games, config.display);
    const mlCount = entries.filter(e => e.marketType === 'moneyline').length;
    const spCount = entries.filter(e => e.marketType === 'spread').length;
    const totCount = entries.filter(e => e.marketType === 'total').length;
    console.log(`  ${config.display}: ${games.length} games → ${mlCount} ML, ${spCount} spreads, ${totCount} totals`);
    allEntries.push(...entries.map(e => ({ ...e, sportKey, prefixes: config.prefixes })));
  }

  console.log(`\nTotal sportsbook entries: ${allEntries.length}`);

  // Step 2: Group entries by unique game (team pair) for Predexon search
  const gameGroups = {};
  for (const entry of allEntries) {
    const key = `${entry.awayTeam}|||${entry.homeTeam}|||${entry.sport}`;
    if (!gameGroups[key]) gameGroups[key] = [];
    gameGroups[key].push(entry);
  }

  console.log(`Unique games: ${Object.keys(gameGroups).length}\n`);

  // Step 3: Match each game to Polymarket via Predexon
  for (const [gameKey, entries] of Object.entries(gameGroups)) {
    const first = entries[0];
    const searchAway = normalizeTeam(first.awayTeam);
    const searchHome = normalizeTeam(first.homeTeam);
    const searchQuery = `${searchAway} ${searchHome}`;

    process.stdout.write(`Predexon "${searchQuery}": `);
    const predexonMarkets = await searchPredexon(searchQuery);
    await sleep(RATE_LIMIT_MS);

    // Filter live markets
    const liveMarkets = predexonMarkets.filter(m => {
      const outcomes = m.outcomes ?? [];
      if (outcomes.length !== 2) return false;
      return outcomes.every(o => o.price > 0.01 && o.price < 0.99) && (m.total_volume_usd ?? 0) > 0;
    });

    console.log(`${predexonMarkets.length} results, ${liveMarkets.length} live`);

    // For each market type entry in this game, try to match
    for (const sbEntry of entries) {
      const mtTag = sbEntry.marketType !== 'moneyline'
        ? ` [${sbEntry.marketType}${sbEntry.line != null ? ' (' + sbEntry.line + ')' : ''}]`
        : '';
      const displayName = sbEntry._isTotal
        ? `${first.awayTeam} @ ${first.homeTeam} O/U ${sbEntry.line}`
        : `${first.awayTeam} @ ${first.homeTeam}`;

      // Build a fake "bfaEntry" compatible with matchPredexonMarket
      const bfaCompat = {
        marketType: sbEntry.marketType,
        awayTeam: sbEntry._isTotal ? 'Over' : sbEntry.awayTeam,
        homeTeam: sbEntry._isTotal ? 'Under' : sbEntry.homeTeam,
        _realAway: sbEntry.awayTeam,
        _realHome: sbEntry.homeTeam,
        line: sbEntry.line,
        startDate: sbEntry.startDate,
      };

      // Determine sport slug for prefix filtering
      const sportSlug = Object.keys(SPORT_SLUG_PREFIXES).find(s =>
        (SPORT_SLUG_PREFIXES[s] ?? []).some(p => (sbEntry.prefixes ?? []).includes(p))
      ) ?? '';

      const match = matchPredexonMarket(bfaCompat, liveMarkets, sportSlug);

      if (!match) {
        console.log(`    No match: ${displayName}${mtTag}`);
        continue;
      }

      const { market: mkt, awayToken, homeToken } = match;
      const volumeUsd = mkt.total_volume_usd ?? 0;

      if (volumeUsd < 300) {
        console.log(`    ${displayName}${mtTag} → skipped (vol=$${Math.round(volumeUsd)})`);
        continue;
      }

      // Fetch real ask prices from CLOB
      const [awayAsk, homeAsk] = await Promise.all([
        getPolyAskPrice(awayToken),
        getPolyAskPrice(homeToken),
      ]);
      const polyAway = awayAsk ?? match.awayPrice;
      const polyHome = homeAsk ?? match.homePrice;

      const polyPrices = { awayImplied: polyAway, homeImplied: polyHome };
      const arb = checkArb(sbEntry, polyPrices);

      process.stdout.write(`    ${displayName}${mtTag} → `);
      console.log(`vol=$${Math.round(volumeUsd).toLocaleString()}  cost=${arb.bestCost.toFixed(4)}  profit=${arb.profitPct.toFixed(2)}%${arb.hasArb ? '  *** ARB ***' : ''}`);

      const startDate = sbEntry.startDate ? new Date(sbEntry.startDate) : null;

      allResults.push({
        date: startDate ? startDate.toLocaleDateString() : '',
        time: startDate ? startDate.toLocaleTimeString() : '',
        sport: sbEntry.sport,
        marketType: sbEntry.marketType,
        line: sbEntry.line != null ? String(sbEntry.line) : '',
        awayTeam: sbEntry.awayTeam,
        homeTeam: sbEntry.homeTeam,
        hasArb: arb.hasArb,
        strategy: arb.strategy,
        sbAwayBookmaker: sbEntry.awayBookmaker,
        sbAwayOdds: sbEntry.awayOdds,
        sbAwayImplied: sbEntry.awayImplied,
        sbHomeBookmaker: sbEntry.homeBookmaker,
        sbHomeOdds: sbEntry.homeOdds,
        sbHomeImplied: sbEntry.homeImplied,
        polyAwayImplied: polyAway,
        polyHomeImplied: polyHome,
        profitPct: arb.profitPct,
        bestCost: arb.bestCost,
        volumeUsd,
      });
    }
  }

  // Sort: arbs first (profit desc), then by bestCost asc
  allResults.sort((a, b) => {
    if (a.hasArb && !b.hasArb) return -1;
    if (!a.hasArb && b.hasArb) return 1;
    if (a.hasArb && b.hasArb) return b.profitPct - a.profitPct;
    return a.bestCost - b.bestCost;
  });

  // Build CSV
  const csvHeader = [
    'Date', 'Time', 'Sport', 'Market Type', 'Line',
    'Away Team', 'Home Team',
    'Arb Opportunity', 'Strategy',
    'Best Bookmaker Away', 'SB Away Odds', 'SB Away Implied (%)',
    'Best Bookmaker Home', 'SB Home Odds', 'SB Home Implied (%)',
    'Polymarket Away Implied (%)', 'Polymarket Home Implied (%)',
    'Profit %', 'Best Option Cost', 'Volume ($)',
  ].join(',');

  const csvRows = allResults.map(r => [
    `"${r.date}"`,
    `"${r.time}"`,
    `"${r.sport}"`,
    `"${r.marketType}"`,
    `"${r.line}"`,
    `"${r.awayTeam}"`,
    `"${r.homeTeam}"`,
    `"${r.hasArb ? 'YES' : 'NO'}"`,
    `"${r.strategy}"`,
    `"${r.sbAwayBookmaker}"`,
    r.sbAwayOdds,
    (r.sbAwayImplied * 100).toFixed(2),
    `"${r.sbHomeBookmaker}"`,
    r.sbHomeOdds,
    (r.sbHomeImplied * 100).toFixed(2),
    (r.polyAwayImplied * 100).toFixed(2),
    (r.polyHomeImplied * 100).toFixed(2),
    r.profitPct.toFixed(2),
    r.bestCost.toFixed(4),
    Math.round(r.volumeUsd),
  ].join(','));

  const today = new Date().toISOString().split('T')[0];
  const outPath = path.join(OUT_DIR, `arb_all_${today}.csv`);
  fs.writeFileSync(outPath, [csvHeader, ...csvRows].join('\n'), 'utf8');

  console.log(`\nSaved → ${outPath}`);
  console.log(`Total matched: ${allResults.length}   Arb: ${allResults.filter(r => r.hasArb).length}`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
