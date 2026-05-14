#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDataDir = Join-Path $repoRoot "backend\data"
$backendUploadsDir = Join-Path $repoRoot "backend\uploads"
$backendDbPath = Join-Path $backendDataDir "chat.db"
$frontendBuildDir = Join-Path $repoRoot "frontend\build"

New-Item -ItemType Directory -Path $backendDataDir -Force | Out-Null
New-Item -ItemType Directory -Path $backendUploadsDir -Force | Out-Null

$env:NODE_ENV = "development"
$env:BACKEND_PORT = "3000"
$env:PORT = "3000"
$env:FRONTEND_URL = "http://127.0.0.1:5173"
$env:PUBLIC_URL = "http://127.0.0.1:5173"
$env:ALLOWED_ORIGINS = "http://127.0.0.1:5173,http://127.0.0.1:3000,http://localhost:5173,http://localhost:3000,http://localhost,http://127.0.0.1,https://tauri.localhost,tauri://localhost"
$env:DB_MODE = "sqlite"
$env:DATABASE_PATH = $backendDbPath
$env:DATA_DIR = $backendDataDir
$env:UPLOADS_DIR = $backendUploadsDir
$env:STATIC_DIR = $frontendBuildDir
$env:VITE_SOCKET_URL = "http://127.0.0.1:3000"
$env:VITE_TURN_SERVER = "127.0.0.1"
$env:VITE_TURN_PORT = "3478"
$env:VITE_USE_TURNS = "false"
$env:VITE_ENABLE_GOOGLE_STUN = "true"
$env:VITE_ENABLE_RELAYS = "false"
$env:STATE_STDB_SUBSCRIPTIONS_ENABLED = "false"
$env:WABI_STDB_BRIDGE_SERVER = ""
$env:WABI_STDB_BRIDGE_DATABASE = ""
$env:WABI_STDB_AUTH_TOKEN = ""
$env:WABI_STDB_ANONYMOUS = "true"

Write-Host "[local-dev] Starting localhost stack"
Write-Host "[local-dev] frontend: http://127.0.0.1:5173"
Write-Host "[local-dev] backend:  http://127.0.0.1:3000"
Write-Host "[local-dev] health:   http://127.0.0.1:3000/health"

$frontendDir = Join-Path $repoRoot "frontend"
$backendDir = Join-Path $repoRoot "backend"

$frontendProc = Start-Process -FilePath "bun" -ArgumentList @("run", "dev") -WorkingDirectory $frontendDir -NoNewWindow -PassThru
$backendProc = Start-Process -FilePath "bun" -ArgumentList @("run", "dev") -WorkingDirectory $backendDir -NoNewWindow -PassThru

try {
  while ($true) {
    Start-Sleep -Seconds 1
    $frontendProc.Refresh()
    $backendProc.Refresh()

    if ($frontendProc.HasExited -or $backendProc.HasExited) {
      break
    }
  }
}
finally {
  if (-not $frontendProc.HasExited) {
    Stop-Process -Id $frontendProc.Id -Force
  }
  if (-not $backendProc.HasExited) {
    Stop-Process -Id $backendProc.Id -Force
  }
}

if ($frontendProc.HasExited -and $frontendProc.ExitCode -ne 0) {
  exit $frontendProc.ExitCode
}
if ($backendProc.HasExited -and $backendProc.ExitCode -ne 0) {
  exit $backendProc.ExitCode
}
