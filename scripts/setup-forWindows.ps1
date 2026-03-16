#!/usr/bin/env pwsh
[CmdletBinding()]
param(
  [string]$OutputRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Domain = "",
  [string]$PublicIp = "",
  [string]$GiphyApiKey = "",
  [switch]$DisableTurn,
  [switch]$NonInteractive,
  [ValidateSet("Auto", "Docker", "Podman")]
  [string]$ContainerRuntime = "Auto"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Ok {
  param([string]$Message)
  Write-Host "  [ok] $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "  [!]  $Message" -ForegroundColor Yellow
}

function Write-Bad {
  param([string]$Message)
  Write-Host "  [x]  $Message" -ForegroundColor Red
}

function Read-TrimmedLine {
  param([string]$Prompt)
  return (Read-Host $Prompt).Trim()
}

function Confirm-DefaultYes {
  param([string]$Prompt)
  $value = Read-TrimmedLine $Prompt
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $true
  }
  return $value -match '^(?i:y|yes)$'
}

function Normalize-DomainValue {
  param([string]$Value)

  $next = if ($null -eq $Value) { "" } else { $Value.Trim().ToLowerInvariant() }
  if ([string]::IsNullOrWhiteSpace($next) -or $next -eq "no" -or $next -eq "n" -or $next -eq "localhost") {
    return ""
  }

  if ($next.StartsWith("https://")) {
    $next = $next.Substring(8)
  } elseif ($next.StartsWith("http://")) {
    $next = $next.Substring(7)
  }

  $slashIndex = $next.IndexOf("/")
  if ($slashIndex -ge 0) {
    $next = $next.Substring(0, $slashIndex)
  }

  if ($next -match '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$') {
    return $next
  }

  return $null
}

function Get-DetectedPublicIp {
  try {
    $client = New-Object System.Net.WebClient
    try {
      $client.Headers["User-Agent"] = "WabiSetup"
      $candidate = $client.DownloadString("https://api.ipify.org").Trim()
      if ($candidate -match '^\d{1,3}(\.\d{1,3}){3}$') {
        return $candidate
      }
    } finally {
      $client.Dispose()
    }
  } catch {
  }

  return $null
}

function New-SecretBase64 {
  param([int]$Length = 32)

  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }

  return [Convert]::ToBase64String($bytes)
}

function Ensure-ProjectLayout {
  param([string]$Root)

  if (-not (Test-Path (Join-Path $Root "docker-compose.yml"))) {
    throw "Can't find docker-compose.yml in $Root"
  }

  if (-not (Test-Path (Join-Path $Root "frontend"))) {
    throw "Can't find frontend/ in $Root"
  }
}

function Get-ContainerRuntimeInfo {
  param([string]$Preference = "Auto")

  $normalizedPreference = if ([string]::IsNullOrWhiteSpace($Preference)) { "auto" } else { $Preference.Trim().ToLowerInvariant() }

  $candidates = switch ($normalizedPreference) {
    "docker" { @("docker", "docker-compose") }
    "podman" { @("podman", "podman-compose") }
    "auto" { @("docker", "podman", "docker-compose", "podman-compose") }
    default { throw "Invalid ContainerRuntime '$Preference'. Use Auto, Docker, or Podman." }
  }

  foreach ($candidate in $candidates) {
    switch ($candidate) {
      "docker" {
        if (Get-Command docker -ErrorAction SilentlyContinue) {
          try {
            $null = & docker compose version
            return @{
              EngineCommand = "docker"
              EngineLabel = "Docker"
              ComposeCommand = @("docker", "compose")
              ComposeDisplay = "docker compose"
            }
          } catch {
          }
        }
      }
      "podman" {
        if (Get-Command podman -ErrorAction SilentlyContinue) {
          try {
            $null = & podman compose version
            return @{
              EngineCommand = "podman"
              EngineLabel = "Podman"
              ComposeCommand = @("podman", "compose")
              ComposeDisplay = "podman compose"
            }
          } catch {
          }
        }
      }
      "docker-compose" {
        if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
          try {
            $null = & docker-compose version
            return @{
              EngineCommand = "docker"
              EngineLabel = "Docker"
              ComposeCommand = @("docker-compose")
              ComposeDisplay = "docker-compose"
            }
          } catch {
          }
        }
      }
      "podman-compose" {
        if (Get-Command podman-compose -ErrorAction SilentlyContinue) {
          try {
            $null = & podman-compose version
            return @{
              EngineCommand = "podman"
              EngineLabel = "Podman"
              ComposeCommand = @("podman-compose")
              ComposeDisplay = "podman-compose"
            }
          } catch {
          }
        }
      }
    }
  }

  if ($normalizedPreference -eq "docker") {
    throw "Docker Compose was requested, but 'docker compose' or 'docker-compose' is not available."
  }
  if ($normalizedPreference -eq "podman") {
    throw "Podman Compose was requested, but 'podman compose' or 'podman-compose' is not available."
  }

  throw "No supported container runtime was found. Install Docker Desktop or Podman Desktop, or rerun with -ContainerRuntime Docker|Podman."
}

