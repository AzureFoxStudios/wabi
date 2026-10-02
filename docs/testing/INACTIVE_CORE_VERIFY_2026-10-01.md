# Inactive core replay and second-computer verification

**Date:** 2026-10-01
**Status:** Main Wabi worktree component acceptance. No Authority activation,
full-instance certificate, automatic recovery or deployment is claimed.

## Implemented contract

`wabidb::engine::offline_inspect` rebuilds projections from the complete indexed
history into a new in-memory view. It starts no sequencer, replication or
snapshot task and never calls normal engine open/drop. It compares the rebuilt
watermark and every nonempty index/key/value with the saved projection, checks
the trusted commit prefix, and holds the actual persistent advisory lock inode.
Two bounded inventories detect engine-file changes. Existing lock contents and
all inactive guards are preserved; a missing persistent lock may be created.

The server's `verify-inactive` command additionally authenticates the original
encrypted V2 archive against the source receipt, compares its private header
with restored configuration, and recomputes the source's ordered whole-root
inventory. Unknown files and empty directories are included. Published upload
metadata/bytes must match canonical history and registry denials must agree.
The captured active JWT/bootstrap keys are verified without consulting ambient
key overrides. See the [operator contract](../deployment/LIVE_CHECKPOINT_ARCHIVE.md#inactive-core-verification-candidate)
for limits and the explicitly restricted support profile.

The receipt remains `externalStateVerified: false` and `fullInstanceReady:
false`. Enabled external topology/plugins, external blacklist paths, missing
complete history and unbackfilled legacy uploads refuse this profile. Unknown
bundled files are byte-verified, not semantically certified as application state.

## Focused checks

```sh
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked \
  -p wabidb --lib engine::offline_inspect -- --test-threads=1

CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked \
  -p wabi-server --test live_checkpoint_archive_contract \
  encrypted_live_archive_preserves_active_keys_security_retained_state_and_unknown_files \
  -- --test-threads=1
```

[Selected contract evidence](geographic-2026-10-01/offline-core-contracts.json)
records eight engine tests and one real live-V2 integration test passing on the
pinned Rust 1.93 toolchain. Engine cases cover independent replay/no data write,
invented saved state, wrong key/prefix, missing indexed records, discontinuous
index files, active/bad borrowed locks, strict schema/duplicates, budgets and
unsupported filesystem entries. The integration preserves owner identity,
retained/deleted messages, a consumed recovery code and revoked token, and
checks one published attachment plus one upload denial.

Inside that integration, twelve invalid source/tree/profile variants are
refused: mismatched prefix/inventory/ciphertext/count receipt, changed JWT,
opaque file, attachment or registry, changed private header, missing empty
directory, enabled Lore switch and plugin directory. The actual CLI emits PASS
for the valid tree and a redacted REFUSED for malformed private receipt input.
Invalid inputs are not repaired and live guards remain intact.

A follow-up snapshot-binary wrapper test build initially stopped at a concurrent
security-owned gallery edit (`auth` was out of scope); its tests did not run.
That is recorded separately, rather than describing a full current-worktree
suite as passing. No other worker's gallery code was changed here.

## Real live capture and Ronin replay

The [rehearsal](../../scripts/geographic-acceptance/inactive-live-rehearsal.mjs)
uses frozen copies of explicitly selected existing binaries. It creates a
loopback-only disposable Authority, two accounts, a retained room/message,
revoked session, canonical completed upload and unknown file/empty directory.
The real authenticated local operator route produces an encrypted live V2
checkpoint. An additional acknowledged source write proves admission resumes.
The source is then stopped before either inactive copy is verified.

The matching restore is verified on dotRonin and on Ronin (`bazzite`) through
the already authorized SSH/Tailscale path. Ronin starts only the snapshot CLI;
it opens no listener and never runs an Authority on the copy. Every public
verification field matches across the two computers: watermark 16, 16 indexed
commits, 14 nonempty indexes, 26 projection entries, 28 files, 36 directories
and 23,756 whole-tree file bytes. One canonical published upload is checked;
this smaller process fixture has zero upload-denial records, unlike the
integration fixture above. Both keys and both inactive guards match.

The [first remote attempt](geographic-2026-10-01/inactive-live-transfer-first-attempt.json)
passed local verification but failed during a large debug-binary transfer. Its
owned source and both scratch roots were removed. The
[successful retry](geographic-2026-10-01/inactive-live-field-retry.json) strips
debug symbols only from owned copies: the server is 122,854,096 bytes and the
remote verifier 27,823,408 bytes. Original build outputs remain intact. Exact
input and executed binary digests are in each receipt. This demonstrates a
second physical machine, not fresh qualification of three recovery uplinks.

A [final run](geographic-2026-10-01/inactive-live-field-final.json) also passes
after adding harness SHA-256 and safer process-listener ordering. It records
the exact final harness digest, matching local/remote results and successful
owned cleanup. The original compiled source contains shared work in progress;
these frozen artifact results are not a full current-branch build verdict.

After the user's fresh Tailscale SSH approval, a separate
[Iyoku run](geographic-2026-10-01/inactive-live-field-iyoku.json) also passes with
the same executed binaries and final harness digest. Its local and Iyoku
verification receipts match at the same fixture counts/watermark, and owned
scratch is removed. These are separate captures, not one simultaneously
replicated three-node checkpoint or a new three-uplink qualification.

Remote commands have independent timeouts. Remote cleanup requires this run's
random ownership marker and, if present, an available engine advisory lock.
Local/private ownership evidence records the scratch root, source PID/executable
and exact remote root before mutation. It survives an interrupted runner for
review; a stale PID is not permission to kill another process. Normal cleanup
runs even after the workload deadline. Whole-host crash cleanup itself remains
unproven.

## Remaining scope

This advances package 3 of the [master plan](../plans/2026-09-26-geographic-community-nodes.md#remaining-execution-plan--resumed-2026-09-30).
Comprehensive permission/policy/deletion/expiry semantics, protected deployment
configuration, complete enabled-instance inventory and external-store
participants remain open. No inactive copy was promoted, no old writer was
re-elected, and no client continued after Authority loss. Trusted durable
consensus, every-path writer fencing including nonce allocation, surviving
discovery, automatic failure/partition recovery, regional room ownership,
physical desktop/media and measured capacity/privacy gates remain required.
