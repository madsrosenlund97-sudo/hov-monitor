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
