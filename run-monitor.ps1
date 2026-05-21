# HOV Monitor runner
# Runs the Node monitor, parses the result, manages alert state, and notifies on failure.
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$logDir    = Join-Path $scriptDir 'logs'
$stateFile = Join-Path $scriptDir 'state.json'
$configFile = Join-Path $scriptDir 'config.json'

# Use project-local browser folder so the scheduled-task context (which can't
# see %LOCALAPPDATA%\ms-playwright due to a Windows session-virtualisation
# quirk on this machine) finds the chromium binary.
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $scriptDir '.playwright-browsers'

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$dayStamp  = Get-Date -Format 'yyyy-MM-dd'
$logFile   = Join-Path $logDir ("monitor-$dayStamp.log")

# Run the monitor and capture both stdout and exit code
$rawOutput = & node (Join-Path $scriptDir 'monitor.js') $args 2>&1 | Out-String
$exitCode  = $LASTEXITCODE

# Persist raw output to today's log
"=== $timestamp (exit=$exitCode) ===" | Out-File -FilePath $logFile -Append -Encoding utf8
$rawOutput.TrimEnd() | Out-File -FilePath $logFile -Append -Encoding utf8

# Try to parse JSON output
$parsed = $null
try { $parsed = $rawOutput | ConvertFrom-Json -ErrorAction Stop } catch {}

# Load config and state
$config = Get-Content $configFile -Raw | ConvertFrom-Json
$cooldownMinutes = [int]$config.alertCooldownMinutes
if ($cooldownMinutes -le 0) { $cooldownMinutes = 30 }
$minFailStreak = [int]$config.minFailStreakForAlert
if ($minFailStreak -le 0) { $minFailStreak = 1 }

$state = [pscustomobject]@{ lastStatus = 'unknown'; lastAlertTime = $null; failStreak = 0; alerted = $false }
if (Test-Path $stateFile) {
    try { $state = Get-Content $stateFile -Raw | ConvertFrom-Json } catch {}
}
if (-not (Get-Member -InputObject $state -Name 'alerted' -ErrorAction SilentlyContinue)) {
    $state | Add-Member -NotePropertyName 'alerted' -NotePropertyValue $false
}

$currentStatus = if ($exitCode -eq 0) { 'ok' } else { 'fail' }
$now = Get-Date

# Detect when ALL frontend pages fail with net::ERR_INTERNET_DISCONNECTED.
# That means THIS computer lost its connection - not a site failure - so do not alert.
$localNetOutage = $false
if ($parsed -and $parsed.results -and ($parsed.results.Count -gt 1)) {
    $allDisconnected = $true
    foreach ($r in $parsed.results) {
        if (-not $r.navError -or ($r.navError -notmatch 'ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED')) {
            $allDisconnected = $false; break
        }
    }
    if ($allDisconnected) { $localNetOutage = $true }
}

# Track consecutive-fail streak (matches cloud notify.js behaviour).
$newFailStreak = if ($currentStatus -eq 'fail') { [int]$state.failStreak + 1 } else { 0 }

# Decide whether to alert
$shouldAlert = $false
$alertKind = ''

if ($localNetOutage) {
    # local internet drop - skip alert, do not even bump the streak
    $newFailStreak = [int]$state.failStreak
    "Skipping alert: local network outage (all pages ERR_INTERNET_DISCONNECTED)" | Out-File -FilePath $logFile -Append -Encoding utf8
} elseif ($currentStatus -eq 'fail') {
    if ($newFailStreak -lt $minFailStreak) {
        # streak below threshold - suppress (transient flake)
        "Suppressing alert: failStreak $newFailStreak < threshold $minFailStreak" | Out-File -FilePath $logFile -Append -Encoding utf8
    } elseif (-not $state.alerted) {
        $shouldAlert = $true; $alertKind = 'down'
    } else {
        $cooldownPassed = $true
        if ($state.lastAlertTime) {
            try {
                $lastAlert = [DateTime]::Parse($state.lastAlertTime)
                $cooldownPassed = ($now - $lastAlert).TotalMinutes -ge $cooldownMinutes
            } catch { $cooldownPassed = $true }
        }
        if ($cooldownPassed) { $shouldAlert = $true; $alertKind = 'still-down' }
    }
} elseif ($currentStatus -eq 'ok' -and $state.alerted) {
    $shouldAlert = $true
    $alertKind = 'recovered'
}

function Build-AlertBody($parsed, $kind, $rawOutput) {
    if ($kind -eq 'recovered') {
        return 'Sitet er online igen.'
    }
    $lines = @()
    if ($parsed -and $parsed.results) {
        foreach ($r in $parsed.results) {
            if (-not $r.ok) {
                $lines += $r.url
                foreach ($p in $r.problems) { $lines += "  - $p" }
            }
        }
    } elseif ($parsed -and $parsed.error) {
        $lines += $parsed.error
    } else {
        $lines += 'Ukendt fejl. Se logs.'
        $lines += ($rawOutput.Substring(0, [Math]::Min(300, $rawOutput.Length)))
    }
    return ($lines -join "`n")
}

