// Detects new WooCommerce orders since last run and sends a Telegram notification
// per new order. Uses the WC REST API directly (drift.houseofvinterberg.com)
// with consumer key/secret - no browser auth, no Playwright.
//
// State: notified-orders.json (set of already-pushed order IDs).
// First run: populate set without pushing (avoid spamming about all existing).
//
// Required env vars:
//   WC_KEY + WC_SECRET                  WooCommerce REST API credentials
//   TELEGRAM_BOT_TOKEN                  Sales-bot token fra @BotFather
//   TELEGRAM_CHAT_ID                    Gruppe-ID for HOV Sales
//
// Usage: node check-orders.js
//        node check-orders.js --dry-run
//        node check-orders.js --force-push   (re-push for all current orders, testing)

const fs = require('fs');
const path = require('path');
const { notify } = require('./notifications');

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

const WC_BASE_URL = process.env.WC_BASE_URL || 'https://drift.houseofvinterberg.com';

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
  // WP backend lever på drift.houseofvinterberg.com efter Next.js-cutover.
  const url = WC_BASE_URL + '/wp-json/wc/v3/orders?' + params.toString();
  const auth = Buffer.from(key + ':' + secret).toString('base64');
  const res = await fetch(url, { headers: { Authorization: 'Basic ' + auth } });
  if (!res.ok) {
    throw new Error('REST orders ' + res.status + ': ' + (await res.text()).slice(0, 200));
  }
  return res.json();
}


(async () => {
  // WC REST API only. The previous Playwright/wp-admin fallback path required
  // a working WP login flow which became fragile after the Next.js cutover;
  // REST is the only contract we maintain now.
  let orders;
  const method = 'rest';
  try {
    orders = await fetchOrdersViaRest();
  } catch (e) {
    console.error('WC REST fejlede: ' + e.message);
    process.exit(1);
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
      const r = await notify({ title, message });
      sent.push({ id: o.id, customer: o.customer, total: o.total, via: r.sent, channelFailures: r.failed });
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
