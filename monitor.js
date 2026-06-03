const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency). Reads KEY=VALUE pairs into process.env.
(function loadEnvFile(){
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

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const simulateFail = process.argv.includes('--simulate-fail');

function shouldIgnoreConsole(text) {
  const lower = text.toLowerCase();
  return config.ignoredConsoleErrors.some((needle) =>
    lower.includes(needle.toLowerCase())
  );
}

/**
 * Tjekker om en first-party HTTP-fejl skal ignoreres baseret på URL+status.
 * Bruges til at filtrere kendte ikke-kritiske 4xx'er (fx admin-ajax 403)
 * fra alert-strømmen. Hver regel skal matche BÅDE urlIncludes OG status
 * (hvis status er sat) for at filtere — så vi ikke utilsigtet skjuler
 * admin-ajax 500'er der faktisk er kritiske.
 *
 * Eksempel-regel:
 *   { "urlIncludes": "/wp-admin/admin-ajax.php", "status": 403 }
 * Match: en 403 på en URL der indeholder "/wp-admin/admin-ajax.php" → ignorér.
 * Ingen match: en 500 på samme URL → stadig alert.
 */
function shouldIgnoreFirstPartyError(url, status) {
  if (!Array.isArray(config.ignoredFirstPartyErrors)) return false;
  const lower = url.toLowerCase();
  return config.ignoredFirstPartyErrors.some((rule) => {
    if (typeof rule.status === 'number' && status !== rule.status) return false;
    if (
      typeof rule.urlIncludes === 'string' &&
      !lower.includes(rule.urlIncludes.toLowerCase())
    ) {
      return false;
    }
    return true;
  });
}

async function checkPage(browser, pageConfig) {
  // Use language-appropriate Accept-Language header so the Next.js site does
  // not redirect Danish pages to /en/ when the runner defaults to en-US.
  const isEnglishPath = pageConfig.path.startsWith('/en/') || pageConfig.path === '/en';
  const acceptLanguage = isEnglishPath ? 'en-US,en;q=0.9' : 'da-DK,da;q=0.9,en;q=0.5';
  const ctxOpts = {
    userAgent: config.userAgent,
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: false,
    locale: isEnglishPath ? 'en-US' : 'da-DK',
    extraHTTPHeaders: { 'Accept-Language': acceptLanguage },
  };
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  const jsErrors = [];           // real JS exceptions (not resource load failures)
  const firstPartyHttpErrors = []; // 4xx + 5xx subrequest responses from our own domain
  const thirdPartyServerErrors = []; // 5xx only from third parties (4xx is usually noise)
  const networkFailures = [];    // ERR_FAILED, ERR_NAME_NOT_RESOLVED etc - NOT ERR_ABORTED
  const siteOrigin = new URL(config.site).origin;

  // Browser noise message ("Failed to load resource: 404") - we already capture
  // the real URL + status via the response handler, so ignore this redundant signal.
  const RESOURCE_LOAD_NOISE = /Failed to load resource:/i;

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (RESOURCE_LOAD_NOISE.test(text)) return;
    if (shouldIgnoreConsole(text)) return;
    jsErrors.push(text);
  });

  page.on('pageerror', (err) => {
    const text = err.message || String(err);
    if (!shouldIgnoreConsole(text)) jsErrors.push('uncaught: ' + text);
  });

  page.on('requestfailed', (req) => {
    const url = req.url();
    if (shouldIgnoreConsole(url)) return;
    const reason = req.failure() ? req.failure().errorText : 'unknown';
    // ERR_ABORTED is almost always Playwright tearing down the page while
    // background trackers are still firing - it is not a site bug.
    if (reason === 'net::ERR_ABORTED') return;
    networkFailures.push({ url, reason });
  });

  page.on('response', (resp) => {
    const status = resp.status();
    const url = resp.url();
    if (status < 400) return;
    if (shouldIgnoreConsole(url)) return;
    const isFirstParty = url.startsWith(siteOrigin);
    if (isFirstParty) {
      // Filtrér kendte ikke-kritiske first-party 4xx'er (admin-ajax 403,
      // wc-ajax 403 osv.) væk så vi kun alerter på reelle problemer.
      // Status-specifik regel — en 500 på samme URL bliver IKKE filtreret.
      if (shouldIgnoreFirstPartyError(url, status)) return;
      firstPartyHttpErrors.push({ url, status });
    } else if (status >= 500) {
      thirdPartyServerErrors.push({ url, status });
    }
  });

  const url = config.site + pageConfig.path;
  const start = Date.now();
  let response = null;
  let navError = null;

  try {
    response = await page.goto(url, {
      timeout: config.timeoutMs,
      waitUntil: 'domcontentloaded',
    });
    // Vent på reel content (h1 eller body med text) i stedet for kun
    // networkidle — 3rd-party scripts (Cookiebot, GTM, Klaviyo) holder
    // networkidle blokeret længere end 8s, hvilket forhindrer body-text
    // check i at se renderet content. Selector-wait fanger renderet
    // content uden at hænge på 3rd-party requests.
    await page
      .waitForSelector('h1, h2, [role="heading"]', { timeout: 10000 })
      .catch(() => {});
    // Sekundær networkidle-wait med højere timeout (15s) som safety-net
    // for sider uden heading-selector. Cookiebot+GTM+Klaviyo har behov
    // for 10-13s i praksis før networkidle nås.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  } catch (e) {
    navError = e.message;
  }

  const loadMs = Date.now() - start;
  const status = response ? response.status() : null;

  let bodyText = '';
  const missingTerms = [];
  const missingSelectors = [];
  let title = '';

  if (!navError && response && response.ok()) {
    try {
      title = await page.title();
    } catch (_) {}
    try {
      bodyText = (await page.textContent('body')) || '';
    } catch (_) {}

    // Selector checks: a page may render with the right text but missing a
    // critical UI element (booking calendar, product grid, etc). Verify each
    // selector resolves to a real, visible element.
    for (const sel of pageConfig.mustHaveSelector || []) {
      const found = await page
        .waitForSelector(sel, { state: 'attached', timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!found) missingSelectors.push(sel);
    }

    let haystack = (title + ' ' + bodyText).toLowerCase();
    for (const term of pageConfig.mustContain || []) {
      if (haystack.includes(term.toLowerCase())) continue;
      // Retry-on-miss: term ikke fundet ved første læsning. Måske er
      // content lazily renderet eller scripts ikke færdige med at
      // skrive til DOM. Vent op til 5s på at term dukker op via
      // waitForFunction. Kun ved den faktiske miss → ingen ekstra
      // venten for sider hvor alle terms findes med det samme.
      const found = await page
        .waitForFunction(
          (t) =>
            (document.body?.innerText || '').toLowerCase().includes(t),
          term.toLowerCase(),
          { timeout: 5000 }
        )
        .then(() => true)
        .catch(() => false);
      if (!found) {
        missingTerms.push(term);
      } else {
        // Refresh haystack med post-wait body så efterfølgende terms
        // også kan matche uden ekstra retry-runder.
        try {
          bodyText = (await page.textContent('body')) || '';
          haystack = (title + ' ' + bodyText).toLowerCase();
        } catch (_) {}
      }
    }
  }

  await context.close();

  function shortUrl(u) {
    return u.length > 110 ? u.slice(0, 107) + '...' : u;
  }

  const problems = [];
  if (navError) problems.push('Navigation fejlede: ' + navError);
  if (status !== null && status >= 400)
    problems.push('HTTP ' + status + ' returneret');
  const pageMaxLoadMs = pageConfig.maxLoadMs || config.maxLoadMs;
  if (!navError && loadMs > pageMaxLoadMs)
    problems.push(
      'Langsom load: ' +
        (loadMs / 1000).toFixed(1) +
        's (max ' +
        (pageMaxLoadMs / 1000).toFixed(0) +
        's)'
    );
  if (missingTerms.length)
    problems.push('Manglende indhold paa siden: ' + missingTerms.join(', '));
  if (missingSelectors.length)
    problems.push('Manglende UI-element: ' + missingSelectors.join(', '));
  if (firstPartyHttpErrors.length) {
    const sample = firstPartyHttpErrors
      .slice(0, 3)
      .map((e) => e.status + ' ' + shortUrl(e.url))
      .join(' | ');
    problems.push(
      firstPartyHttpErrors.length +
        ' fejlede subrequests fra siden selv: ' +
        sample
    );
  }
  if (thirdPartyServerErrors.length) {
    const sample = thirdPartyServerErrors
      .slice(0, 2)
      .map((e) => e.status + ' ' + shortUrl(e.url))
      .join(' | ');
    problems.push(
      thirdPartyServerErrors.length + ' 5xx fra tredjepart: ' + sample
    );
  }
  if (jsErrors.length)
    problems.push(
      'JS-fejl (' + jsErrors.length + '): ' + jsErrors.slice(0, 3).join(' | ')
    );
  if (networkFailures.length > 3)
    problems.push(
      networkFailures.length +
        ' netvaerksfejl (ikke-aborted): ' +
        networkFailures
          .slice(0, 2)
          .map((f) => f.reason + ' ' + shortUrl(f.url))
          .join(' | ')
    );

  return {
    url,
    ok: problems.length === 0,
    status,
    title,
    loadMs,
    problems,
    jsErrors: jsErrors.slice(0, 5),
    firstPartyHttpErrors: firstPartyHttpErrors.slice(0, 10),
    thirdPartyServerErrors: thirdPartyServerErrors.slice(0, 5),
    networkFailures: networkFailures.slice(0, 5),
    navError,
  };
}

(async () => {
  if (simulateFail) {
    const output = {
      timestamp: new Date().toISOString(),
      ok: false,
      simulated: true,
      results: [
        {
          url: config.site + '/',
          ok: false,
          status: 503,
          loadMs: 99999,
          problems: ['SIMULERET FEJL - testkoersel af alert-systemet'],
        },
      ],
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.log(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          ok: false,
          fatal: true,
          error:
            'Playwright er ikke installeret. Koer install.ps1 (eller npm install + npx playwright install chromium).',
        },
        null,
        2
      )
    );
    process.exit(2);
  }
  const browser = await chromium.launch({ headless: true });
  const concurrency = Math.max(1, Math.min(config.concurrency || 1, config.pages.length));
  const results = new Array(config.pages.length);
  try {
    let next = 0;
    async function worker() {
      while (next < config.pages.length) {
        const i = next++;
        results[i] = await checkPage(browser, config.pages[i]);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    await browser.close();
  }

  const allOk = results.every((r) => r.ok);
  const output = {
    timestamp: new Date().toISOString(),
    ok: allOk,
    results,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  const output = {
    timestamp: new Date().toISOString(),
    ok: false,
    fatal: true,
    error: 'Monitor crashed: ' + (err.message || String(err)),
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(2);
});
