#!/usr/bin/env bash
# Media stack merge: 202 -> 204 -> 205 -> 207, each layer:
# merge latest main -> cargo test --workspace --locked -> bun gate -> squash merge.
set -u
export PATH="$HOME/.local/bin:$PATH"
cd /home/ironin/wabi

merge_layer() { # pr branch
  local pr="$1" branch="$2"
  echo "=== stack #$pr ($branch) $(date +%H:%M)"
  git checkout -q "$branch" || { echo "  CHECKOUT FAILED"; return 1; }
  if ! git merge --no-edit main >/dev/null 2>&1; then
    echo "  MERGE CONFLICT with main - aborting layer"; git merge --abort 2>/dev/null; return 1
  fi
  git push -q origin "$branch" || { echo "  PUSH FAILED"; return 1; }
  if cargo test --workspace --locked > "/tmp/cargo-$pr.log" 2>&1; then
    echo "  cargo: PASS ($(grep -c '^test result: ok' /tmp/cargo-$pr.log) suites)"
  else
    echo "  cargo: FAIL (see /tmp/cargo-$pr.log)"; return 1
  fi
  local test_out check_out
  test_out=$( ( cd frontend && bun install >/dev/null 2>&1; bun test src/lib 2>&1 | tail -4 ) )
  check_out=$( ( cd frontend && bun run check 2>&1 | tail -1 ) )
  echo "$test_out" | grep -E "Ran" | sed 's/^/  bun: /'
  echo "$check_out" | sed 's/^/  /'
  if echo "$test_out" | grep -qE " 0 fail" && echo "$check_out" | grep -q " 0 errors"; then
    gh pr merge "$pr" --repo AzureFoxStudios/wabi --squash 2>&1 | tail -1
    local st; st=$(gh pr view "$pr" --json state --jq .state)
    echo "  #$pr -> $st"
    [ "$st" = "MERGED" ]
  else
    echo "  BUN GATE RED - not merged"; return 1
  fi
}

git checkout -q main && git pull -q --ff-only origin main
merge_layer 202 feat/shared-media-nodes || { echo "stack halted at 202"; exit 1; }
git checkout -q main && git pull -q --ff-only origin main
merge_layer 204 feat/shared-media-node-advertisement || { echo "stack halted at 204"; exit 1; }
git checkout -q main && git pull -q --ff-only origin main
merge_layer 205 feat/shared-media-node-multi-authority || { echo "stack halted at 205"; exit 1; }
git checkout -q main && git pull -q --ff-only origin main
merge_layer 207 feat/media-voice-policy-selective || { echo "stack halted at 207"; exit 1; }
echo "=== stack complete $(date +%H:%M)"
