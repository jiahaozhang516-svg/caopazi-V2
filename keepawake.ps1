# keep the system awake after a wake-timer resume
param([int]$Minutes = 25)

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1

Add-Type -Namespace Win32 -Name Power -MemberDefinition @"
[DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
"@ -ErrorAction Stop

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Note($m) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  [System.IO.File]::AppendAllText((Join-Path $logDir 'keepawake.log'), "[$ts] $m`r`n", $utf8)
}

Note "keep awake start, $Minutes minutes"
[void][Win32.Power]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED))

$end = (Get-Date).AddMinutes($Minutes)
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds 15
  [void][Win32.Power]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED))
}

[void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS)
Note "keep awake end"
