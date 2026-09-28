# Local writer fence check — 2026-09-26

**Scope:** WabiDB's local canonical commit sequencer, the Authority's admin standby status, and the stopped-instance retirement path. This is a prerequisite for multi-node recovery, not a distributed writer lease or promotion test.

## Checks run

```sh
cargo test --locked -p wabidb --lib fence_ -- --nocapture
cargo test --locked -p wabidb --lib sequencer::tests --quiet
cargo test --locked -p wabidb --lib tests::write_completion --quiet
cargo test --locked -p wabi-server --test helper_admin_auth_contract paired_node_secrets_still_work_and_standby_remains_explicitly_incomplete -- --nocapture
```

All passed on 2026-09-26: 2 focused fence tests, 13 sequencer tests, 13 write-completion tests, and the focused server integration test. The fence test starts a valid commit, waits until it is durable but its projection application is pending, queues a fence and another command, then proves the fence waits for application and the later command gets `WriterFenced`. A separate engine test proves the marker survives restart and keeps new local commits rejected. The server test proves authenticated standby status reports `localWriterFenced` accurately while promotion remains unavailable.

The follow-up stopped-instance check passed the `wabi-instance-snapshot` fence command's lock/idempotence test and the full ten-test first-boot integration file. The command refused a locked data tree, wrote a private durable marker on a stopped tree, and tolerated a repeat call. The Authority then refused to open that fenced tree at all, so it could not expose file-backed routes after restart. The integration test also launched the real `wabi-server` executable against the fenced tree and confirmed it exited before recreating JWT secrets or upload folders. A combined disposable rehearsal encrypted and restored a stopped data/uploads set, fenced the original, opened the replacement with the same community signing identity and roster, and accepted a new write there. See the [controlled move procedure](../deployment/BACKUP_AND_RECOVERY.md#candidate-controlled-move-of-a-stopped-authority).

## Limits

The engine fence covers local sequencer commits on one data directory. A **restarted** full Authority refuses to boot from a fenced tree, but invoking the engine fence inside an already running process does not yet stop every sidecar path; the controlled move keeps that process stopped before fencing. This cannot fence an unreachable former Authority, provide a distributed term/lease, prove replica convergence, or permit a standby to promote. A restored `writer-fenced-v1` marker must not be removed as a shortcut around those missing rules. No three-site network or power-loss run was performed here.
