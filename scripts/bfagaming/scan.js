/**
 * BFAGaming ↔ Polymarket Arbitrage Scanner — Core Module
 *
 * Exports runScan() which returns an array of result objects.
 * Used by both the CLI script (getBFAGamingArb.js) and the notifier service.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const PREDEXON_API_KEY = process.env.PREDEXON_API_KEY;
const POLYMARKET_BASE  = 'https://gamma-api.polymarket.com';
const BFA_BASE         = 'https://api.bfagaming.com/oddsservice';
const PREDEXON_HOST    = 'api.predexon.com';
const PREDEXON_BASE    = '/v2';
// Broad set of slugs to probe — BFA has no listing endpoint, so we try all known slugs
// and keep the ones that return games.
const ALL_BFA_SLUGS = [
  'nba', 'nhl', 'nfl', 'mlb', 'ufc', 'mma', 'boxing',
  'soccer', 'tennis', 'golf', 'cricket', 'rugby',
  'ncaab', 'ncaaf', 'epl', 'mls',
];
const RATE_LIMIT_MS    = 200;

// BFA market type mapping
const BFA_MARKET_TYPES = { 1: 'moneyline', 2: 'spread', 3: 'total' };

// ── Bet sizing constants ───────────────────────────────────────────────────────
const BONUS    = 200;
const ROLLOVER = 4800;
const MIN_BET  = 10;
const MAX_BET  = 100;
const MAX_COST = 1.02;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function get(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { ...BROWSER_HEADERS, ...extraHeaders },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 150)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── American odds helpers ─────────────────────────────────────────────────────

function americanToImplied(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// ── BFAGaming ─────────────────────────────────────────────────────────────────

/**
 * Fetch BFA games for a sport slug. Returns one entry per game+market-type combo.
 * Each entry has: { name, startDate, status, awayTeam, homeTeam, marketType,
 *   line (null for ML), awayOdds, homeOdds, awayImplied, homeImplied }
 * For totals: "away" = over, "home" = under (side 4 / side 5).
 */
async function fetchBFAGames(slug) {
  const url = `${BFA_BASE}/events/popular/${slug}?playerId=0&agentId=0&fixtureType=1&set=Auto`;
  try {
    const data = await get(url);
    const events = Array.isArray(data) ? data : (data.games ?? data.events ?? data.data ?? []);
    const entries = [];

    for (const game of events) {
      if (!game.fixtures || !game.markets) continue;

      const contestants = game.fixtures[0]?.contestants ?? [];
      const away = contestants.find((c) => c.side === 2);
      const home = contestants.find((c) => c.side === 1);
      if (!away || !home) continue;

      const awayL = away.name.toLowerCase();
      const homeL = home.name.toLowerCase();
      if (awayL.includes('away') && homeL.includes('home')) continue;

      const base = {
        name: game.name,
        startDate: game.startDate ?? game.fixtures[0]?.date ?? null,
        status: game.status ?? 'Upcoming',
        awayTeam: away.name,
        homeTeam: home.name,
      };

      for (const mkt of game.markets) {
        const marketType = BFA_MARKET_TYPES[mkt.type];
        if (!marketType || !mkt.odds) continue;

        if (marketType === 'moneyline') {
          const awayOddsObj = mkt.odds.find((o) => o.side === 2);
          const homeOddsObj = mkt.odds.find((o) => o.side === 1);
          if (!awayOddsObj || !homeOddsObj) continue;
          entries.push({
            ...base, marketType, line: null,
            awayOdds: awayOddsObj.price, homeOdds: homeOddsObj.price,
            awayImplied: americanToImplied(awayOddsObj.price),
            homeImplied: americanToImplied(homeOddsObj.price),
          });
        } else if (marketType === 'spread') {
          // side 1 = home, side 2 = away; line is on odds object
          const awayOddsObj = mkt.odds.find((o) => o.side === 2);
          const homeOddsObj = mkt.odds.find((o) => o.side === 1);
          if (!awayOddsObj || !homeOddsObj) continue;
          entries.push({
            ...base, marketType, line: homeOddsObj.line, // home spread line (e.g. -1.5)
            awayOdds: awayOddsObj.price, homeOdds: homeOddsObj.price,
            awayImplied: americanToImplied(awayOddsObj.price),
            homeImplied: americanToImplied(homeOddsObj.price),
          });
        } else if (marketType === 'total') {
          // side 4 = over, side 5 = under
          const overObj = mkt.odds.find((o) => o.side === 4);
          const underObj = mkt.odds.find((o) => o.side === 5);
          if (!overObj || !underObj) continue;
          entries.push({
            ...base, marketType, line: overObj.line, // total line (e.g. 6.5)
            awayOdds: overObj.price, homeOdds: underObj.price, // away=over, home=under
            awayImplied: americanToImplied(overObj.price),
            homeImplied: americanToImplied(underObj.price),
            awayTeam: 'Over', homeTeam: 'Under',
            _realAway: away.name, _realHome: home.name, // keep for matching
          });
        }
      }
    }

    const mlCount = entries.filter(e => e.marketType === 'moneyline').length;
    const spCount = entries.filter(e => e.marketType === 'spread').length;
    const totCount = entries.filter(e => e.marketType === 'total').length;
    console.log(`  BFAGaming ${slug.toUpperCase()}: ${mlCount} ML, ${spCount} spreads, ${totCount} totals`);
    return entries;
  } catch (err) {
    console.warn(`  BFAGaming ${slug.toUpperCase()} error: ${err.message}`);
    return [];
  }
}

