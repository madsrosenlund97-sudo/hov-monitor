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

  const consoleErrors = [];
  const failedRequests = [];
  const serverErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!shouldIgnoreConsole(text)) consoleErrors.push(text);
    }
  });

  page.on('pageerror', (err) => {
    const text = err.message || String(err);
    if (!shouldIgnoreConsole(text)) consoleErrors.push('pageerror: ' + text);
  });

  page.on('requestfailed', (req) => {
    const url = req.url();
    if (shouldIgnoreConsole(url)) return;
    failedRequests.push({
      url,
      reason: req.failure() ? req.failure().errorText : 'unknown',
    });
  });

  page.on('response', (resp) => {
    const status = resp.status();
    const url = resp.url();
    if (status >= 500 && !shouldIgnoreConsole(url)) {
      serverErrors.push({ url, status });
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
  if (consoleErrors.length)
    problems.push(
      'JS console errors (' +
        consoleErrors.length +
        '): ' +
        consoleErrors.slice(0, 3).join(' | ')
    );
  if (serverErrors.length)
    problems.push(
      serverErrors.length +
        ' 5xx-svar fra subrequests (' +
        serverErrors[0].status +
        ' ' +
        serverErrors[0].url +
        ')'
    );
  if (failedRequests.length > 3)
    problems.push(failedRequests.length + ' fejlede netvaerks-requests');

  return {
    url,
    ok: problems.length === 0,
    status,
    title,
    loadMs,
    problems,
    consoleErrors: consoleErrors.slice(0, 5),
    failedRequests: failedRequests.slice(0, 5),
    serverErrors: serverErrors.slice(0, 5),
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