function Write-WabiEnvFiles {
  param(
    [string]$Root,
    [string]$ResolvedDomain,
    [string]$ResolvedPublicIp,
    [bool]$EnableTurn,
    [string]$ResolvedGiphyApiKey
  )

  $envPath = Join-Path $Root ".env"
  $frontendEnvPath = Join-Path $Root "frontend/.env"
  $caddyPath = Join-Path $Root "Caddyfile"

  $jwtSecret = New-SecretBase64
  $turnSecret = New-SecretBase64

  $hasDomain = -not [string]::IsNullOrWhiteSpace($ResolvedDomain)
  if ($hasDomain) {
    $baseUrl = "https://$ResolvedDomain"
    $turnRealm = $ResolvedDomain
  } else {
    $baseUrl = "http://localhost:3000"
    $turnRealm = if ([string]::IsNullOrWhiteSpace($ResolvedPublicIp)) { "127.0.0.1" } else { $ResolvedPublicIp }
  }

  $allowedOrigins = "$baseUrl,https://tauri.localhost,tauri://localhost"
  $viteTurnServer = if ([string]::IsNullOrWhiteSpace($ResolvedPublicIp)) { "127.0.0.1" } else { $ResolvedPublicIp }
  $turnProfileEnabled = if ($EnableTurn) { "true" } else { "false" }

  New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "uploads") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "plugins") | Out-Null

  $envContent = @"
FRONTEND_URL=$baseUrl
PUBLIC_URL=$baseUrl
ALLOWED_ORIGINS=$allowedOrigins
NODE_ENV=production
PORT=8080

# Generated by scripts/setup-forWindows.ps1
WABI_MODE=normal
WABI_RUNTIME=node
DB_MODE=sqlite
DATABASE_PATH=/app/data/chat.db
STATE_BACKEND_MODE=legacy
STATE_STDB_READ_ENABLED=false
STATE_STDB_MESSAGE_READ_CANARY_PERCENT=10
STATE_STDB_CHANNEL_READ_CANARY_PERCENT=10
STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT=10
STATE_STDB_USER_READ_CANARY_PERCENT=10
STATE_STDB_SESSION_READ_CANARY_PERCENT=10
STATE_STDB_RBAC_READ_CANARY_PERCENT=10
STATE_SHADOW_WARMUP_ENABLED=true
STATE_SHADOW_WARMUP_LIMIT=25000
STATE_STDB_WRITE_ENABLED=false
STATE_STDB_SUBSCRIPTIONS_ENABLED=false
STATE_STDB_ENFORCE_RBAC=true
STATE_BACKEND_STRICT=false
STATE_OUTBOX_PATH=
STATE_OUTBOX_REDACT_SENSITIVE=true
STATE_OUTBOX_MAX_BYTES=67108864
STATE_OUTBOX_TRUNCATE_MIN_BYTES=16777216
STATE_SHADOW_WRITER_ENABLED=false
STATE_SHADOW_SINK=mirror
STATE_SHADOW_ENDPOINT=
STATE_SHADOW_TOKEN=
STATE_SHADOW_SIGNING_SECRET=
STATE_SHADOW_SIGNING_KEY_ID=
STATE_SHADOW_COMMAND=
STATE_SHADOW_COMMAND_TIMEOUT_MS=10000
STATE_PLANE_SCHEMA_VERSION=1
STATE_PLANE_SCHEMA_AUTO_APPLY=true
STATE_REDUCER_INGRESS_ENABLED=false
STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true
STATE_REDUCER_INGRESS_MAX_SKEW_MS=300000
STATE_REDUCER_INGRESS_MAX_BODY_BYTES=1048576
STATE_SHADOW_POLL_INTERVAL_MS=1000
STATE_SHADOW_BATCH_SIZE=250
WABI_STDB_BRIDGE_MODE=spacetime-call
WABI_STDB_BRIDGE_SERVER=local
WABI_STDB_BRIDGE_DATABASE=
WABI_STDB_BRIDGE_REDUCER=ingest_wabi_event
WABI_STDB_BRIDGE_MAP_FILE=
WABI_STDB_BRIDGE_TIMEOUT_MS=10000
WABI_STDB_AUTH_TOKEN=
WABI_STDB_ANONYMOUS=false
WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=false
WEBHOOK_MAX_BODY_BYTES=65536
WEBHOOK_ALLOW_PRIVATE_TARGETS=false
WEBHOOK_ALLOWED_HOSTS=
WEBHOOK_MAX_DNS_RECORDS=16
WEBHOOK_MAX_CONCURRENT_DELIVERIES=20
WEBHOOK_MAX_EVENT_FANOUT=250

