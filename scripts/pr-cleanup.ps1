param(
  [ValidateSet("codex", "all", "author")]
  [string]$Scope = "codex",

  [string]$Author = "",

  [switch]$KeepNewestPerTopic,

  [switch]$DeleteBranch,

  [switch]$Apply,

  [string]$Reason = "Closing stale Codex PR backlog in favor of a consolidated branch."
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' is not installed or not on PATH."
  }
}

function Invoke-GhJson {
  param([string[]]$GhArgs)
  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()
  $proc = Start-Process -FilePath "gh" -ArgumentList $GhArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
  $output = Get-Content $stdoutFile -Raw
  $stderr = Get-Content $stderrFile -Raw
  Remove-Item $stdoutFile -Force
  Remove-Item $stderrFile -Force
  if ($proc.ExitCode -ne 0) {
    throw "gh $($GhArgs -join ' ') failed: $stderr"
  }
  if (-not [string]::IsNullOrWhiteSpace($stderr)) {
    Write-Host $stderr.Trim()
  }
  $jsonText = ($output | Out-String).Trim()
  $startArray = $jsonText.IndexOf("[")
  $startObject = $jsonText.IndexOf("{")
  $start = -1
  if ($startArray -ge 0 -and $startObject -ge 0) {
    $start = [Math]::Min($startArray, $startObject)
  } elseif ($startArray -ge 0) {
    $start = $startArray
  } elseif ($startObject -ge 0) {
    $start = $startObject
  }
  $end = [Math]::Max($jsonText.LastIndexOf("]"), $jsonText.LastIndexOf("}"))

  if ($start -lt 0 -or $end -lt $start) {
    throw "gh $($GhArgs -join ' ') returned non-JSON output: $jsonText"
  }

  $prefix = $jsonText.Substring(0, $start).Trim()
  $suffix = $jsonText.Substring($end + 1).Trim()
  if (-not [string]::IsNullOrWhiteSpace($prefix)) {
    Write-Host $prefix
  }
  if (-not [string]::IsNullOrWhiteSpace($suffix)) {
    Write-Host $suffix
  }

  $jsonOnly = $jsonText.Substring($start, $end - $start + 1)
  return ($jsonOnly | ConvertFrom-Json)
}

function Invoke-Gh {
  param([string[]]$GhArgs)
  Write-Host ">> gh $($GhArgs -join ' ')"
  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()
  $proc = Start-Process -FilePath "gh" -ArgumentList $GhArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
  $stdout = Get-Content $stdoutFile -Raw
  $stderr = Get-Content $stderrFile -Raw
  Remove-Item $stdoutFile -Force
  Remove-Item $stderrFile -Force
  if ($proc.ExitCode -ne 0) {
    throw "gh $($GhArgs -join ' ') failed: $stderr"
  }
  if (-not [string]::IsNullOrWhiteSpace($stdout)) {
    Write-Host $stdout.Trim()
  }
  if (-not [string]::IsNullOrWhiteSpace($stderr)) {
    Write-Host $stderr.Trim()
  }
}

function Normalize-Topic {
  param([string]$HeadRefName)
  if ([string]::IsNullOrWhiteSpace($HeadRefName)) {
    return "unknown"
  }

  $topic = $HeadRefName.ToLowerInvariant()
  # Normalize Codex branch suffixes like "-bzgh5x" or "-a1b2c3d4".
  $topic = $topic -replace '-[a-z0-9]{6,10}$', ''
  return $topic
}

function Resolve-RepoFromOrigin {
  $repoUrl = (git remote get-url origin).Trim()
  if ($repoUrl.EndsWith(".git")) {
    $repoUrl = $repoUrl.Substring(0, $repoUrl.Length - 4)
  }
  if ($repoUrl.StartsWith("https://github.com/")) {
    return $repoUrl.Replace("https://github.com/", "")
  }
  if ($repoUrl.StartsWith("git@github.com:")) {
    return $repoUrl.Replace("git@github.com:", "")
  }
  throw "Could not parse GitHub repo from origin URL: $repoUrl"
}

Require-Command "git"
Require-Command "gh"

$insideRepo = (git rev-parse --is-inside-work-tree 2>$null)
if ($insideRepo -ne "true") {
  throw "Current directory is not a git repository."
}

if ($Scope -eq "author" -and [string]::IsNullOrWhiteSpace($Author)) {
  throw "Scope 'author' requires -Author."
}

$repo = Resolve-RepoFromOrigin

$prs = Invoke-GhJson -GhArgs @(
  "pr", "list",
  "--repo", $repo,
  "--state", "open",
  "--limit", "200",
  "--json", "number,title,headRefName,createdAt,url,author,isDraft"
)

if ($null -eq $prs -or $prs.Count -eq 0) {
  Write-Host "No open PRs found in $repo."
  exit 0
}

$filtered = @()
switch ($Scope) {
  "codex" {
    $filtered = $prs | Where-Object {
      $_.headRefName -like "codex/*" -or $_.title -like "Codex-generated pull request*"
    }
  }
  "author" {
    $filtered = $prs | Where-Object { $_.author.login -eq $Author }
  }
  default {
    $filtered = $prs
  }
}

if ($filtered.Count -eq 0) {
  Write-Host "No PRs matched scope '$Scope'."
  exit 0
}

$targets = @()
if ($KeepNewestPerTopic) {
  $groups = $filtered | Group-Object { Normalize-Topic $_.headRefName }
  foreach ($group in $groups) {
    $ordered = $group.Group | Sort-Object createdAt -Descending
    $toClose = @($ordered | Select-Object -Skip 1)
    if ($toClose.Count -gt 0) {
      $targets += $toClose
    }
  }
} else {
  $targets = $filtered
}

if ($targets.Count -eq 0) {
  Write-Host "Nothing to close after applying filters."
  exit 0
}

Write-Host ""
Write-Host "Repo: $repo"
Write-Host "Scope: $Scope"
if ($KeepNewestPerTopic) {
  Write-Host "Mode: keep newest PR per normalized topic, close older duplicates"
} else {
  Write-Host "Mode: close all matched PRs"
}
Write-Host "Total matched: $($filtered.Count)"
Write-Host "Targets to close: $($targets.Count)"
Write-Host ""

$targets |
  Sort-Object createdAt -Descending |
  Select-Object number,title,headRefName,createdAt,url |
  Format-Table -AutoSize

if (-not $Apply) {
  Write-Host ""
  Write-Host "Dry run only. Re-run with -Apply to close these PRs."
  exit 0
}

foreach ($pr in ($targets | Sort-Object number)) {
  $args = @(
    "pr", "close", "$($pr.number)",
    "--repo", $repo
  )
  if ($DeleteBranch) {
    $args += "--delete-branch"
  }
  Invoke-Gh -GhArgs $args
}

Write-Host ""
Write-Host "Cleanup complete."
