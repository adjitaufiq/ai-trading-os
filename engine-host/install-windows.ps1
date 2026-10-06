# Registers the Arena Engine Host to start at boot and restart on failure (Task Scheduler).
# Run ONCE in an elevated PowerShell from the repo root:  powershell -ExecutionPolicy Bypass -File engine-host\install-windows.ps1
param(
  [string]$GatewayUrl = "http://127.0.0.1:8000",
  [int]$Port = 8090,
  [string]$Symbols = "XAUUSD,BTCUSD"
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { throw "Bun not found. Install: powershell -c `"irm bun.sh/install.ps1 | iex`"" }

$runner = Join-Path $PSScriptRoot "run-engine-host.cmd"
@"
@echo off
cd /d "$repo"
set ENGINE_GATEWAY_URL=$GatewayUrl
set ENGINE_HOST_PORT=$Port
set ENGINE_SYMBOLS=$Symbols
"$bun" engine-host\main.ts >> engine-host\data\engine-host.log 2>&1
"@ | Set-Content -Encoding ASCII $runner
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "data") | Out-Null

$action   = New-ScheduledTaskAction -Execute $runner
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
Register-ScheduledTask -TaskName "ArenaEngineHost" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "ArenaEngineHost"
Write-Host "ArenaEngineHost registered and started. Check: curl http://127.0.0.1:$Port/v1/engine/health"
