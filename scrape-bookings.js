// Scrapes today's appointments from the Amelia admin and writes them to a
// JS file the daily checklist reads. Reuses the auth-state.json from monitor.js
// so we don't re-login every run.
//
// Usage: node scrape-bookings.js
// Exit codes: 0 = success, 1 = recoverable failure, 2 = fatal (missing creds, etc).

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
const OUT_FILE = path.resolve(__dirname, 'checklist', 'data', 'bookings.js');
const RAW_DEBUG_FILE = path.join(__dirname, 'logs', 'amelia-raw.json');

function todayKey(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function fail(code, message){
  console.error('[scrape-bookings] ' + message);
  process.exit(code);
}

async function loginWp(chromium){
  const wpUser = process.env.WP_USER || '';
  const wpPass = process.env.WP_PASS || '';
  if (!wpUser || !wpPass) throw new Error('WP_USER/WP_PASS mangler i miljoet');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: config.userAgent, viewport: { width:1366, height:900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(config.site + ((config.auth && config.auth.loginUrl) || '/wp-login.php'), {
      timeout: config.timeoutMs, waitUntil: 'domcontentloaded'
    });
    await page.fill('#user_login', wpUser);
    await page.fill('#user_pass', wpPass);
    await Promise.all([
      page.waitForNavigation({ timeout: config.timeoutMs, waitUntil: 'domcontentloaded' }).catch(()=>{}),
      page.click('#wp-submit'),
    ]);
    if (!page.url().includes('/wp-admin/')) {
      throw new Error('Login mislykkedes . landede paa ' + page.url());
    }
    await ctx.storageState({ path: AUTH_STATE_FILE });
  } finally {
    await ctx.close();
    await browser.close();
  }
}

function categorizeService(name){
  const s = (name || '').toLowerCase();
  if (s.includes('opmål') || s.includes('opmal') || s.includes('måling') || s.includes('maling')) return 'Opmåling';
  if (s.includes('fitting') || s.includes('tilpasning') || s.includes('udlevering') || s.includes('alteration')) return 'Fitting';
  return 'Booking';
}

function normalizeAppointment(a){
  const startStr = a.bookingStartDateTime || a.bookingStart || a.booking_start ||
                   (a.bookings && a.bookings[0] && a.bookings[0].timeStart) || '';
  const datePart = startStr.slice(0,10);
  const timePart = startStr.slice(11,16);

  const bookingList = Array.isArray(a.bookings) ? a.bookings : [];
  const customers = bookingList.map(b => b && b.customer).filter(Boolean);
  function fullName(c){
    return ((c.firstName || c.first_name || '') + ' ' + (c.lastName || c.last_name || '')).trim()
      || c.email || 'Ukendt gæst';
  }
  let name;
  if (customers.length === 0){
    name = a.customer ? fullName(a.customer) : 'Ukendt gæst';
  } else if (customers.length === 1){
    name = fullName(customers[0]);
  } else {
    name = fullName(customers[0]) + ' + ' + (customers.length - 1);
  }

  const svc = a.service || (a.bookings && a.bookings[0] && a.bookings[0].service) || {};
  const serviceName = svc.name || a.serviceName || '-';
  const id = a.id || a.bookingId || (a.bookings && a.bookings[0] && a.bookings[0].id) || '';

  // Amelia internal note ONLY. Don't fall back to other fields.
  const ameliaNote = (a.note || a.internalNotes || '').trim();

  const employee = a.employee ? ((a.employee.firstName || '') + ' ' + (a.employee.lastName || '')).trim() : '';

  return {
    _date: datePart,
    time: timePart,
    name: name,
    category: categorizeService(serviceName),
    orderId: String(id || '-'),
    item: serviceName,
    employee: employee || '-',
    notes: ameliaNote,
  };
}

function extractAppointments(json){
  // Amelia wraps payload in { data: { appointments: [...] } } usually.
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (json.data && Array.isArray(json.data.appointments)) return json.data.appointments;
  if (json.data && json.data.appointments && Array.isArray(json.data.appointments[todayKey()])) return json.data.appointments[todayKey()];
  if (json.data && json.data.appointments && typeof json.data.appointments === 'object'){
    return Object.values(json.data.appointments).flatMap(v => Array.isArray(v) ? v : (v && v.appointments) || []);
  }
  if (json.appointments) return Array.isArray(json.appointments) ? json.appointments : Object.values(json.appointments);
  return [];
}

function writeOutput(bookings){
  const out = '// Auto-generated by HOV-Monitor/scrape-bookings.js at ' + new Date().toISOString() + '\n' +
    '// Do not edit by hand. The scraper overwrites this file on every run.\n' +
    'window.HOV_BOOKINGS = ' + JSON.stringify(bookings, null, 2) + ';\n' +
    'window.HOV_DELIVERY_COUNT = ' + JSON.stringify(bookings.filter(b => /udlever|pickup|delivery/i.test(b.status)).length) + ';\n' +
    'window.HOV_BOOKINGS_UPDATED = ' + JSON.stringify(new Date().toISOString()) + ';\n';
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, out, 'utf8');
}

