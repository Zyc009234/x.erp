# x.erp Windows background service (scheduled task running as SYSTEM at boot).
# Called by the installer / uninstaller:
#   xerp-service.ps1 -Action install   -AppDir <dir> -DataDir <dir> -Port 8686
#   xerp-service.ps1 -Action uninstall -AppDir <dir>
#   xerp-service.ps1 -Action stop      -AppDir <dir>
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall', 'stop')][string]$Action,
  [Parameter(Mandatory = $true)][string]$AppDir,
  [string]$DataDir = (Join-Path $env:ProgramData 'XERP'),
  [int]$Port = 8686
)
$ErrorActionPreference = 'Stop'
$TaskName = 'x.erp'
$RuleName = 'xerp-tcp-in'
$AppDir = $AppDir.TrimEnd('\')
$LogFile = Join-Path $DataDir 'install.log'
function Log($m) { try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m) } catch {} }

function Stop-Xerp {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch {}
  # Only kill node.exe processes that belong to this installation
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 800
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if ($Action -eq 'stop') { Stop-Xerp; Log 'stopped'; exit 0 }

if ($Action -eq 'uninstall') {
  Stop-Xerp
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}
  try { Remove-NetFirewallRule -Name $RuleName -ErrorAction Stop } catch {}
  Log 'uninstalled (data kept)'
  exit 0
}

# ---- install / upgrade ----
Stop-Xerp
$node = Join-Path $AppDir 'node.exe'
$pwdFile = Join-Path $DataDir 'admin-password.txt'
$argLine = '"' + (Join-Path $AppDir 'server.js') + '" --data "' + $DataDir + '" --port ' + $Port + ' --admin-password-file "' + $pwdFile + '"'

$act = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $AppDir
$trg = New-ScheduledTaskTrigger -AtStartup
$pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# No time limit (scheduled tasks stop after 72h by default), restart if it crashes
$set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Principal $pri -Settings $set `
  -Description "x.erp server (http://127.0.0.1:$Port)" -Force | Out-Null
Log "task registered, port $Port, data $DataDir"

# Allow other computers on the same LAN only
try { Remove-NetFirewallRule -Name $RuleName -ErrorAction Stop } catch {}
try {
  New-NetFirewallRule -Name $RuleName -DisplayName "x.erp (TCP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
  Log 'firewall rule added (LocalSubnet)'
} catch { Log ('firewall rule failed: ' + $_.Exception.Message) }

Start-ScheduledTask -TaskName $TaskName
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/api/ping"
    if ($r.Content -match 'XERP') { Log 'server is up'; exit 0 }
  } catch {}
}
Log "server did not answer on port $Port within 20s; see $DataDir\logs"
exit 0
