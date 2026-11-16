$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }
$lines = & $node (Join-Path $root 'tools\healthcheck.mjs') 2>&1
$code = $LASTEXITCODE
$lines | Out-File -FilePath (Join-Path $logDir 'healthcheck-run.log') -Append -Encoding utf8
"exit $code" | Out-File -FilePath (Join-Path $logDir 'healthcheck-run.log') -Append -Encoding utf8
exit 0
