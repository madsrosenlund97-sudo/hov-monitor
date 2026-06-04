# HOV Monitor

24/7 overvågning af `houseofvinterberg.com` plus to push-kanaler til ny aktivitet:

1. `monitor.js` - frontend health-check (HTTP, console errors, "Vinterberg" i body)
2. `check-bookings.js` - notifikation når der lander en ny booking i `/admin/bookings`
3. `check-orders.js` - notifikation når der lander en ny WooCommerce-ordre

Alt kører via GitHub Actions hvert 5. minut. Push leveres via Telegram (bot + gruppe, så flere modtagere får samme notifikation uden delte konti).

## Hvad fanges af `monitor.js`

- HTTP 4xx/5xx på siden
- Sitet helt nede (DNS / timeout / SSL)
- Langsom load over `maxLoadMs`
- Manglende "Vinterberg" i body
- JavaScript console-fejl i headless Chromium
- 5xx fra subrequests (CSS/JS/billeder)

URL'er og tærskler ligger i `config.json`. `ignoredFirstPartyErrors` filtrerer kendte ikke-kritiske 4xx'er (fx admin-ajax 403).

## Filer

| Fil | Rolle |
|---|---|
| `monitor.js` | Frontend-check. Skriver JSON til stdout, eksitkode 0/1/2. |
| `notify.js` | Læser `result.json`, holder dedup-state i `state.json`, fyrer Telegram/Slack/Discord/Twilio/webhook hvis konfigureret. |
| `notifications.js` | Fælles helper. `notify({title, message})` sender til Telegram-gruppe. |
| `check-bookings.js` | Scraper `/admin/bookings` på Next.js-frontenden via Basic Auth plus Vercel Protection Bypass. Pusher per ny booking via `notifications.js`. |
| `check-orders.js` | Henter ordrer via WC REST API på `drift.houseofvinterberg.com`. Pusher per ny ordre via `notifications.js`. |
| `get-telegram-chat-id.js` | Setup-hjælper: finder gruppe-ID til Telegram-botten. Køres én gang ved opsætning. |
| `test-notify.js` | Setup-test: sender en testbesked via notify(). `--website` skifter til Web Alerts-botten. |
| `config.json` | URL'er, timeouts, ignored-console-patterns. |
| `.github/workflows/monitor.yml` | Cron hvert 5. minut, kører alle tre scripts. |

## Secrets i GitHub Actions

Sættes under **Settings → Secrets and variables → Actions**.

### Bookings-scrape (Next.js admin)

| Navn | Værdi |
|---|---|
| `VERCEL_BYPASS_SECRET` | Protection Bypass for Automation, fra Vercel-projektet |
| `ADMIN_USER` | Basic-Auth bruger (typisk `mads@houseofvinterberg.com`) |
| `ADMIN_PASS` | Basic-Auth password |

### WC-ordrer

| Navn | Værdi |
|---|---|
| `WC_KEY` | WooCommerce REST consumer key (Settings → Advanced → REST API) |
| `WC_SECRET` | WooCommerce REST consumer secret |

### Telegram (multi-modtager via gruppe-chat)

Brugt af `notify.js`, `check-bookings.js` og `check-orders.js`. Hver stream kan bruge sin egen bot + gruppe via per-stream overrides, eller dele én bot/gruppe via defaults.

| Navn | Værdi |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Default bot-token. Bruges af alle streams uden override. |
| `TELEGRAM_CHAT_ID` | Default chat-ID. Samme regel. |
| `TELEGRAM_BOT_TOKEN_WEBSITE` | Valgfri. Override for `notify.js` (frontend alerts). |
| `TELEGRAM_CHAT_ID_WEBSITE` | Valgfri. Override for `notify.js`. |
| `TELEGRAM_BOT_TOKEN_BOOKING` | Valgfri. Override for `check-bookings.js`. |
| `TELEGRAM_CHAT_ID_BOOKING` | Valgfri. Override for `check-bookings.js`. |
| `TELEGRAM_BOT_TOKEN_WEBSHOP` | Valgfri. Override for `check-orders.js`. |
| `TELEGRAM_CHAT_ID_WEBSHOP` | Valgfri. Override for `check-orders.js`. |

Typisk to-bot opsætning (HOV's nuværende):
- **Bot 1** (web alerts) → `TELEGRAM_BOT_TOKEN_WEBSITE` + `TELEGRAM_CHAT_ID_WEBSITE`
- **Bot 2** (bookings + webshop) → `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`

Vil du dele bookings og webshop i hver sin gruppe (samme bot 2), så lader du `TELEGRAM_BOT_TOKEN` stå med bot 2's token og sætter `TELEGRAM_CHAT_ID_BOOKING` + `TELEGRAM_CHAT_ID_WEBSHOP` til hver sin gruppe.

Setup-flow: opret bot via @BotFather → tilføj bot til Telegram-gruppe → send en besked i gruppen → kør `node get-telegram-chat-id.js` for at finde gruppe-ID.

### Valgfri ekstra alert-kanaler i `notify.js`

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `GENERIC_WEBHOOK_URL`. (Telegram for `notify.js` deler `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` ovenfor.)

## Lokalt udvikling

```powershell
cd "C:\Users\mads\.claude\Code\HOV-Monitor"
npm install
npx playwright install chromium

# Kopier .env.example til .env og udfyld felterne
node monitor.js                    # frontend-check
node check-bookings.js --dry-run   # bookings (uden at pushe)
node check-orders.js --dry-run     # ordrer (uden at pushe)
```

`--force-push` på check-scripts overrider dedup-state og pusher alt nuværende én gang (kun til test).

## Konfiguration

Tilføj eller fjern overvågede pages i `config.json`:

```json
"pages": [
  { "path": "/", "mustContain": ["Vinterberg"] },
  { "path": "/showroom/", "mustContain": ["Showroom"] }
]
```

Sænk `maxLoadMs` hvis du vil have besked om performance-regressioner. Skru op på `alertCooldownMinutes` hvis du ikke vil have flere "still-down" alerts i samme nedbrud.

## State og cache

Workflowet cacher tre filer mellem runs via GitHub Actions cache:

- `state.json` - dedup for `notify.js` (cooldown og last-status)
- `notified-bookings.json` - sæt af allerede-pushed booking-IDs
- `notified-orders.json` - sæt af allerede-pushed ordre-IDs

Første kørsel af både `check-bookings.js` og `check-orders.js` populerer settet uden at pushe, så du ikke får 50 push på eksisterende data.

Cache-keys er namespacet (`hov-monitor-notified-bookings-` vs `-orders-`) så `restore-keys` prefix-matching ikke krydsforurener.
