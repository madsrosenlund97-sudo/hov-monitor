// Detects new WooCommerce orders since last run and pushes a Pushover alert
// per new order. Runs alongside check-bookings.js (reuses auth-state.json).
//
// State: notified-orders.json (set of already-pushed order IDs).
// First run: populate set without pushing (avoid spamming about all existing).
//
// Usage: node check-orders.js
//        node check-orders.js --dry-run
//        node check-orders.js --force-push   (re-push for all current orders, testing)

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
const NOTIFIED_FILE = path.join(__dirname, 'notified-orders.json');
const MAX_REMEMBERED_IDS = 1000;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_PUSH = process.argv.includes('--force-push');

// Statuses we care about. Skip 'pending' (cart abandonment), 'failed', 'cancelled', 'refunded', 'trash'.
const NOTIFY_STATUSES = ['processing', 'completed', 'on-hold'];

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

function formatDanishMoney(amount, currency) {
  // amount comes as string from WC, eg "1250.00"
  const n = parseFloat(amount);
  if (isNaN(n)) return amount + ' ' + (currency || '');
  const formatted = n
    .toFixed(n % 1 === 0 ? 0 : 2)
    .replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cur = (currency || 'DKK').toUpperCase();
  return formatted + ' ' + (cur === 'DKK' ? 'kr' : cur);
}

function normalizeOrder(o) {
  const billing = o.billing || {};
  const fullName =
    ((billing.first_name || '') + ' ' + (billing.last_name || '')).trim() ||
    billing.email ||
    'Ukendt kunde';
  const items = Array.isArray(o.line_items) ? o.line_items : [];
  const itemCount = items.reduce((sum, it) => sum + (parseInt(it.quantity, 10) || 0), 0);
  const itemNames = items.map((it) => it.name).filter(Boolean);
  return {
    id: String(o.id),
    number: o.number || String(o.id),
    status: o.status,
    total: o.total,
    currency: o.currency || 'DKK',
    customer: fullName,
    itemCount,
    itemNames,
    dateCreated: o.date_created,
  };
}

function buildPushMessage(o) {
  const lines = [];
  lines.push(formatDanishMoney(o.total, o.currency));
  if (o.customer) lines.push(o.customer);
  if (o.itemCount > 0) {
    const head = o.itemNames[0] || '';
    if (o.itemCount === 1 || o.itemNames.length === 1) {
      lines.push(o.itemCount + ' vare' + (o.itemCount === 1 ? '' : 'r') + (head ? ': ' + head : ''));
    } else {
      const more = o.itemCount - 1;
      lines.push(o.itemCount + ' varer: ' + head + ' +' + more);
    }
  }
  return lines.join('\n');
}

