// Name-based Polymarket.US market resolver. Inputs the rich scan-row context
// (sport, date, team/fighter names, isSeries, marketType, line) and finds the
// matching PM.US market via tiered lookup, scored against `market.question`
// and `market.slug` rather than playing slug-encoding telephone with Predexon.

const { normalizeTeam } = require('../scripts/bfagaming/scan');

// Predexon league prefix → PM.US sport tagId. From `sports.list()`. Series-
// winner futures (tec- prefix) live under the **regular** sport tag, not a
// separate series tag, so we always search the regular tag.
const TAG_BY_PREFIX = { ufc: 9, mma: 9, nba: 5, nhl: 7, nfl: 1, mlb: 4, epl: 17, ucl: 18, mls: 10 };
const TAG_BY_SPORT  = { UFC: 9, MMA: 9, NBA: 5, NHL: 7, NFL: 1, MLB: 4, EPL: 17, UCL: 18, MLS: 10 };

// PM.US slug prefixes per market type:
//   aec- = moneyline (binary, two-outcome)
//   asc- = spread
//   tsc- = total (over/under)
//   tec- = futures / series-winner (one slug per outcome side)
const PREFIX_BY_MARKET_TYPE = { moneyline: 'aec-', spread: 'asc-', total: 'tsc-' };
const SERIES_PREFIX = 'tec-';

const SERIES_RE = /\b(series|advance|win.the|playoff.winner|round.\d|to-win|championship|finals)\b/i;

const NEG_TTL_MS = 60 * 60 * 1000; // 1 hour
const _posCache = new Map();   // input slug → resolved slug
const _negCache = new Map();   // input slug → expiresAt ms

