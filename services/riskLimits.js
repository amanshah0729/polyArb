/**
 * Fire-time circuit breaker for the arb executor.
 *
 * Arbs settle days after they fire, so we can't gate on *settled* PnL at fire
 * time. Instead every limit here is computable the instant we're about to fire,
 * from the event log: bet count, dollars deployed, open exposure, and the
 * losses that ARE realized immediately (Poly bought but the hedge failed → we
 * unwind at a loss). Two of the checks are "sticky": once tripped they latch a
 * HALT that blocks all execution until a human clears it (`clearHalt`), so a
 * systematic failure (a resurfaced matcher bug, a dead BFA session) can't drain
 * the account one auto-fire at a time.
 *
 * All thresholds are env-tunable; defaults are the "supervised burn-in" set.
 */
const fs = require('fs');
const path = require('path');
const eventLog = require('./eventLog');

const HALT_PATH = path.join(__dirname, '..', 'priv', 'risk-halt.json');
const DAY_MS = 24 * 60 * 60 * 1000;

function envNum(key, def) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function limits() {
  return {
    maxStakePerBet:   envNum('RISK_MAX_STAKE_PER_BET', 25),    // BFA $ on any single bet
    maxFiresPerDay:   envNum('RISK_MAX_FIRES_PER_DAY', 15),    // filled_both count per UTC day
    maxDailyStake:    envNum('RISK_MAX_DAILY_STAKE', 150),     // sum BFA $ deployed per UTC day
    maxOpenExposure:  envNum('RISK_MAX_OPEN_EXPOSURE', 200),   // sum BFA $ still at risk (trailing window)
    maxUnwindLossDay: envNum('RISK_MAX_UNWIND_LOSS_DAY', 20),  // realized unwind loss/day → HALT
    maxConsecFails:   envNum('RISK_MAX_CONSEC_FAILS', 4),      // consecutive hedge failures → HALT
    openWindowDays:   envNum('RISK_OPEN_WINDOW_DAYS', 14),     // trailing window treated as "unsettled"
  };
}

// Outcomes where we actually bought the Poly leg (so real money moved and the
// attempt can be judged good/bad). Benign non-fires (false_arb, unsupported,
// skipped, risk_blocked) are NOT execution failures and must not trip the halt.
const EXECUTED = new Set(['filled_both', 'poly_unwound', 'poly_stuck']);

function isUtcToday(ts, now) {
  return new Date(ts).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
}

function readHalt() {
  try {
    const j = JSON.parse(fs.readFileSync(HALT_PATH, 'utf8'));
    if (j && j.halted) return j;
  } catch {}
  return null;
}

function tripHalt(reason, detail = {}) {
  const rec = { halted: true, reason, detail, trippedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(HALT_PATH), { recursive: true });
    fs.writeFileSync(HALT_PATH, JSON.stringify(rec, null, 2));
  } catch {}
  try { eventLog.alarm({ kind: 'risk_halt', reason, detail }); } catch {}
  return rec;
}

function clearHalt() {
  try { fs.rmSync(HALT_PATH, { force: true }); } catch {}
  return { halted: false };
}

function isHalted() { return !!readHalt(); }

/** Aggregate the fire-time signals from the event log. */
function _snapshot(now = Date.now()) {
  const L = limits();
  const finals = eventLog.readTypes('final', now - L.openWindowDays * DAY_MS);

  let firesToday = 0, dailyStake = 0, openExposure = 0, dailyUnwindLoss = 0;
  for (const f of finals) {
    const stake = Number(f?.bfa?.amount) || 0;
    if (f.outcome === 'filled_both') {
      openExposure += stake;                        // trailing-window proxy for unsettled risk
      if (isUtcToday(f.t, now)) { firesToday++; dailyStake += stake; }
    }
    if ((f.outcome === 'poly_unwound' || f.outcome === 'poly_stuck') && isUtcToday(f.t, now)) {
      dailyUnwindLoss += Number(f.unwindLoss) || 0;
    }
  }

  // Consecutive hedge-failure streak: newest→oldest over EXECUTED finals only,
  // counting the leading run of non-filled_both until the first good fill.
  const executed = finals.filter(f => EXECUTED.has(f.outcome)).sort((a, b) => b.t - a.t);
  let consecFails = 0;
  for (const f of executed) {
    if (f.outcome === 'filled_both') break;
    consecFails++;
  }

  return { firesToday, dailyStake, openExposure, dailyUnwindLoss, consecFails };
}

/**
 * Call BEFORE placing an arb. Returns { ok, reason, snapshot, limits }.
 * A sticky HALT (or any breached ceiling) returns ok:false.
 */
function precheck({ bfaAmount } = {}) {
  const L = limits();
  const halt = readHalt();
  if (halt) return { ok: false, reason: `halted:${halt.reason}`, halt, limits: L };

  const s = _snapshot();
  const stake = Number(bfaAmount) || 0;

  if (stake > L.maxStakePerBet)
    return { ok: false, reason: `stake_per_bet ${stake} > ${L.maxStakePerBet}`, snapshot: s, limits: L };
  if (s.firesToday >= L.maxFiresPerDay)
    return { ok: false, reason: `fires_today ${s.firesToday} ≥ ${L.maxFiresPerDay}`, snapshot: s, limits: L };
  if (s.dailyStake + stake > L.maxDailyStake)
    return { ok: false, reason: `daily_stake ${(s.dailyStake + stake).toFixed(2)} > ${L.maxDailyStake}`, snapshot: s, limits: L };
  if (s.openExposure + stake > L.maxOpenExposure)
    return { ok: false, reason: `open_exposure ${(s.openExposure + stake).toFixed(2)} > ${L.maxOpenExposure}`, snapshot: s, limits: L };

  return { ok: true, snapshot: s, limits: L };
}

/**
 * Call AFTER each attempt with its final record. Latches a HALT when the
 * realized-loss or consecutive-failure ceilings are breached.
 */
function recordOutcome(final) {
  if (!final || typeof final !== 'object') return { halted: isHalted() };
  const L = limits();
  const s = _snapshot();

  if (s.dailyUnwindLoss > L.maxUnwindLossDay) {
    return tripHalt('daily_unwind_loss', { dailyUnwindLoss: s.dailyUnwindLoss, limit: L.maxUnwindLossDay });
  }
  if (s.consecFails >= L.maxConsecFails) {
    return tripHalt('consecutive_failures', { consecFails: s.consecFails, limit: L.maxConsecFails });
  }
  return { halted: false, snapshot: s };
}

function status() {
  return { halt: readHalt() || { halted: false }, snapshot: _snapshot(), limits: limits() };
}

module.exports = { precheck, recordOutcome, isHalted, status, tripHalt, clearHalt, HALT_PATH };
