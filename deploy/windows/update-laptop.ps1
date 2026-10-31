# The laptop's steps after a pull. Deletes nothing and does not reboot.
# powershell -ExecutionPolicy Bypass -File deploy\windows\update-laptop.ps1
param([string]$Hub = "http://100.104.185.17:4317")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $root
$config = Join-Path $root "orchestrator.config.yaml"
if (-not (Test-Path $config)) { throw "No orchestrator.config.yaml in $root" }

Write-Host "1. Hub for approvals and memory: $Hub"
Copy-Item $config "$config.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
$lines = [System.Collections.Generic.List[string]]([IO.File]::ReadAllLines($config))
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^sharedMemory:') { $start = $i; break } }
if ($start -lt 0) {
  $lines.Add("sharedMemory:")
  $lines.Add("  hub: $Hub")
} else {
  $found = $false
  for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\S' -and $lines[$i] -notmatch '^#') { break }
    if ($lines[$i] -match '^\s+hub:') { $lines[$i] = "  hub: $Hub"; $found = $true; break }
  }
  if (-not $found) { $lines.Insert($start + 1, "  hub: $Hub") }
}
[IO.File]::WriteAllLines($config, $lines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "2. Old WhatsApp link task (the link lives on Linux now)"
$link = Get-ScheduledTask -TaskName "Orchestrator WhatsApp link" -ErrorAction SilentlyContinue
if ($link) {
  Stop-ScheduledTask -TaskName "Orchestrator WhatsApp link" -ErrorAction SilentlyContinue
  Disable-ScheduledTask -TaskName "Orchestrator WhatsApp link" | Out-Null
  Write-Host "   stopped and disabled. Remove the old device on the phone: Linked devices."
} else { Write-Host "   not installed" }

Write-Host "3. Packages and restart"
& npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Warning "npm install failed" }
$node = Get-ScheduledTask -TaskName "Orchestrator node" -ErrorAction SilentlyContinue
if ($node) {
  Stop-ScheduledTask -TaskName "Orchestrator node" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-ScheduledTask -TaskName "Orchestrator node"
  Write-Host "   Orchestrator node restarted"
} else { Write-Warning "No 'Orchestrator node' task: run deploy\windows\install.ps1 as administrator" }

Write-Host "4. Style book and people graph to the hub"
& npm.cmd run orc -- style graph
if ($LASTEXITCODE -ne 0) { Write-Warning "style graph failed" }
& npm.cmd run orc -- style push
if ($LASTEXITCODE -ne 0) { Write-Warning "style push failed: look for 'People graph sent' above" }

Write-Host "5. Network adapters, for Wake-on-LAN (paste these into the Linux session)"
Get-NetAdapter -Physical | Format-Table Name, InterfaceDescription, Status, MacAddress -AutoSize
Get-NetAdapter -Physical | Get-NetAdapterPowerManagement -ErrorAction SilentlyContinue | Format-Table Name, WakeOnMagicPacket -AutoSize

Write-Host "Done. Now reboot once, to test that the node comes back at logon."
