#!/usr/bin/env bash
# Sequential PR merge orchestrator — waits for the 'test' check (ci.yml gate)
# to succeed on each PR head, then squash-merges. Resumable: skips merged PRs.
set -u
export PATH="$HOME/.local/bin:$PATH"
REPO=AzureFoxStudios/wabi
ORDER=(216 200 199 210 212 208 187 196 202 204 205 207)

head_sha() { gh api "repos/$REPO/pulls/$1" --jq .head.sha 2>/dev/null; }
merged()   { [ "$(gh api "repos/$REPO/pulls/$1" --jq .state 2>/dev/null)" = "merged" ]; }

test_check() { # sha -> prints success|failed|pending|absent
  local sha="$1" out
  out=$(gh api "repos/$REPO/commits/$sha/check-runs?per_page=100" 2>/dev/null | \
    jq -r '[.check_runs[] | select(.name=="test")] | if length==0 then "absent" else (map(.conclusion) | if any(. == null) then "pending" elif any(. == "failure") then "failed" else "success" end) end')
  echo "${out:-absent}"
}

for pr in "${ORDER[@]}"; do
  if merged "$pr"; then echo "[$(date +%H:%M)] #$pr already merged, skip"; continue; fi
  sha=$(head_sha "$pr")
  echo "[$(date +%H:%M)] #$pr waiting on test check (head ${sha:0:9})"
  waited=0; st="absent"
  while :; do
    st=$(test_check "$sha")
    case "$st" in
      success) echo "[$(date +%H:%M)] #$pr test check success -> merging"; break;;
      failed)  echo "[$(date +%H:%M)] #$pr TEST CHECK FAILED - skipping"; break;;
      absent)  if [ $waited -gt 2700 ]; then echo "[$(date +%H:%M)] #$pr no test check after 45min - skip"; break; fi ;;
      pending) if [ $waited -gt 5400 ]; then echo "[$(date +%H:%M)] #$pr still pending after 90min - skip"; break; fi ;;
    esac
    sleep 60; waited=$((waited+60))
    newsha=$(head_sha "$pr")
    if [ "$newsha" != "$sha" ]; then sha=$newsha; echo "    [$ (date +%H:%M)] head moved to ${sha:0:9}, restarting wait"; fi
  done
  if [ "$st" = "success" ]; then
    if gh pr merge "$pr" --repo "$REPO" --squash; then
      echo "[$(date +%H:%M)] #$pr MERGED"
    else
      echo "[$(date +%H:%M)] #$pr MERGE COMMAND FAILED"
    fi
  fi
done
echo "[$(date +%H:%M)] orchestrator done"
