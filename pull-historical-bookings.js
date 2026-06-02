// One-shot: pulls ALL Amelia appointments for a wide date range and writes
// a clean JSON + CSV with date, time, service, customer email, source,
// status, employee. Used for backtracking-analysis - hvor kommer bookings fra
// før det nye attribution-system?
//
// Usage:
//   node pull-historical-bookings.js [START_DATE] [END_DATE]
//   Defaults: 2025-01-01 til 2027-01-01
//
// Output:
//   logs/historical-bookings.json
//   logs/historical-bookings.csv

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

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const AUTH_STATE_FILE = path.join(__dirname, 'auth-state.json');
const OUT_JSON = path.join(__dirname, 'logs', 'historical-bookings.json');
const OUT_CSV = path.join(__dirname, 'logs', 'historical-bookings.csv');

const START = process.argv[2] || '2025-01-01';
const END = process.argv[3] || '2027-01-01';

async function loginWp(chromium) {
  const wpUser = process.env.WP_USER || '';
  const wpPass = process.env.WP_PASS || '';
  if (!wpUser || !wpPass) throw new Error('WP_USER/WP_PASS mangler i miljoet');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: config.userAgent, viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(config.site + '/wp-login.php', { timeout: config.timeoutMs, waitUntil: 'domcontentloaded' });
    await page.fill('#user_login', wpUser);
    await page.fill('#user_pass', wpPass);
    await Promise.all([
      page.waitForNavigation({ timeout: config.timeoutMs, waitUntil: 'domcontentloaded' }).catch(()=>{}),
      page.click('#wp-submit'),
    ]);
    if (!page.url().includes('/wp-admin/')) throw new Error('Login mislykkedes - landede paa ' + page.url());
    await ctx.storageState({ path: AUTH_STATE_FILE });
  } finally {
    await ctx.close();
    await browser.close();
  }
}

function normalize(appt) {
  const startStr = appt.bookingStartDateTime || appt.bookingStart || '';
  const date = startStr.slice(0, 10);
  const time = startStr.slice(11, 16);
  const svc = appt.service || (appt.bookings && appt.bookings[0] && appt.bookings[0].service) || {};
  const serviceName = svc.name || appt.serviceName || '';
  const employee = appt.employee ? ((appt.employee.firstName || '') + ' ' + (appt.employee.lastName || '')).trim() : '';
  const bookingList = Array.isArray(appt.bookings) ? appt.bookings : [];
  const out = [];
  if (bookingList.length === 0) {
    out.push({
      appointmentId: appt.id,
      bookingId: null,
      date, time,
      service: serviceName,
      employee,
      source: appt.bookingSource || '',
      status: appt.status || '',
      customerEmail: '',
      customerName: '',
      customerCreated: '',
      price: ''
    });
  } else {
    for (const b of bookingList) {
      const c = b.customer || {};
      out.push({
        appointmentId: appt.id,
        bookingId: b.id,
        date, time,
        service: serviceName,
        employee,
        source: appt.bookingSource || '',
        status: b.status || appt.status || '',
        customerEmail: c.email || '',
        customerName: ((c.firstName || '') + ' ' + (c.lastName || '')).trim(),
        customerCreated: c.created || '',
        price: b.price != null ? b.price : (appt.price != null ? appt.price : '')
      });
    }
  }
  return out;
}

