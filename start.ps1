# Starts the backend (FastAPI on :8000) and the frontend (Vite on :5173) in two new windows, then opens the app.
# Usage (from this folder):  powershell -ExecutionPolicy Bypass -File .\start.ps1
# If the servers are already running (ports 8000/5173 busy), just open http://localhost:5173 instead.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$busy = @(8000, 5173) | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue }
if ($busy) {
    Write-Host "Already running on port(s): $($busy -join ', '). Opening the app."
} else {
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\backend'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\frontend'; npm run dev"
    Start-Sleep -Seconds 6
}
Start-Process 'http://localhost:5173'
