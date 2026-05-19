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
const AUTH_STATE_FILE = path.join(__dirname, 'auth-state.json');

function shouldIgnoreConsole(text) {
  const lower = text.toLowerCase();
  return config.ignoredConsoleErrors.some((needle) =>
    lower.includes(needle.toLowerCase())
  );
}

async function loginWp(browser) {
  const loginPath = (config.auth && config.auth.loginUrl) || '/wp-login.php';
  const wpUser = process.env.WP_USER || '';
  const wpPass = process.env.WP_PASS || '';
  if (!wpUser || !wpPass) {
    throw new Error('Mangler WP_USER/WP_PASS i miljoet (.env eller secrets)');
  }
  const ctx = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: false,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(config.site + loginPath, {
      timeout: config.timeoutMs,
      waitUntil: 'domcontentloaded',
    });
    await page.fill('#user_login', wpUser);
    await page.fill('#user_pass', wpPass);
    await Promise.all([
      page.waitForNavigation({ timeout: config.timeoutMs, waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.click('#wp-submit'),
    ]);
    const finalUrl = page.url();
    if (!finalUrl.includes('/wp-admin/')) {
      const bodyTxt = (await page.textContent('body').catch(() => '')) || '';
      let hint = '';
      if (/incorrect|forkert|invalid/i.test(bodyTxt)) hint = ' (forkert kodeord)';
      else if (/captcha|verify|robot/i.test(bodyTxt)) hint = ' (captcha/sikkerhedsplugin blokerer)';
      throw new Error('Login mislykkedes' + hint + ' . landede paa ' + finalUrl);
    }
    await ctx.storageState({ path: AUTH_STATE_FILE });
  } finally {
    await ctx.close();
  }
}

async function checkPage(browser, pageConfig, retryCtx) {
  // If the page needs auth but no credentials are set, skip rather than alert.
  if (pageConfig.requiresAuth && !retryCtx && (!process.env.WP_USER || !process.env.WP_PASS)) {
    return {
      url: config.site + pageConfig.path,
      ok: true,
      skipped: true,
      reason: 'WP_USER/WP_PASS ikke sat . auth-checket springes over',
      status: null,
      title: '',
      loadMs: 0,
      problems: [],
      jsErrors: [],
      firstPartyHttpErrors: [],
      thirdPartyServerErrors: [],
      networkFailures: [],
      navError: null,
    };
  }
  // Use language-appropriate Accept-Language header so WPML does not
  // redirect Danish pages to /en/ when the runner happens to default to en-US.
  const isEnglishPath = pageConfig.path.startsWith('/en/') || pageConfig.path === '/en';
  const acceptLanguage = isEnglishPath ? 'en-US,en;q=0.9' : 'da-DK,da;q=0.9,en;q=0.5';
  const ctxOpts = {
    userAgent: config.userAgent,
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: false,
    locale: isEnglishPath ? 'en-US' : 'da-DK',
    extraHTTPHeaders: { 'Accept-Language': acceptLanguage },
  };
  if (pageConfig.requiresAuth && fs.existsSync(AUTH_STATE_FILE)) {
    ctxOpts.storageState = AUTH_STATE_FILE;
  }
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

  // Auth expired: if a requiresAuth page was redirected to wp-login, re-login and retry once.
  if (pageConfig.requiresAuth && !retryCtx && page.url().includes('/wp-login.php')) {
    await context.close();
    try {
      await loginWp(browser);
    } catch (loginErr) {
      return {
        url,
        ok: false,
        status: null,
        title: '',
        loadMs,
        problems: ['Auto-login mislykkedes: ' + loginErr.message],
        jsErrors: [],
        firstPartyHttpErrors: [],
        thirdPartyServerErrors: [],
        networkFailures: [],
        navError: null,
      };
    }
    return checkPage(browser, pageConfig, { retried: true });
  }

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
