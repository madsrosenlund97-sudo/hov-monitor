// Hjælpescript: find dit Telegram chat-ID (typisk gruppe-ID) til notifikationer.
//
// Sådan bruger du det:
//   1. Opret botten via @BotFather i Telegram, kopier token.
//   2. Læg token i .env som TELEGRAM_BOT_TOKEN=...  (eller kør med --token=...)
//   3. Lav en Telegram-gruppe, tilføj botten som medlem.
//      VIGTIGT: send mindst ÉN besked i gruppen efter botten er tilføjet,
//      ellers ved Telegram-serveren ikke om gruppen og getUpdates returnerer tomt.
//   4. Kør: node get-telegram-chat-id.js
//   5. Find linjen "GROUP" i output - kopier dens id til TELEGRAM_CHAT_ID.
//
// Note: hvis getUpdates returnerer tomt selvom du har sendt en besked,
// så har en webhook sandsynligvis spist updates. Det fixes ved at kalde
//   curl https://api.telegram.org/bot<TOKEN>/deleteWebhook
// og prøv igen.

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

function getToken() {
  const argMatch = process.argv.find((a) => a.startsWith('--token='));
  if (argMatch) return argMatch.slice('--token='.length);
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  console.error('Mangler TELEGRAM_BOT_TOKEN. Sæt det i .env eller kør med --token=<bot-token>.');
  process.exit(2);
}

async function callApi(token, method) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method);
  return res.json();
}

(async () => {
  const token = getToken();

  // Ryd evt. webhook der ville stjæle vores updates. No-op hvis ingen er sat.
  try { await callApi(token, 'deleteWebhook'); } catch (_) { /* ignorer */ }

  // Hent bot-info så vi kan vise brugernavn + tip om privacy mode
  const me = await callApi(token, 'getMe');
  const botUsername = me && me.ok && me.result ? me.result.username : null;

  const data = await callApi(token, 'getUpdates');
  if (!data.ok) {
    console.error('Telegram API fejl:', data);
    process.exit(1);
  }

  if (!data.result || data.result.length === 0) {
    console.log('Ingen updates fundet for ' + (botUsername ? '@' + botUsername : 'denne bot') + '.\n');
    console.log('Sandsynlig årsag: bot privacy mode (default ON) skjuler almindelige');
    console.log('gruppe-beskeder for botten. Prøv én af disse i gruppen:\n');
    if (botUsername) {
      console.log('  - Skriv: /hej@' + botUsername);
      console.log('  - Eller @-mention: @' + botUsername + ' test');
    } else {
      console.log('  - /hej@<bot_brugernavn>');
      console.log('  - @<bot_brugernavn> test');
    }
    console.log('\nSend beskeden, vent 2 sekunder, og kør scriptet igen.\n');
    console.log('Alternativt: slå privacy mode fra i @BotFather:');
    console.log('  /mybots -> vælg botten -> Bot Settings -> Group Privacy -> Turn off');
    console.log('  Derefter SKAL botten fjernes og tilføjes til gruppen igen for at tage effekt.');
    process.exit(0);
  }

  // Saml unikke chats fra alle updates
  const chats = new Map();
  for (const u of data.result) {
    const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    if (!msg || !msg.chat) continue;
    const c = msg.chat;
    if (!chats.has(c.id)) chats.set(c.id, c);
  }

  console.log('Bot: ' + (botUsername ? '@' + botUsername : '(ukendt)'));
  console.log('Fundet ' + chats.size + ' unik(ke) chat(s):\n');
  for (const c of chats.values()) {
    const type = (c.type || '').toUpperCase();
    const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '(uden navn)';
    console.log('  [' + type.padEnd(11) + '] id=' + c.id + '   ' + name);
  }
  console.log('');
  console.log('-> Til en notifikations-gruppe: brug id\'et fra GROUP eller SUPERGROUP linjen.');
  console.log('-> Læg den i .env som TELEGRAM_CHAT_ID=...  (eller som GitHub Actions secret).');
  process.exit(0);
})().catch((err) => {
  console.error('crash: ' + (err && err.message || err));
  process.exit(2);
});
