// One-shot helper that logs into Netlify with email/password, generates a
// Personal Access Token, and writes it to .env as NETLIFY_AUTH_TOKEN so the
// netlify CLI can deploy without further interaction.
//
// Usage:
//   NETLIFY_LOGIN_EMAIL=... NETLIFY_LOGIN_PASS=... node netlify-login.js
//   (Or set the same vars in .env)

const { chromium } = require('playwright');
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

function appendEnv(key, value){
  const envFile = path.join(__dirname, '.env');
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const re = new RegExp('^' + key + '=.*$', 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    if (content && !content.endsWith('\n')) content += '\n';
    content += `${key}=${value}\n`;
  }
  fs.writeFileSync(envFile, content, 'utf8');
}

async function dumpDebug(page, label){
  try {
    const html = await page.content();
    const url = page.url();
    fs.writeFileSync(path.join(__dirname, 'logs', `netlify-${label}.html`), `<!-- url=${url} -->\n` + html, 'utf8');
    await page.screenshot({ path: path.join(__dirname, 'logs', `netlify-${label}.png`), fullPage:true }).catch(()=>{});
  } catch(e){}
}

(async () => {
  const email = process.env.NETLIFY_LOGIN_EMAIL || process.env.LAGER_USER_NEW || '';
  const pass  = process.env.NETLIFY_LOGIN_PASS  || process.env.LAGER_PASS_NEW  || '';
  if (!email || !pass){
    console.error('Mangler NETLIFY_LOGIN_EMAIL / NETLIFY_LOGIN_PASS i .env');
    process.exit(2);
  }

  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width:1366, height:900 } });
  const page = await ctx.newPage();

  try {
    console.error('navigating to netlify login...');
    await page.goto('https://app.netlify.com/login', { waitUntil:'domcontentloaded', timeout:30000 });
    await page.waitForLoadState('networkidle', { timeout:15000 }).catch(()=>{});

    // Click "Log in with email" if such option appears (Netlify shows SSO options first)
    const emailBtn = await page.$('a:has-text("Log in with email"), button:has-text("Log in with email")');
    if (emailBtn) { await emailBtn.click(); await page.waitForTimeout(1000); }

    const emailInput = await page.$('input[type=email], input[name=email], input#email');
    const passInput  = await page.$('input[type=password], input[name=password], input#password');
    if (!emailInput || !passInput){
      await dumpDebug(page, 'no-form');
      throw new Error('Login form blev ikke fundet');
    }
    await emailInput.fill(email);
    await passInput.fill(pass);
    const submit = await page.$('button[type=submit]') || await page.$('form button:has-text("Log in")');
    if (!submit) throw new Error('Submit-knap ikke fundet');
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout:20000 }).catch(()=>{}),
      submit.click(),
    ]);
    await page.waitForTimeout(2500);

    // Check for verification screens or login failure
    const currentUrl = page.url();
    if (currentUrl.includes('/login')){
      const bodyTxt = (await page.textContent('body').catch(()=>'')) || '';
      await dumpDebug(page, 'login-failed');
      let hint = '';
      if (/incorrect|invalid|wrong/i.test(bodyTxt)) hint = ' (forkert email/kodeord)';
      else if (/verify|verification|captcha|robot/i.test(bodyTxt)) hint = ' (verification/captcha kraevet)';
      else if (/two[- ]factor|2fa|authenticator/i.test(bodyTxt)) hint = ' (2FA er aktiveret)';
      throw new Error('Login mislykkedes' + hint);
    }
    console.error('logged in, current URL:', currentUrl);

    // Navigate to PAT page
    await page.goto('https://app.netlify.com/user/applications#personal-access-tokens', { waitUntil:'domcontentloaded', timeout:30000 });
    await page.waitForLoadState('networkidle', { timeout:15000 }).catch(()=>{});
    await page.waitForTimeout(2000);
    await dumpDebug(page, 'pat-page');

    // Click "New access token" button (text varies: "New access token", "New token")
    const newBtn = await page.$('button:has-text("New access token"), a:has-text("New access token"), button:has-text("New token"), a:has-text("New token")');
    if (!newBtn) {
      await dumpDebug(page, 'no-new-token-btn');
      throw new Error('Kunne ikke finde "New access token" knap');
    }
    await newBtn.click();
    await page.waitForTimeout(1500);

    // Fill description
    const descInput = await page.$('input[placeholder*="description" i], input[name=description], input[id*="description" i], input[type=text]');
    if (descInput) await descInput.fill('HOV Daily Checklist Deploy ' + new Date().toISOString().slice(0,10));

    // Submit token generation
    const genBtn = await page.$('button:has-text("Generate token"), button:has-text("Create token"), button[type=submit]');
    if (!genBtn){
      await dumpDebug(page, 'no-generate-btn');
      throw new Error('Kunne ikke finde "Generate" knap');
    }
    await genBtn.click();
    await page.waitForTimeout(2500);
    await dumpDebug(page, 'after-generate');

    // Extract token. Netlify shows the token in a <code> or similar element once.
    let token = null;
    // Try common selectors
    const tokenSelectors = [
      'code',
      'input[readonly]',
      'input[type=text][readonly]',
      'pre',
      '[data-testid*="token" i]',
      '[class*="token-display" i]',
    ];
    for (const sel of tokenSelectors) {
      const el = await page.$(sel);
      if (!el) continue;
      const val = (await el.inputValue?.().catch(()=>null)) || (await el.textContent());
      if (val && /^[a-zA-Z0-9_-]{32,}$/.test(val.trim())) { token = val.trim(); break; }
    }

    if (!token) {
      // Fallback: scan all visible text for a long token-like string
      const html = await page.content();
      const m = html.match(/\b([a-zA-Z0-9_-]{36,80})\b/g);
      if (m) token = m.find(s => !/^https?/.test(s) && !s.includes('netlify') && s.length >= 36) || null;
    }

    if (!token){
      await dumpDebug(page, 'token-not-extracted');
      throw new Error('Token blev genereret men kunne ikke ekstraheres. Se logs/netlify-after-generate.html');
    }

    appendEnv('NETLIFY_AUTH_TOKEN', token);
    console.log(JSON.stringify({ ok:true, tokenPreview: token.slice(0,8) + '...' + token.slice(-4), savedTo: '.env' }, null, 2));
  } finally {
    await ctx.close();
    await browser.close();
  }
})().catch((err) => {
  console.error('[netlify-login] crash:', err && err.message || err);
  process.exit(2);
});
