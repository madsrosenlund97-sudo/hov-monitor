// Detects new bookings from the new admin (Next.js + Basic Auth, behind Vercel
// Bot Protection) and pushes a Pushover alert per new booking.
//
// Replaces the old Amelia/WordPress version. Same state machine: tracks already-
// pushed IDs in notified-bookings.json. First run populates the set without
// pushing (avoid spam on existing). Subsequent runs push only for fresh IDs.
//
// Required env vars:
//   VERCEL_BYPASS_SECRET   Vercel Protection Bypass for Automation secret
//   ADMIN_USER             Basic-Auth username (mads@houseofvinterberg.com)
//   ADMIN_PASS             Basic-Auth password
//   PUSHOVER_USER          Pushover user key
//   PUSHOVER_TOKEN         Pushover app token (booking app)
//
// Flags: --dry-run, --force-push (testing)

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

const BASE = 'https://houseofvinterberg-frontend.vercel.app';
const ADMIN_URL = BASE + '/admin/bookings';
const NOTIFIED_FILE = path.join(__dirname, 'notified-bookings.json');
const MAX_REMEMBERED_IDS = 500;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_PUSH = process.argv.includes('--force-push');
const USER_AGENT = 'Mozilla/5.0 (HOV-Monitor) AppleWebKit/537.36';

const DA_MONTHS = { jan:0, feb:1, mar:2, apr:3, maj:4, jun:5, jul:6, aug:7, sep:8, okt:9, nov:10, dec:11 };

function parseBookingDate(s, baseYear){
  const m = s.match(/(\d{1,2})\.\s+([a-zæøå]+)\.?,?\s+(\d{1,2})[.:](\d{2})/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthAbbr = m[2].slice(0,3).toLowerCase();
  const month = DA_MONTHS[monthAbbr];
  if (month === undefined) return null;
  const hour = parseInt(m[3], 10);
  const minute = parseInt(m[4], 10);
  let year = baseYear;
  const now = new Date();
  if (month < now.getMonth()) year = baseYear + 1;
  return new Date(year, month, day, hour, minute);
}

function splitCustomer(text){
  const emailIdx = text.search(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (emailIdx === -1) return { name: text.trim(), email: '', phone: '' };
  const name = text.slice(0, emailIdx).trim();
  const rest = text.slice(emailIdx);
  const phoneMatch = rest.match(/\+?\d[\d\s]{6,}/);
  const phone = phoneMatch ? phoneMatch[0].trim() : '';
  const email = rest.replace(phone, '').replace(/[·•]/g, '').trim();
  return { name, email, phone };
}

function loadNotified(){
  if (!fs.existsSync(NOTIFIED_FILE)) return { initialized: false, ids: [], lastUpdated: null };
  try { return JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8')); }
  catch(_){ return { initialized: false, ids: [], lastUpdated: null }; }
}

function saveNotified(state){
  state.lastUpdated = new Date().toISOString();
  state.ids = state.ids.slice(-MAX_REMEMBERED_IDS);
  fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(state, null, 2));
}

function formatDanishDateTime(dt){
  const dayNames = ['søn','man','tirs','ons','tors','fre','lør'];
  const monthNames = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
  return `${dayNames[dt.getDay()]}. ${dt.getDate()}. ${monthNames[dt.getMonth()]} kl. ${String(dt.getHours()).padStart(2,'0')}.${String(dt.getMinutes()).padStart(2,'0')}`;
}

function buildPushMessage(b){
  const lines = [];
  lines.push(formatDanishDateTime(b.dt));
  lines.push(b.service);
  if (b.customerName) lines.push(b.customerName);
  return lines.join('\n');
}

async function sendPushover(title, message){
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;
  if (!user || !token) throw new Error('PUSHOVER_USER/PUSHOVER_TOKEN ikke sat');
  const params = new URLSearchParams({
    token, user, title, message,
    priority: '0',
    sound: 'magic',
  });
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Pushover ' + res.status + ': ' + txt.slice(0, 200));
  }
}

(async () => {
  const bypass = process.env.VERCEL_BYPASS_SECRET || '';
  const user = process.env.ADMIN_USER || '';
  const pass = process.env.ADMIN_PASS || '';
  if (!bypass || !user || !pass) {
    console.error('Mangler VERCEL_BYPASS_SECRET / ADMIN_USER / ADMIN_PASS');
    process.exit(2);
  }

  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch(_){ console.error('Playwright ikke installeret'); process.exit(2); }

  const basicAuth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const browser = await chromium.launch({ headless: true });
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

  let rows;
  try {
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => ({
          text: td.textContent.trim(),
          href: td.querySelector('a') ? td.querySelector('a').href : null,
        }));
        return cells;
      });
    });
  } finally {
    await ctx.close();
    await browser.close();
  }

  // Parse alle rows. Vi tager ALLE statuser (også cancelled) i ID-tracking-settet
  // så vi ikke gen-pusher en booking der senere bliver aflyst og dukker op igen.
  const allBookings = [];
  const now = new Date();
  for (const cells of rows) {
    if (cells.length < 6) continue;
    const dateStr = cells[0].text;
    const service = cells[1].text;
    const detailHref = cells[1].href || '';
    const id = detailHref ? detailHref.split('/').pop() : '';
    if (!id) continue;
    const customerText = cells[2].text;
    const status = cells[5].text.toLowerCase();
    const dt = parseBookingDate(dateStr, now.getFullYear());
    if (!dt) continue;
    const cust = splitCustomer(customerText);
    allBookings.push({
      id,
      dt,
      service,
      status,
      customerName: cust.name || 'Ukendt gæst',
    });
  }

  const state = loadNotified();
  const known = new Set(state.ids);
  const fresh = allBookings.filter(b => !known.has(b.id));

  // Notifikation kun for "confirmed" (skip cancelled/completed historik)
  const toPush = fresh.filter(b => b.status === 'confirmed');

  const result = {
    ok: true,
    initialized: state.initialized,
    rowsExamined: rows.length,
    bookingsSeen: allBookings.length,
    newSeen: fresh.length,
    toPush: toPush.length,
    pushed: [],
    failures: [],
  };

  if (!state.initialized && !FORCE_PUSH) {
    // First run: don't push, just record everything as "already seen"
    state.initialized = true;
    state.ids = Array.from(new Set([...state.ids, ...allBookings.map(b => b.id)]));
    saveNotified(state);
    result.firstRun = true;
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const pushList = FORCE_PUSH ? allBookings.filter(b => b.status === 'confirmed') : toPush;
  for (const b of pushList) {
    const title = 'Ny booking: ' + b.service;
    const msg = buildPushMessage(b);
    if (DRY_RUN) {
      result.pushed.push({ id: b.id, title, message: msg, dryRun: true });
      continue;
    }
    try {
      await sendPushover(title, msg);
      result.pushed.push({ id: b.id, title });
    } catch(e){
      result.failures.push({ id: b.id, error: e.message });
    }
  }

  // Persistér ALLE sete IDs (også cancelled) for at undgå re-push hvis status flipper
  state.ids = Array.from(new Set([...state.ids, ...allBookings.map(b => b.id)]));
  saveNotified(state);

  console.log(JSON.stringify(result, null, 2));
})().catch(err => {
  console.error('crash: ' + (err && err.message || err));
  process.exit(2);
});
