#!/usr/bin/env pwsh
param(
	[string]$Plugin = "model-viewer"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceDir = Join-Path $repoRoot "TEST\$Plugin"
$destDir = Join-Path $repoRoot "plugins\$Plugin"
$sourceManifest = Join-Path $sourceDir "plugin.json"
$destManifest = Join-Path $destDir "plugin.json"

if (-not (Test-Path $sourceDir)) {
	throw "[plugin-install] Test plugin not found: $sourceDir"
}

if (-not (Test-Path $sourceManifest)) {
	throw "[plugin-install] Missing plugin.json in test plugin: $sourceManifest"
}

Write-Host "[plugin-install] Installing test plugin '$Plugin'"
Write-Host "[plugin-install] Source: $sourceDir"
Write-Host "[plugin-install] Dest:   $destDir"

if (Test-Path $destDir) {
	Remove-Item -Path $destDir -Recurse -Force
}

New-Item -ItemType Directory -Path (Join-Path $repoRoot "plugins") -Force | Out-Null
Copy-Item -Path $sourceDir -Destination $destDir -Recurse -Force

if (-not (Test-Path $destManifest)) {
	throw "[plugin-install] Install failed: destination plugin.json missing at $destManifest"
}

$manifest = Get-Content $destManifest | ConvertFrom-Json
$pluginId = "$($manifest.id)"
$pluginVersion = "$($manifest.version)"
Write-Host "[plugin-install] Installed: id=$pluginId version=$pluginVersion"
Write-Host "[plugin-install] Next: restart backend to load plugin."
