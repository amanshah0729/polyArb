require('dotenv').config({ path: require('path').join(__dirname, '../..', '.env') });
const { placeBet, getBalance, getOpenBets } = require('./placeBet');
const { close } = require('../../services/bfaBrowser');

const BFA_BASE = 'https://api.bfagaming.com/oddsservice';
const SPORTS = ['nba', 'nhl', 'mlb', 'nfl', 'soccer', 'ufc', 'mma'];

// $7 bet near +100: on a moneyline between +90 and +120, risk $7 wins ~$6.30–$8.40 → both sides clear $5 rule
const MIN_PRICE = 90;
const MAX_PRICE = 120;
const AMOUNT = 7;

async function fetchSport(slug) {
  const url = `${BFA_BASE}/events/popular/${slug}?playerId=0&agentId=0&fixtureType=1&set=Auto`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
    },
  });
  if (!res.ok) return [];
  const j = await res.json().catch(() => ({}));
  return j.games || [];
}

const SKIP_EVENT_IDS = new Set([2848774]); // Magic vs 76ers — already have open bet on this fixture

function findPick(games, slug) {
  for (const game of games) {
    if (!game.fixtures || !game.markets) continue;
    if (SKIP_EVENT_IDS.has(game.id)) continue;
    const fixture = game.fixtures[0];
    if (!fixture) continue;
    if (game.status !== 0) continue; // not upcoming
    const mlMarket = game.markets.find((m) => m.type === 1 && Array.isArray(m.odds));
    if (!mlMarket) continue;
    for (const odd of mlMarket.odds) {
      if (odd.price >= MIN_PRICE && odd.price <= MAX_PRICE) {
        const contestant = fixture.contestants.find((c) => c.id === odd.contestantId);
        return {
          sport: slug,
          gameName: game.name,
          team: contestant ? contestant.name : `side ${odd.side}`,
          eventId: game.id,
          fixtureId: fixture.id,
          marketType: mlMarket.type, // 1
          idWagerType: mlMarket.id,
          side: odd.side,
          contestantId: odd.contestantId,
          line: odd.line ?? 0,
          price: odd.price,
          index: odd.index ?? 0,
          periodNumber: mlMarket.periodNumber ?? 0,
          startDate: fixture.date,
        };
      }
    }
  }
  return null;
}

(async () => {
  console.log(`Looking for a moneyline between +${MIN_PRICE} and +${MAX_PRICE}...\n`);
  let pick = null;
  for (const slug of SPORTS) {
    const games = await fetchSport(slug);
    console.log(`  ${slug.toUpperCase()}: ${Array.isArray(games) ? games.length : 0} games`);
    pick = findPick(Array.isArray(games) ? games : [], slug);
    if (pick) break;
  }
  if (!pick) { console.log('\nNo pick found in +90..+120 range.'); await close(); return; }

  console.log('\nPick found:');
  console.log(JSON.stringify(pick, null, 2));
  console.log(`\nBalance before:`);
  const balBefore = await getBalance();
  console.log(`  avail=$${balBefore.availableBalance}  atRisk=$${balBefore.amountAtRisk}`);

  // Sanity: any required ID missing → abort
  const missing = ['eventId', 'fixtureId', 'idWagerType', 'contestantId'].filter((k) => !pick[k]);
  if (missing.length) {
    console.log(`\nABORT — missing fields: ${missing.join(', ')}`);
    await close();
    return;
  }

  console.log(`\nPlacing bet: ${pick.team} ML +${pick.price}, risk $${AMOUNT} → win $${(AMOUNT * (pick.price / 100)).toFixed(2)}`);
  const result = await placeBet({
    eventId: pick.eventId,
    fixtureId: pick.fixtureId,
    marketType: pick.marketType,
    side: pick.side,
    contestantId: pick.contestantId,
    line: pick.line,
    price: pick.price,
    amount: AMOUNT,
    // Omit idWagerType → placeBet uses observed account-wide constant 80982
    periodNumber: pick.periodNumber,
    index: pick.index,
    isLive: false,
  });

  console.log('\n=== Wager result ===');
  console.log('HTTP status:', result.status);
  console.log('Response body:', JSON.stringify(result.body));
  console.log('IdTransaction:', result.idTransaction);
  console.log('Placed (verified via open bets):', result.placed);

  const balAfter = await getBalance();
  console.log(`\nBalance after: avail=$${balAfter.availableBalance}  atRisk=$${balAfter.amountAtRisk}`);
  const openBets = await getOpenBets();
  const list = Array.isArray(openBets) ? openBets : (openBets?.items || openBets?.data || []);
  console.log(`Open bets count: ${Array.isArray(list) ? list.length : '?'} (was ${balBefore.amountAtRisk > 0 ? '≥1' : '0'})`);

  await close();
})().catch(async (e) => { console.error('ERR:', e.message); await close(); process.exit(1); });
