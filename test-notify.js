// Setup-test: sender en test-notifikation via Telegram.
// Bruger samme notify()-helper som check-bookings.js og check-orders.js.
//
// Default sender den med Sales-botten (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).
// Brug --website for at teste Web Alerts-botten i stedet
// (TELEGRAM_BOT_TOKEN_WEBSITE / TELEGRAM_CHAT_ID_WEBSITE).

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

const isWebsite = process.argv.includes('--website');

if (isWebsite) {
  // Override defaults med _WEBSITE-værdierne, så notify() sender til web-bot/gruppe
  if (process.env.TELEGRAM_BOT_TOKEN_WEBSITE) process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_WEBSITE;
  if (process.env.TELEGRAM_CHAT_ID_WEBSITE) process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID_WEBSITE;
}

const { notify } = require('./notifications');

(async () => {
  const title = isWebsite ? 'HOV Monitor: testbesked (web)' : 'HOV Monitor: testbesked (salg)';
  const message = isWebsite
    ? 'Hvis du ser denne i "HOV Web Alerts" gruppen, så virker setup\'et. Du kan slette beskeden.'
    : 'Hvis du ser denne i "HOV Sales" gruppen, så virker setup\'et. Du kan slette beskeden.';
  try {
    const r = await notify({ title, message });
    console.log('OK. Sendt via:', r.sent.join(', ') || '(ingen)');
    if (r.failed.length) console.log('Fejl:', r.failed);
  } catch (e) {
    console.error('Fejl:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
