// Detects new Amelia bookings since last run and pushes a Pushover alert per
// new booking. Designed to run alongside monitor.js (reuses auth-state.json).
//
// State: notified-bookings.json (set of already-pushed booking IDs).
// First run: populate set without pushing (avoid spamming about all existing).
// Subsequent runs: push only for IDs not in the set.
//
// Usage: node check-bookings.js
// Exit codes: 0 = success (with or without new bookings), 1 = recoverable, 2 = fatal.

const fs = require('fs');
const path = require('path');

(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) return;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    });
})();

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const AUTH_STATE_FILE = path.join(__dirname, 'auth-state.json');
const NOTIFIED_FILE = path.join(__dirname, 'notified-bookings.json');
const MAX_REMEMBERED_IDS = 500; // prune old IDs so the file does not grow forever
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_PUSH = process.argv.includes('--force-push'); // re-push for ALL current bookings (testing)

function loadNotified() {
  if (!fs.existsSync(NOTIFIED_FILE)) {
    return { initialized: false, ids: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8'));
  } catch (_) {
    return { initialized: false, ids: [], lastUpdated: null };
  }
}

function saveNotified(state) {
  state.lastUpdated = new Date().toISOString();
  state.ids = state.ids.slice(-MAX_REMEMBERED_IDS);
  fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(state, null, 2));
}