async function sendPushover(title, message) {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;
  if (!user || !token) throw new Error('PUSHOVER_USER/PUSHOVER_TOKEN ikke sat');
  const params = new URLSearchParams({
    token,
    user,
    title,
    message,
    priority: '0',
    sound: 'cashregister',
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

async function fetchOrdersViaRest() {
  // WooCommerce REST API with consumer key/secret (HTTP Basic Auth).
  // Cookie auth does NOT work for WC REST - must use dedicated API keys.
  const key = process.env.WC_KEY;
  const secret = process.env.WC_SECRET;
  if (!key || !secret) {
    throw new Error('WC_KEY/WC_SECRET mangler - opret API-nogle i WooCommerce -> Settings -> Advanced -> REST API');
  }
  const params = new URLSearchParams({
    per_page: '30',
    orderby: 'date',
    order: 'desc',
    status: NOTIFY_STATUSES.join(','),
  });
  const url = config.site + '/wp-json/wc/v3/orders?' + params.toString();
  const auth = Buffer.from(key + ':' + secret).toString('base64');
  const res = await fetch(url, { headers: { Authorization: 'Basic ' + auth } });
  if (!res.ok) {
    throw new Error('REST orders ' + res.status + ': ' + (await res.text()).slice(0, 200));
  }
  return res.json();
}

async function fetchOrdersViaAdminXhr(page) {
  // Fallback: visit wp-admin orders page and capture XHR responses.
  const captured = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/wc-orders|shop_order|wc\/v3\/orders/i.test(url)) return;
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data = await resp.json();
      captured.push(data);
    } catch (_) {}
  });
  await page.goto(config.site + '/wp-admin/admin.php?page=wc-orders', {
    timeout: config.timeoutMs,
    waitUntil: 'domcontentloaded',
  });
  try {
    await page.waitForLoadState('networkidle', { timeout: 12000 });
  } catch (_) {}
  await page.waitForTimeout(2000);

  // Flatten captured payloads to an array of orders
  const all = [];
  for (const p of captured) {
    if (Array.isArray(p)) all.push(...p);
    else if (p && Array.isArray(p.data)) all.push(...p.data);
    else if (p && p.orders) all.push(...(Array.isArray(p.orders) ? p.orders : []));
  }
  return all.filter((o) => o && o.id);
}

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    console.error('Playwright ikke installeret');
    process.exit(2);
  }

  // WC REST API uses dedicated consumer key/secret - no Playwright needed.
  let orders = null;
  let method = 'rest';
  try {
    orders = await fetchOrdersViaRest();
  } catch (e) {
    // Fall back to wp-admin XHR scraping if REST is unavailable
    if (!chromium) {
      console.error('REST fejlede og Playwright ikke tilgaengelig: ' + e.message);
      process.exit(2);
    }
    if (!fs.existsSync(AUTH_STATE_FILE)) {
      try { await loginWp(chromium); }
      catch (e2) { console.error('Login fejlede: ' + e2.message); process.exit(2); }
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({ userAgent: config.userAgent, storageState: AUTH_STATE_FILE });
      const page = await ctx.newPage();
      orders = await fetchOrdersViaAdminXhr(page);
      method = 'xhr';
      await ctx.close();
    } catch (e2) {
      console.error('Begge order-fetch metoder fejlede. REST: ' + e.message + ' / XHR: ' + e2.message);
      await browser.close();
      process.exit(1);
    }
    await browser.close();
  }

  if (!orders) {
    console.error('Kunne ikke hente orders');
    process.exit(1);
  }

  const normalized = orders
    .map(normalizeOrder)
    .filter((o) => NOTIFY_STATUSES.includes(o.status));

  const state = loadNotified();
  const known = new Set(state.ids);
  const currentIds = normalized.map((o) => o.id);

  if (!state.initialized && !FORCE_PUSH) {
    state.initialized = true;
    state.ids = currentIds;
    saveNotified(state);
    console.log(JSON.stringify({
      ok: true,
      mode: 'first-run-init',
      method,
      tracked: currentIds.length,
      pushed: 0,
    }, null, 2));
    process.exit(0);
  }

  const newOnes = FORCE_PUSH ? normalized : normalized.filter((o) => !known.has(o.id));
  const sent = [];
  const failed = [];

  for (const o of newOnes) {
    const message = buildPushMessage(o);
    const title = 'Nyt salg #' + o.number;
    if (DRY_RUN) {
      sent.push({ id: o.id, title, message });
      continue;
    }
    try {
      await sendPushover(title, message);
      sent.push({ id: o.id, customer: o.customer, total: o.total });
      state.ids.push(o.id);
    } catch (e) {
      failed.push({ id: o.id, error: e.message });
    }
  }

  if (!FORCE_PUSH && !DRY_RUN) {
    for (const id of currentIds) if (!state.ids.includes(id)) state.ids.push(id);
    saveNotified(state);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: DRY_RUN ? 'dry-run' : (FORCE_PUSH ? 'force-push' : 'normal'),
    method,
    totalOrders: normalized.length,
    newPushed: sent.length,
    failedToPush: failed.length,
    pushed: sent,
    failures: failed,
  }, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error('check-orders crash: ' + (err && err.message || err));
  process.exit(2);
});
