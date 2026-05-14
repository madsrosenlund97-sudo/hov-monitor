// One-off site-wide audit. Pulls URLs from sitemap, renders each page with
// Playwright, and reports first-party 4xx/5xx subrequests + uncaught JS errors.
//
// Usage:
//   node audit.js                 // pages + posts + 20 sampled products
//   node audit.js --all-products  // adds all 644 products (slow)
//   node audit.js --only=/booking,/galleri  // restrict to specific paths
//
// Output: audit-report.json (full data) + human-readable summary on stdout.

const { chromium } = require('playwright');
const fs = require('fs');

const SITE = 'https://houseofvinterberg.com';
const ORIGIN = new URL(SITE).origin;
const CONCURRENCY = 5;

const IGNORED = [
  'favicon', 'gtag', 'google-analytics', 'googletagmanager',
  'googlesyndication', 'pagead2', 'doubleclick', 'googleadservices',
  'facebook.net', 'facebook.com/tr', 'connect.facebook.net',
  'hotjar', 'klaviyo', 'robots.txt', 'tiktok', 'snap.licdn',
  'bing.com', 'bat.bing', 'linkedin.com/li/track',
];

function shouldIgnore(url) {
  const lower = url.toLowerCase();
  return IGNORED.some((n) => lower.includes(n));
}

async function fetchUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(sitemapUrl + ' -> ' + res.status);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

function pickSample(arr, n) {
  const out = [];
  const step = Math.max(1, Math.floor(arr.length / n));
  for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]);
  return out;
}

async function buildUrlList(opts) {
  const index = await fetchUrls(SITE + '/sitemap_index.xml');
  const subUrls = {};
  for (const sm of index) {
    const key = sm.split('/').pop().replace('-sitemap.xml', '').replace('-sitemap1.xml', '').replace('.xml', '');
    if (!subUrls[key]) subUrls[key] = [];
    subUrls[key].push(...(await fetchUrls(sm)));
  }

  const urls = new Set();
  const collect = (key) => (subUrls[key] || []).forEach((u) => urls.add(u));
  collect('page');
  collect('post');
  collect('wffn_ty');
  collect('wfacp_checkout');
  collect('local');

  const allProducts = [
    ...(subUrls['product1'] || []),
    ...(subUrls['product2'] || []),
    ...(subUrls['product3'] || []),
    ...(subUrls['product4'] || []),
    ...(subUrls['product'] || []),
  ];

  if (opts.allProducts) {
    allProducts.forEach((u) => urls.add(u));
  } else {
    pickSample(allProducts, 20).forEach((u) => urls.add(u));
  }

  let list = [...urls];
  if (opts.only) {
    const filters = opts.only.split(',');
    list = list.filter((u) => filters.some((f) => u.includes(f)));
  }
  return list;
}

async function auditPage(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (HOV-Audit) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/Headless',
  });
  const page = await context.newPage();

  const firstPartyHttpErrors = [];
  const thirdPartyServerErrors = [];
  const jsErrors = [];

  page.on('response', (resp) => {
    const s = resp.status();
    const u = resp.url();
    if (s < 400) return;
    if (shouldIgnore(u)) return;
    const fp = u.startsWith(ORIGIN);
    if (fp) firstPartyHttpErrors.push({ url: u, status: s });
    else if (s >= 500) thirdPartyServerErrors.push({ url: u, status: s });
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource:/i.test(text)) return;
    if (shouldIgnore(text)) return;
    jsErrors.push(text);
  });
  page.on('pageerror', (err) => {
    const text = err.message || String(err);
    if (!shouldIgnore(text)) jsErrors.push('uncaught: ' + text);
  });

  let pageStatus = null;
  let navError = null;
  const start = Date.now();
  try {
    const resp = await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
    pageStatus = resp ? resp.status() : null;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (e) {
    navError = e.message;
  }
  const loadMs = Date.now() - start;

  await context.close();

  return {
    url,
    pageStatus,
    loadMs,
    navError,
    firstPartyHttpErrors,
    thirdPartyServerErrors,
    jsErrors,
  };
}

