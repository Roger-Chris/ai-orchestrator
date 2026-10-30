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

$runner = Join-Path $Code "deploy\windows\keep-running.ps1"
function Install-Task($name, $label, [string[]]$command) {
  $argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Code `"$Code`" -Root `"$Root`" -Name $label -Command $($command -join ',')"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description "AI Orchestrator: orc $($command -join ' ') (deploy\windows\install.ps1)" -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host "${name}: starts at logon, running now; log in $Root\data\logs\$label.log"
}

Say "Scheduled tasks (code: $Code, config and data: $Root)"
Install-Task "Orchestrator node" "serve" @("serve")
if ($WhatsApp) { Install-Task "Orchestrator WhatsApp link" "whatsapp-link" @("whatsapp", "link") }

Say "Done"
Write-Host "Check it: curl http://127.0.0.1:4317/api/health   (the phone finds this PC as a backup through the Linux hub)"
Write-Host "Stop it: Stop-ScheduledTask 'Orchestrator node'; turn it off: Disable-ScheduledTask 'Orchestrator node'"
