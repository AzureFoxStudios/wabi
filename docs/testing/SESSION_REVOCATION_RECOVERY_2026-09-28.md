# Session revocation recovery checks — 2026-09-28

**Scope:** Disposable local main Wabi engines and API fixtures. The ordered
revocation component passed the checks below. No production deployment,
complete checkpoint or failover gate is claimed.

## Database checks

```text
CARGO_INCREMENTAL=0 cargo test --locked -p wabidb --lib -- auth_revocations sequencer::tests tests::write_completion
```

Result: **34 passed**, zero failures, exit zero.

| Coverage | Passed |
|---|---:|
| New revocation projection/admission/actual-engine checks | 7 |
| Existing sequencer admission, grouping, failure and fencing checks | 13 |
| Existing durable completion/replay checks | 14 |

The new cases checked whole-delta refusal without partial index mutation,
version/readiness and stream validation, advancing floors, expiration retention,
stale-prune refusal and queued stale-floor rejection before commit. A refused
actual-engine command left the commit count and applied barrier unchanged and
did not halt later valid writes. Removing its projection snapshot forced event
replay and retained the accepted account floor.

A separate actual engine was durably fenced, received the source's encrypted
commit/segment prefixes in order and applied the token denial, account floor,
exemption and global floor. Its projected records matched the source. It refused
a local canonical write and retained the same denial records after deleting only
its disposable projection snapshot and reopening through event replay. This is
an in-process transport fixture, not a WAN receiver run or a complete Authority.

## Server/API integration checks

```text
CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --test auth_revocation_recovery_contract --test helper_admin_auth_contract --test payment_access_contract --test admin_role_contract --test first_boot_onboarding
```

Result: **53 passed**, zero failures, exit zero. One subprocess-only fixture was
ignored by the direct runner; its parent restart test passed.

| Coverage | Passed |
|---|---:|
| New canonical revocation recovery contract | 6 |
| Helper administration credential/admission contract | 4 |
| Payment access/password-reset contract | 8 |
| Administration/live role and badge contract | 14 |
| First-owner, desktop bootstrap, invite and startup contract | 21 |

The six new cases exercised:

1. Legacy map import, old permanent user denials, current-session exemptions,
   later token and account changes, non-shortening expiration, full event replay
   and a stale malformed legacy file after canonical initialization. The stale
   file was not reread or rewritten and no second import commit appeared.
2. Thirty-two concurrent token denials and repeated account revocation, with all
   denials present and an advancing floor after restart.
3. A durably fenced engine: real HTTP logout returned an error rather than
   success, later revocation methods refused writes, and both the applied
   position and the in-memory denial view stayed unchanged.
4. Invalid legacy JSON/types/unknown fields refused Authority startup and left
   the operator's source file intact.
5. An interrupted import with no completion marker, followed by startup that
   retried a 1,100-token legacy set in bounded batches and kept every denial.
6. Cancellation after the owned publication worker was admitted but blocked on
   its auth-view guard. The request task was aborted; the worker still committed
   and published its denial, which also remained effective after restart.

The first integration run stopped on two administration fixture failures. One
assumed that a fresh member always had ID 2; it now configures the actual
persisted member after reopening. The other expected revocation to leave the
database watermark unchanged; it now observes that revocation commit and proves
subsequent denied badge mutations add no further commit or false broadcast.
The permissions and live revocation assertions were preserved. A later auth
unit fixture similarly replaced a hardcoded subject ID 1 with the subject from
its actual signed token. The combined integration rerun above passed after the
cancellation safeguard was added.

## Auth and socket unit checks

```text
CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --lib -- state::tests api::auth::tests socket_revocation_tests socket_authentication_tests
```

Result: **32 passed**, zero failures, exit zero, after the owned publication
worker was added. Coverage includes eight state checks, six auth API checks and
eighteen socket auth/revocation checks. The socket checks run in both existing
module inclusion paths; they are eighteen executions of nine distinct cases.

The final three commands above completed **119 passing checks** in total. This
is a focused set, not a whole-workspace run. Existing compiler warnings remain.

## Boundary and cleanup

These results prove the component's local ordering, migration, replay and error
handling. They do not prove complete cross-file recovery, recovery-code storage,
atomic compound ownership/password operations, remote enrollment, distributed
leases, zero-loss replication, privacy races or 500,000-member capacity. Large
denial sets and mixed-version rollback remain operator considerations. See
[operations](../deployment/SESSION_REVOCATION_RECOVERY.md).

All accounts, secrets and fault injection used temporary directories. Test
fixtures removed them after completion. No live installation was changed.
After the final test processes exited, an exclusive Cargo cache lock was
acquired. The idle incremental cache, this contract's generated test executable
and seven owned transient logs were removed. Shared dependencies, shared
binaries and the other task's live preview were retained. Available disk space
reported by `df -h` rose from 136G to 144G. The recorded file sizes are logical
bytes, not a measurement of filesystem blocks freed.

The sanitized [receipt](session-revocations-2026-09-28/receipt.json) retains the
commands, counts, final log hashes, candidate source hashes and cleanup details.

Subsequent code-state and compound ownership recovery work has a separate
[account recovery receipt](ACCOUNT_RECOVERY_STATE_2026-09-28.md). It does not
broaden the session-only results recorded here.
