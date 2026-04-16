require('dotenv').config({ path: require('path').join(__dirname, '../..', '.env') });
const crypto = require('crypto');
const { getContext, getAccessToken, close } = require('../../services/bfaBrowser');
const cooldown = require('../../services/bfaCooldown');
const firedLog = require('../../services/firedLog');

const API = 'https://api.bfagaming.com';
const BALANCE_BUFFER = 0.01;

function maybeTriggerCooldown(status, endpoint) {
  if (status === 403 || status === 429) {
    cooldown.trigger(`${endpoint} HTTP ${status}`);
    console.warn(`[cooldown] Triggered by ${endpoint} HTTP ${status} — pausing BFA for ${Math.round(cooldown.DEFAULT_COOLDOWN_MS / 60000)}min`);
  }
}

function assertNotInCooldown() {
  if (cooldown.isInCooldown()) {
    const mins = (cooldown.remainingMs() / 60000).toFixed(1);
    throw new Error(`BFA cooldown active (${mins} min remaining) — skipping`);
  }
}

async function getBalance() {
  assertNotInCooldown();
  const ctx = await getContext();
  const token = await getAccessToken();
  const playerId = parseInt(process.env.BFA_PLAYER_ID, 10);
  const res = await ctx.request.get(`${API}/balance/api/GetPlayerBalanceByPlayerId?playerId=${playerId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    maybeTriggerCooldown(res.status(), 'balance');
    throw new Error(`balance ${res.status()}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function getOpenBets() {
  assertNotInCooldown();
  const ctx = await getContext();
  const token = await getAccessToken();
  const playerId = parseInt(process.env.BFA_PLAYER_ID, 10);
  const res = await ctx.request.get(`${API}/history/api/GetPlayerOpenBets?playerId=${playerId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    maybeTriggerCooldown(res.status(), 'openBets');
    throw new Error(`openBets ${res.status()}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// Observed constant for player 412469 across multiple captures (Magic spread + Nationals ML).
// Likely the player's agent/shop group ID. If a future capture shows this varying, make it dynamic.
const DEFAULT_ID_WAGER_TYPE = 80982;

async function placeBet({
  eventId, fixtureId, marketType, side, contestantId, line, price, amount,
  idWagerType = DEFAULT_ID_WAGER_TYPE, periodNumber = 0, index = 0, isLive = false,
  allowDuplicate = false, meta = {},
}) {
  const playerId = parseInt(process.env.BFA_PLAYER_ID, 10);
  if (!playerId) throw new Error('BFA_PLAYER_ID not set');

  if (cooldown.isInCooldown()) {
    const mins = (cooldown.remainingMs() / 60000).toFixed(1);
    return { skipped: true, reason: 'cooldown', cooldownRemainingMinutes: mins };
  }

  const firedKey = firedLog.makeKey({ eventId, marketType, contestantId, line: line ?? 0, side });
  if (!allowDuplicate && firedLog.hasFired(firedKey)) {
    return { skipped: true, reason: 'duplicate', firedKey };
  }

  const ctx = await getContext();
  const token = await getAccessToken();

  let bal;
  try { bal = await getBalance(); }
  catch (e) { return { skipped: true, reason: 'balance-fetch-failed', error: e.message }; }
  const available = Number(bal?.availableBalance ?? 0);
  if (available + BALANCE_BUFFER < amount) {
    return { skipped: true, reason: 'insufficient-balance', availableBalance: available, required: amount };
  }

  const pick = {
    EventId: eventId, FixtureId: fixtureId, MarketType: marketType, PeriodNumber: periodNumber,
    Side: side, Index: index, ContestantId: contestantId, Line: line, TeaserPoints: 0.0,
    Price: price, Amount: amount, PointsPurchased: 0.0, PitcherAction: 0,
    RoundRobinCombinations: 0, UseFreePlay: false, RiskOrWinType: 1,
  };
  const idTx = crypto.randomUUID();
  const wager = [{
    IdTransaction: idTx, IdPlayer: playerId, FillIdWager: -1, WagerType: 0, OpenSpots: 0,
    Picks: [pick], RiskWin: 1, AcceptChanges: 0, IdWagerType: idWagerType, IsLive: isLive,
  }];

  const res = await ctx.request.post(`${API}/wagering/api/v1/wager?playerId=${playerId}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
      accept: '*/*',
      origin: 'https://bfagaming.com',
      referer: 'https://bfagaming.com/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      priority: 'u=1, i',
    },
    data: wager,
  });
  const status = res.status();
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  maybeTriggerCooldown(status, 'wager');

  // Verify via balance delta (authoritative) + open-bets poll (slower propagation)
  const balanceBefore = available;
  let placed = false;
  let balanceAfter = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const bets = await getOpenBets();
      const list = Array.isArray(bets) ? bets : (bets?.items || bets?.data || []);
      if (list.some((b) => JSON.stringify(b).includes(idTx))) { placed = true; break; }
    } catch {}
  }
  try {
    const balNow = await getBalance();
    balanceAfter = Number(balNow?.availableBalance ?? NaN);
    if (!placed && Number.isFinite(balanceAfter) && balanceBefore - balanceAfter >= amount - BALANCE_BUFFER) {
      placed = true;
    }
  } catch {}

  if (placed) {
    firedLog.record({
      key: firedKey, eventId, fixtureId, marketType, side, contestantId,
      line: line ?? 0, price, amount, idTransaction: idTx,
      balanceBefore, balanceAfter, meta,
    });
  }

  return { status, body, idTransaction: idTx, placed, balanceBefore, balanceAfter, firedKey };
}

module.exports = { placeBet, getBalance, getOpenBets, cooldown, firedLog };

// CLI: auth + balance smoke test only. No bet placed.
if (require.main === module) {
  (async () => {
    const cdStatus = cooldown.status();
    if (cdStatus.active) {
      console.log(`[cooldown] Active — ${(cdStatus.remainingMs / 60000).toFixed(1)} min remaining (reason: ${cdStatus.reason})`);
    } else {
      console.log('[cooldown] inactive');
    }
    console.log(`[firedLog] ${firedLog.readAll().length} entries in the last ${firedLog.ENTRY_TTL_MS / 3600000}h`);
    const bal = await getBalance();
    console.log('Balance:', JSON.stringify(bal, null, 2));
    const bets = await getOpenBets();
    const list = Array.isArray(bets) ? bets : (bets?.items || bets?.data || []);
    console.log('Open bets count:', Array.isArray(list) ? list.length : 'unknown');
    await close();
  })().catch(async (e) => { console.error('ERR:', e.message); await close(); process.exit(1); });
}
