const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const simulateFail = process.argv.includes('--simulate-fail');

function shouldIgnoreConsole(text) {
  const lower = text.toLowerCase();
  return config.ignoredConsoleErrors.some((needle) =>
    lower.includes(needle.toLowerCase())
  );
}

async function checkPage(browser, pageConfig) {
  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: false,
  });
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
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (e) {
    navError = e.message;
  }

  const loadMs = Date.now() - start;
  const status = response ? response.status() : null;

  let bodyText = '';
  const missingTerms = [];
  let title = '';

  if (!navError && response && response.ok()) {
    try {
      title = await page.title();
    } catch (_) {}
    try {
      bodyText = (await page.textContent('body')) || '';
    } catch (_) {}
    const haystack = (title + ' ' + bodyText).toLowerCase();
    for (const term of pageConfig.mustContain || []) {
      if (!haystack.includes(term.toLowerCase())) {
        missingTerms.push(term);
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
  if (!navError && loadMs > config.maxLoadMs)
    problems.push(
      'Langsom load: ' +
        (loadMs / 1000).toFixed(1) +
        's (max ' +
        (config.maxLoadMs / 1000).toFixed(0) +
        's)'
    );
  if (missingTerms.length)
    problems.push('Manglende indhold paa siden: ' + missingTerms.join(', '));
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
  const results = [];
  try {
    for (const pageConfig of config.pages) {
      const result = await checkPage(browser, pageConfig);
      results.push(result);
    }
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
