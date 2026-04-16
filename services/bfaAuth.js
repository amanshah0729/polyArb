require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const TOKEN_URL = 'https://auth.bfagaming.com/realms/players_realm/protocol/openid-connect/token';
const CLIENT_ID = 'bfagaming';

let access_token = null;
let refresh_token = null;
let access_expires_at = 0;
let refresh_expires_at = 0;

function need(name) {
  if (!process.env[name]) throw new Error(`${name} is not set in .env`);
  return process.env[name];
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://bfagaming.com',
      'Referer': 'https://bfagaming.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token ${params.grant_type} failed ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function storeTokens(j) {
  const now = Date.now();
  access_token       = j.access_token;
  refresh_token      = j.refresh_token;
  access_expires_at  = now + (j.expires_in         - 30) * 1000;
  refresh_expires_at = now + (j.refresh_expires_in - 30) * 1000;
}

async function passwordLogin() {
  const j = await tokenRequest({
    grant_type: 'password',
    username: need('BFA_USERNAME'),
    password: need('BFA_PASSWORD'),
    scope: 'openid email profile',
  });
  storeTokens(j);
  return j;
}

async function refreshLogin() {
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token });
  storeTokens(j);
  return j;
}

async function getAccessToken() {
  const now = Date.now();
  if (access_token && now < access_expires_at) return access_token;
  if (refresh_token && now < refresh_expires_at) {
    try { await refreshLogin(); return access_token; } catch (_) { /* fall through */ }
  }
  await passwordLogin();
  return access_token;
}

module.exports = { getAccessToken };
