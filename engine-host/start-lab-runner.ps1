# Starts the Lab DEMO runner (SHADOW unless LAB_RUNNER_ARMED=YES). Run as the MT5 interactive user.
# Requires: bun, engine-host/risk-policy.json, mt5_gateway on 127.0.0.1:8765, mt5_exec on 127.0.0.1:8100.
# Set DEMO_EXEC_TOKEN / DEMO_ACCOUNT_WHITELIST / DEMO_SERVER_WHITELIST as user env vars beforehand (never in this file).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not $env:LAB_RUNNER_ARMED) { $env:LAB_RUNNER_ARMED = "NO" }
bun engine-host/lab-runner.ts *>> engine-host/data/lab-runner/console.log