JWT_SECRET=$jwtSecret

DATA_DIR=/app/data
PLUGINS_DIR=/app/plugins
PLUGINS_ENABLED=false
PLUGINS_ALLOW_INSTALL=false
WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED=false
STATIC_DIR=/app/frontend/build

TURN_EXTERNAL_IP=$viteTurnServer
TURN_REALM=$turnRealm
TURN_SHARED_SECRET=$turnSecret
TURN_CREDENTIAL_TTL_SECONDS=3600

MEDIA_LOCAL_ENHANCED_ENABLED=true
MEDIA_SRT_GATEWAY_ENABLED=false
MEDIA_SRT_GATEWAY_URL=
MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS=45000
MEDIA_GATEWAY_KEY=
MEDIA_SRT_SESSION_TTL_SECONDS=900
MEDIA_SRT_BASE_PORT=7000
MEDIA_GATEWAY_ORIGIN_URL=http://backend:8080
MEDIA_GATEWAY_REGION=local
MEDIA_GATEWAY_HEARTBEAT_INTERVAL_MS=15000
MEDIA_GATEWAY_SESSION_SYNC_INTERVAL_MS=10000
SFU_PROVIDER=none
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
CLOUDFLARE_TUNNEL_TOKEN=
TUNNEL_CONNECTOR=named

OPENMOJI_VERSION=15.1.0
ENABLE_TURN_PROFILE=$turnProfileEnabled
VITE_TURN_SERVER=$viteTurnServer
VITE_TURN_PORT=3478
VITE_USE_TURNS=false
VITE_ENABLE_GOOGLE_STUN=true
VITE_SOCKET_URL=
VITE_GIPHY_API_KEY=$ResolvedGiphyApiKey
"@

  $frontendEnvContent = @"
