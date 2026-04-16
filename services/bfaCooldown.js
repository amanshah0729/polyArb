const fs = require('fs');
const path = require('path');

const COOLDOWN_PATH = path.join(__dirname, '..', 'priv', 'bfa-cooldown.json');
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'));
    if (typeof j.cooldownUntil === 'number') return j;
  } catch {}
  return { cooldownUntil: 0, reason: null, triggeredAt: null };
}

function write(obj) {
  fs.mkdirSync(path.dirname(COOLDOWN_PATH), { recursive: true });
  fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(obj, null, 2));
}

function isInCooldown() {
  return Date.now() < read().cooldownUntil;
}

function remainingMs() {
  const ms = read().cooldownUntil - Date.now();
  return ms > 0 ? ms : 0;
}

function status() {
  const j = read();
  return {
    active: Date.now() < j.cooldownUntil,
    remainingMs: Math.max(0, j.cooldownUntil - Date.now()),
    triggeredAt: j.triggeredAt,
    reason: j.reason,
  };
}

function trigger(reason = 'rate-limit', durationMs = DEFAULT_COOLDOWN_MS) {
  const now = Date.now();
  write({
    cooldownUntil: now + durationMs,
    reason,
    triggeredAt: new Date(now).toISOString(),
  });
}

function clear() {
  write({ cooldownUntil: 0, reason: null, triggeredAt: null });
}

module.exports = { isInCooldown, remainingMs, status, trigger, clear, DEFAULT_COOLDOWN_MS };
