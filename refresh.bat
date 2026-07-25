@echo off
cd /d "%~dp0"

echo Exporting latest trades from trades.db...
"C:\Users\Owner\anaconda3\envs\trading\python.exe" export_web_data.py
if errorlevel 1 (
    echo Export failed - stopping before touching git.
    exit /b 1
)

git add docs\data.json

git diff --cached --quiet -- docs\data.json
if %errorlevel%==0 (
    echo No new trades since the last refresh - nothing to push.
    exit /b 0
)

for /f "tokens=2 delims==" %%d in ('wmic os get localdatetime /value') do set dt=%%d
set today=%dt:~0,4%-%dt:~4,2%-%dt:~6,2%

git commit -m "Refresh data (%today%)"
git push

echo Done. Live in ~30-60s at https://cblalock.github.io/trading-agent-dashboard/
