# Makes this Windows PC the backup hub: the orchestrator starts hidden at logon and is started again
# whenever it stops, so the phone app can move here when the Linux hub is down (a power cut). With
# -WhatsApp the WhatsApp link (`orc whatsapp link`) runs the same way; while the Linux hub does not
# answer it hands new messages to the orchestrator here, which drafts the replies.
# Safe to run again: the tasks are rewritten, nothing is deleted.
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 [-Root <folder with config, .env, data>] [-WhatsApp]
# -Root defaults to this checkout. Code always comes from this checkout (its node_modules).
param(
  [string]$Root,
  [switch]$WhatsApp
)
$ErrorActionPreference = "Stop"
$Code = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $Root) { $Root = $Code }
$Root = (Resolve-Path $Root).Path
function Say($m) { Write-Host "`n== $m" }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }

Say "Checking"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is missing: install Node 22.13+" }
$v = (& $node -p "process.versions.node").Split(".") | ForEach-Object { [int]$_ }
if ($v[0] -lt 22 -or ($v[0] -eq 22 -and $v[1] -lt 13)) { throw "Node $($v -join '.') is too old: the orchestrator needs 22.13+" }
if (-not (Test-Path (Join-Path $Code "node_modules\.bin\tsx.cmd"))) {
  Say "npm ci in $Code"
  Push-Location $Code; npm ci --no-audit --no-fund; Pop-Location
}
if (-not (Test-Path (Join-Path $Root "orchestrator.config.yaml"))) { throw "no orchestrator.config.yaml in ${Root}: run 'npm run orc -- init' there first" }
$envFile = Join-Path $Root ".env"
if (-not ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^ORC_TOKEN=.' -Quiet))) { Warn "ORC_TOKEN is not in ${envFile}: the phone and the other devices can't use this PC" }
if (-not (Test-Path (Join-Path $Root "fcm-service-account.json"))) { Warn "no fcm-service-account.json in ${Root}: this PC can't send phone notifications while it is the hub" }
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { Warn "Tailscale is not installed: the phone can't reach this PC" }

Say "Firewall: port 4317 for Tailscale addresses only"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (Get-NetFirewallRule -Name "Orchestrator-Tailscale" -ErrorAction SilentlyContinue) { Write-Host "already open" }
elseif ($admin) { New-NetFirewallRule -Name "Orchestrator-Tailscale" -DisplayName "AI Orchestrator (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 4317 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null; Write-Host "opened" }
else { Warn "not an administrator, so other devices may not reach this PC: run this script once as administrator" }

$runner = Join-Path $Code "deploy\windows\keep-running.ps1"
function Install-Task($name, $label, [string[]]$command) {
  $argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Code `"$Code`" -Root `"$Root`" -Name $label -Command $($command -join ',')"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine -WorkingDirectory $Root
  # The full account name (MACHINE\user): a bare name is refused, e.g. when the PC has the user's name.
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "AI Orchestrator: orc $($command -join ' ') (deploy\windows\install.ps1)" -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host "${name}: starts at logon, running now; log in $Root\data\logs\$label.log"
}

Say "Scheduled tasks (code: $Code, config and data: $Root)"
Install-Task "Orchestrator node" "serve" @("serve")
if ($WhatsApp) { Install-Task "Orchestrator WhatsApp link" "whatsapp-link" @("whatsapp", "link") }

Say "Desktop shortcut: Jarvis Record"
$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Jarvis Record.lnk"))
$link.TargetPath = "powershell.exe"
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"& '$(Join-Path $Code 'node_modules\.bin\tsx.cmd')' '$(Join-Path $Code 'src\cli.ts')' record; Read-Host 'Press Enter to close'`""
$link.WorkingDirectory = $Root
$link.Description = "Record a conversation; press Enter to stop and send it to Jarvis"
$link.Save()
Write-Host "double-click it, talk, press Enter to stop"

Say "Done"
Write-Host "Check it: curl http://127.0.0.1:4317/api/health   (the phone finds this PC as a backup through the Linux hub)"
Write-Host "Stop it: Stop-ScheduledTask 'Orchestrator node'; turn it off: Disable-ScheduledTask 'Orchestrator node'"
