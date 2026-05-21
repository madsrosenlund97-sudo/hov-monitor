// One-off inspection script for the Lagersystem page (post-login).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(function loadEnv(){
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  });
})();

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();

  const xhrs = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('supabase.co') || url.includes('/api/') || url.includes('/rest/') || (url.includes('netlify') && resp.headers()['content-type'] && resp.headers()['content-type'].includes('json'))) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const data = await resp.json().catch(() => null);
          xhrs.push({ url, status: resp.status(), data });
        } else {
          xhrs.push({ url, status: resp.status() });
        }
      } catch(_) {}
    }
  });

  const user = process.env.LAGER_USER || process.env.WP_USER || '';
  const pass = process.env.LAGER_PASS || process.env.WP_PASS || '';

  try {
    await page.goto('https://houseofvinterberg.netlify.app/mtm-ordrer', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    await page.waitForTimeout(2000);

    // Login if the form is present
    const hasPwd = await page.$('input[type=password]').then(el => !!el);
    if (hasPwd && user && pass) {
      console.error('logging in as', user);
      const emailInput = await page.$('input[type=email]') || await page.$('input[name=email]') || await page.$('input[placeholder*="mail" i]');
      const pwdInput = await page.$('input[type=password]');
      if (emailInput) await emailInput.fill(user);
      if (pwdInput) await pwdInput.fill(pass);
      const submit = await page.$('button[type=submit]') || await page.$('button:has-text("Log ind")') || await page.$('form button');
      if (submit) {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{}),
          submit.click(),
        ]);
        await page.waitForTimeout(3000);
      }
    }

    // Force navigate to MTM orders view after login.
    console.error('post-login URL:', page.url());
    await page.goto('https://houseofvinterberg.netlify.app/mtm-ordrer', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    await page.waitForTimeout(4000);

    // Try clicking the MTM nav tab in case the route is internal
    const mtmTab = await page.$('a:has-text("MTM"), button:has-text("MTM"), [href*="mtm"]');
    if (mtmTab) {
      console.error('clicking MTM nav');
      await mtmTab.click().catch(()=>{});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});
      await page.waitForTimeout(3000);
    }
  } catch(e) { console.error('nav error:', e.message); }

  const finalUrl = page.url();
  const title = await page.title();
  const visibleText = (await page.textContent('body').catch(()=>'') || '').slice(0, 2000);
  const hasLoginField = await page.$('input[type=password]').then(el => !!el).catch(()=>false);
  const formCount = await page.$$eval('form', els => els.length).catch(()=>0);
  const tableCount = await page.$$eval('table', els => els.length).catch(()=>0);
  const headings = await page.$$eval('h1,h2,h3', els => els.map(e => e.textContent.trim()).slice(0,20)).catch(()=>[]);

  // Look at script tags for clues about the framework / data layer
  const scripts = await page.$$eval('script[src]', els => els.map(e => e.src).slice(0,20)).catch(()=>[]);

  // Search the HTML for any visible order data or search input
  const html = await page.content();
  const hasSearchBox = /placeholder=["'][^"']*(søg|search|navn|name|kunde)/i.test(html);
  const hasOrderWord = /(mtm|ordr|order|kunde|customer)/i.test(visibleText);

  const out = {
    finalUrl, title, hasLoginField, formCount, tableCount, headings, scripts, hasSearchBox, hasOrderWord,
    visibleTextSample: visibleText,
    xhrCount: xhrs.length,
    xhrUrls: xhrs.map(x => x.url).slice(0, 30),
  };
  fs.writeFileSync(path.join(__dirname, 'logs', 'mtm-inspect.json'), JSON.stringify({ inspectedAt: new Date().toISOString(), result: out, xhrs }, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));

  await ctx.close();
  await browser.close();
})().catch(err => { console.error('crash:', err.message); process.exit(2); });
