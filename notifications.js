// Notification helper for check-bookings.js og check-orders.js.
//
// Sender til Telegram-gruppe hvis konfigureret. Telegram-bot + gruppe lader
// flere modtagere få samme notifikation uden at dele konto.
//
// Konfigurer ved at sætte TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
//
// notify({ title, message }) returnerer { sent: [...], failed: [...] } eller
// kaster hvis Telegram ikke er konfigureret eller forsøget fejlede.

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

async function notify({ title, message }) {
  const sent = [];
  const failed = [];
  try {
    const r = await sendTelegram({ title, message });
    if (r) sent.push(r);
  } catch (e) {
    failed.push((e && e.message) || String(e));
  }
  if (sent.length === 0 && failed.length === 0) {
    throw new Error('Telegram ikke konfigureret (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID mangler)');
  }
  if (sent.length === 0) {
    throw new Error('Telegram fejlede: ' + failed.join('; '));
  }
  return { sent, failed };
}

module.exports = { notify, sendTelegram };