function toCsv(rows) {
  const cols = ['appointmentId','bookingId','date','time','service','employee','source','status','customerEmail','customerName','customerCreated','price'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  return [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) { console.error('Playwright mangler. Kor install.ps1.'); process.exit(2); }

  if (!fs.existsSync(AUTH_STATE_FILE)) {
    console.log('Ingen auth-state - logger ind...');
    await loginWp(chromium);
  }

  const browser = await chromium.launch({ headless: true });
  let allAppointments = [];
  let attemptedRelogin = false;

  async function pull(authPath) {
    const ctx = await browser.newContext({
      userAgent: config.userAgent,
      viewport: { width: 1366, height: 900 },
      storageState: authPath
    });
    const page = await ctx.newPage();
    const captured = [];

    page.on('response', async (resp) => {
      const url = resp.url();
      if (!/wpamelia/i.test(url) && !/amelia\/v1/i.test(url)) return;
      if (!/\/bookings\/appointments/.test(url)) return;
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const data = await resp.json();
        captured.push({ url, data });
      } catch (_) {}
    });

    // First navigate to Amelia admin so we get the wpAmeliaNonce loaded
    await page.goto(config.site + '/wp-admin/admin.php?page=wpamelia-bookings#/appointments', {
      timeout: config.timeoutMs, waitUntil: 'domcontentloaded'
    });

    if (page.url().includes('/wp-login.php')) {
      await ctx.close();
      return { needsLogin: true };
    }

    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (_) {}
    await page.waitForTimeout(2000);

    // Extract the nonce from one of the captured URLs
    let nonce = '';
    for (const p of captured) {
      const m = p.url.match(/wpAmeliaNonce=([a-z0-9]+)/i);
      if (m) { nonce = m[1]; break; }
    }
    if (!nonce) {
      // try to read it from page context
      try {
        nonce = await page.evaluate(() => (window.wpAmeliaSettings && window.wpAmeliaSettings.nonce) || '');
      } catch (_) {}
    }

    console.log('Nonce:', nonce ? '(found)' : '(missing)');

    // Now hit the API directly via page.request to paginate through everything.
    const all = [];
    let pageNum = 1;
    const limit = 100;
    let totalCount = 0;
    while (true) {
      const apiUrl = config.site + '/wp-admin/admin-ajax.php?action=wpamelia_api&call=/bookings/appointments&page=' + pageNum + '&limit=' + limit + '&dates=' + START + ',' + END + '&wpAmeliaNonce=' + nonce;
      const r = await page.request.get(apiUrl);
      if (!r.ok()) { console.error('Page', pageNum, 'fejl:', r.status()); break; }
      const json = await r.json();
      const apptMap = (json && json.data && json.data.appointments) || {};
      totalCount = (json && json.data && json.data.totalCount) || 0;

      // appointments is keyed by date string (or "0","1",..) - flatten
      const pageAppts = [];
      for (const k of Object.keys(apptMap)) {
        const v = apptMap[k];
        if (Array.isArray(v)) pageAppts.push(...v);
        else if (v && Array.isArray(v.appointments)) pageAppts.push(...v.appointments);
        else if (v && typeof v === 'object' && v.id) pageAppts.push(v);
      }
      console.log('Page', pageNum, '-', pageAppts.length, 'appointments (total i system:', totalCount + ')');
      if (pageAppts.length === 0) break;
      all.push(...pageAppts);
      if (all.length >= totalCount) break;
      pageNum++;
      if (pageNum > 20) { console.warn('Stopped at page 20 safety'); break; }
    }

    await ctx.close();
    return { appointments: all, totalCount };
  }

  let result = await pull(AUTH_STATE_FILE);
  if (result.needsLogin && !attemptedRelogin) {
    attemptedRelogin = true;
    console.log('Auth udløbet - relogin');
    await browser.close();
    await loginWp(chromium);
    const browser2 = await require('playwright').chromium.launch({ headless: true });
    // Can't easily reassign closure - just call directly
    result = await (async () => {
      const ctx = await browser2.newContext({ userAgent: config.userAgent, storageState: AUTH_STATE_FILE });
      const page = await ctx.newPage();
      const captured = [];
      page.on('response', async (resp) => {
        const url = resp.url();
        if (!/\/bookings\/appointments/.test(url)) return;
        try { captured.push({ url, data: await resp.json() }); } catch(_){}
      });
      await page.goto(config.site + '/wp-admin/admin.php?page=wpamelia-bookings#/appointments', { timeout: config.timeoutMs, waitUntil: 'domcontentloaded' });
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch(_){}
      await page.waitForTimeout(2000);
      let nonce = '';
      for (const p of captured) { const m = p.url.match(/wpAmeliaNonce=([a-z0-9]+)/i); if (m) { nonce = m[1]; break; } }
      const all = [];
      let pageNum = 1; const limit = 100; let totalCount = 0;
      while (true) {
        const apiUrl = config.site + '/wp-admin/admin-ajax.php?action=wpamelia_api&call=/bookings/appointments&page=' + pageNum + '&limit=' + limit + '&dates=' + START + ',' + END + '&wpAmeliaNonce=' + nonce;
        const r = await page.request.get(apiUrl);
        if (!r.ok()) break;
        const json = await r.json();
        const apptMap = (json && json.data && json.data.appointments) || {};
        totalCount = (json && json.data && json.data.totalCount) || 0;
        const pageAppts = [];
        for (const k of Object.keys(apptMap)) { const v = apptMap[k]; if (Array.isArray(v)) pageAppts.push(...v); else if (v && Array.isArray(v.appointments)) pageAppts.push(...v.appointments); else if (v && v.id) pageAppts.push(v); }
        console.log('Page', pageNum, '-', pageAppts.length, 'appointments');
        if (pageAppts.length === 0) break;
        all.push(...pageAppts);
        if (all.length >= totalCount) break;
        pageNum++;
        if (pageNum > 20) break;
      }
      await ctx.close();
      await browser2.close();
      return { appointments: all, totalCount };
    })();
  } else {
    await browser.close();
  }

  if (!result.appointments) {
    console.error('Ingen appointments hentet');
    process.exit(1);
  }

  // Dedupe by appointmentId
  const seen = new Set();
  const unique = result.appointments.filter(a => {
    const id = a.id || (a.bookings && a.bookings[0] && a.bookings[0].id);
    if (!id || seen.has(id)) return false;
    seen.add(id); return true;
  });

  // Normalize - flatten to one row per booking
  const rows = [];
  for (const a of unique) rows.push(...normalize(a));

  // Sort by date
  rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    pulledAt: new Date().toISOString(),
    range: { start: START, end: END },
    totalCountInAmelia: result.totalCount,
    appointmentsReturned: unique.length,
    bookingsReturned: rows.length,
    rows
  }, null, 2));
  fs.writeFileSync(OUT_CSV, toCsv(rows));

  console.log('OK -', unique.length, 'appointments,', rows.length, 'bookings');
  console.log('JSON:', OUT_JSON);
  console.log('CSV: ', OUT_CSV);
})().catch((err) => {
  console.error('crash:', err && err.message || err);
  process.exit(2);
});