if ($shouldAlert) {
    $title = switch ($alertKind) {
        'down'        { 'HOV: Frontend FEJL' }
        'still-down'  { 'HOV: Stadig nede' }
        'recovered'   { 'HOV: Site OK igen' }
        default       { 'HOV Monitor' }
    }
    $body = Build-AlertBody $parsed $alertKind $rawOutput

    # 1. Windows toast notification (BurntToast preferred, balloon fallback)
    $toastSent = $false
    try {
        Import-Module BurntToast -ErrorAction Stop
        New-BurntToastNotification -Text $title, $body -ErrorAction Stop
        $toastSent = $true
    } catch {
        try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            Add-Type -AssemblyName System.Drawing -ErrorAction Stop
            $notify = New-Object System.Windows.Forms.NotifyIcon
            $notify.Icon = [System.Drawing.SystemIcons]::Warning
            $notify.BalloonTipTitle = $title
            $notify.BalloonTipText  = $body
            $notify.Visible = $true
            $notify.ShowBalloonTip(15000)
            Start-Sleep -Seconds 12
            $notify.Dispose()
            $toastSent = $true
        } catch {
            "Toast notification failed: $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
        }
    }

    # 2. Optional Slack webhook
    if ($config.slackWebhookUrl -and $config.slackWebhookUrl.Trim().Length -gt 0) {
        try {
            $slackPayload = @{ text = "*$title*`n$body" } | ConvertTo-Json -Compress
            Invoke-RestMethod -Method Post -Uri $config.slackWebhookUrl -ContentType 'application/json' -Body $slackPayload -TimeoutSec 10 | Out-Null
        } catch {
            "Slack post failed: $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
        }
    }

    # 3. Optional generic email/webhook (e.g. Zapier, Make, n8n catch-hook)
    if ($config.emailWebhookUrl -and $config.emailWebhookUrl.Trim().Length -gt 0) {
        try {
            $payload = @{ title = $title; body = $body; timestamp = $timestamp; kind = $alertKind } | ConvertTo-Json -Compress
            Invoke-RestMethod -Method Post -Uri $config.emailWebhookUrl -ContentType 'application/json' -Body $payload -TimeoutSec 10 | Out-Null
        } catch {
            "Email webhook failed: $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
        }
    }

    "ALERT sent ($alertKind): $title" | Out-File -FilePath $logFile -Append -Encoding utf8
    $state.lastAlertTime = $now.ToString('o')
}

# Track whether we've notified user about current incident (matches notify.js)
if ($alertKind -eq 'down')      { $state.alerted = $true }
if ($alertKind -eq 'recovered') { $state.alerted = $false }

$state.lastStatus = $currentStatus
$state.failStreak = $newFailStreak
$state | ConvertTo-Json | Out-File -FilePath $stateFile -Encoding utf8

# Daily sync: scrape Amelia bookings, enrich with MTM orders, deploy to Netlify.
# Runs once per day, the first time the scheduled task fires at/after DAILY_SYNC_HOUR.
$lastSyncFile = Join-Path $scriptDir 'last-daily-sync.txt'
$today = Get-Date -Format 'yyyy-MM-dd'
$lastSync = if (Test-Path $lastSyncFile) { (Get-Content $lastSyncFile -Raw).Trim() } else { '' }

# Load .env for NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID, DAILY_SYNC_HOUR
$envFile = Join-Path $scriptDir '.env'
$dailySyncHour = 7
$netlifyToken = ''
$netlifySiteId = ''
if (Test-Path $envFile) {
    Get-Content $envFile -Encoding utf8 | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $matches[1]; $v = $matches[2].Trim()
            if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length-2) }
            if ($k -eq 'DAILY_SYNC_HOUR') { try { $dailySyncHour = [int]$v } catch {} }
            if ($k -eq 'NETLIFY_AUTH_TOKEN') { $netlifyToken = $v }
            if ($k -eq 'NETLIFY_SITE_ID') { $netlifySiteId = $v }
        }
    }
}

$currentHour = (Get-Date).Hour
$shouldSync = ($lastSync -ne $today) -and ($currentHour -ge $dailySyncHour)

if ($shouldSync) {
    "=== $timestamp daily-sync start ===" | Out-File -FilePath $logFile -Append -Encoding utf8
    $syncOk = $true

    try {
        $scrapeOutput = & node (Join-Path $scriptDir 'scrape-bookings.js') 2>&1 | Out-String
        "--- scrape ---`n$($scrapeOutput.TrimEnd())" | Out-File -FilePath $logFile -Append -Encoding utf8
    } catch {
        "Scrape crashed: $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
        $syncOk = $false
    }

    try {
        $enrichOutput = & node (Join-Path $scriptDir 'enrich-orders.js') 2>&1 | Out-String
        "--- enrich ---`n$($enrichOutput.TrimEnd())" | Out-File -FilePath $logFile -Append -Encoding utf8
    } catch {
        "Enrich crashed: $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
        $syncOk = $false
    }

    if ($syncOk -and $netlifyToken -and $netlifySiteId) {
        try {
            $env:NETLIFY_AUTH_TOKEN = $netlifyToken
            $checklistDir = Resolve-Path (Join-Path $scriptDir '..\HOV-Daily-Checklist')
            $deployOutput = & npx --yes netlify-cli@latest deploy --dir="$checklistDir" --prod --site="$netlifySiteId" --no-build 2>&1 | Out-String
            "--- deploy ---`n$($deployOutput.TrimEnd())" | Out-File -FilePath $logFile -Append -Encoding utf8
        } catch {
            "Deploy crashed: $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
            $syncOk = $false
        }
    } elseif (-not $netlifyToken -or -not $netlifySiteId) {
        "Skipping deploy: NETLIFY_AUTH_TOKEN or NETLIFY_SITE_ID not set in .env" | Out-File -FilePath $logFile -Append -Encoding utf8
    }

    if ($syncOk) {
        $today | Set-Content -Path $lastSyncFile -Encoding utf8
        "=== daily-sync done ($today) ===" | Out-File -FilePath $logFile -Append -Encoding utf8
    } else {
        "=== daily-sync had errors . will retry on next run ===" | Out-File -FilePath $logFile -Append -Encoding utf8
    }
}

# Log retention: prune log files older than 30 days
Get-ChildItem -Path $logDir -Filter 'monitor-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

exit $exitCode
