# Registers the Arena Engine Host to start at boot and restart on failure (Task Scheduler).
# Run ONCE in an elevated PowerShell from the repo root:  powershell -ExecutionPolicy Bypass -File engine-host\install-windows.ps1
param(
  [string]$GatewayUrl = "http://127.0.0.1:8765",
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
rem DEMO env comes from Machine-level variables on the VPS (never literal values in this file).
set EXECUTION_MODE=%EXECUTION_MODE%
set ACCOUNT_MODE=%ACCOUNT_MODE%
set SHADOW_MODE=%SHADOW_MODE%
set DEMO_EXEC_URL=%DEMO_EXEC_URL%
set DEMO_EXEC_TOKEN=%DEMO_EXEC_TOKEN%
set DEMO_ACCOUNT_WHITELIST=%DEMO_ACCOUNT_WHITELIST%
set DEMO_SERVER_WHITELIST=%DEMO_SERVER_WHITELIST%
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
