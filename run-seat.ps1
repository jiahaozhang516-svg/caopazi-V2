# caopazi-V2 launcher (task scheduler entry)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
try {
  Add-Type -Namespace Win32 -Name Power -MemberDefinition @"
[DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
"@ -ErrorAction Stop
  [void][Win32.Power]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED))
} catch {}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$note = Join-Path $logDir "run-$stamp.note.log"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Note($m) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  [System.IO.File]::AppendAllText($note, "[$ts] $m`r`n", $utf8)
}

Note "start"
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }

# 不用 Start-Process 重定向（PowerShell 退出时可能崩溃），
# runner 自己会写 logs\<日期>.log 和 last-run.json
& $node (Join-Path $root 'src\runner.mjs')
$code = $LASTEXITCODE
Note "exit code $code"

if ($code -ne 0) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  [System.IO.File]::AppendAllText((Join-Path $logDir 'FAILED.txt'), "$ts exit=$code`r`n", $utf8)
}

try { [void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS) } catch {}
exit $code
