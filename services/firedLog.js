const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'priv', 'fired.jsonl');
const ENTRY_TTL_MS = 48 * 60 * 60 * 1000;

function ymd(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function makeKey({ eventId, marketType, contestantId, line = 0, side = 0 }) {
  return `${eventId}|${marketType}|${side}|${contestantId}|${line}|${ymd()}`;
}

function readAll() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  const cutoff = Date.now() - ENTRY_TTL_MS;
  const out = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp && Date.parse(obj.timestamp) >= cutoff) out.push(obj);
    } catch {}
  }
  return out;
}

function hasFired(key) {
  return readAll().some((e) => e.key === key);
}

function record(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const line = JSON.stringify({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function prune() {
  const kept = readAll();
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
}

module.exports = { makeKey, hasFired, record, readAll, prune, ENTRY_TTL_MS };