VITE_SOCKET_URL=
VITE_GIPHY_API_KEY=$ResolvedGiphyApiKey
VITE_TURN_SERVER=$viteTurnServer
VITE_TURN_PORT=3478
VITE_USE_TURNS=false
VITE_ENABLE_GOOGLE_STUN=true
VITE_VIDEO_COMPRESSION_CLIENT_METRICS=false
"@

  if ($hasDomain) {
    $caddyContent = @"
$ResolvedDomain {
    @backend {
        path /socket.io/* /api/* /uploads/* /health /health/*
    }
    reverse_proxy @backend localhost:8080
    reverse_proxy localhost:3000
}

gateway.$ResolvedDomain {
    reverse_proxy localhost:8095
}
"@
  } else {
    $caddyContent = @"
:80 {
    @backend {
        path /socket.io/* /api/* /uploads/* /health /health/*
    }
    reverse_proxy @backend localhost:8080
    reverse_proxy localhost:3000
}

# Optional gateway host template:
# gateway.example.com {
#     reverse_proxy localhost:8095
# }
"@
  }

  Set-Content -Path $envPath -Value $envContent -Encoding UTF8
  Set-Content -Path $frontendEnvPath -Value $frontendEnvContent -Encoding UTF8
  Set-Content -Path $caddyPath -Value $caddyContent -Encoding UTF8

  Write-Ok ".env"
  Write-Ok "frontend/.env"
  Write-Ok "Caddyfile"

  return @{
    BaseUrl = $baseUrl
    TurnEnabled = $EnableTurn
    HasDomain = $hasDomain
  }
}

Ensure-ProjectLayout -Root $OutputRoot

Write-Host ""
Write-Host "  Wabi Windows Server Setup" -ForegroundColor Cyan
Write-Host "  This generates server config files for container-based hosting."
Write-Host ""
Write-Host "  Checking prerequisites..."
Write-Host ""

$runtimeInfo = Get-ContainerRuntimeInfo -Preference $ContainerRuntime
Write-Ok "$($runtimeInfo.EngineLabel) installed"
Write-Ok "Compose available via $($runtimeInfo.ComposeDisplay)"

$resolvedDomain = Normalize-DomainValue -Value $Domain
if ($Domain -and $null -eq $resolvedDomain) {
  throw "The provided domain '$Domain' is invalid."
}

$detectedPublicIp = Get-DetectedPublicIp

if ($NonInteractive) {
  if ([string]::IsNullOrWhiteSpace($PublicIp)) {
    $PublicIp = if ($detectedPublicIp) { $detectedPublicIp } else { "127.0.0.1" }
  }
} else {
  if ([string]::IsNullOrWhiteSpace($Domain)) {
    $domainInput = Read-TrimmedLine "Do you have a public domain pointed at this server? (enter domain or 'no')"
    $candidateDomain = Normalize-DomainValue -Value $domainInput
    if ($null -eq $candidateDomain -and -not [string]::IsNullOrWhiteSpace($domainInput) -and $domainInput.ToLowerInvariant() -notin @("no", "n")) {
      Write-Warn "'$domainInput' does not look like a valid domain. Continuing with localhost/direct mode."
      $candidateDomain = ""
    }
    $resolvedDomain = $candidateDomain
  }

  if ([string]::IsNullOrWhiteSpace($PublicIp)) {
    if ($detectedPublicIp) {
      if (Confirm-DefaultYes "Detected public IP $detectedPublicIp. Use it? [Y/n]") {
        $PublicIp = $detectedPublicIp
      }
    }
    if ([string]::IsNullOrWhiteSpace($PublicIp)) {
      $PublicIp = Read-TrimmedLine "Public IP for TURN/direct access (blank for 127.0.0.1)"
    }
    if ([string]::IsNullOrWhiteSpace($PublicIp)) {
      $PublicIp = "127.0.0.1"
    }
  }

  if (-not $DisableTurn.IsPresent) {
    if (-not (Confirm-DefaultYes "Enable TURN profile for voice/video? [Y/n]")) {
      $DisableTurn = $true
    }
  }

  if ([string]::IsNullOrWhiteSpace($GiphyApiKey)) {
    $GiphyApiKey = Read-TrimmedLine "Optional Giphy API key (press Enter to skip)"
  }
}

if ([string]::IsNullOrWhiteSpace($PublicIp)) {
  $PublicIp = "127.0.0.1"
}

$result = Write-WabiEnvFiles `
  -Root $OutputRoot `
  -ResolvedDomain $(if ($null -eq $resolvedDomain) { "" } else { $resolvedDomain }) `
  -ResolvedPublicIp $PublicIp `
  -EnableTurn (-not $DisableTurn.IsPresent) `
  -ResolvedGiphyApiKey $(if ($null -eq $GiphyApiKey) { "" } else { $GiphyApiKey })

Write-Host ""
Write-Host "  Next steps" -ForegroundColor Cyan
Write-Host ""
if ($result.HasDomain) {
  Write-Host "  1. If you are using a reverse proxy, load the generated Caddyfile (or adapt it to your proxy)." -ForegroundColor White
} else {
  Write-Host "  1. Start the stack directly with $($runtimeInfo.ComposeDisplay)." -ForegroundColor White
}

if ($result.TurnEnabled) {
  Write-Host "     $($runtimeInfo.ComposeDisplay) --profile turn up -d --build" -ForegroundColor Gray
} else {
  Write-Host "     $($runtimeInfo.ComposeDisplay) up -d --build" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  2. Open the server:" -ForegroundColor White
Write-Host "     $($result.BaseUrl)" -ForegroundColor Gray
Write-Host ""
Write-Host "  3. The first account created becomes the admin." -ForegroundColor White
Write-Host ""
