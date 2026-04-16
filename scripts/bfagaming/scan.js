/**
 * BFAGaming ↔ Polymarket Arbitrage Scanner — Core Module
 *
 * Uses Predexon API exclusively for Polymarket market discovery + pricing.
 * Exports runScan() which returns an array of result objects.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const PREDEXON_API_KEY = process.env.PREDEXON_API_KEY;
const BFA_BASE         = 'https://api.bfagaming.com/oddsservice';
const PREDEXON_HOST    = 'api.predexon.com';
const PREDEXON_BASE    = '/v2';
// Broad set of slugs to probe — BFA has no listing endpoint, so we try all known slugs
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

/** Fetch the actual ask price (what you pay to buy) from Polymarket CLOB */
async function getPolyAskPrice(tokenId) {
  try {
    // side=SELL returns the best ask — the price you'd pay to acquire the token
    const data = await get(`https://clob.polymarket.com/price?token_id=${tokenId}&side=SELL`);
    return parseFloat(data.price) || null;
  } catch {
    return null;
  }
}

// ── American odds helpers ─────────────────────────────────────────────────────

function americanToImplied(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// ── BFAGaming ─────────────────────────────────────────────────────────────────

/**
 * Fetch BFA games for a sport slug. Returns one entry per game+market-type combo.
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

      const fixture = game.fixtures[0];
      const base = {
        name: game.name,
        startDate: game.startDate ?? fixture?.date ?? null,
        status: game.status ?? 'Upcoming',
        awayTeam: away.name,
        homeTeam: home.name,
        bfaEventId: game.id,
        bfaFixtureId: fixture?.id ?? null,
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
            bfaMarketTypeInt: mkt.type,
            bfaPeriodNumber: mkt.periodNumber ?? 0,
            bfaAwaySide: awayOddsObj.side, bfaHomeSide: homeOddsObj.side,
            bfaAwayContestantId: awayOddsObj.contestantId ?? away.id,
            bfaHomeContestantId: homeOddsObj.contestantId ?? home.id,
            bfaAwayIndex: awayOddsObj.index ?? 0,
            bfaHomeIndex: homeOddsObj.index ?? 0,
            bfaAwayLine: awayOddsObj.line ?? 0,
            bfaHomeLine: homeOddsObj.line ?? 0,
          });
        } else if (marketType === 'spread') {
          const awayOddsObj = mkt.odds.find((o) => o.side === 2);
          const homeOddsObj = mkt.odds.find((o) => o.side === 1);
          if (!awayOddsObj || !homeOddsObj) continue;
          entries.push({
            ...base, marketType, line: homeOddsObj.line,
            awayOdds: awayOddsObj.price, homeOdds: homeOddsObj.price,
            awayImplied: americanToImplied(awayOddsObj.price),
            homeImplied: americanToImplied(homeOddsObj.price),
            bfaMarketTypeInt: mkt.type,
            bfaPeriodNumber: mkt.periodNumber ?? 0,
            bfaAwaySide: awayOddsObj.side, bfaHomeSide: homeOddsObj.side,
            bfaAwayContestantId: awayOddsObj.contestantId ?? away.id,
            bfaHomeContestantId: homeOddsObj.contestantId ?? home.id,
            bfaAwayIndex: awayOddsObj.index ?? 0,
            bfaHomeIndex: homeOddsObj.index ?? 0,
            bfaAwayLine: awayOddsObj.line ?? 0,
            bfaHomeLine: homeOddsObj.line ?? 0,
          });
        } else if (marketType === 'total') {
          const overObj = mkt.odds.find((o) => o.side === 4);
          const underObj = mkt.odds.find((o) => o.side === 5);
          if (!overObj || !underObj) continue;
          entries.push({
            ...base, marketType, line: overObj.line,
            awayOdds: overObj.price, homeOdds: underObj.price,
            awayImplied: americanToImplied(overObj.price),
            homeImplied: americanToImplied(underObj.price),
            awayTeam: 'Over', homeTeam: 'Under',
            _realAway: away.name, _realHome: home.name,
            bfaMarketTypeInt: mkt.type,
            bfaPeriodNumber: mkt.periodNumber ?? 0,
            bfaAwaySide: overObj.side, bfaHomeSide: underObj.side,
            bfaAwayContestantId: overObj.contestantId ?? 0,
            bfaHomeContestantId: underObj.contestantId ?? 0,
            bfaAwayIndex: overObj.index ?? 0,
            bfaHomeIndex: underObj.index ?? 0,
            bfaAwayLine: overObj.line ?? 0,
            bfaHomeLine: underObj.line ?? 0,
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

// ── Predexon — search + prices ───────────────────────────────────────────────

/**
 * Search Predexon for Polymarket markets matching a query.
 * Returns raw market objects with condition_id, title, slug, outcomes, volume.
 */
async function searchPredexon(query) {
  const url = `https://${PREDEXON_HOST}${PREDEXON_BASE}/polymarket/markets?search=${encodeURIComponent(query)}&status=open`;
  try {
    const data = await get(url, { 'x-api-key': PREDEXON_API_KEY });
    return data.markets ?? [];
  } catch (err) {
    console.warn(`    Predexon search error for "${query}": ${err.message}`);
    return [];
  }
}

/**
 * From a Predexon search result set, find the best matching live market for a BFA entry.
 * Returns { market, swapped } or null.
 *
 * "swapped" means BFA-away corresponds to Predexon outcome[1] instead of outcome[0].
 */
// Map BFA sport slugs to Predexon slug prefixes for cross-sport filtering
const SPORT_SLUG_PREFIXES = {
  nba: ['nba-'],
  nhl: ['nhl-'],
  nfl: ['nfl-'],
  mlb: ['mlb-'],
  ufc: [], // UFC slugs don't have a consistent prefix, skip filtering
  mma: [],
};

const MAX_DATE_DRIFT_DAYS = 2; // max days apart before we consider a market stale/rescheduled

function extractSlugDate(slug) {
  const m = slug.match(/(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

function datesWithinRange(bfaStartDate, slugDateStr) {
  if (!bfaStartDate || !slugDateStr) return true; // can't verify, allow through
  const bfaDate = new Date(bfaStartDate);
  const polyDate = new Date(slugDateStr + 'T00:00:00Z');
  if (isNaN(bfaDate) || isNaN(polyDate)) return true;
  const diffMs = Math.abs(bfaDate - polyDate);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= MAX_DATE_DRIFT_DAYS;
}

function matchPredexonMarket(bfaEntry, predexonMarkets, sportSlug) {
  const mt = bfaEntry.marketType;
  const awayName = bfaEntry.marketType === 'total' ? (bfaEntry._realAway ?? '') : bfaEntry.awayTeam;
  const homeName = bfaEntry.marketType === 'total' ? (bfaEntry._realHome ?? '') : bfaEntry.homeTeam;

  const allowedPrefixes = SPORT_SLUG_PREFIXES[sportSlug] ?? [];

  for (const mkt of predexonMarkets) {
    const outcomes = mkt.outcomes ?? [];
    if (outcomes.length !== 2) continue;

    const [o0, o1] = outcomes;
    const p0 = o0.price ?? 0;
    const p1 = o1.price ?? 0;
    const t0 = o0.token_id ?? '';
    const t1 = o1.token_id ?? '';

    // Skip resolved markets (0/1 prices)
    if (p0 < 0.01 || p0 > 0.99 || p1 < 0.01 || p1 > 0.99) continue;
    // Skip 0-volume
    if ((mkt.total_volume_usd ?? 0) === 0) continue;

    const slug = (mkt.market_slug ?? '').toLowerCase();

    // Date cross-check: skip markets where the Polymarket event date doesn't match BFA's date.
    // Catches cancelled/rescheduled events where Poly still has the old stale market.
    const slugDate = extractSlugDate(slug);
    if (!datesWithinRange(bfaEntry.startDate, slugDate)) {
      const bfaDateStr = bfaEntry.startDate ? new Date(bfaEntry.startDate).toISOString().split('T')[0] : '?';
      console.log(`    ⚠ Date mismatch: BFA=${bfaDateStr} vs Poly=${slugDate} — skipping ${slug}`);
      continue;
    }

    // Cross-sport filter: if we know the sport prefix, reject mismatches
    if (allowedPrefixes.length > 0 && !allowedPrefixes.some(p => slug.startsWith(p))) continue;
    const title = (mkt.title ?? '').toLowerCase();
    const l0 = (o0.label ?? '').toLowerCase();
    const l1 = (o1.label ?? '').toLowerCase();

    if (mt === 'moneyline') {
      // Slug should NOT contain 'total' or 'spread'
      if (slug.includes('total') || slug.includes('spread') || slug.includes('o-u') || slug.includes('pt')) continue;
      // Labels should be team/fighter names, not Over/Under
      if (l0 === 'over' || l0 === 'under' || l1 === 'over' || l1 === 'under') continue;

      // BOTH teams must appear in the market labels to prevent cross-sport false matches
      // Use strict matching: label must equal normalized name, or one must fully contain the other
      const awayNorm = normalizeTeam(awayName);
      const homeNorm = normalizeTeam(homeName);

      function labelMatches(label, norm) {
        if (!label || !norm) return false;
        // Exact match or label equals the norm
        if (label === norm) return true;
        // The label is a full team name containing the normalized nickname
        // but the normalized name must be at least 4 chars to avoid short false matches
        if (norm.length >= 4 && label.includes(norm) && label.split(/\s+/).some(w => norm.includes(w))) return true;
        if (norm.includes(label) && label.length >= 4) return true;
        return false;
      }

      const awayInL0 = labelMatches(l0, awayNorm);
      const awayInL1 = labelMatches(l1, awayNorm);
      const homeInL0 = labelMatches(l0, homeNorm);
      const homeInL1 = labelMatches(l1, homeNorm);

      // Both teams must be present across the two labels
      if (!((awayInL0 || awayInL1) && (homeInL0 || homeInL1))) continue;

      // Determine which outcome is away vs home
      if (awayInL0) {
        return { market: mkt, marketSlug: mkt.market_slug, awayPrice: p0, homePrice: p1, awayToken: t0, homeToken: t1, swapped: false };
      }
      if (homeInL0) {
        return { market: mkt, marketSlug: mkt.market_slug, awayPrice: p1, homePrice: p0, awayToken: t1, homeToken: t0, swapped: true };
      }

    } else if (mt === 'total') {
      // Match by total line in slug or title: "total-6pt5" or "O/U 6.5"
      const bfaLine = bfaEntry.line;
      if (!slug.includes('total') && !title.includes('o/u')) continue;
      // Strict line matching — lines must match exactly (6 !== 6.5, 7 !== 7.5)
      const lineStr = String(bfaLine).replace('.', 'pt');
      const lineRe = new RegExp(`(^|[^0-9])${lineStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^0-9pt])`);
      const titleRe = new RegExp(`(^|[^0-9.])${String(bfaLine).replace('.', '\\.')}($|[^0-9.])`);
      if (!lineRe.test(slug) && !titleRe.test(title)) continue;
      // Verify teams appear in the title to prevent cross-sport matches
      const awayNorm = normalizeTeam(awayName);
      const homeNorm = normalizeTeam(homeName);
      if (!title.includes(awayNorm) && !title.includes(homeNorm)) continue;

      // Outcomes should be Over/Under
      if (l0 === 'over') {
        return { market: mkt, marketSlug: mkt.market_slug, awayPrice: p0, homePrice: p1, awayToken: t0, homeToken: t1, swapped: false };
      }
      if (l0 === 'under') {
        return { market: mkt, marketSlug: mkt.market_slug, awayPrice: p1, homePrice: p0, awayToken: t1, homeToken: t0, swapped: true };
      }

    } else if (mt === 'spread') {
      // Match by spread in slug or title
      if (!slug.includes('spread') && !title.includes('spread')) continue;

      const bfaLine = bfaEntry.line;
      // Strict line matching — lines must match exactly (3 !== 3.5)
      const lineStr = String(Math.abs(bfaLine)).replace('.', 'pt');
      const lineRe = new RegExp(`(^|[^0-9])${lineStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^0-9pt])`);
      const titleRe = new RegExp(`(^|[^0-9.])${String(Math.abs(bfaLine)).replace('.', '\\.')}($|[^0-9.])`);
      if (!lineRe.test(slug) && !titleRe.test(title)) continue;

      // Verify teams appear
      const awayNorm = normalizeTeam(awayName);
      const homeNorm = normalizeTeam(homeName);
      const allText = `${l0} ${l1} ${title}`;
      if (!(allText.includes(awayNorm) || awayNorm.includes(l0) || awayNorm.includes(l1))) continue;
      if (!(allText.includes(homeNorm) || homeNorm.includes(l0) || homeNorm.includes(l1))) continue;
      if (l0.includes(awayNorm) || awayNorm.includes(l0)) {
        return { market: mkt, marketSlug: mkt.market_slug, awayPrice: p0, homePrice: p1, awayToken: t0, homeToken: t1, swapped: false };
      }
      if (l0.includes(homeNorm) || homeNorm.includes(l0)) {
        return { market: mkt, marketSlug: mkt.market_slug, awayPrice: p1, homePrice: p0, awayToken: t1, homeToken: t0, swapped: true };
      }
    }
  }

  return null;
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

  // option1: bet BFA-away + Poly-home  (hedging opposite sides)
  const option1 = bfaAway + polyHome;
  // option2: bet Poly-away + BFA-home
  const option2 = polyAway + bfaHome;

  const bestCost = Math.min(option1, option2);
  const hasArb = bestCost < 1.0;
  const profitPct = hasArb ? ((1 - bestCost) / bestCost) * 100 : 0;

  const mt = bfaEntry.marketType;
  const lineTag = bfaEntry.line != null ? ` (${bfaEntry.line})` : '';
  const mtLabel = mt !== 'moneyline' ? ` [${mt}${lineTag}]` : '';

  let strategy, bfaImplied, polyImplied, bfaSide, polySide;
  if (option1 <= option2) {
    strategy = `${bfaEntry.awayTeam}@BFA + ${bfaEntry.homeTeam}@Poly${mtLabel}`;
    bfaImplied = bfaAway;
    polyImplied = polyHome;
    bfaSide = 'away';
    polySide = 'home';
  } else {
    strategy = `${bfaEntry.awayTeam}@Poly + ${bfaEntry.homeTeam}@BFA${mtLabel}`;
    bfaImplied = bfaHome;
    polyImplied = polyAway;
    bfaSide = 'home';
    polySide = 'away';
  }

  return { hasArb, bestCost, profitPct, strategy, bfaImplied, polyImplied, bfaSide, polySide };
}

// ── Main scan function ────────────────────────────────────────────────────────

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

  // Deduplicate Predexon searches: group BFA entries by game (same away+home teams)
  for (const { slug, entries: bfaEntries } of activeSports) {
    console.log(`[${slug.toUpperCase()}]`);

    // Group entries by game to share one Predexon search per matchup
    const gameGroups = new Map();
    for (const entry of bfaEntries) {
      const realAway = entry._realAway ?? entry.awayTeam;
      const realHome = entry._realHome ?? entry.homeTeam;
      const key = `${realAway}|||${realHome}`;
      if (!gameGroups.has(key)) gameGroups.set(key, { realAway, realHome, entries: [] });
      gameGroups.get(key).entries.push(entry);
    }

    for (const [, { realAway, realHome, entries }] of gameGroups) {
      // Build search query — use normalized (city-stripped) names for better search results
      // Full names like "Boston Bruins" return too many futures; "Bruins" finds the game
      const normAway = normalizeTeam(realAway);
      const normHome = normalizeTeam(realHome);
      const query = `${normAway} ${normHome}`;

      const predexonMarkets = await searchPredexon(query);
      await sleep(RATE_LIMIT_MS);

      const liveCount = predexonMarkets.filter(m => {
        const outcomes = m.outcomes ?? [];
        if (outcomes.length !== 2) return false;
        return outcomes.every(o => o.price > 0.01 && o.price < 0.99) && (m.total_volume_usd ?? 0) > 0;
      }).length;

      if (liveCount > 0) {
        console.log(`  Predexon "${query}": ${predexonMarkets.length} results, ${liveCount} live`);
      }

      for (const bfaEntry of entries) {
        const displayName = bfaEntry.marketType === 'total'
          ? `${realAway} @ ${realHome} O/U ${bfaEntry.line}`
          : `${bfaEntry.awayTeam} @ ${bfaEntry.homeTeam}${bfaEntry.line != null ? ` (${bfaEntry.line})` : ''}`;
        const mtTag = bfaEntry.marketType !== 'moneyline' ? ` [${bfaEntry.marketType}]` : '';

        const match = matchPredexonMarket(bfaEntry, predexonMarkets, slug);

        if (!match) {
          console.log(`    No match: ${displayName}${mtTag}`);
          continue;
        }

        const { market: mkt, marketSlug: polyMarketSlug, awayPrice: midAway, homePrice: midHome, awayToken, homeToken, swapped: polySwapped } = match;
        const volumeUsd = mkt.total_volume_usd ?? 0;

        // Skip low-volume markets — unwind ladder needs liquidity to exit cleanly if a leg fails.
        if (volumeUsd < 1000) {
          console.log(`    ${displayName}${mtTag} → skipped (vol=$${Math.round(volumeUsd)})`);
          continue;
        }

        // Fetch actual ask prices from Polymarket CLOB (what you'd really pay to buy)
        const [awayAsk, homeAsk] = await Promise.all([
          getPolyAskPrice(awayToken),
          getPolyAskPrice(homeToken),
        ]);
        const awayPrice = awayAsk ?? midAway;
        const homePrice = homeAsk ?? midHome;

        const polyPrices = { awayImplied: awayPrice, homeImplied: homePrice, volumeUsd };

        const arb = checkArb(bfaEntry, polyPrices);
        const sized = sizeBet(arb.bfaImplied, arb.polyImplied, arb.bestCost, rolloverRemaining, bankroll);

        process.stdout.write(`    ${displayName}${mtTag} → `);
        console.log(`vol=$${Math.round(volumeUsd).toLocaleString()}  cost=${arb.bestCost.toFixed(4)}  W=$${sized.W}  P=$${sized.P}  net=${sized.netValue >= 0 ? '+' : ''}$${sized.netValue.toFixed(2)}${arb.hasArb ? '  *** ARB ***' : ''}`);

        const startDate = bfaEntry.startDate ? new Date(bfaEntry.startDate) : null;

        allResults.push({
          date: startDate ? startDate.toLocaleDateString() : '',
          time: startDate ? startDate.toLocaleTimeString() : '',
          sport: slug.toUpperCase(),
          marketType: bfaEntry.marketType,
          line: bfaEntry.line != null ? String(bfaEntry.line) : '',
          awayTeam: bfaEntry.marketType === 'total' ? realAway : bfaEntry.awayTeam,
          homeTeam: bfaEntry.marketType === 'total' ? realHome : bfaEntry.homeTeam,
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
          volumeUsd,

          // Structured identifiers for one-click Place Bet via executeArb()
          bfaSide: arb.bfaSide,    // 'away' | 'home'
          polySide: arb.polySide,  // 'away' | 'home'
          bfaEventId: bfaEntry.bfaEventId,
          bfaFixtureId: bfaEntry.bfaFixtureId,
          bfaMarketTypeInt: bfaEntry.bfaMarketTypeInt,
          bfaPeriodNumber: bfaEntry.bfaPeriodNumber,
          bfaAwaySide: bfaEntry.bfaAwaySide,
          bfaHomeSide: bfaEntry.bfaHomeSide,
          bfaAwayContestantId: bfaEntry.bfaAwayContestantId,
          bfaHomeContestantId: bfaEntry.bfaHomeContestantId,
          bfaAwayIndex: bfaEntry.bfaAwayIndex,
          bfaHomeIndex: bfaEntry.bfaHomeIndex,
          bfaAwayLine: bfaEntry.bfaAwayLine,
          bfaHomeLine: bfaEntry.bfaHomeLine,
          bfaAwayPrice: bfaEntry.awayOdds,
          bfaHomePrice: bfaEntry.homeOdds,
          polyMarketSlug,
          polyAwayToken: awayToken,
          polyHomeToken: homeToken,
          polyAwayPrice: polyPrices.awayImplied,
          polyHomePrice: polyPrices.homeImplied,
          // polymarket-us uses LONG (YES = outcome[0]) / SHORT (NO = outcome[1]) intents.
          // swapped=false → away is outcome[0] (LONG); swapped=true → away is outcome[1] (SHORT).
          polyAwayIntent: polySwapped ? 'ORDER_INTENT_BUY_SHORT' : 'ORDER_INTENT_BUY_LONG',
          polyHomeIntent: polySwapped ? 'ORDER_INTENT_BUY_LONG'  : 'ORDER_INTENT_BUY_SHORT',
        });
      }
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

module.exports = {
  runScan, ALL_BFA_SLUGS,
  // Shared utilities for other scanners
  get, sleep, americanToImplied, normalizeTeam, CITY_MAP,
  SPORT_SLUG_PREFIXES, matchPredexonMarket, searchPredexon,
  getPolyAskPrice, PREDEXON_API_KEY, RATE_LIMIT_MS,
};
