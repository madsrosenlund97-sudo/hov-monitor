# Forcerer en alert ved at koere monitor.js med --simulate-fail.
# Bruges til at verificere at toast/Slack/webhook virker.
$scriptDir = $PSScriptRoot
& (Join-Path $scriptDir 'run-monitor.ps1') '--simulate-fail'
Write-Host ''
Write-Host 'Hvis du saa en Windows toast (eller en balloon nede ved uret), virker alert-systemet.' -ForegroundColor Green
Write-Host 'Koer nu .\run-monitor.ps1 for at faa en "recovered"-besked.' -ForegroundColor Cyan
