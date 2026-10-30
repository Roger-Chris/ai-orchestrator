# Runs one orchestrator command for ever: started again 15 s after it stops (a crash, a lost network).
# Started hidden at logon by the scheduled tasks deploy/windows/install.ps1 makes.
#   keep-running.ps1 -Code <checkout with node_modules> -Root <folder with the config, .env and data> -Name serve -Command serve
param(
  [Parameter(Mandatory)] [string]$Code,
  [Parameter(Mandatory)] [string]$Root,
  [Parameter(Mandatory)] [string]$Name,
  # comma-separated ("whatsapp,link"): `powershell -File` passes it as one string
  [Parameter(Mandatory)] [string]$Command
)
$words = $Command -split ","
$tsx = Join-Path $Code "node_modules\.bin\tsx.cmd"
$cli = Join-Path $Code "src\cli.ts"
$logs = Join-Path $Root "data\logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$log = Join-Path $logs "$Name.log"
# .env, orchestrator.config.yaml and ./data are read from the folder it starts in.
Set-Location $Root
while ($true) {
  Add-Content $log "`n== $(Get-Date -Format s) starting: orc $($words -join ' ')"
  & $tsx $cli @words *>> $log
  Add-Content $log "== $(Get-Date -Format s) stopped (exit $LASTEXITCODE); starting again in 15 s"
  Start-Sleep -Seconds 15
}
