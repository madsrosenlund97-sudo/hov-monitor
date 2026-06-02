// Probe the new bookings admin page to discover auth + data structure.
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

const TARGET = process.argv[2] || 'https://houseofvinterberg.com/book';
const USER_AGENT = 'Mozilla/5.0 (HOV-Probe) AppleWebKit/537.36';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const bypass = process.env.VERCEL_BYPASS_SECRET || 'asdfghhjklafbkjkdjnfjndfdkfkfkdj';
  const user = process.env.ADMIN_USER || 'mads@houseofvinterberg.com';
  const pass = process.env.ADMIN_PASS || 'hov';
  const basicAuth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: USER_AGENT,
    extraHTTPHeaders: {
      'x-vercel-protection-bypass': bypass,
      'x-vercel-set-bypass-cookie': 'true',
      'authorization': basicAuth,
    },
  });
  const page = await ctx.newPage();

  const xhrs = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (/supabase\.co|\/api\//i.test(url)) {
      try {
        const ct = resp.headers()['content-type'] || '';
        const entry = { url, status: resp.status() };
        if (ct.includes('json')) {
          entry.data = await resp.json().catch(() => null);
        }
        xhrs.push(entry);
      } catch(_) {}
    }
  });

  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    await page.waitForTimeout(6000);
    await page.screenshot({ path: path.join(__dirname, 'logs', 'newbookings-page.png'), fullPage: true }).catch(()=>{});
    const fullHtml = await page.content();
    fs.writeFileSync(path.join(__dirname, 'logs', 'newbookings-page.html'), fullHtml, 'utf8');
  } catch(e){ console.error('nav error:', e.message); }

  // Dump table structure if visible
  const tableInfo = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.map(t => {
      const headers = Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.textContent.trim());
      const rows = Array.from(t.querySelectorAll('tbody tr')).slice(0, 3).map(tr => {
        return Array.from(tr.querySelectorAll('td, th')).map(td => {
          const link = td.querySelector('a');
          return { text: td.textContent.trim().slice(0, 100), href: link ? link.href : null };
        });
      });
      return { headerCount: headers.length, headers, sampleRows: rows };
    });
  }).catch(e => ({ error: e.message }));

  const finalUrl = page.url();
  const title = await page.title();
  const visibleText = ((await page.textContent('body').catch(()=>'')) || '').slice(0, 1500);
  const hasLogin = await page.$('input[type=password]').then(el => !!el);
  const emailInput = await page.$('input[type=email], input[name=email]').then(el => !!el);
  const html = await page.content();
  const supabaseMatch = html.match(/https?:\/\/[a-z0-9]+\.supabase\.co/);
  const anonKeyMatch = html.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/);

  const out = {
    finalUrl, title,
    hasLoginField: hasLogin,
    hasEmailField: emailInput,
    visibleTextPreview: visibleText,
    supabaseUrl: supabaseMatch ? supabaseMatch[0] : null,
    anonKeyPrefix: anonKeyMatch ? anonKeyMatch[0].slice(0,40) + '...' : null,
    xhrCount: xhrs.length,
    xhrUrls: xhrs.map(x => `[${x.status}] ${x.url}`).slice(0, 20),
    tableInfo,
  };
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'logs', 'newbookings-inspect.json'), JSON.stringify({ at: new Date().toISOString(), result: out, xhrs }, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));

  await ctx.close();
  await browser.close();
})().catch(err => { console.error('crash:', err.message); process.exit(2); });
