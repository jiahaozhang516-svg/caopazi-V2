# caopazi-V2 启动器（由任务计划调用）
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$out = Join-Path $logDir "run-$stamp.out.log"
$err = Join-Path $logDir "run-$stamp.err.log"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Note($m) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  [System.IO.File]::AppendAllText($out, "[$ts] $m`r`n", $utf8)
}

Note "启动，等待网络与开抢时刻"
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }

$p = Start-Process -FilePath $node -ArgumentList (Join-Path $root 'src\runner.mjs') `
  -WorkingDirectory $root -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err
$code = $p.ExitCode
Note "退出码 $code"

if ($code -ne 0) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  [System.IO.File]::AppendAllText((Join-Path $logDir 'FAILED.txt'), "$ts exit=$code out=$out err=$err`r`n", $utf8)
}
exit $code
