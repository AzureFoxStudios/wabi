Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$moduleDir = Join-Path $repoRoot "spacetimedb\wabi_state_bridge"
$frontendHost = if ($env:FRONTEND_HOST) { $env:FRONTEND_HOST } else { "127.0.0.1" }
$frontendPort = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "5173" }
$backendPort = if ($env:BACKEND_PORT) { $env:BACKEND_PORT } else { "3001" }

Write-Host "[local-dev] Real local Wabi dev mode"
Write-Host "[local-dev] This is NOT frontend mock mode."
Write-Host "[local-dev] Expected stack: Rust server + SpacetimeDB + frontend."
Write-Host "[local-dev] Frontend: http://${frontendHost}:${frontendPort}"
Write-Host "[local-dev] Backend:  http://${frontendHost}:${backendPort}"

if ($env:VITE_WABI_LOCAL_MOCK -eq "1" -or $env:VITE_WABI_LOCAL_MOCK -eq "true") {
    throw "VITE_WABI_LOCAL_MOCK is set. Use 'bun run dev:mock' only for visual smoke tests."
}

if (!(Test-Path $moduleDir)) {
    throw @"
Missing SpacetimeDB module directory:
  $moduleDir

Real dev mode cannot run without the Wabi STDB module. Restore/add spacetimedb/wabi_state_bridge, or point the app at an already-published local STDB database. Refusing to fall back to local mock or legacy database modes.
"@
}

Push-Location $repoRoot
try {
    Write-Host "[local-dev] Building frontend for embedded server assets..."
    bun run --cwd frontend build

    Write-Host "[local-dev] Building Rust server..."
    cargo build -p wabi-server

    Write-Host "[local-dev] Starting canonical compose core stack..."
    docker compose up -d spacetimedb stdb-publisher stdb-proxy wabi-server

    Write-Host "[local-dev] Waiting for Rust server health..."
    $deadline = (Get-Date).AddSeconds(60)
    do {
        try {
            Invoke-WebRequest -UseBasicParsing "http://${frontendHost}:${backendPort}/health" | Out-Null
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    } while ((Get-Date) -lt $deadline)
    Invoke-WebRequest -UseBasicParsing "http://${frontendHost}:${backendPort}/health" | Out-Null

    $env:VITE_SOCKET_URL = "http://${frontendHost}:${backendPort}"
    Remove-Item Env:VITE_WABI_LOCAL_MOCK -ErrorAction SilentlyContinue

    Write-Host "[local-dev] Starting frontend against real Rust/STDB backend..."
    bun run --cwd frontend dev -- --host $frontendHost --port $frontendPort
} finally {
    Pop-Location
}
