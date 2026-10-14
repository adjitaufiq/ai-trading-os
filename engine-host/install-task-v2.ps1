# Registers task "ArenaEngineHost" (v2). Review before running; run in elevated PowerShell from the repo root:
#   powershell -ExecutionPolicy Bypass -File engine-host\install-task-v2.ps1 -RunAsUser "<windows user that runs MT5 terminal>"
# Runs as the SAME interactive Windows user as the MT5 terminal/gateway (not SYSTEM), at that user's logon.
# MultipleInstances=IgnoreNew + launcher port check => never two Engine Hosts. Restarts on failure every minute.
param([Parameter(Mandatory = $true)][string]$RunAsUser)
$ErrorActionPreference = "Stop"
$launcher = Join-Path $PSScriptRoot "start-engine-host.ps1"
if (-not (Test-Path $launcher)) { throw "launcher missing: $launcher" }
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $repo `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $RunAsUser
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName "ArenaEngineHost" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "ArenaEngineHost registered for $RunAsUser (NOT started). Start: Start-ScheduledTask ArenaEngineHost"
