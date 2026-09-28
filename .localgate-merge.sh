#!/usr/bin/env bash
# Local-gate merge: validate each PR branch with the same toolchains CI uses
# (bun test + svelte-check), then squash-merge. Logs to stdout.
set -u
export PATH="$HOME/.local/bin:$PATH"
cd /home/ironin/wabi

merge_pr() { # pr branch
  local pr="$1" branch="$2"
  echo "=== #$pr ($branch) local gate"
  git checkout -q "$branch" 2>/dev/null || { echo "  CHECKOUT FAILED"; return 1; }
  ( cd frontend && bun install >/dev/null 2>&1 )
  local test_out check_out
  test_out=$( ( cd frontend && bun test src/lib 2>&1 | tail -5 ) )
  check_out=$( ( cd frontend && bun run check 2>&1 | tail -2 ) )
  echo "$test_out" | grep -E "Ran|fail" | sed 's/^/  /'
  echo "$check_out" | sed 's/^/  /'
  if echo "$test_out" | grep -qE " 0 fail" && echo "$check_out" | grep -q " 0 errors"; then
    for attempt in 1 2 3; do
      if gh pr merge "$pr" --repo AzureFoxStudios/wabi --squash 2>&1; then
        echo "  #$pr MERGED"; return 0
      fi
      echo "  merge attempt $attempt failed (network?); retrying in 20s"; sleep 20
    done
    echo "  #$pr MERGE FAILED after retries"; return 1
  fi
  echo "  #$pr LOCAL GATE RED - not merged"; return 1
}

merge_pr 200 polish/public-site-seo-legal
merge_pr 199 feature/chat-backdrops-koi
merge_pr 210 fix/joker-shader-fidelity
merge_pr 212 feat/emote-library-ux
merge_pr 208 feat/translator-assist-addon
merge_pr 187 feat/mobile-first-2026-09-12
merge_pr 196 fix/mobile-native-green-2026-09-13
echo "=== local-gate batch done"
