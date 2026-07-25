# Refreshes docs/data.json from trades.db and publishes it via GitHub Pages.
# Run this from anywhere - it locates itself and cd's into the repo.

$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

Write-Host "Exporting latest trades from trades.db..."
& "C:\Users\Owner\anaconda3\envs\trading\python.exe" export_web_data.py
if (-not $?) {
    Write-Host "Export failed - stopping before touching git." -ForegroundColor Red
    exit 1
}

git add docs/data.json

git diff --cached --quiet -- docs/data.json
if ($?) {
    Write-Host "No new trades since the last refresh - nothing to push." -ForegroundColor Yellow
    exit 0
}

$dateStamp = Get-Date -Format "yyyy-MM-dd"
git commit -m "Refresh data ($dateStamp)"
git push

Write-Host "Done. Live in ~30-60s at https://cblalock.github.io/trading-agent-dashboard/" -ForegroundColor Green
