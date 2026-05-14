# HOV Monitor runner
# Runs the Node monitor, parses the result, manages alert state, and notifies on failure.
$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
$logDir    = Join-Path $scriptDir 'logs'
$stateFile = Join-Path $scriptDir 'state.json'
$configFile = Join-Path $scriptDir 'config.json'

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

$state = [pscustomobject]@{ lastStatus = 'unknown'; lastAlertTime = $null; failStreak = 0 }
if (Test-Path $stateFile) {
    try { $state = Get-Content $stateFile -Raw | ConvertFrom-Json } catch {}
}

$currentStatus = if ($exitCode -eq 0) { 'ok' } else { 'fail' }
$now = Get-Date

# Decide whether to alert
$shouldAlert = $false
$alertKind = ''

if ($currentStatus -eq 'fail') {
    if ($state.lastStatus -ne 'fail') {
        $shouldAlert = $true
        $alertKind = 'down'
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
} elseif ($currentStatus -eq 'ok' -and $state.lastStatus -eq 'fail') {
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

if ($currentStatus -eq 'fail') {
    if ($state.lastStatus -eq 'fail') { $state.failStreak = ($state.failStreak + 1) } else { $state.failStreak = 1 }
} else {
    $state.failStreak = 0
}
$state.lastStatus = $currentStatus
$state | ConvertTo-Json | Out-File -FilePath $stateFile -Encoding utf8

# Log retention: prune log files older than 30 days
Get-ChildItem -Path $logDir -Filter 'monitor-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

exit $exitCode
