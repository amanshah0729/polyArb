const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'priv', 'events');
const RETAIN_DAYS = 30;

function pathFor(day = new Date()) {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, '0');
  const d = String(day.getUTCDate()).padStart(2, '0');
  return path.join(LOG_DIR, `${y}-${m}-${d}.jsonl`);
}

function write(type, payload = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const entry = { t: Date.now(), timestamp: new Date().toISOString(), type, ...payload };
  fs.appendFileSync(pathFor(), JSON.stringify(entry) + '\n');
  return entry;
}

function readRange(sinceMs) {
  const cutoff = sinceMs ?? (Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000);
  if (!fs.existsSync(LOG_DIR)) return [];
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.t >= cutoff) out.push(obj);
      } catch {}
    }
  }
  return out;
}

function readTypes(types, sinceMs) {
  const set = new Set(Array.isArray(types) ? types : [types]);
  return readRange(sinceMs).filter((e) => set.has(e.type));
}

const scan       = (payload) => write('scan', payload);
const arbFound   = (payload) => write('arb_found', payload);
const attempt    = (payload) => write('attempt', payload);
const polyFilled = (payload) => write('poly_filled', payload);
const polyFailed = (payload) => write('poly_failed', payload);
const bfaFilled  = (payload) => write('bfa_filled', payload);
const bfaFailed  = (payload) => write('bfa_failed', payload);
const unwind     = (payload) => write('unwind', payload);
const finalize   = (payload) => write('final', payload);
const alarm      = (payload) => write('alarm', payload);

module.exports = {
  write, readRange, readTypes,
  scan, arbFound, attempt, polyFilled, polyFailed,
  bfaFilled, bfaFailed, unwind, finalize, alarm,
  LOG_DIR,
};
