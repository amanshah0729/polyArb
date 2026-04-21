require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const STATE_PATH = path.join(__dirname, '..', 'priv', 'bfa-state.json');
const TOKEN_PATH = path.join(__dirname, '..', 'priv', 'bfa-token.json');
const OIDC_PATH = path.join(__dirname, '..', 'priv', 'bfa-oidc.json');
const SITE = 'https://bfagaming.com';
const OIDC_KEY = 'oidc.user:https://auth.bfagaming.com/realms/players_realm:bfagaming';

let _browser = null;
let _context = null;
let _tokenCache = null; // { access_token, expires_at }

function need(name) {
  if (!process.env[name]) throw new Error(`${name} is not set in .env`);
  return process.env[name];
}

function loadDiskToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    if (j.access_token && j.expires_at && Date.now() < j.expires_at - 30000) {
      _tokenCache = j;
      return j;
    }
  } catch {}
  return null;
}

function saveDiskToken(tok) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tok));
  } catch {}
}

async function launch() {
  if (_browser) return _browser;
  _browser = await chromium.launch({ headless: true });
  return _browser;
}

async function newContext() {
  const browser = await launch();
  const opts = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  };
  if (fs.existsSync(STATE_PATH)) opts.storageState = STATE_PATH;
  const context = await browser.newContext(opts);

  // Inject cached OIDC user into sessionStorage before any page script runs — Blazor SPA reads
  // sessionStorage[oidc.user:...] to decide logged-in state. storageState doesn't persist sessionStorage.
  // Only inject if the cached token is still fresh — injecting a stale token causes the SPA to believe
  // it's logged in and skip processing the Keycloak callback after a fresh login, leaving us with a dead token.
  if (fs.existsSync(OIDC_PATH)) {
    try {
      const oidcJson = fs.readFileSync(OIDC_PATH, 'utf8');
      const parsed = JSON.parse(oidcJson);
      const fresh = parsed && parsed.access_token && parsed.expires_at && (parsed.expires_at * 1000) > Date.now() + 30000;
      if (fresh) {
        await context.addInitScript(({ key, value }) => {
          try { sessionStorage.setItem(key, value); } catch {}
        }, { key: OIDC_KEY, value: oidcJson });
      }
    } catch {}
  }
  return context;
}

async function extractTokenFromPage(page) {
  return page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }, OIDC_KEY);
}

async function login(context) {
  const page = await context.newPage();
  const user = need('BFA_USERNAME');
  const pass = need('BFA_PASSWORD');

  // Clear cached oidc user + cookies so the SPA renders the logged-out state and exposes the Log In button.
  // Stale access_token in sessionStorage would otherwise make the SPA display as "logged in" even though the server rejected it.
  await context.clearCookies().catch(() => {});
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 });

  const loginBtn = page.locator('button:has-text("Log In"), button:has-text("Login")').first();
  await loginBtn.waitFor({ timeout: 30000 });
  // MudBlazor snackbar can intercept pointer events even with force:true — dispatch click via JS
  await loginBtn.evaluate((el) => (el).click());

  await page.waitForURL(/auth\.bfagaming\.com/, { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.locator('#username, input[name="username"]').first().waitFor({ timeout: 30000 });
  await page.locator('#username, input[name="username"]').first().fill(user);
  await page.locator('#password, input[name="password"]').first().fill(pass);
  await page.locator('#kc-login, button[type="submit"], input[type="submit"]').first().click();

  // Wait for return to bfagaming.com AND for oidc.user to populate
  await page.waitForURL(/bfagaming\.com/, { timeout: 45000 });
  const deadline = Date.now() + 30000;
  let oidc = null;
  while (Date.now() < deadline) {
    oidc = await extractTokenFromPage(page);
    if (oidc && oidc.access_token) break;
    await page.waitForTimeout(1000);
  }
  if (!oidc || !oidc.access_token) { await page.close(); throw new Error('Login completed but no access_token found'); }

  await context.storageState({ path: STATE_PATH });
  try {
    fs.mkdirSync(path.dirname(OIDC_PATH), { recursive: true });
    fs.writeFileSync(OIDC_PATH, JSON.stringify(oidc));
  } catch {}
  await page.close();
  return oidc;
}

function oidcToToken(oidc) {
  // oidc.user shape: { access_token, refresh_token, expires_at (seconds), token_type, ... }
  const expiresAtMs = oidc.expires_at ? oidc.expires_at * 1000 : Date.now() + 25 * 60 * 1000;
  return { access_token: oidc.access_token, refresh_token: oidc.refresh_token, expires_at: expiresAtMs };
}

async function getContext() {
  if (_context) return _context;
  _context = await newContext();
  return _context;
}

async function getAccessToken({ force = false } = {}) {
  if (!force) {
    if (_tokenCache && Date.now() < _tokenCache.expires_at - 30000) return _tokenCache.access_token;
    const disk = loadDiskToken();
    if (disk) return disk.access_token;
  }
  const ctx = await getContext();
  // Try to extract token from an existing session (storageState restores cookies/localStorage but not sessionStorage;
  // visiting the site will re-populate oidc.user via silent sign-in if KEYCLOAK_SESSION cookies are still valid).
  const page = await ctx.newPage();
  const isFresh = (o) => o && o.access_token && o.expires_at && (o.expires_at * 1000) > Date.now() + 30000;
  try {
    await page.goto(SITE, { waitUntil: 'networkidle', timeout: 60000 });
    let oidc = await extractTokenFromPage(page);
    // Wait for SPA to silently refresh if the injected token is stale (refresh_token exchange)
    const deadline = Date.now() + 15000;
    while (!isFresh(oidc) && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      oidc = await extractTokenFromPage(page);
    }
    if (isFresh(oidc)) {
      _tokenCache = oidcToToken(oidc);
      saveDiskToken(_tokenCache);
      try { fs.writeFileSync(OIDC_PATH, JSON.stringify(oidc)); } catch {}
      return _tokenCache.access_token;
    }
  } finally {
    await page.close();
  }
  // Silent path failed — do a full login
  const oidc = await login(ctx);
  _tokenCache = oidcToToken(oidc);
  saveDiskToken(_tokenCache);
  return _tokenCache.access_token;
}

async function close() {
  if (_context) { await _context.close().catch(() => {}); _context = null; }
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
}

module.exports = { getContext, getAccessToken, close, STATE_PATH };

if (require.main === module) {
  (async () => {
    const token = await getAccessToken();
    console.log('access_token length:', token.length);
    const ctx = await getContext();
    const playerId = process.env.BFA_PLAYER_ID;
    const res = await ctx.request.get(
      `https://api.bfagaming.com/balance/api/GetPlayerBalanceByPlayerId?playerId=${playerId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    console.log('balance status:', res.status());
    console.log('balance body:', (await res.text()).slice(0, 400));
    await close();
  })().catch(async (e) => { console.error('ERR:', e.message); await close(); process.exit(1); });
}
