# HOV Monitor

Overvågning af `houseofvinterberg.com` med to mulige måder at køre det:

- **Lokalt** — Windows Scheduled Task på din PC. Hurtigt at sætte op, kører kun når PC'en er tændt.
- **Cloud (24/7)** — GitHub Actions cron + Pushover push til din telefon. Kører altid.

Samme `monitor.js` driver begge.

## Hvad fanger den

- HTTP 4xx/5xx på siden
- Sitet helt nede (DNS / timeout / SSL)
- Langsom load (>15 s)
- Manglende "Vinterberg" i body
- JavaScript console errors i headless Chromium
- 5xx fra subrequests (CSS/JS/billeder)

## Cloud-setup (anbefalet for 24/7)

GitHub Actions kører `monitor.js` hvert 5. minut. Pushover sender push til
din telefon (føles som SMS, koster 35 kr én gang, virker i Danmark).

### 1. Pushover (3 min)

1. Hent **Pushover** appen i App Store / Google Play. Lav en konto.
2. Køb licensen (5 USD, én gang per platform, 30-dages gratis trial først).
3. Log ind på [pushover.net](https://pushover.net). På forsiden finder du din
   **User Key** (30 tegn).
4. Klik "Create an Application/API Token" → kald den "HOV Monitor" →
   du får en **API Token** (30 tegn).

Notér: `USER_KEY` og `API_TOKEN`.

### 2. Push koden til GitHub

Allerede klar som git-repo med initial commit. Du skal bare oprette repoet på
GitHub og pushe:

```powershell
cd "C:\Users\mads\.claude\Code\HOV-Monitor"

# Lav et nyt PRIVAT repo paa github.com/new — kald det fx "hov-monitor".
# Kopier remote-URL'en og kor:

git remote add origin https://github.com/<dit-brugernavn>/hov-monitor.git
git branch -M main
git push -u origin main
```

### 3. Tilføj Pushover secrets

På repo-siden på GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

Tilføj to:

| Navn | Værdi |
|---|---|
| `PUSHOVER_USER` | din User Key fra pushover.net |
| `PUSHOVER_TOKEN` | API Token for "HOV Monitor" applikationen |

(Valgfrit: `PUSHOVER_PRIORITY` = `2` for emergency alerts der bryder igennem
silent mode og bliver ved indtil du bekræfter dem. Default `1` = high priority,
laver lyd, men respekterer telefonens stille-tilstand.)

### 4. Test det

På repo-siden: **Actions → HOV Monitor → Run workflow → Simulate fail: true → Run workflow**.

Inden for et minut bør Pushover give dig en push på telefonen med titlen
"HOV: Frontend FEJL". Kør derefter workflow uden simulate_fail for at få
"HOV: Site OK igen".

Når du har bekræftet at det virker, kører den automatisk hvert 5. minut.

## Lokal setup (Windows toast på din PC)

```powershell
cd "C:\Users\mads\.claude\Code\HOV-Monitor"
.\install.ps1     # installerer Playwright + BurntToast + Scheduled Task
.\test-alert.ps1  # tvinger en toast for at bekraefte det virker
```

Detaljer: scheduled task hedder `HOV-Monitor`, kører hvert 5. minut, logger i
`logs\monitor-YYYY-MM-DD.log`, dedup'er via `state.json`. Stop med
`Unregister-ScheduledTask -TaskName HOV-Monitor -Confirm:$false`.

## Andre alert-kanaler

`notify.js` understøtter også Telegram, Twilio SMS, Slack, Discord og en
generisk JSON-webhook. Sæt de tilsvarende env vars / secrets — så fyrer den
alle konfigurerede kanaler på samme alert. Se top-kommentaren i `notify.js`
for nøjagtige variabelnavne.

## Filer

| Fil | Hvad |
|---|---|
| `monitor.js` | Node + Playwright check. Skriver JSON til stdout. Eksitkode 0/1/2. |
| `notify.js` | Læser `result.json`, holder state i `state.json`, sender til konfigurerede kanaler. |
| `config.json` | URL'er, timeouts, ignored console patterns. |
| `.github/workflows/monitor.yml` | GitHub Actions cron (hvert 5. min). |
| `run-monitor.ps1` | Lokal PowerShell wrapper (Windows toast). |
| `install.ps1` / `test-alert.ps1` | Lokal setup + smoke test. |

## Konfiguration af hvad der overvåges

I `config.json` kan du tilføje flere paths som hver kan have egen `mustContain`-liste:

```json
"pages": [
  { "path": "/", "mustContain": ["Vinterberg"] },
  { "path": "/showroom/", "mustContain": ["Showroom"] }
]
```

Sænk `maxLoadMs` hvis du vil have besked om performance-regressioner.
Skru op på `alertCooldownMinutes` hvis du ikke vil have flere "still-down"
alerts i samme nedbrud.

## Overvågning af sider bag wp-admin login

Sider med `"requiresAuth": true` i `config.json` får automatisk login-flow før
check. Eksempel der allerede er tilføjet:

```json
{ "path": "/wp-admin/admin.php?page=wpamelia-bookings#/appointments",
  "mustContain": ["Amelia"], "requiresAuth": true }
```

Login-cookies cachelagres i `auth-state.json` så der ikke logges ind hver
gang. Hvis sessionen udløber detekteres redirect til `wp-login.php` og der
logges ind igen automatisk.

### Lokalt setup

1. Kopier `.env.example` til `.env` i samme mappe.
2. Sæt `WP_USER` og `WP_PASS` til admin-loginet på `houseofvinterberg.com`.
3. `.env` og `auth-state.json` er allerede i `.gitignore` så de ikke committer.

Test det med:

```powershell
node monitor.js
```

Output indeholder nu også et result-objekt for wp-admin URL'en. Første kørsel
logger ind og gemmer cookies, efterfølgende kørsler genbruger dem.

### GitHub Actions setup

Tilføj to secrets under **Settings → Secrets and variables → Actions**:

| Navn | Værdi |
|---|---|
| `WP_USER` | wp-admin brugernavn |
| `WP_PASS` | wp-admin password |

Workflow'en cacher `auth-state.json` mellem runs, så hver kørsel ikke laver
en ny login. Hvis dit WP-site har Wordfence eller andet sikkerhedsplugin der
spotter automatiseret login, så whitelist user-agent
`Mozilla/5.0 (HOV-Monitor; +https://houseofvinterberg.com) AppleWebKit/537.36`
eller den IP GitHub Actions kører fra.

### Hvad checket fanger

- Login virker (forkert password = alert med hint).
- wp-admin er ikke død (5xx, timeout).
- Amelia plugin loadet (mustContain `Amelia`).
- Sikkerhedsplugin har ikke blokeret kontoen.

Det fanger IKKE om der er kommet nye bookinger . dertil bruges scraperen
beskrevet nedenfor.

## Amelia bookings scraper

`scrape-bookings.js` tager dagens bookinger ud fra Amelia admin og skriver dem
til en JS-fil som den daglige tjekliste læser. Sammen med form-loginet i
`monitor.js` betyder det at vi kan vise rigtige bookings i tjeklisten indtil
det nye bookingsystem er færdigt.

### Filer

| Fil | Hvad |
|---|---|
| `scrape-bookings.js` | Logger ind (eller bruger cached state), aabner Amelia appointments view, opfanger XHR-svaret og skriver bookings ud. |
| `../HOV-Daily-Checklist/data/bookings.js` | Output. `window.HOV_BOOKINGS` array som tjeklisten loader. |
| `logs/amelia-raw.json` | Rå XHR-payloads gemmes her ved hver kørsel (til debugging af parseren). |

### Sådan virker det

1. Bruger den samme `.env` med `WP_USER`/`WP_PASS` og `auth-state.json` som monitoren.
2. Aabner `wp-admin/admin.php?page=wpamelia-bookings#/appointments` og lytter på
   alle responses der matcher `wpamelia` eller `amelia/v1`.
3. Filtrerer til dagens dato, normaliserer felter (time, navn, service, status,
   id, notes) og skriver til `bookings.js`.
4. Tjeklisten har et `<script src="data/bookings.js">` der populerer
   `window.HOV_BOOKINGS`, og rendere automatisk de nye data næste gang siden åbnes.

### Kør den

```powershell
cd "C:\Users\mads\.claude\Code\HOV-Monitor"
node scrape-bookings.js
```

`run-monitor.ps1` kører den automatisk efter hver monitor-cyklus, så når den
scheduled task'en kører hvert 5. minut, bliver bookings også opdateret.

### Hvis parseren ikke matcher Amelias struktur

Amelias API-struktur varierer mellem versioner. Hvis ingen bookings vises:

1. Aabn `HOV-Monitor/logs/amelia-raw.json` . den indeholder de raa XHR-svar.
2. Send den til Claude, så raffinerer han `normalizeAppointment` /
   `extractAppointments` funktionerne i `scrape-bookings.js` til at passe din
   Amelia version.

Felter som CMT status, leveringsdato og fittings-tæller er kun pladsholdere
indtil de bygges ind i Amelia/jeres backend, da Amelia ikke har dem out of the
box.

## MTM ordre-berigelse (Lagersystem)

`enrich-orders.js` kører lige efter `scrape-bookings.js` og slår dagens
booking-kunder op i HOV Lagersystemet (`houseofvinterberg.netlify.app`).
Hvis en kunde har en MTM ordre, beriges bookingen med item, ordre-status,
CMT-status og shipping-dato.

### Sådan virker det

1. Logger ind i Lagersystemet via Supabase auth (`LAGER_USER` + `LAGER_PASS`).
2. Læser dagens bookings fra `data/bookings.js`.
3. For hver unik kunde-navn, kalder Supabase REST direkte:
   `GET /rest/v1/orders?customer_name=ilike.*Navn*&...`
4. Tager den nyeste ordre og merger ind i bookingens felter.
5. Skriver opdateret `bookings.js`.

Førstegangsbesøg/opmålinger uden ordre forbliver med deres oprindelige Amelia
service-info (fx "Bryllups Opmåling"), så staff stadig kan se hvad bookingen
er for. Returnerende kunder med aktiv MTM ordre får ordre-info vist
(fx "AA Collection (JX3163) . Delivered").

### Manuelt run

```powershell
cd "C:\Users\mads\.claude\Code\HOV-Monitor"
npm run refresh   # = scrape + enrich (lokal data, ingen deploy)
npm run sync-now  # = scrape + enrich + deploy til Netlify (kan køre når som helst)
```

### Daglig auto-sync til Netlify

`run-monitor.ps1` (som scheduled task hvert 5. minut) inkluderer en daglig
sync der kører **én gang per dag** efter kl. 07:00. Den scraper Amelia,
beriger med Lagersystem-data, og deployer det opdaterede `bookings.js` til
`https://hov-daglig-tjekliste.netlify.app`.

Konfiguration i `.env`:

```
NETLIFY_AUTH_TOKEN=nfp_...
NETLIFY_SITE_ID=54c915a9-db97-4e4b-8cb8-67fcb2fb5bcd
DAILY_SYNC_HOUR=7
```

State i `last-daily-sync.txt` (gitignored) holder styr på hvilken dato sidste
sync skete, så scheduled task'en der fyrer hvert 5. minut kun gennemfører
sync én gang per dag. Slet filen hvis du vil tvinge en ny sync samme dag.

### Credentials

Tilføj til `.env`:

```
LAGER_USER=mads@houseofvinterberg.com
LAGER_PASS=<dit-lager-kodeord>
```

(samme login som du bruger på `houseofvinterberg.netlify.app`).
