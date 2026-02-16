param(
  [Parameter(Mandatory = $true)]
  [string]$Title,

  [string]$Body = "",

  [string]$Base = "",

  [switch]$Draft,

  [switch]$AutoMerge,

  [ValidateSet("merge", "squash", "rebase")]
  [string]$AutoMergeMethod = "squash",

  [switch]$DeleteBranch
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' is not installed or not on PATH."
  }
}

function Run-Cmd {
  param([string]$Command)
  Write-Host ">> $Command"
  Invoke-Expression $Command
}

Require-Command "git"
Require-Command "gh"

$insideRepo = (git rev-parse --is-inside-work-tree 2>$null)
if ($insideRepo -ne "true") {
  throw "Current directory is not a git repository."
}

$branch = (git branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) {
  throw "Could not determine current branch."
}
if ($branch -eq "main" -or $branch -eq "master") {
  throw "Refusing to open a PR from '$branch'. Check out a feature branch first."
}

if ([string]::IsNullOrWhiteSpace($Base)) {
  $headRef = (git symbolic-ref refs/remotes/origin/HEAD 2>$null).Trim()
  if (-not [string]::IsNullOrWhiteSpace($headRef) -and $headRef.Contains("/")) {
    $Base = $headRef.Split("/")[-1]
  } else {
    $Base = "main"
  }
}

$remoteExists = (git remote) -contains "origin"
if (-not $remoteExists) {
  throw "Remote 'origin' does not exist."
}

Run-Cmd "git push -u origin $branch"

$repo = (git remote get-url origin).Trim()
if ($repo.EndsWith(".git")) {
  $repo = $repo.Substring(0, $repo.Length - 4)
}
if ($repo.StartsWith("https://github.com/")) {
  $repo = $repo.Replace("https://github.com/", "")
} elseif ($repo.StartsWith("git@github.com:")) {
  $repo = $repo.Replace("git@github.com:", "")
}

$existing = gh pr list --repo $repo --head $branch --state open --json number,url,title | ConvertFrom-Json

if ($existing.Count -gt 0) {
  $pr = $existing[0]
  Write-Host "Open PR already exists: #$($pr.number) $($pr.url)"
  Run-Cmd "gh pr edit $($pr.number) --repo $repo --title `"$Title`""
  if (-not [string]::IsNullOrWhiteSpace($Body)) {
    Run-Cmd "gh pr edit $($pr.number) --repo $repo --body `"$Body`""
  }
  $prNumber = $pr.number
} else {
  $draftFlag = ""
  if ($Draft) {
    $draftFlag = "--draft"
  }

  $bodyArg = ""
  if (-not [string]::IsNullOrWhiteSpace($Body)) {
    $bodyArg = "--body `"$Body`""
  } else {
    $bodyArg = "--fill"
  }

  $createCmd = "gh pr create --repo $repo --head $branch --base $Base --title `"$Title`" $bodyArg $draftFlag"
  Run-Cmd $createCmd

  $created = gh pr list --repo $repo --head $branch --state open --json number,url,title | ConvertFrom-Json
  if ($created.Count -eq 0) {
    throw "PR creation did not return an open PR."
  }
  $prNumber = $created[0].number
  Write-Host "Created PR: #$prNumber $($created[0].url)"
}

if ($AutoMerge) {
  $deleteFlag = ""
  if ($DeleteBranch) {
    $deleteFlag = "--delete-branch"
  }
  Run-Cmd "gh pr merge $prNumber --repo $repo --auto --$AutoMergeMethod $deleteFlag"
}

Write-Host "Done."