async function runInPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;

  async function pull() {
    while (next < total) {
      const i = next++;
      const item = items[i];
      const r = await worker(item);
      results[i] = r;
      done++;
      process.stderr.write(
        '[' + done + '/' + total + '] ' +
        (r.firstPartyHttpErrors.length || r.jsErrors.length || r.navError || (r.pageStatus && r.pageStatus >= 400)
          ? 'X'
          : '.') + ' ' + item + '\n'
      );
    }
  }
  await Promise.all(Array.from({ length: concurrency }, pull));
  return results;
}

function summarize(results) {
  const pagesWithIssues = results.filter(
    (r) =>
      r.navError ||
      (r.pageStatus && r.pageStatus >= 400) ||
      r.firstPartyHttpErrors.length ||
      r.jsErrors.length
  );

  const assetCounts = new Map(); // missing URL -> pages that reference it
  for (const r of results) {
    for (const e of r.firstPartyHttpErrors) {
      const key = e.status + ' ' + e.url;
      if (!assetCounts.has(key)) assetCounts.set(key, []);
      assetCounts.get(key).push(r.url);
    }
  }

  return { pagesWithIssues, assetCounts };
}

function fmt(r) {
  const issues = [];
  if (r.navError) issues.push('navError: ' + r.navError);
  if (r.pageStatus && r.pageStatus >= 400) issues.push('HTTP ' + r.pageStatus);
  if (r.firstPartyHttpErrors.length) issues.push(r.firstPartyHttpErrors.length + ' first-party 4xx/5xx');
  if (r.jsErrors.length) issues.push(r.jsErrors.length + ' JS errors');
  return issues.join(', ');
}

(async () => {
  const opts = {
    allProducts: process.argv.includes('--all-products'),
    only: process.argv.find((a) => a.startsWith('--only='))?.slice(7),
  };

  console.error('Fetching sitemaps...');
  const urls = await buildUrlList(opts);
  console.error('Auditing ' + urls.length + ' URLs (concurrency=' + CONCURRENCY + ')...');

  const browser = await chromium.launch({ headless: true });
  const t0 = Date.now();
  let results;
  try {
    results = await runInPool(urls, CONCURRENCY, (u) => auditPage(browser, u));
  } finally {
    await browser.close();
  }
  const duration = ((Date.now() - t0) / 1000).toFixed(1);

  fs.writeFileSync('audit-report.json', JSON.stringify({ scannedAt: new Date().toISOString(), durationSec: +duration, urls: urls.length, results }, null, 2));

  const { pagesWithIssues, assetCounts } = summarize(results);

  console.log('');
  console.log('===========================================');
  console.log('HOV site audit  -  ' + duration + 's  -  ' + urls.length + ' URLs');
  console.log('===========================================');
  console.log('Pages with issues: ' + pagesWithIssues.length + ' / ' + results.length);
  console.log('Unique broken assets referenced: ' + assetCounts.size);
  console.log('');

  if (pagesWithIssues.length) {
    console.log('--- Pages with issues ---');
    for (const r of pagesWithIssues) {
      console.log('');
      console.log('X  ' + r.url);
      console.log('   ' + fmt(r));
      if (r.firstPartyHttpErrors.length) {
        for (const e of r.firstPartyHttpErrors.slice(0, 8)) {
          console.log('     ' + e.status + ' ' + e.url);
        }
        if (r.firstPartyHttpErrors.length > 8) {
          console.log('     ... (' + (r.firstPartyHttpErrors.length - 8) + ' flere)');
        }
      }
      if (r.jsErrors.length) {
        for (const e of r.jsErrors.slice(0, 3)) {
          console.log('     js: ' + e.slice(0, 180));
        }
      }
    }
  }

  if (assetCounts.size) {
    console.log('');
    console.log('--- Top broken assets (by page-count) ---');
    const sorted = [...assetCounts.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 30);
    for (const [key, pages] of sorted) {
      console.log(pages.length + 'x  ' + key);
      if (pages.length <= 3) {
        for (const p of pages) console.log('     on: ' + p);
      } else {
        console.log('     on: ' + pages.slice(0, 2).join(', ') + ' (+ ' + (pages.length - 2) + ' flere)');
      }
    }
  }

  console.log('');
  console.log('Full data in audit-report.json');
})().catch((err) => {
  console.error('FATAL:', err.stack || err.message || err);
  process.exit(1);
});