// ── Polymarket (gamma API — for discovery + conditionId only) ─────────────────

// Generic/root tags to skip when looking for sport-specific tags
const GENERIC_TAGS = new Set(['1', '100639']);

async function getPolyTagId(sportKey) {
  const sports = await get(`${POLYMARKET_BASE}/sports`);
  const entry = sports.find((s) => s.sport && s.sport.toLowerCase() === sportKey);
  if (!entry) return null;

  const tagIds = typeof entry.tags === 'string'
    ? entry.tags.split(',').map((t) => t.trim())
    : (Array.isArray(entry.tags) ? entry.tags : []);

  // Pick the first sport-specific tag (skip generic root tags)
  const specific = tagIds.find((t) => !GENERIC_TAGS.has(t));
  // Fall back to generic if no specific tag exists (e.g. UFC only has 1,100639)
  return specific ?? tagIds[1] ?? tagIds[0] ?? null;
}

async function fetchPolyEvents(tagId) {
  const all = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${POLYMARKET_BASE}/events?tag_id=${tagId}&closed=false&limit=${limit}&offset=${offset}&order=startDate&ascending=true`;
    const events = await get(url);
    if (!Array.isArray(events) || events.length === 0) break;
    all.push(...events);
    if (events.length < limit) break;
    offset += limit;
    await sleep(100);
  }

  return all;
}

function extractTeamsFromTitle(title) {
  if (!title) return { away: null, home: null };
  const m = title.match(/^(.+?)\s+(?:vs\.?|@|versus|at)\s+(.+)$/i);
  if (m) return { away: m[1].trim(), home: m[2].trim() };
  return { away: null, home: null };
}

/**
 * Parse gamma events into market records.
 * Returns one entry per market (moneyline, spread, total) with conditionId.
 */
function parsePolyEvents(events) {
  const records = [];

  for (const event of events) {
    if (!event.markets) continue;

    // Determine teams from event title once
    const teams = extractTeamsFromTitle(event.title);

    for (const m of event.markets) {
      const type = m.sportsMarketType;
      if (!type || !m.conditionId) continue;

      let outcomes;
      try {
        outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
      } catch { continue; }
      if (!Array.isArray(outcomes) || outcomes.length !== 2) continue;

      if (type === 'moneyline') {
        let awayTeam, homeTeam;
        if (teams.away && teams.home) {
          const o0 = outcomes[0].toLowerCase();
          const awayL = teams.away.toLowerCase();
          if (o0.includes(awayL) || awayL.includes(o0)) {
            awayTeam = outcomes[0]; homeTeam = outcomes[1];
          } else {
            awayTeam = outcomes[1]; homeTeam = outcomes[0];
          }
        } else {
          awayTeam = outcomes[0]; homeTeam = outcomes[1];
        }
        records.push({
          title: event.title, conditionId: m.conditionId,
          marketType: 'moneyline', line: null,
          awayTeam, homeTeam,
        });

      } else if (type === 'spreads') {
        // question format: "Spread: TeamName (-1.5)"
        const spreadMatch = (m.question ?? '').match(/Spread:\s*(.+?)\s*\(([+-]?\d+\.?\d*)\)/i);
        if (!spreadMatch) continue;
        const spreadTeam = spreadMatch[1].trim();
        const spreadLine = parseFloat(spreadMatch[2]);
        // outcomes = [spreadTeam, otherTeam] — first outcome is the team in the question
        let awayTeam, homeTeam;
        if (teams.away && teams.home) {
          const o0 = outcomes[0].toLowerCase();
          const awayL = teams.away.toLowerCase();
          if (o0.includes(awayL) || awayL.includes(o0)) {
            awayTeam = outcomes[0]; homeTeam = outcomes[1];
          } else {
            awayTeam = outcomes[1]; homeTeam = outcomes[0];
          }
        } else {
          awayTeam = outcomes[0]; homeTeam = outcomes[1];
        }
        // Determine which team the spread belongs to — match spreadTeam to home
        const homeSpreadLine = teamsMatch(spreadTeam, homeTeam) ? spreadLine
          : teamsMatch(spreadTeam, awayTeam) ? -spreadLine : spreadLine;
        records.push({
          title: event.title, conditionId: m.conditionId,
          marketType: 'spread', line: homeSpreadLine,
          awayTeam, homeTeam, spreadTeam,
        });

      } else if (type === 'totals') {
        // question format: "Team A vs. Team B: O/U 6.5"
        const totalMatch = (m.question ?? '').match(/O\/U\s+(\d+\.?\d*)/i);
        if (!totalMatch) continue;
        const totalLine = parseFloat(totalMatch[1]);
        // outcomes = ["Over", "Under"]
        records.push({
          title: event.title, conditionId: m.conditionId,
          marketType: 'total', line: totalLine,
          awayTeam: 'Over', homeTeam: 'Under',
          _eventTitle: event.title,
        });
      }
    }
  }

  return records;
}

// ── Predexon — prices + volume ────────────────────────────────────────────────

async function fetchPredexonPrices(conditionId, awayLabel, homeLabel) {
  if (!PREDEXON_API_KEY) throw new Error('PREDEXON_API_KEY missing in .env');

  const url = `https://${PREDEXON_HOST}${PREDEXON_BASE}/polymarket/markets?condition_id=${conditionId}`;
  let data;
  try {
    data = await get(url, { 'x-api-key': PREDEXON_API_KEY });
  } catch (err) {
    console.warn(`    Predexon error for ${conditionId.slice(0, 10)}…: ${err.message}`);
    return null;
  }

  const market = data.markets?.[0];
  if (!market) return null;

  const volumeUsd = market.total_volume_usd ?? 0;
  if (volumeUsd === 0) return null;

  if (!Array.isArray(market.outcomes) || market.outcomes.length !== 2) return null;

  const [o0, o1] = market.outcomes;
  let awayPrice, homePrice;

  const label0 = (o0.label ?? '').toLowerCase();
  const normAway = normalizeTeam(awayLabel);
  const normHome = normalizeTeam(homeLabel);

  if (label0.includes(normAway) || normAway.includes(label0)) {
    awayPrice = o0.price; homePrice = o1.price;
  } else if (label0.includes(normHome) || normHome.includes(label0)) {
    awayPrice = o1.price; homePrice = o0.price;
  } else {
    awayPrice = o0.price; homePrice = o1.price;
  }

  if (isNaN(awayPrice) || isNaN(homePrice)) return null;

  return { awayImplied: awayPrice, homeImplied: homePrice, volumeUsd };
}

