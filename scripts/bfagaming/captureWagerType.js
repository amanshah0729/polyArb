require('dotenv').config({ path: require('path').join(__dirname, '../..', '.env') });
const fs = require('fs');
const path = require('path');
const { getContext, close } = require('../../services/bfaBrowser');

const SAMPLES_PATH = path.join(__dirname, '../..', 'priv', 'wagertype-samples.jsonl');
const SCREENSHOT_DIR = path.join(__dirname, '../..', 'priv', 'capture-screenshots');
const TRAFFIC_LOG = path.join(__dirname, '../..', 'priv', 'capture-traffic.jsonl');

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

(async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(TRAFFIC_LOG, ''); // clear per run

  const ctx = await getContext();
  const page = await ctx.newPage();

  // Log ALL network (including WS handshakes) so we can find a hidden IdWagerType source
  page.on('request', (req) => {
    try {
      const entry = {
        t: Date.now(), kind: 'req',
        method: req.method(), url: req.url(),
        post: req.postData() ? req.postData().slice(0, 2000) : null,
        resType: req.resourceType(),
      };
      appendJsonl(TRAFFIC_LOG, entry);
    } catch {}
  });
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      let bodyPreview = null;
      if (ct.includes('json') && res.status() === 200) {
        try { bodyPreview = (await res.text()).slice(0, 3000); } catch {}
      }
      appendJsonl(TRAFFIC_LOG, {
        t: Date.now(), kind: 'res', status: res.status(), url: res.url(), ct, bodyPreview,
      });
    } catch {}
  });
  page.on('websocket', (ws) => {
    appendJsonl(TRAFFIC_LOG, { t: Date.now(), kind: 'ws-open', url: ws.url() });
    ws.on('framesent', (f) => appendJsonl(TRAFFIC_LOG, { t: Date.now(), kind: 'ws-sent', url: ws.url(), data: (f.payload || '').toString().slice(0, 1500) }));
    ws.on('framereceived', (f) => appendJsonl(TRAFFIC_LOG, { t: Date.now(), kind: 'ws-recv', url: ws.url(), data: (f.payload || '').toString().slice(0, 1500) }));
  });

  // Intercept the wager POST — capture body, abort, do NOT place the bet
  const captured = [];
  await page.route('**/wagering/api/v1/wager*', async (route) => {
    const req = route.request();
    const body = req.postData();
    let parsed = null; try { parsed = JSON.parse(body); } catch {}
    const sample = {
      timestamp: new Date().toISOString(),
      url: req.url(),
      body: parsed || body,
      headers: req.headers(),
    };
    captured.push(sample);
    appendJsonl(SAMPLES_PATH, sample);
    console.log('\n*** INTERCEPTED /wager POST ***');
    console.log(JSON.stringify(parsed || body, null, 2));
    console.log('Aborting — no bet will be placed.\n');
    await route.abort('aborted');
  });

  try {
    await page.goto('https://bfagaming.com', { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-home.png') });

    const nhlBtn = page.locator('button:has-text("NHL")').first();
    await nhlBtn.waitFor({ timeout: 15000 });
    await nhlBtn.click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-nhl.png') });

    // Find a pure moneyline odds button (text like "+105" or "-110", no newline/spread info)
    // Grab them via JS evaluation, then click the first matching one by its nth selector
    const oddsInfo = await page.locator('button.mud-button-text').evaluateAll((els) => {
      const out = [];
      for (let i = 0; i < els.length; i++) {
        const txt = (els[i].innerText || '').trim();
        if (/^[+\-]\d{2,4}$/.test(txt)) out.push({ idx: i, txt });
      }
      return out;
    });
    if (!oddsInfo.length) throw new Error('No ML odds button found on NHL page');
    console.log(`Found ${oddsInfo.length} ML buttons; clicking first: "${oddsInfo[0].txt}"`);
    await page.locator('button.mud-button-text').nth(oddsInfo[0].idx).click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-betslip.png') });

    // Fill the stake in the bet slip. Find the numeric input.
    const stakeInput = page.locator('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]').first();
    await stakeInput.waitFor({ timeout: 15000 });
    await stakeInput.fill('5');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-staked.png') });

    // The place bet trigger is a <section class="betbutton" role="button"> inside .betslip-fixed-footer
    const placeBtn = page.locator('.betbutton[role="button"]').first();
    await placeBtn.waitFor({ timeout: 15000 });
    const btnLabel = await placeBtn.locator('.betbutton-label').innerText().catch(() => '');
    console.log('Bet button label:', btnLabel);
    if (/login/i.test(btnLabel)) {
      throw new Error('Bet button says "Login to place a bet" — OIDC session not restored in SPA');
    }
    await placeBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-confirm-dialog.png') });

    // Confirmation dialog: "Yes, submit wager" button
    const confirmBtn = page.locator('button:has-text("Yes, submit wager"), button:has-text("Yes"), button:has-text("Confirm")').first();
    await confirmBtn.waitFor({ timeout: 10000 });
    console.log('Clicking confirm...');
    await confirmBtn.click();

    // Wait for the intercepted POST
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && captured.length === 0) {
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-after-click.png') });

    if (captured.length === 0) {
      console.log('No /wager POST captured within 10s. Screenshots saved for debugging.');
    } else {
      console.log(`\nCaptured ${captured.length} wager POST(s). Samples written to: ${SAMPLES_PATH}`);
      for (const s of captured) {
        const pick = s.body?.[0]?.Picks?.[0];
        const top = s.body?.[0];
        if (pick && top) {
          console.log(`  EventId=${pick.EventId} MarketType=${pick.MarketType} Side=${pick.Side} ContestantId=${pick.ContestantId} Line=${pick.Line} Price=${pick.Price} → IdWagerType=${top.IdWagerType}`);
        }
      }
    }
  } catch (e) {
    console.error('Flow error:', e.message);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'error.png') }).catch(() => {});
  } finally {
    await page.close();
    await close();
    console.log(`\nFull traffic log: ${TRAFFIC_LOG}`);
    console.log(`Screenshots: ${SCREENSHOT_DIR}`);
  }
})();
