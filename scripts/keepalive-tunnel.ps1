# THE LAST TWO - Persistent Tunnel Daemon
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$dest = Join-Path $projectRoot "public\tunnel_url.txt"
$distDest = Join-Path $projectRoot "dist\tunnel_url.txt"

Write-Host "Starting persistent keep-alive SSH tunnel for mobile access..." -ForegroundColor Cyan
Write-Host "Target output files: $dest, $distDest" -ForegroundColor DarkGray

while ($true) {
    try {
        Write-Host "Connecting to localhost.run..." -ForegroundColor Yellow
        $processInfo = New-Object System.Diagnostics.ProcessStartInfo
        $processInfo.FileName = "ssh"
        $processInfo.Arguments = "-o ServerAliveInterval=15 -o ServerAliveCountMax=240 -o StrictHostKeyChecking=no -o TCPKeepAlive=yes -R 80:localhost:5000 nokey@localhost.run"
        $processInfo.RedirectStandardOutput = $true
        $processInfo.RedirectStandardError = $true
        $processInfo.UseShellExecute = $false
        $processInfo.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($processInfo)

        while (-not $proc.HasExited) {
            $line = $proc.StandardOutput.ReadLine()
            if ($line) {
                Write-Host $line
                if ($line -match "(https://[a-zA-Z0-9-]+\.app\.lhr\.life|https://[a-zA-Z0-9-]+\.lhr\.life)") {
                    $url = $Matches[1]
                    Set-Content -Path $dest -Value $url -Force
                    if (Test-Path (Join-Path $projectRoot "dist")) {
                        Set-Content -Path $distDest -Value $url -Force
                    }
                    Write-Host ">>> Tunnel URL active and saved: $url <<<" -ForegroundColor Green
                }
            }
        }
    } catch {
        Write-Host "Tunnel interrupted: $_. Reconnecting in 3 seconds..." -ForegroundColor Red
    }
    Start-Sleep -Seconds 3
}