// ── Team matching ─────────────────────────────────────────────────────────────

const CITY_MAP = [
  [/^los angeles (lakers|clippers|rams|kings|chargers)/i, '$1'],
  [/^los angeles /i, ''],
  [/^new york /i, ''],
  [/^new orleans /i, ''],
  [/^golden state /i, ''],
  [/^oklahoma city /i, ''],
  [/^san antonio /i, ''],
  [/^portland trail/i, 'trailblazers'],
  [/^portland /i, ''],
  [/^memphis /i, ''],
  [/^sacramento /i, ''],
  [/^utah /i, ''],
  [/^phoenix /i, ''],
  [/^dallas /i, ''],
  [/^denver /i, ''],
  [/^detroit /i, ''],
  [/^cleveland /i, ''],
  [/^chicago /i, ''],
  [/^milwaukee /i, ''],
  [/^indiana /i, ''],
  [/^orlando /i, ''],
  [/^charlotte /i, ''],
  [/^washington /i, ''],
  [/^miami /i, ''],
  [/^atlanta /i, ''],
  [/^toronto /i, ''],
  [/^brooklyn /i, ''],
  [/^boston /i, ''],
  [/^philadelphia /i, ''],
  [/^minnesota /i, ''],
  [/^houston /i, ''],
  [/^vegas golden /i, 'golden'],
  [/^vegas /i, ''],
  [/^st\. louis /i, ''],
  [/^columbus /i, ''],
  [/^nashville /i, ''],
  [/^tampa bay /i, ''],
  [/^florida /i, ''],
  [/^carolina /i, ''],
  [/^new jersey /i, ''],
  [/^pittsburgh /i, ''],
  [/^buffalo /i, ''],
  [/^ottawa /i, ''],
  [/^montreal /i, ''],
  [/^winnipeg /i, ''],
  [/^edmonton /i, ''],
  [/^calgary /i, ''],
  [/^vancouver /i, ''],
  [/^seattle /i, ''],
  [/^san jose /i, ''],
  [/^anaheim /i, ''],
  [/^colorado /i, ''],
  [/^arizona /i, ''],
  [/^green bay /i, ''],
  [/^kansas city /i, ''],
  [/^san francisco /i, ''],
  [/^new england /i, ''],
  [/^baltimore /i, ''],
  [/^cincinnati /i, ''],
  [/^jacksonville /i, ''],
  [/^tennessee /i, ''],
  [/^las vegas /i, ''],
  // MLB extras
  [/^texas /i, ''],
  [/^oakland /i, ''],
  [/^san diego /i, ''],
];

