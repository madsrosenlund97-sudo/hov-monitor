// Reads monitor result JSON and fires alerts on every configured channel.
// State file (state.json) is used to dedupe so you don't get spammed during outages.
//
// Channel ENV vars (any combination, only configured ones fire):
//   PUSHOVER_USER + PUSHOVER_TOKEN
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM + TWILIO_TO
//   SLACK_WEBHOOK_URL
//   DISCORD_WEBHOOK_URL
//   GENERIC_WEBHOOK_URL   (POST { title, body, kind, timestamp })
//
// Tuning:
//   ALERT_COOLDOWN_MIN  (default 30) - minutes between repeated "still-down" alerts
//   PUSHOVER_PRIORITY   (default 1)  - -2..2, 2 = emergency (bypasses quiet hours)

const fs = require('fs');
const path = require('path');

const RESULT_PATH = process.argv[2] || path.join(__dirname, 'result.json');
const STATE_PATH = process.argv[3] || path.join(__dirname, 'state.json');
const COOLDOWN_MIN = parseInt(process.env.ALERT_COOLDOWN_MIN || '30', 10);

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

const result = readJson(RESULT_PATH, null);
if (!result) {
  console.error('No usable result at ' + RESULT_PATH + ' - skipping notify.');
  process.exit(0);
}

const state = readJson(STATE_PATH, { lastStatus: 'unknown', lastAlertTime: null });
const now = new Date();
const currentStatus = result.ok ? 'ok' : 'fail';

let shouldAlert = false;
let kind = '';

if (currentStatus === 'fail') {
  if (state.lastStatus !== 'fail') {
    shouldAlert = true;
    kind = 'down';
  } else if (state.lastAlertTime) {
    const elapsedMin = (now - new Date(state.lastAlertTime)) / 60000;
    if (elapsedMin >= COOLDOWN_MIN) {
      shouldAlert = true;
      kind = 'still-down';
    }
  } else {
    shouldAlert = true;
    kind = 'still-down';
  }
} else if (currentStatus === 'ok' && state.lastStatus === 'fail') {
  shouldAlert = true;
  kind = 'recovered';
}

function buildMessage(result, kind) {
  if (kind === 'recovered') {
    return { title: 'HOV: Site OK igen', body: 'Sitet er online igen.' };
  }
  const lines = [];
  for (const r of result.results || []) {
    if (!r.ok) {
      lines.push(r.url);
      for (const p of r.problems || []) lines.push('- ' + p);
    }
  }
  if (result.error) lines.push(result.error);
  return {
    title: kind === 'still-down' ? 'HOV: Stadig nede' : 'HOV: Frontend FEJL',
    body: lines.join('\n') || 'Ukendt fejl - se workflow log.',
  };
}

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(res.status + ': ' + txt.slice(0, 200));
  }
}

async function postForm(url, params, headers) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(headers || {}),
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(res.status + ': ' + txt.slice(0, 200));
  }
}

const channels = {
  async pushover(title, body) {
    const user = process.env.PUSHOVER_USER;
    const token = process.env.PUSHOVER_TOKEN;
    if (!user || !token) return null;
    const priority = process.env.PUSHOVER_PRIORITY || '1';
    const params = { token, user, title, message: body, priority };
    if (priority === '2') {
      params.retry = '60';
      params.expire = '1800';
    }
    await postForm('https://api.pushover.net/1/messages.json', params);
    return 'pushover';
  },

  async telegram(title, body) {
    const t = process.env.TELEGRAM_BOT_TOKEN;
    const c = process.env.TELEGRAM_CHAT_ID;
    if (!t || !c) return null;
    await postJson('https://api.telegram.org/bot' + t + '/sendMessage', {
      chat_id: c,
      text: '*' + title + '*\n\n' + body,
      parse_mode: 'Markdown',
    });
    return 'telegram';
  },

  async twilio(title, body) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const tok = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    const to = process.env.TWILIO_TO;
    if (!sid || !tok || !from || !to) return null;
    const auth = Buffer.from(sid + ':' + tok).toString('base64');
    const url =
      'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';
    await postForm(
      url,
      { From: from, To: to, Body: (title + '\n' + body).slice(0, 1500) },
      { Authorization: 'Basic ' + auth }
    );
    return 'twilio';
  },

  async slack(title, body) {
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) return null;
    await postJson(url, { text: '*' + title + '*\n' + body });
    return 'slack';
  },

  async discord(title, body) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return null;
    await postJson(url, { content: '**' + title + '**\n' + body });
    return 'discord';
  },

  async generic(title, body, kind) {
    const url = process.env.GENERIC_WEBHOOK_URL;
    if (!url) return null;
    await postJson(url, {
      title,
      body,
      kind,
      timestamp: new Date().toISOString(),
    });
    return 'generic';
  },
};

(async () => {
  let report = { alerted: false, status: currentStatus, kind: kind || null };

  if (shouldAlert) {
    const { title, body } = buildMessage(result, kind);
    const sent = [];
    const failed = [];
    for (const [name, fn] of Object.entries(channels)) {
      try {
        const r = await fn(title, body, kind);
        if (r) sent.push(r);
      } catch (e) {
        failed.push(name + ': ' + e.message);
      }
    }
    if (sent.length === 0 && failed.length === 0) {
      console.error(
        'WARNING: alert fired but no channels are configured. Set at least one of PUSHOVER_*, TELEGRAM_*, TWILIO_*, SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL, or GENERIC_WEBHOOK_URL.'
      );
    }
    state.lastAlertTime = now.toISOString();
    report = { alerted: true, kind, title, sent, failed };
  }

  state.lastStatus = currentStatus;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((err) => {
  console.error('notify.js crashed: ' + (err.stack || err.message || err));
  process.exit(1);
});
