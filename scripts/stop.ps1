# Stops all EdgeGate processes and frees the lab ports.
# Usage: npm run stop
$ports = 3000,3001,3002,3003,4001,4002,4003,4004,4005,4006,5000,5001,5173
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
