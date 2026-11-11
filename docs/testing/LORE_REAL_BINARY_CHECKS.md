# Lore checks against the real `lore` program

Written 2026-11-11. **Not yet run.** Nothing below has been executed against the real program; this page says how to do it and what to send back.

## Why

Every Lore test in this repository runs against a shell stand-in for the `lore` program. The stand-in prints fixed answers and keeps no branches or commits. So the tests show that Wabi sends the commands it should, and not that the real program reacts the way Wabi assumes. Several changes in November 2026 (Tasks 4.1, 4.8 and 4.8b in `docs/plans/2026-11-06-backend-plan.md`) depend on branch behaviour the stand-in cannot show.

The checks live in `core/addons/lore/backend/tests/real_lore_binary.rs`. They are marked `#[ignore]`, CI never runs them, and they refuse to start without the real program.

## Safety

- Each check makes its own repository in a temporary directory and deletes it afterwards. Nothing reads or writes a real Wabi data directory.
- Do not point anything here at `data/` or at a repository you care about.
- Wabi runs `lore` with `HOME=/var/wabi/lore` (`run_lore` in `core/addons/lore/backend/src/lib.rs`). If the real program needs a home directory that exists, a check may fail for that reason alone. That is a finding: report it, and do not create or change that directory on a machine that also runs a real Wabi server without checking what is in it first.

## Paste this into a Claude Code session on the machine that has `lore`

```
Read AGENTS.md and docs/testing/LORE_REAL_BINARY_CHECKS.md, then do what that page says. This is a checking task: change no code unless the page says so, commit nothing, push nothing, and do not touch any real Wabi data directory.

1. Find the real lore program and report its path and version (try `lore --version`, `which lore` or `where lore`; if Wabi runs in Docker here, say so and say where lore lives).
2. Run the command in the "Run" section, with WABI_LORE_REAL_BINARY set to that path.
3. If a check fails to start because of the test code itself and not because of how lore behaves (a wrong argument, a path problem on this operating system), say exactly what and fix only the test file core/addons/lore/backend/tests/real_lore_binary.rs so that it reaches the real question. Never loosen an assertion to make it pass.
4. For any failed assertion, reproduce it by hand with the lore program in a temporary directory and report the exact commands and output.
5. Give me the report in the format under "What to send back", with the full output of the run attached or pasted.
```

## Run

Linux or macOS:

```bash
WABI_LORE_REAL_BINARY="$(command -v lore)" cargo test -p wabi-lore --test real_lore_binary -- --ignored --nocapture --test-threads=1
```

Windows PowerShell:

```powershell
$env:WABI_LORE_REAL_BINARY = (Get-Command lore).Source; cargo test -p wabi-lore --test real_lore_binary -- --ignored --nocapture --test-threads=1
```

The answers are the lines that start with `OBSERVED`.

If `lore` only exists inside a container, run the same command inside it from a checkout of this repository, or copy the program out. Say which you did.

## What each check answers

| Check | Question | If it fails or surprises |
|---|---|---|
| `q1_review_branch_upload_leaves_the_mainline_untouched` | After an upload that goes to a review branch, are the mainline's files and current branch exactly as before? Does a later direct commit stay free of the review bytes? | Serious. Tasks 4.1 and 4.8b assume yes. A member without `lore.commit` would be changing what everyone reads. |
| `approving_a_review_branch_lands_its_bytes_on_the_mainline` | Does approve put the review bytes on the mainline and leave the tree on the mainline? | Review flow is broken on the real program. |
| `q3_first_branch_name_and_direct_promote_to_main` | What is a new repository's first branch called? The promote handler and `set_binding` default to the literal `main`. | If it is not `main`, a default promote fails at the branch switch. The default has to come from the repository. |
| `q2_observe_a_staged_file_across_a_branch_switch` | Does a staged, uncommitted file follow a branch switch? What does a retry of the same path do afterwards? | Observation only. If the file follows, a promote that fails after staging leaves it on the mainline. |
| `q5_observe_a_restart_while_on_a_review_branch` | If the server stops while the tree is on a review branch, where does the next direct upload land? | Observation only. Known gap: nothing puts the tree back at startup. |
| `basic_direct_operations_work` | Upload, second revision, identical bytes again, delete, health check. | The basics differ from what the stand-in pretends. |

## Checks in the running app (need a browser, not covered above)

Do these on a throwaway Lore channel, as two users: one with a role that has `lore.stage` and not `lore.commit` (the seeded Artist role), and one who can commit and approve.

1. As the artist, upload a file to a repository whose review setting is off. Expected: the upload is reported as waiting for review, and the file list on the mainline does not show the new bytes.
2. As the artist, try to delete a file. Expected: refused. Note what the screen says; the Lore screen still offers the button.
3. As the approver, approve the artist's upload. Expected: the file appears on the mainline.
4. Bind a chat channel to the repository with path prefix `/assets`, then promote a chat attachment. Expected: the file lands at `assets/<name>` and the tree is back on its original branch. No automated test drives this end to end.
5. The promote dialog reads `pendingReview` and `reviewBranch`, but the API answers `pending_review` and `review_branch`, so it is expected to say "Committed" even for a staged promote. Confirm or refute.

## What to send back

```
lore program: <path>, <version>, <operating system>, <native or in a container>
command run: <the exact command>
result line: <the "test result:" line>

per check: passed / failed / changed the test to reach the question (say what changed)
q3 first branch name:
q1 mainline untouched: yes / no, with the OBSERVED lines
approve: worked / failed, with the OBSERVED lines
q2 staged file follows a branch switch: yes / no; retry of the same path: <what happened>
q5 upload after restart landed on: mainline / the left-behind branch / failed
basic: identical-bytes upload: <what happened>

anything that failed because of HOME=/var/wabi/lore or another environment reason:
app checks 1 to 5, if done: what happened in each
full output: <attached or pasted>
```
