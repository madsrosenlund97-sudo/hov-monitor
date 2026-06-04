// Multi-channel notification helper for check-bookings.js og check-orders.js.
//
// Sender til alle konfigurerede kanaler (Pushover + Telegram) parallelt.
// En kanal regnes som "konfigureret" hvis dens env-vars er sat. Mangler de,
// springes kanalen stille over - ingen fejl.
//
// Konfigurer Pushover ved at sætte PUSHOVER_USER + PUSHOVER_TOKEN.
// Konfigurer Telegram ved at sætte TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
//
// notify({ title, message, sound }) returnerer { sent: [...], failed: [...] }
// eller kaster hvis INGEN kanal er konfigureret, eller hvis ALLE forsøg fejlede.
// "sound" rammer kun Pushover (Telegram styres af modtagerens chat-indstillinger).

async function sendPushover({ title, message, sound }) {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;
  if (!user || !token) return null; // ikke konfigureret
  const params = new URLSearchParams({
    token,
    user,
    title,
    message,
    priority: '0',
    sound: sound || 'pushover',
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
  return 'pushover';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram({ title, message }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null; // ikke konfigureret
  // HTML parse_mode: kun &<> skal escapes, ulig MarkdownV2 der kræver 18 tegn escapet.
  const text = '<b>' + escapeHtml(title) + '</b>\n\n' + escapeHtml(message);
  const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Telegram ' + res.status + ': ' + txt.slice(0, 200));
  }
  return 'telegram';
}

async function notify({ title, message, sound }) {
  const results = await Promise.allSettled([
    sendPushover({ title, message, sound }),
    sendTelegram({ title, message }),
  ]);
  const sent = [];
  const failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value) sent.push(r.value); // null = kanal ikke konfigureret, skip stille
    } else {
      failed.push((r.reason && r.reason.message) || String(r.reason));
    }
  }
  if (sent.length === 0 && failed.length === 0) {
    throw new Error(
      'Ingen notifikations-kanaler konfigureret (sæt PUSHOVER_USER+PUSHOVER_TOKEN eller TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID)'
    );
  }
  if (sent.length === 0) {
    throw new Error('Alle kanaler fejlede: ' + failed.join('; '));
  }
  return { sent, failed };
}

module.exports = { notify, sendPushover, sendTelegram };