function writeRawDebug(payloads){
  try {
    fs.mkdirSync(path.dirname(RAW_DEBUG_FILE), { recursive: true });
    fs.writeFileSync(RAW_DEBUG_FILE, JSON.stringify({ at:new Date().toISOString(), payloads }, null, 2), 'utf8');
  } catch(e){}
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch(e){ fail(2, 'Playwright ikke installeret. Kor install.ps1.'); }

  // Ensure auth state exists; if not, log in.
  if (!fs.existsSync(AUTH_STATE_FILE)){
    try { await loginWp(chromium); }
    catch(e){ fail(2, 'Login fejlede: ' + e.message); }
  }

  const browser = await chromium.launch({ headless: true });
  let attempt = 0;
  let bookings = null;
  const capturedPayloads = [];

  while (attempt < 2 && !bookings){
    attempt++;
    const ctx = await browser.newContext({
      userAgent: config.userAgent,
      viewport: { width:1366, height:900 },
      storageState: AUTH_STATE_FILE,
    });
    const page = await ctx.newPage();

    page.on('response', async (resp) => {
      const url = resp.url();
      if (!/wpamelia/i.test(url) && !/amelia\/v1/i.test(url)) return;
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const data = await resp.json();
        capturedPayloads.push({ url, data });
      } catch(_) {}
    });

    try {
      await page.goto(config.site + '/wp-admin/admin.php?page=wpamelia-bookings#/appointments', {
        timeout: config.timeoutMs, waitUntil: 'domcontentloaded'
      });
    } catch(e){
      await ctx.close();
      continue;
    }

    if (page.url().includes('/wp-login.php')){
      // Auth expired . re-login and retry once.
      await ctx.close();
      if (attempt === 1){
        try { await loginWp(chromium); continue; }
        catch(e){ fail(2, 'Re-login fejlede: ' + e.message); }
      }
      break;
    }

    // Wait for Amelia API calls to settle.
    try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch(_) {}
    await page.waitForTimeout(2000);

    await ctx.close();

    // Find the payload that looks most like an appointments list.
    let allAppointments = [];
    for (const p of capturedPayloads){
      const ap = extractAppointments(p.data);
      if (ap && ap.length) allAppointments = allAppointments.concat(ap);
    }
    // De-dupe by id.
    const seen = new Set();
    allAppointments = allAppointments.filter(a => {
      const k = a.id || a.bookingId || JSON.stringify(a).slice(0,80);
      if (seen.has(k)) return false; seen.add(k); return true;
    });

    const today = todayKey();
    bookings = allAppointments
      .map(normalizeAppointment)
      .filter(b => b._date === today)
      .sort((a,b) => a.time.localeCompare(b.time))
      .map(({_date, ...rest}) => rest);
  }

  await browser.close();

  if (!bookings){
    writeRawDebug(capturedPayloads);
    fail(1, 'Kunne ikke faa fat i bookings. Raa payload gemt i ' + RAW_DEBUG_FILE);
  }

  // Always save raw payloads for debugging until the parser is proven.
  writeRawDebug(capturedPayloads);
  writeOutput(bookings);

  console.log(JSON.stringify({
    ok: true,
    count: bookings.length,
    updated: new Date().toISOString(),
    wrote: OUT_FILE
  }, null, 2));
})().catch((err) => {
  console.error('[scrape-bookings] crash: ' + (err && err.message || err));
  process.exit(2);
});
