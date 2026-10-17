# One script to set up (first run only) and start the whole app:
#   backend  = FastAPI on http://localhost:8000   (its own window)
#   frontend = Vite    on http://localhost:5173   (its own window)
# Usage (from this folder):
#   powershell -ExecutionPolicy Bypass -File .\start.ps1             # set up if needed, start, open the app
#   powershell -ExecutionPolicy Bypass -File .\start.ps1 -Restart    # stop running servers first (picks up code changes)
#   powershell -ExecutionPolicy Bypass -File .\start.ps1 -NoBrowser  # don't open the browser
# First run: copies .env.example to .env (fill in the keys, run again), creates backend\.venv (Python 3.12) from
# backend\requirements.txt and runs npm install in frontend\. Later runs reinstall only when those files change.
param([switch]$Restart, [switch]$NoBrowser)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$venv = Join-Path $backend '.venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Listening($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Stamp($file) { (Get-FileHash $file -Algorithm SHA256).Hash }

# 1. API keys
if (-not (Test-Path (Join-Path $root '.env'))) {
    Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env')
    Fail 'No .env found, so one was created from .env.example. Fill in the API keys in .env, then run this again.'
}

# 2. Backend packages (Python 3.12 venv from backend\requirements.txt)
$req = Join-Path $backend 'requirements.txt'
$reqStamp = Join-Path $venv '.requirements.sha256'
if (-not (Test-Path $venvPy)) {
    Step 'Creating backend\.venv (Python 3.12)'
    if ($uv) { & $uv venv --python 3.12 $venv } else { & py -3.12 -m venv $venv }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) { Fail 'Could not create the venv. Install Python 3.12 (or uv) and try again.' }
}
if (-not (Test-Path $reqStamp) -or (Get-Content $reqStamp) -ne (Stamp $req)) {
    Step 'Installing backend packages (backend\requirements.txt)'
    if ($uv) { & $uv pip install --python $venvPy -r $req }
    else { & $venvPy -m ensurepip --upgrade | Out-Null; & $venvPy -m pip install -r $req }
    if ($LASTEXITCODE -ne 0) { Fail 'Backend package install failed (see the output above).' }
    Set-Content $reqStamp (Stamp $req) -Encoding ascii
}

# 3. Frontend packages (npm, from frontend\package-lock.json)
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm not found. Install Node.js 22 or newer and try again.' }
$lock = Join-Path $frontend 'package-lock.json'
$lockStamp = Join-Path $frontend 'node_modules\.lock.sha256'
if (-not (Test-Path $lockStamp) -or (Get-Content $lockStamp) -ne (Stamp $lock)) {
    Step 'Installing frontend packages (npm install)'
    Push-Location $frontend
    & npm.cmd install
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Fail 'npm install failed (see the output above).' }
    Set-Content $lockStamp (Stamp $lock) -Encoding ascii
}

# 4. Optionally stop running servers (and the venv launcher that owns uvicorn)
if ($Restart) {
    foreach ($port in 8000, 5173) {
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
            Step "Stopping :$port ($($p.Name), pid $($p.ProcessId))"
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            if ($parent -and $parent.Name -eq 'python.exe') { Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue }
        }
    }
    Start-Sleep -Seconds 1
}

# 5. Start both servers, each in its own window (close a window to stop that server)
if (Listening 8000) { Write-Host 'Backend already running on :8000 (use -Restart to pick up backend code changes).' }
else {
    Step 'Starting backend on :8000'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Xero Copilot backend :8000'; Set-Location '$backend'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
}
if (Listening 5173) { Write-Host 'Frontend already running on :5173.' }
else {
    Step 'Starting frontend on :5173'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Xero Copilot frontend :5173'; Set-Location '$frontend'; npm.cmd run dev"
}

# 6. Wait until both answer
Step 'Waiting for the servers'
$deadline = (Get-Date).AddSeconds(60)
$health = $null
while ((Get-Date) -lt $deadline -and -not $health) {
    try { $health = Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 2 } catch { Start-Sleep -Milliseconds 500 }
}
$web = $false
while ((Get-Date) -lt $deadline -and -not $web) {
    try { $null = Invoke-WebRequest 'http://localhost:5173' -UseBasicParsing -TimeoutSec 2; $web = $true } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $health) { Write-Host 'Backend did not answer within 60 s: check its window for errors.' -ForegroundColor Red }
elseif ($health.missing) { Write-Host "Backend up, but these keys are empty in .env: $($health.missing -join ', ')" -ForegroundColor Yellow }
else { Write-Host 'Backend up, all API keys present.' -ForegroundColor Green }
if (-not $web) { Write-Host 'Frontend did not answer within 60 s: check its window for errors.' -ForegroundColor Red }
else { Write-Host 'Frontend up: http://localhost:5173' -ForegroundColor Green }

if (-not $NoBrowser -and $web) { Start-Process 'http://localhost:5173' }
