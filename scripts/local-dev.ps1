#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDataDir = Join-Path $repoRoot "backend\data"
$backendUploadsDir = Join-Path $repoRoot "backend\uploads"
$backendDbPath = Join-Path $backendDataDir "chat.db"
$frontendBuildDir = Join-Path $repoRoot "frontend\build"
$backendPort = if ($env:BACKEND_PORT) { $env:BACKEND_PORT } else { "3000" }
$frontendPort = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "5173" }
$frontendHost = if ($env:FRONTEND_HOST) { $env:FRONTEND_HOST } else { "127.0.0.1" }

New-Item -ItemType Directory -Path $backendDataDir -Force | Out-Null
New-Item -ItemType Directory -Path $backendUploadsDir -Force | Out-Null

$env:NODE_ENV = "development"
$env:BACKEND_PORT = $backendPort
$env:PORT = $backendPort
$env:FRONTEND_URL = "http://${frontendHost}:${frontendPort}"
$env:PUBLIC_URL = "http://${frontendHost}:${frontendPort}"
$env:ALLOWED_ORIGINS = "http://${frontendHost}:${frontendPort},http://localhost:${frontendPort},http://${frontendHost}:${backendPort},http://localhost:${backendPort},http://localhost,http://${frontendHost},https://tauri.localhost,tauri://localhost"
$env:DB_MODE = "sqlite"
$env:DATABASE_PATH = $backendDbPath
$env:DATA_DIR = $backendDataDir
$env:UPLOADS_DIR = $backendUploadsDir
$env:STATIC_DIR = $frontendBuildDir
$env:VITE_SOCKET_URL = "http://${frontendHost}:${backendPort}"
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
Write-Host "[local-dev] frontend: http://${frontendHost}:${frontendPort}"
Write-Host "[local-dev] backend:  http://${frontendHost}:${backendPort}"
Write-Host "[local-dev] health:   http://${frontendHost}:${backendPort}/health"

$frontendDir = Join-Path $repoRoot "frontend"

$frontendProc = Start-Process -FilePath "bun" -ArgumentList @("run", "dev", "--", "--host", $frontendHost, "--port", $frontendPort) -WorkingDirectory $frontendDir -NoNewWindow -PassThru
$backendProc = Start-Process -FilePath "cargo" -ArgumentList @("run", "-p", "wabi-server", "--", "--host", $frontendHost, "--port", $backendPort, "--data-dir", $backendDataDir) -WorkingDirectory $repoRoot -NoNewWindow -PassThru

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
