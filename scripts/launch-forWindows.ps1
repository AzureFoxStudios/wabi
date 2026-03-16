#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Quote-BashArg {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  if ($Value -eq "") {
    return "''"
  }

  # Escape single quotes for bash: ' becomes '\''
  # In PowerShell, we use doubled single quotes '' inside single-quoted strings
  # to represent a literal single quote
  $escaped = $Value -replace "'", "''"
  return "'$escaped'"
}

function Convert-WindowsPathToWsl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if ($Path -match "^([A-Za-z]):\\(.*)$") {
    $drive = $matches[1].ToLower()
    $rest = ($matches[2] -replace "\\", "/")
    return "/mnt/$drive/$rest"
  }

  throw "Unable to convert path to WSL format: $Path"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw "WSL is required for scripts/launch-forWindows.ps1. For first-run Windows server setup without WSL, run scripts/setup-forWindows.ps1. Otherwise install WSL and retry."
}

$repoRootWsl = Convert-WindowsPathToWsl -Path $repoRoot.Path
$quotedArgs = @($args | ForEach-Object { Quote-BashArg -Value "$_" }) -join " "
$bashCommand = "cd $(Quote-BashArg -Value $repoRootWsl) && ./scripts/launch.sh $quotedArgs"

Write-Host "[launch-forWindows] Using WSL to run scripts/launch.sh"
wsl.exe bash -lc $bashCommand
