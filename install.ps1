# HOV Monitor installer
# Installs dependencies and registers a Windows Scheduled Task that runs every 5 minutes.
$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
Push-Location $scriptDir

try {
    Write-Host '== HOV Monitor: installerer afhaengigheder ==' -ForegroundColor Cyan

    Write-Host '-> npm install playwright'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install fejlede' }

    Write-Host '-> playwright install chromium'
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'playwright install fejlede' }

    Write-Host '-> Install-Module BurntToast (toast notifikationer)'
    try {
        if (-not (Get-Module -ListAvailable -Name BurntToast)) {
            Install-Module -Name BurntToast -Force -Scope CurrentUser -AllowClobber -ErrorAction Stop
        } else {
            Write-Host '   BurntToast er allerede installeret.'
        }
    } catch {
        Write-Warning "BurntToast install fejlede ($($_.Exception.Message)). Falder tilbage til balloon tip."
    }

    Write-Host '== Opretter Windows Scheduled Task ==' -ForegroundColor Cyan
    $taskName = 'HOV-Monitor'

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptDir\run-monitor.ps1`"" `
        -WorkingDirectory $scriptDir

    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
    $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([System.TimeSpan]::FromDays(36500))).Repetition

    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
        -MultipleInstances IgnoreNew

    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Overvaager houseofvinterberg.com hvert 5. minut og smider en toast hvis frontend fejler.' | Out-Null

    Write-Host ""
    Write-Host "Scheduled task '$taskName' oprettet. Koerer hvert 5. minut." -ForegroundColor Green
    Write-Host ""
    Write-Host 'Naeste skridt:' -ForegroundColor Cyan
    Write-Host '  1. Test alert-systemet med:    .\test-alert.ps1'
    Write-Host '  2. Koer en rigtig check med:   .\run-monitor.ps1'
    Write-Host '  3. Tilfoej Slack webhook i config.json hvis du vil have besked udenfor PC.'
    Write-Host '  4. Stop overvaagning med:      Unregister-ScheduledTask -TaskName HOV-Monitor -Confirm:$false'
} finally {
    Pop-Location
}
