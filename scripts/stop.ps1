# Stops all EdgeGate processes and frees the lab ports.
# Usage: npm run stop
$ports = 3010,3011,3012,3013,4011,4012,4013,4014,4015,4016,5010,5011,5174,14001,14002,14003,14004,14100,14101,14102,15000,15001
$killed = @{}
foreach ($port in $ports) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $pid = $_.OwningProcess
    if ($pid -and -not $killed[$pid] -and $pid -ne $PID) {
      try {
        $proc = Get-Process -Id $pid -ErrorAction Stop
        if ($proc.ProcessName -match 'node|npm|cmd|powershell') {
          Stop-Process -Id $pid -Force -ErrorAction Stop
          Write-Host "Stopped pid $pid ($($proc.ProcessName)) listening on :$port"
          $killed[$pid] = $true
        }
      } catch {}
    }
  }
}
if ($killed.Count -eq 0) { Write-Host "No EdgeGate processes found." }
