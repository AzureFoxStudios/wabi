# Campaign closure audit — 2026-09-17

Source baseline: c6b69517, production-finish isolated worktree. This is not a completion certificate.

## Verified implementation blockers being repaired

- GF07 Files: FilesWorkspace.svelte used non-subscribing get(store) derived values; unfenced discovery/list/search/preview/download/upload continuations; hidden discovery failures; no listing retry; repeated destination upload keys and timed removal of failed uploads. A scoped worker owns the component/session helper/tests. Implementation and independent verification remain pending.
- R03/C05 build: PR #234 Android CI fails E0599 at src-tauri/src/lore_local.rs because pick_folder is desktop-only in tauri-plugin-dialog. A separate scoped worker owns target gating without changing desktop functionality. A passing desktop build alone cannot verify Android.
- Integration: ten frontend dependency updates are in PR #235, not fifteen. Rust bumps #219/#221/#224/#225/#227 are not integrated or verified. Feature PRs #233/#217/#207/#184 require completed reviews; #233 has Windows archive test failures beyond inherited boot failures; #184 conflicts with current main. No blanket merge recommendation.

## Closed on this candidate at automated-check level

- GF01–GF06: commits 0de4e9b3, 55db034c, 76b965ae and b69bac10; frontend 912 pass/3 skip/0 fail; check 0 errors/167 warnings; static build; Gallery feedback backend contract 4/4. Rendered acceptance is still open.
- Boot brand default mismatch: c6b69517, reproduced two failures then 7/7 target passes.
- Full locked wabi-server run: 586 test executions, 0 fail, 2 ignored across 25 targets. Library/binary duplicate unit executions are included; this is not 586 distinct behaviors or whole-workspace coverage.

## Explicit existing product limits, not silently expanded scope

- Local Notes profile-annotation legacy mapping is not implemented; original source bytes remain recoverable and the UI/docs disclose manual recovery. N02 still records this open item.
- Multipart notebook backups are explicitly future work in docs/features/LOCAL_NOTES.md; current export/import limits match (20 MB, 10,000 notes, 100,000 references), with individual downloads. Do not claim multipart support or fabricate migration acceptance.
- Experimental encryption, standby/replication and optional Lore services retain their documented limits. Core DMs are server-readable. No new federation/HA/confidentiality claim.

## Acceptance-only work still required

- Real rendered Gallery and Files journeys, multi-surface draft/selection behavior, reload/restart, errors/retry, context retirement; all other exposed workspace records must identify tested scope rather than treating a navigation label as acceptance.
- Full theme/keyboard/zoom/constrained-panel/phone review and measured performance, beyond existing narrow fixtures.
- Physical Linux/Windows/Redmi installation, microphones/cameras/screenshare and independent-network calling/capacity; synthetic or browser viewport tests do not certify these.
- Isolated hosted-copy upgrade/restore/rollback, independent operator walkthrough and deployed-policy checks. Existing disposable same-binary rehearsal is not hosted-copy acceptance.
- Historical exposure disposition: no match between inspected live keys and historical key versions was recorded, but historical community data/exposure remains unresolved. No rotation or history rewriting is authorized by a test result.
- Final release identity/artifacts, deliberate deployment, public/authenticated runtime verification and actual pilot feedback. No deployment in this session.

## Evidence and current blockers

Server log: /var/home/Ronin/wabi-campaign-server-tests.log (private local path; no credentials/content copied here).
PRs: https://github.com/AzureFoxStudios/wabi/pull/234 and https://github.com/AzureFoxStudios/wabi/pull/235.
Both Hermes review subagents failed with provider HTTP 429. Their unfinished reviews are not evidence. Browser tool refused the private localhost URL; no new rendered acceptance was obtained through that tool.
