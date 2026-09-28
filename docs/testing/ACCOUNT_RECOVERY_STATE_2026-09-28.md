# Ordered account recovery checks — 2026-09-28

**Scope:** Disposable local main Wabi engines and API fixtures. Code state and
code-based ownership recovery passed the component checks below. No production
deployment, WAN receiver run, complete checkpoint or failover gate is claimed.

## Database checks

```text
CARGO_INCREMENTAL=0 cargo test --locked -p wabidb --lib -- recovery_codes auth_revocations sequencer::tests tests::write_completion
```

Result: **42 passed**, zero failures, exit zero.

| Coverage | Passed |
|---|---:|
| New recovery-code transition/admission/actual-engine checks | 8 |
| Existing canonical revocation checks | 7 |
| Existing sequencer admission, grouping, failure and fencing checks | 13 |
| Existing durable completion/replay checks | 14 |

The new cases cover bound single use, permanent consumed-digest refusal,
whole-delta refusal without partial publication, account/floor validation,
bounded schema/stream/record-kind and mixed-command checks, and idempotent
partial import before initialization. Directly queued code reuse accepted only
the first recovery, added one commit and retained all three state changes after
full event replay. A separately queued ownership change prevented stale code
issuance before preparation, without a commit or loss of later writer health.

A separate durably fenced receiver ingested encrypted commit/segment prefixes
from the source, including account registration and the compound recovery.
Code records, owner, global cutoff and account rows matched the source at its
applied watermark. The receiver refused local issuance and retained the same
rows after deleting only its disposable projection snapshot and reopening
through full event replay. This is an in-process transport fixture.

## Hard process exits

```text
CARGO_INCREMENTAL=0 cargo test --locked -p wabidb --features test-harness --lib -- projections::recovery_codes::tests::process_crashes_keep_code_owner_and_session_recovery_together --exact
```

Result: **1 parent test passed**, zero failures, exit zero. That test launched
five separate child processes with these injected exit boundaries:

| Exit boundary | Replayed recovery |
|---|---|
| Before any event write | Old code, owner and session cutoff |
| During stream write | Old code, owner and session cutoff |
| Before commit-index fsync | Old code, owner and session cutoff |
| After commit-index fsync | Consumed code, restored owner and new cutoff |
| After projection update, before response | Consumed code, restored owner and new cutoff |

Each child exited with the expected crash status. Parent reopen reclaimed its
dead process lock without manual deletion and forced full event replay.
Commit-index count and applied watermark agreed with the entire old/new state.
Each reopened engine also accepted a new issuance by its recovered current
owner. These are controlled process crashes, not hardware power-cut tests.

## Server/API integration checks

```text
CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --test account_recovery_contract --test auth_revocation_recovery_contract --test helper_admin_auth_contract --test payment_access_contract --test admin_role_contract --test first_boot_onboarding
```

Result: **66 passed**, zero failures, exit zero, including the direct
cancelled first-owner claim check. One subprocess-only fixture was ignored by
the direct runner; its parent restart test passed.

| Coverage | Passed |
|---|---:|
| New account recovery contract | 13 |
| Existing canonical revocation recovery contract | 6 |
| Helper administration credential/admission contract | 4 |
| Payment access/password-reset contract | 8 |
| Administration/live role and badge contract | 14 |
| First-owner, desktop bootstrap, invite and startup contract | 21 |

The thirteen new cases check issuance/consumption and stale legacy files across
restart/full replay; 32 concurrent attempts with exactly one spend; real HTTP
recovery with one commit for code, owner and global revocation; and real HTTP
recovery/issuance refusal on a fenced writer without false success or returned
codes. The recovered cutoff exceeded a future account cutoff and invalidated
its earlier current-session exemption.

Cancellation cases hold the relevant publication guard, prove an owned worker
is admitted, abort the caller and then release the guard. Issuance, consumption,
compound recovery, first-owner claiming and ordinary owner assignment still publish their committed
state, which remains effective after restart. A transfer queued behind recovery
was refused by its stale expected owner without another commit.

Import tests resume a partial 1,100-code legacy map in bounded batches and
reject malformed JSON, types, invalid/duplicate keys, directories and symlinks
without rewriting the source. Invalid counts, missing accounts, stale ownership
assignment and issuance by a former owner add no commit. No existing permission
assertions were weakened. An earlier nine-case integration run passed before
the final owner-publication and issuance-admission checks were added; the
66-pass command above is the final integration evidence.

## Auth/socket regressions

```text
CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --lib -- state::tests api::auth::tests socket_revocation_tests socket_authentication_tests
```

Result: **32 passed**, zero failures, exit zero. Coverage includes eight state
checks, six auth API checks and eighteen socket auth/revocation executions.
The socket cases run through both existing module inclusion paths: eighteen
executions of nine distinct cases. Existing compiler warnings remain.

The final commands above total **141 passing checks**, including the one parent
that exercises five separate process exits. These are focused checks rather
than a whole-workspace run.

## Boundary and cleanup

These results prove this component's ordered migration, consumption, compound
recovery, replay and tested failure/cancellation behavior. They do not certify
a complete live checkpoint, unavailable-host promotion, distributed leases,
zero-loss replication, all permission races or 500,000-member capacity.
Other operator/ownership/password workflows retain separate writes. See
[operations](../deployment/ACCOUNT_RECOVERY_STATE.md).

All accounts, credentials and injected failures used disposable directories;
fixtures removed them after completion. No live installation was changed.
After all test processes exited, an exclusive Cargo cache lock was acquired.
The two owned contract executables, their dependency files, six transient logs
and the receipt script were removed. Shared dependencies, shared binaries and
the other task's live preview were retained; incremental builds stayed disabled.
The sanitized [receipt](account-recovery-2026-09-28/receipt.json) retains final
commands, counts, log/source hashes and cleanup details. Recorded file sizes
are logical bytes, not a measurement of filesystem blocks freed.
