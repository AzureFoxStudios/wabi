#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root ".env"
$templateFile = Join-Path $root "relay-node.env.example"

if (-not (Test-Path $templateFile)) {
  throw "[setup] Missing template: $templateFile"
}

function Get-DefaultRegion {
  try {
    $country = (Invoke-RestMethod -Uri "https://ipapi.co/country/" -TimeoutSec 4).Trim()
    if (-not [string]::IsNullOrWhiteSpace($country)) {
      return $country.ToLowerInvariant()
    }
  } catch {
    # ignore
  }
  return "unknown"
}

function Set-EnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $content = Get-Content -Path $Path -Raw
  $pattern = "(?m)^$([regex]::Escape($Key))=.*$"
  if ($content -match $pattern) {
    $updated = [regex]::Replace($content, $pattern, "$Key=$Value")
  } else {
    $updated = $content.TrimEnd() + [Environment]::NewLine + "$Key=$Value" + [Environment]::NewLine
  }
  Set-Content -Path $Path -Value $updated -NoNewline
}

$defaultName = "relay-$($env:COMPUTERNAME.ToLowerInvariant())"
$defaultRegion = Get-DefaultRegion

Write-Host "Wabi Relay Setup Wizard (Windows)"
Write-Host ""

if (-not (Test-Path $envFile)) {
  Copy-Item -Path $templateFile -Destination $envFile
  Write-Host "[setup] Created .env from template."
} else {
  Write-Host "[setup] Reusing existing .env."
}

$originUrl = Read-Host "Origin URL (example: https://chat.example.com)"
$originUrl = $originUrl.TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($originUrl)) {
  throw "[setup] Origin URL is required."
}

$publicUrl = Read-Host "Public relay URL (must be publicly reachable)"
$publicUrl = $publicUrl.TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($publicUrl)) {
  throw "[setup] Public relay URL is required."
}

$relayName = Read-Host "Relay name [$defaultName]"
if ([string]::IsNullOrWhiteSpace($relayName)) { $relayName = $defaultName }

$relayRegion = Read-Host "Relay region [$defaultRegion]"
if ([string]::IsNullOrWhiteSpace($relayRegion)) { $relayRegion = $defaultRegion }

Set-EnvValue -Path $envFile -Key "RELAY_ORIGIN_URL" -Value $originUrl
Set-EnvValue -Path $envFile -Key "RELAY_PUBLIC_URL" -Value $publicUrl
Set-EnvValue -Path $envFile -Key "RELAY_NAME" -Value $relayName
Set-EnvValue -Path $envFile -Key "RELAY_REGION" -Value $relayRegion

Write-Host ""
Write-Host "[setup] Saved relay configuration to $envFile"
Write-Host "[setup] Next step:"
Write-Host "  docker compose up -d --build"