async function loginWp(chromium) {
  const wpUser = process.env.WP_USER || '';
  const wpPass = process.env.WP_PASS || '';
  if (!wpUser || !wpPass) throw new Error('WP_USER/WP_PASS mangler i miljoet');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: config.userAgent });
  const page = await ctx.newPage();
  try {
    await page.goto(config.site + '/wp-login.php', {
      timeout: config.timeoutMs,
      waitUntil: 'domcontentloaded',
    });
    await page.fill('#user_login', wpUser);
    await page.fill('#user_pass', wpPass);
    await Promise.all([
      page.waitForNavigation({ timeout: config.timeoutMs, waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.click('#wp-submit'),
    ]);
    if (!page.url().includes('/wp-admin/')) {
      throw new Error('Login mislykkedes - landede paa ' + page.url());
    }
    await ctx.storageState({ path: AUTH_STATE_FILE });
  } finally {
    await ctx.close();
    await browser.close();
  }
}

function extractAppointments(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (json.data && Array.isArray(json.data.appointments)) return json.data.appointments;
  if (json.data && json.data.appointments && typeof json.data.appointments === 'object') {
    return Object.values(json.data.appointments).flatMap((v) =>
      Array.isArray(v) ? v : (v && v.appointments) || []
    );
  }
  if (json.appointments) {
    return Array.isArray(json.appointments) ? json.appointments : Object.values(json.appointments);
  }
  return [];
}

function normalizeAppointment(a) {
  const startStr =
    a.bookingStartDateTime ||
    a.bookingStart ||
    a.booking_start ||
    (a.bookings && a.bookings[0] && a.bookings[0].timeStart) ||
    '';
  const datePart = startStr.slice(0, 10);
  const timePart = startStr.slice(11, 16);

  const bookingList = Array.isArray(a.bookings) ? a.bookings : [];
  const customers = bookingList.map((b) => b && b.customer).filter(Boolean);
  function fullName(c) {
    return (
      ((c.firstName || c.first_name || '') + ' ' + (c.lastName || c.last_name || '')).trim() ||
      c.email ||
      'Ukendt gaest'
    );
  }
  let name;
  if (customers.length === 0) name = a.customer ? fullName(a.customer) : 'Ukendt gaest';
  else if (customers.length === 1) name = fullName(customers[0]);
  else name = fullName(customers[0]) + ' + ' + (customers.length - 1);

  const svc = a.service || (a.bookings && a.bookings[0] && a.bookings[0].service) || {};
  const serviceName = svc.name || a.serviceName || '-';
  const id = a.id || a.bookingId || (a.bookings && a.bookings[0] && a.bookings[0].id) || '';
  const employee = a.employee
    ? ((a.employee.firstName || '') + ' ' + (a.employee.lastName || '')).trim()
    : '';

  return {
    id: String(id || ''),
    date: datePart,
    time: timePart,
    name,
    service: serviceName,
    employee: employee || null,
  };
}

function formatDanishDate(isoDate) {
  if (!isoDate || isoDate.length < 10) return isoDate;
  const months = [
    'januar', 'februar', 'marts', 'april', 'maj', 'juni',
    'juli', 'august', 'september', 'oktober', 'november', 'december',
  ];
  const d = new Date(isoDate + 'T00:00:00');
  return d.getDate() + '. ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function buildPushMessage(b) {
  const lines = [];
  if (b.date && b.time) {
    lines.push(formatDanishDate(b.date) + ' kl. ' + b.time);
  } else if (b.date) {
    lines.push(formatDanishDate(b.date));
  }
  if (b.name) lines.push(b.name);
  if (b.service && b.service !== '-') lines.push(b.service);
  if (b.employee) lines.push('Konsulent: ' + b.employee);
  return lines.join('\n');
}

async function sendPushover(title, message) {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;
  if (!user || !token) {
    throw new Error('PUSHOVER_USER/PUSHOVER_TOKEN ikke sat');
  }
  const params = new URLSearchParams({
    token,
    user,
    title,
    message,
    priority: '0', // normal priority (positive notification, not emergency)
    sound: 'cashregister', // cha-ching for new bookings
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
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    console.error('Playwright ikke installeret');
    process.exit(2);
  }

  if (!fs.existsSync(AUTH_STATE_FILE)) {
    try {
      await loginWp(chromium);
    } catch (e) {
      console.error('Login fejlede: ' + e.message);
      process.exit(2);
    }
  }

  const browser = await chromium.launch({ headless: true });
  let bookings = null;
  const captured = [];

  for (let attempt = 1; attempt <= 2 && !bookings; attempt++) {
    const ctx = await browser.newContext({
      userAgent: config.userAgent,
      viewport: { width: 1366, height: 900 },
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
        captured.push(data);
      } catch (_) {}
    });

    try {
      await page.goto(config.site + '/wp-admin/admin.php?page=wpamelia-bookings#/appointments', {
        timeout: config.timeoutMs,
        waitUntil: 'domcontentloaded',
      });
    } catch (_) {
      await ctx.close();
      continue;
    }

    if (page.url().includes('/wp-login.php')) {
      await ctx.close();
      if (attempt === 1) {
        try {
          await loginWp(chromium);
          continue;
        } catch (e) {
          console.error('Re-login fejlede: ' + e.message);
          process.exit(2);
        }
      }
      break;
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 12000 });
    } catch (_) {}
    await page.waitForTimeout(2000);
    await ctx.close();

    const all = [];
    for (const p of captured) {
      const ap = extractAppointments(p);
      if (ap && ap.length) all.push(...ap);
    }
    const seenIds = new Set();
    bookings = all
      .map(normalizeAppointment)
      .filter((b) => b.id && !seenIds.has(b.id) && (seenIds.add(b.id), true))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }

  await browser.close();

  if (!bookings) {
    console.error('Kunne ikke faa fat i bookings');
    process.exit(1);
  }

  const state = loadNotified();
  const known = new Set(state.ids);
  const currentIds = bookings.map((b) => b.id);

  if (!state.initialized && !FORCE_PUSH) {
    // First run - populate set without pushing, to avoid spamming all existing.
    state.initialized = true;
    state.ids = currentIds;
    saveNotified(state);
    console.log(JSON.stringify({
      ok: true,
      mode: 'first-run-init',
      tracked: currentIds.length,
      pushed: 0,
    }, null, 2));
    process.exit(0);
  }

  const newOnes = FORCE_PUSH ? bookings : bookings.filter((b) => !known.has(b.id));
  const sent = [];
  const failed = [];

  for (const b of newOnes) {
    const message = buildPushMessage(b);
    if (DRY_RUN) {
      sent.push({ id: b.id, title: 'Ny booking', message });
      continue;
    }
    try {
      await sendPushover('Ny booking', message);
      sent.push({ id: b.id, name: b.name, time: b.date + ' ' + b.time });
      state.ids.push(b.id);
    } catch (e) {
      failed.push({ id: b.id, error: e.message });
    }
  }

  // Always update the set (even if no new pushes) so we keep track of current IDs.
  if (!FORCE_PUSH && !DRY_RUN) {
    for (const id of currentIds) if (!state.ids.includes(id)) state.ids.push(id);
    saveNotified(state);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: DRY_RUN ? 'dry-run' : (FORCE_PUSH ? 'force-push' : 'normal'),
    totalBookings: bookings.length,
    newPushed: sent.length,
    failedToPush: failed.length,
    pushed: sent,
    failures: failed,
  }, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error('check-bookings crash: ' + (err && err.message || err));
  process.exit(2);
});