function _normName(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

// Tokens we'll search for inside `market.question` and `market.slug` to confirm
// a candidate is the right team. Includes BOTH city ("orlando") and mascot
// ("magic") because PM.US is inconsistent across market types: aec- slugs use
// city codes ("orl"), aec- questions use city names ("Orlando vs. Detroit"),
// while broader markets sometimes use the full team name. Returning multiple
// tokens means we accept any of them as proof of identity.
function _teamMatchTokens(name) {
  if (!name) return [];
  const out = new Set();
  const fullNorm = _normName(name);
  const fullParts = fullNorm.split(/\s+/).filter(Boolean);
  for (const w of fullParts) {
    if (w.length >= 3) out.add(w);          // "orlando", "magic"
  }
  // mascot-only (post city-strip) — covers cases where slug uses just mascot
  const mascotNorm = _normName(normalizeTeam(name));
  const mascotParts = mascotNorm.split(/\s+/).filter(Boolean);
  if (mascotParts.length) out.add(mascotParts[mascotParts.length - 1]);
  return [...out];
}

// Does the candidate's slug+question contain ANY of the team's match tokens?
function _hayContainsAnyToken(hay, tokens) {
  if (!tokens?.length) return false;
  return tokens.some(t => t.length >= 3 && hay.includes(t));
}

function _isSeriesMarket(m) {
  const slug = m?.slug || '';
  if (slug.startsWith(SERIES_PREFIX)) return true;
  return SERIES_RE.test(slug) || SERIES_RE.test(m?.question || '');
}

// Tokens for matching team identity against PM.US slug abbreviations.
// "Detroit Pistons" → ['detroit','pistons','det','pis'] so we can match
// against PM.US slugs like `tec-...-det` or `aec-nba-orl-det-...`. We
// deliberately keep the city tokens — PM.US series slugs use city codes
// (det, orl) not mascot codes — so do NOT call normalizeTeam here.
function _teamSlugTokens(name) {
  if (!name) return [];
  const norm = _normName(name);
  const words = norm.split(/\s+/).filter(Boolean);
  const out = new Set();
  for (const w of words) {
    if (w.length >= 2) out.add(w);
    if (w.length >= 3) out.add(w.slice(0, 3));
  }
  return [...out];
}

function _seriesSideTeamMatches(slug, polyTeamTokens) {
  if (!polyTeamTokens?.length) return false;
  // For tec- series slugs, the suffix after the date is the outcome side, e.g.
  // `tec-nba-round1-det-orl-2026-04-27-det` → suffix "det". Match if any
  // of polyTeam's slug tokens equals (or starts with) that suffix.
  const m = String(slug || '').match(/-(\d{4}-\d{2}-\d{2})-([a-z]+)$/i);
  if (!m) return false;
  const suffix = m[2].toLowerCase();
  return polyTeamTokens.some(t => t === suffix || t.startsWith(suffix) || suffix.startsWith(t));
}

function _slugDate(slug) {
  const m = String(slug || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function _normalizeDate(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  // e.g. "5/2/2026"
  const m = String(d).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  return null;
}

function _tagFor({ sport, slug }) {
  const upper = sport ? String(sport).toUpperCase() : null;
  if (upper && TAG_BY_SPORT[upper]) return TAG_BY_SPORT[upper];
  const m = String(slug || '').match(/^([a-z]+)-/i);
  return m ? TAG_BY_PREFIX[m[1].toLowerCase()] : null;
}

function _isNegCached(slug) {
  if (!slug) return false;
  const exp = _negCache.get(slug);
  if (!exp) return false;
  if (Date.now() > exp) { _negCache.delete(slug); return false; }
  return true;
}

function _setNeg(slug) {
  if (slug) _negCache.set(slug, Date.now() + NEG_TTL_MS);
}

function _setPos(cacheKey, resolved) {
  if (cacheKey && resolved) {
    _posCache.set(cacheKey, resolved);
    _negCache.delete(cacheKey);
  }
}

// Score a candidate market against the inputs. Returns null if it fails any
// hard requirement; otherwise a numeric score (higher = better).
function _scoreCandidate(market, ctx) {
  const slug = (market?.slug || '').toLowerCase();
  const question = (market?.question || '').toLowerCase();
  if (!slug) return null;

  const candIsSeries = _isSeriesMarket(market);

  // Cross-type guard (series ↔ single-game)
  if (typeof ctx.isSeries === 'boolean' && candIsSeries !== !!ctx.isSeries) return null;

  // Market-type prefix guard. Single-game markets must match the per-type
  // prefix (aec-/asc-/tsc-). Series markets use a different shape: PM.US
  // emits per-outcome `tec-…-{teamAbbr}` slugs, so we require `tec-` rather
  // than the moneyline prefix.
  if (ctx.isSeries === true) {
    if (!slug.startsWith(SERIES_PREFIX)) return null;
  } else {
    const wantPrefix = PREFIX_BY_MARKET_TYPE[ctx.marketType];
    if (wantPrefix && !slug.startsWith(wantPrefix)) return null;
  }

  // Single-game requires the date in the slug
  const wantDate = ctx.dateIso;
  if (ctx.isSeries === false && wantDate && !slug.includes(wantDate)) return null;

  // Total markets must include the line
  if (ctx.marketType === 'total' && ctx.line != null) {
    const lineStr = String(ctx.line).replace('.', 'pt');   // 6.5 → 6pt5
    const dotStr  = String(ctx.line);
    if (!slug.includes(lineStr) && !question.includes(dotStr)) return null;
  }

  // Name presence — require BOTH teams' identities to appear in question or
  // slug. Each team contributes multiple tokens (city + mascot) to handle
  // PM.US's inconsistent encoding across market types.
  const hay = `${question} ${slug}`;
  if (!ctx.awayTokens?.length || !ctx.homeTokens?.length) return null;
  if (!_hayContainsAnyToken(hay, ctx.awayTokens)) return null;
  if (!_hayContainsAnyToken(hay, ctx.homeTokens)) return null;

  // Series-specific: pick the right outcome side. PM.US emits per-side slugs
  // (`-det` for Detroit, `-orl` for Orlando) — we need the one matching the
  // team the user is buying on Polymarket. polyTeamTokens carries that.
  let seriesSideMatch = false;
  if (ctx.isSeries === true && ctx.polyTeamTokens?.length) {
    seriesSideMatch = _seriesSideTeamMatches(slug, ctx.polyTeamTokens);
    if (!seriesSideMatch) return null;
  }

  // Score
  let score = 100;
  if (wantDate && slug.includes(wantDate)) score += 50;
  if (ctx.isSeries === true) {
    if (slug.startsWith(SERIES_PREFIX)) score += 30;
    if (seriesSideMatch) score += 40;
  } else {
    const wantPrefix = PREFIX_BY_MARKET_TYPE[ctx.marketType];
    if (wantPrefix && slug.startsWith(wantPrefix)) score += 20;
  }
  score += Math.max(0, 80 - slug.length);
  return score;
}

async function _tier0_direct(client, slug) {
  try { await client.markets.retrieveBySlug(slug); return slug; }
  catch { return null; }
}

async function _tier1_event(client, slug, ctx) {
  try {
    const resp = await client.events.retrieveBySlug(slug);
    const markets = resp?.event?.markets || [];
    const candidates = markets
      .map(m => ({ m, score: _scoreCandidate(m, ctx) }))
      .filter(x => x.score != null)
      .sort((a, b) => b.score - a.score);
    if (candidates.length) return candidates[0].m.slug;

    // No name context → fall back to old aec-preferred pick (preserves slug-only behavior)
    if (!ctx.awayTokens?.length && !ctx.homeTokens?.length) {
      const aec = markets.find(m => (m.slug || '').startsWith('aec-'));
      return aec?.slug || markets[0]?.slug || null;
    }
    return null;
  } catch { return null; }
}

async function _tier2_listByTag(client, ctx) {
  if (!ctx.tagId || !ctx.awayTokens?.length || !ctx.homeTokens?.length) return null;
  let best = null;
  // Paginate — PM.US returns up to 500 per page; sport tags can have more.
  for (let offset = 0; offset < 5000; offset += 500) {
    const r = await client.markets.list({
      limit: 500, tagIds: [ctx.tagId], offset, active: true, closed: false,
    });
    const ms = r?.markets || [];
    if (!ms.length) break;
    for (const m of ms) {
      const s = _scoreCandidate(m, ctx);
      if (s != null && (!best || s > best.score)) best = { score: s, slug: m.slug };
    }
    if (ms.length < 500) break;
  }
  return best?.slug || null;
}

async function _tier3_alphaTokens(client, slug) {
  // Last-resort slug-substring match (with alpha-strip). For non-team markets
  // (politics, weather) where we have no names. Mirrors the legacy resolver.
  const m = String(slug || '').match(/^([a-z]+)-(.+)-(\d{4}-\d{2}-\d{2})$/i);
  if (!m) return null;
  const tagId = TAG_BY_PREFIX[m[1].toLowerCase()];
  if (!tagId) return null;
  const dateStr = m[3];
  const tokens = m[2].split('-')
    .map(t => (t || '').toLowerCase().replace(/[^a-z]/g, ''))
    .filter(t => t.length >= 2);
  if (!tokens.length) return null;
  try {
    const r = await client.markets.list({ limit: 500, tagIds: [tagId], active: true, closed: false });
    for (const mk of (r?.markets || [])) {
      const s = (mk.slug || '').toLowerCase();
      if (!s.includes(dateStr)) continue;
      if (!tokens.every(tok => s.includes(tok))) continue;
      return mk.slug;
    }
  } catch { /* swallow */ }
  return null;
}

/**
 * Resolve a Predexon-style slug to a Polymarket.US market slug using rich
 * scan-row context. Returns { resolvedSlug, source } or null on no match.
 *
 * @param {object} client  PolymarketUS SDK client (from polyTrader.client())
 * @param {object} opts
 *   slug, sport, date, awayTeam, homeTeam, isSeries, marketType, line
 */
async function resolveMarket(client, opts = {}) {
  const slug = opts.slug;
  if (!slug) return null;

  // Series markets resolve to per-side slugs (`-det` vs `-orl`), so the same
  // input slug + different polyTeam must NOT collapse to the same cache entry.
  const cacheKey = opts.isSeries === true && opts.polyTeam
    ? `${slug}|${_normName(opts.polyTeam)}`
    : slug;

  if (_posCache.has(cacheKey)) return { resolvedSlug: _posCache.get(cacheKey), source: 'cache' };
  if (_isNegCached(cacheKey)) return null;

  const ctx = {
    slug,
    sport: opts.sport,
    dateIso: _normalizeDate(opts.date) || _slugDate(slug),
    awayTokens: _teamMatchTokens(opts.awayTeam),
    homeTokens: _teamMatchTokens(opts.homeTeam),
    isSeries: typeof opts.isSeries === 'boolean' ? opts.isSeries : undefined,
    marketType: opts.marketType,
    line: opts.line,
    polyTeamTokens: _teamSlugTokens(opts.polyTeam),  // for series side-picking
    tagId: _tagFor({ sport: opts.sport, slug }),
  };

  // Tier 0 — slug as-is
  const t0 = await _tier0_direct(client, slug);
  if (t0) {
    // Even if direct hit succeeds, verify it doesn't violate the cross-type
    // guard (e.g. Predexon slug accidentally points to a series market when
    // we expected single-game). Cheap insurance.
    if (typeof ctx.isSeries === 'boolean') {
      try {
        const m = await client.markets.retrieveBySlug(t0);
        const mkt = m?.market || m;
        if (_isSeriesMarket(mkt) === ctx.isSeries) { _setPos(cacheKey, t0); return { resolvedSlug: t0, source: 'direct' }; }
        // mismatch → fall through to other tiers
      } catch { _setPos(cacheKey, t0); return { resolvedSlug: t0, source: 'direct' }; }
    } else {
      _setPos(cacheKey, t0); return { resolvedSlug: t0, source: 'direct' };
    }
  }

  // Tier 1 — event lookup
  const t1 = await _tier1_event(client, slug, ctx);
  if (t1) { _setPos(cacheKey, t1); return { resolvedSlug: t1, source: 'event' }; }

  // Tier 2 — name-based listing
  const t2 = await _tier2_listByTag(client, ctx);
  if (t2) { _setPos(cacheKey, t2); return { resolvedSlug: t2, source: 'name' }; }

  // Tier 3 — alpha-stripped token fallback (slug-only callers)
  const t3 = await _tier3_alphaTokens(client, slug);
  if (t3) { _setPos(cacheKey, t3); return { resolvedSlug: t3, source: 'tokens' }; }

  _setNeg(cacheKey);
  return null;
}

module.exports = {
  resolveMarket,
  // exposed for tests
  _internal: { _normName, _teamMatchTokens, _isSeriesMarket, _scoreCandidate, _posCache, _negCache },
};
