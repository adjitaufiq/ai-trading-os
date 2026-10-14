# Arena Engine Host launcher (used by Task Scheduler task "ArenaEngineHost").
# - Exits 0 without starting anything if port 8090 is already listening (no second instance).
# - Waits for the MT5 gateway HTTP health (not just a listening port). Order permission is still decided inside the
#   engine (whitelisted DEMO account read, reconciliation CLEAN, Shadow, kill switch, arm); this launcher never arms.
# - Logs startup lines without any environment values. Secrets come from Machine env vars, never from this file.
param(
  [int]$Port = 8090,
  [string]$GatewayUrl = "http://127.0.0.1:8765",
  [int]$GatewayWaitSeconds = 600
)
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$dataDir = Join-Path $PSScriptRoot "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$log = Join-Path $dataDir "engine-host-launcher.log"
function Log($m) { "$((Get-Date).ToUniversalTime().ToString('o')) [launcher] $m" | Add-Content -Encoding UTF8 $log }

Log "start user=$env:USERNAME session=$((Get-Process -Id $PID).SessionId) repo=$repo"
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Log "port $Port already listening -> another Engine Host is running, exit 0 (no second instance)"
  exit 0
}
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $c = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"; if (Test-Path $c) { $bun = $c } }
if (-not $bun) { Log "bun not found for user $env:USERNAME -> exit 2"; exit 2 }

$deadline = (Get-Date).AddSeconds($GatewayWaitSeconds); $ok = $false; $wait = 5
while ((Get-Date) -lt $deadline) {
  try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "$GatewayUrl/v1/health"; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { }
  Log "gateway not ready, retry in ${wait}s"; Start-Sleep -Seconds $wait; $wait = [Math]::Min($wait * 2, 60)
}
if (-not $ok) { Log "gateway health not 200 within ${GatewayWaitSeconds}s -> exit 4 (Task Scheduler will retry)"; exit 4 }

Log "gateway healthy, starting engine host (env names only: EXECUTION_MODE/ACCOUNT_MODE set=$([bool]$env:EXECUTION_MODE)/$([bool]$env:ACCOUNT_MODE))"
Set-Location $repo
$env:ENGINE_GATEWAY_URL = $GatewayUrl
$env:ENGINE_HOST_PORT = "$Port"
& $bun engine-host\main.ts *>> (Join-Path $dataDir "engine-host.log")
$code = $LASTEXITCODE
Log "engine host exited code=$code"
exit $code
