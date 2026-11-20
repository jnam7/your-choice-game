$logPath = "C:/Users/CMB/.gemini/antigravity/brain/6ade6a0c-1d58-475c-887f-c2405f8a3846/.system_generated/tasks/task-319.log"
$dest = "C:/Users/CMB/Desktop/게임/public/tunnel_url.txt"

if (Test-Path $logPath) {
  $lines = Get-Content -Path $logPath -Tail 20
  foreach ($line in $lines) {
    if ($line -match "https?://[\w.-]+\.app\.lhr\.life") {
      $url = $Matches[0]
      Set-Content -Path $dest -Value $url -Force
      Write-Host "Tunnel URL updated: $url"
      break
    }
  }
} else {
  Write-Host "Tunnel log not found."
}
