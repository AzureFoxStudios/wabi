param(
  [string]$Version = "15.1.0",
  [string]$ExpectedSha256 = "",
  [string]$TargetDir = "frontend/static/openmoji/png"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root $TargetDir
$tmp = Join-Path $env:TEMP ("openmoji_" + [Guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tmp "openmoji-72x72-color.zip"
$extractPath = Join-Path $tmp "extract"
$url = "https://github.com/hfg-gmuend/openmoji/releases/download/$Version/openmoji-72x72-color.zip"

New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  Write-Host "[OpenMoji] Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zipPath

  if ($ExpectedSha256 -and $ExpectedSha256.Trim().Length -gt 0) {
    Write-Host "[OpenMoji] Verifying SHA256"
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLowerInvariant()
    $expected = $ExpectedSha256.Trim().ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "SHA256 mismatch. Expected $expected, got $actual"
    }
  } else {
    Write-Warning "[OpenMoji] OPENMOJI_72_SHA256 not set; skipping checksum verification"
  }

  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  New-Item -ItemType Directory -Path $extractPath -Force | Out-Null

  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

  $pngFiles = Get-ChildItem -Path $extractPath -Recurse -Filter *.png -File
  foreach ($file in $pngFiles) {
    Copy-Item -Path $file.FullName -Destination (Join-Path $target $file.Name) -Force
  }

  $count = (Get-ChildItem -Path $target -Filter *.png -File).Count
  if ($count -eq 0) {
    throw "No PNG assets found after extraction"
  }

  $parent = Split-Path -Parent $target
  $manifest = @{
    source = "openmoji"
    version = $Version
    archive = "openmoji-72x72-color.zip"
    count = $count
  } | ConvertTo-Json -Depth 2
  Set-Content -Path (Join-Path $parent "manifest.json") -Value $manifest -Encoding UTF8

  Write-Host "[OpenMoji] Installed $count PNG files to $target"
} finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
}
