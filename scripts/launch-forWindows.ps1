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

  return "'" + ($Value -replace "'", "'\"'\"'") + "'"
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
  throw "WSL is required for scripts/launch-forWindows.ps1. Install WSL, then run this script again."
}

$repoRootWsl = Convert-WindowsPathToWsl -Path $repoRoot.Path
$quotedArgs = @($args | ForEach-Object { Quote-BashArg -Value "$_" }) -join " "
$bashCommand = "cd $(Quote-BashArg -Value $repoRootWsl) && ./scripts/launch.sh $quotedArgs"

Write-Host "[launch-forWindows] Using WSL to run scripts/launch.sh"
wsl.exe bash -lc $bashCommand