function normalizeTeam(name) {
  if (!name) return '';
  let n = name.toLowerCase().trim();
  for (const [re, repl] of CITY_MAP) {
    n = n.replace(re, repl);
  }
  return n.trim();
}

function teamsMatch(a, b) {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

/**
 * Find a matching Polymarket record for a BFA entry.
 * Matches on: market type + team names + line (for spreads/totals).
 */
function findPolyMatch(bfaEntry, polyRecords) {
  const mt = bfaEntry.marketType;

  for (const pr of polyRecords) {
    if (pr.marketType !== mt) continue;

    if (mt === 'moneyline') {
      if (
        (teamsMatch(bfaEntry.awayTeam, pr.awayTeam) && teamsMatch(bfaEntry.homeTeam, pr.homeTeam)) ||
        (teamsMatch(bfaEntry.awayTeam, pr.homeTeam) && teamsMatch(bfaEntry.homeTeam, pr.awayTeam))
      ) return pr;

    } else if (mt === 'spread') {
      // Match teams AND spread line (BFA line = home spread, Poly line = home spread)
      const teamsOk =
        (teamsMatch(bfaEntry.awayTeam, pr.awayTeam) && teamsMatch(bfaEntry.homeTeam, pr.homeTeam)) ||
        (teamsMatch(bfaEntry.awayTeam, pr.homeTeam) && teamsMatch(bfaEntry.homeTeam, pr.awayTeam));
      if (teamsOk && bfaEntry.line === pr.line) return pr;

    } else if (mt === 'total') {
      // Match by event title (teams) and total line
      const realAway = bfaEntry._realAway ?? bfaEntry.awayTeam;
      const realHome = bfaEntry._realHome ?? bfaEntry.homeTeam;
      const polyTitle = (pr._eventTitle ?? pr.title ?? '').toLowerCase();
      const teamsOk = polyTitle.includes(normalizeTeam(realAway)) || polyTitle.includes(normalizeTeam(realHome));
      if (teamsOk && bfaEntry.line === pr.line) return pr;
    }
  }
  return null;
}

// ── Bet sizing ────────────────────────────────────────────────────────────────

function sizeBet(b, p, C, r, bkr) {
  let W;
  if (C >= MAX_COST) {
    W = MIN_BET;
  } else {
    const scale = (MAX_COST - C) / (MAX_COST - 1.0);
    const W_raw = MIN_BET + (MAX_BET - MIN_BET) * scale;
    W = Math.min(W_raw, r);
  }

  let P = W * (p / b);

  if (W + P > bkr) {
    const factor = bkr / (W + P);
    W *= factor;
    P *= factor;
  }

  W = Math.round(W * 2) / 2;
  P = Math.round(P * 2) / 2;

  const guaranteedPnl = W * (1 - C) / b;
  const amortizedBonus = W * BONUS / ROLLOVER;
  const netValue = guaranteedPnl + amortizedBonus;

  return { W, P, guaranteedPnl, netValue };
}

// ── Arb math ──────────────────────────────────────────────────────────────────

function checkArb(bfaEntry, polyPrices) {
  const bfaAway = bfaEntry.awayImplied;
  const bfaHome = bfaEntry.homeImplied;
  const polyAway = polyPrices.awayImplied;
  const polyHome = polyPrices.homeImplied;

  const option1 = bfaAway + polyHome;
  const option2 = polyAway + bfaHome;

  const bestCost = Math.min(option1, option2);
  const hasArb = bestCost < 1.0;
  const profitPct = hasArb ? ((1 - bestCost) / bestCost) * 100 : 0;

  const mt = bfaEntry.marketType;
  const lineTag = bfaEntry.line != null ? ` (${bfaEntry.line})` : '';
  const mtLabel = mt !== 'moneyline' ? ` [${mt}${lineTag}]` : '';

  let strategy, bfaImplied, polyImplied;
  if (option1 <= option2) {
    strategy = `${bfaEntry.awayTeam}@BFA + ${bfaEntry.homeTeam}@Poly${mtLabel}`;
    bfaImplied = bfaAway;
    polyImplied = polyHome;
  } else {
    strategy = `${bfaEntry.awayTeam}@Poly + ${bfaEntry.homeTeam}@BFA${mtLabel}`;
    bfaImplied = bfaHome;
    polyImplied = polyAway;
  }

  return { hasArb, bestCost, profitPct, strategy, bfaImplied, polyImplied };
}

// ── Main scan function ────────────────────────────────────────────────────────

/**
 * Run a full BFA↔Polymarket arb scan.
 * @param {{ rolloverRemaining?: number, bankroll?: number }} opts
 * @returns {Promise<Array>} array of result objects
 */
async function runScan(opts = {}) {
  const rolloverRemaining = opts.rolloverRemaining ?? ROLLOVER;
  const bankroll = opts.bankroll ?? 300;

  if (!PREDEXON_API_KEY) throw new Error('PREDEXON_API_KEY missing in .env');

  // Phase 1: Discover which BFA slugs have active games
  console.log('\nDiscovering BFA sports...');
  const activeSports = [];
  for (const slug of ALL_BFA_SLUGS) {
    const entries = await fetchBFAGames(slug);
    if (entries.length > 0) activeSports.push({ slug, entries });
  }
  console.log(`Active sports: ${activeSports.map(s => s.slug.toUpperCase()).join(', ') || 'none'}\n`);

  const allResults = [];

  for (const { slug, entries: bfaEntries } of activeSports) {
    console.log(`[${slug.toUpperCase()}]`);

    // Fetch Polymarket records for this sport
    let polyRecords = [];
    try {
      const tagId = await getPolyTagId(slug);
      if (tagId) {
        const rawEvents = await fetchPolyEvents(tagId);
        polyRecords = parsePolyEvents(rawEvents);
        const mlCount = polyRecords.filter(r => r.marketType === 'moneyline').length;
        const spCount = polyRecords.filter(r => r.marketType === 'spread').length;
        const totCount = polyRecords.filter(r => r.marketType === 'total').length;
        console.log(`  Polymarket ${slug.toUpperCase()}: ${mlCount} ML, ${spCount} spreads, ${totCount} totals`);
      } else {
        console.warn(`  No Polymarket tag for ${slug}`);
      }
    } catch (err) {
      console.warn(`  Polymarket discovery error: ${err.message}`);
    }

    for (const bfaEntry of bfaEntries) {
      const polyMatch = findPolyMatch(bfaEntry, polyRecords);
      const displayName = bfaEntry.marketType === 'total'
        ? `${bfaEntry._realAway ?? '?'} @ ${bfaEntry._realHome ?? '?'} O/U ${bfaEntry.line}`
        : `${bfaEntry.awayTeam} @ ${bfaEntry.homeTeam}${bfaEntry.line != null ? ` (${bfaEntry.line})` : ''}`;
      const mtTag = bfaEntry.marketType !== 'moneyline' ? ` [${bfaEntry.marketType}]` : '';

      if (!polyMatch) {
        console.log(`    No Poly match: ${displayName}${mtTag}`);
        continue;
      }

      process.stdout.write(`    ${displayName}${mtTag} → Predexon... `);
      const polyPrices = await fetchPredexonPrices(polyMatch.conditionId, polyMatch.awayTeam, polyMatch.homeTeam);
      await sleep(RATE_LIMIT_MS);

      if (!polyPrices) {
        console.log('skipped (0 volume or unavailable)');
        continue;
      }

      const arb = checkArb(bfaEntry, polyPrices);
      const sized = sizeBet(arb.bfaImplied, arb.polyImplied, arb.bestCost, rolloverRemaining, bankroll);
      console.log(`vol=$${Math.round(polyPrices.volumeUsd).toLocaleString()}  cost=${arb.bestCost.toFixed(4)}  W=$${sized.W}  P=$${sized.P}  net=${sized.netValue >= 0 ? '+' : ''}$${sized.netValue.toFixed(2)}${arb.hasArb ? '  *** ARB ***' : ''}`);

      const startDate = bfaEntry.startDate ? new Date(bfaEntry.startDate) : null;

      allResults.push({
        date: startDate ? startDate.toLocaleDateString() : '',
        time: startDate ? startDate.toLocaleTimeString() : '',
        sport: slug.toUpperCase(),
        marketType: bfaEntry.marketType,
        line: bfaEntry.line != null ? String(bfaEntry.line) : '',
        awayTeam: bfaEntry.marketType === 'total' ? (bfaEntry._realAway ?? 'Over') : bfaEntry.awayTeam,
        homeTeam: bfaEntry.marketType === 'total' ? (bfaEntry._realHome ?? 'Under') : bfaEntry.homeTeam,
        status: String(bfaEntry.status),
        hasArb: arb.hasArb,
        strategy: arb.strategy,
        bfaAwayOdds: bfaEntry.awayOdds,
        bfaAwayImplied: bfaEntry.awayImplied,
        bfaHomeOdds: bfaEntry.homeOdds,
        bfaHomeImplied: bfaEntry.homeImplied,
        polyAwayImplied: polyPrices.awayImplied,
        polyHomeImplied: polyPrices.homeImplied,
        profitPct: arb.profitPct,
        bestCost: arb.bestCost,
        bfaBet: sized.W,
        polyBet: sized.P,
        guaranteedPnl: sized.guaranteedPnl,
        netValue: sized.netValue,
      });
    }
  }

  // Sort: arbs first (by profit% desc), then by bestCost asc
  allResults.sort((a, b) => {
    if (a.hasArb && !b.hasArb) return -1;
    if (!a.hasArb && b.hasArb) return 1;
    if (a.hasArb) return b.profitPct - a.profitPct;
    return a.bestCost - b.bestCost;
  });

  return allResults;
}

module.exports = { runScan, ALL_BFA_SLUGS };
