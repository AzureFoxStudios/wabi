# All-branch integration — 2026-10-02

Status: combined development candidate; final Rust and runtime gates in progress.
No deployment or main merge is recorded by this document yet.

The requested order is checkpoint/push accumulated source, consolidate non-main
work on a reviewable branch, then merge the validated branch into main.

## Checkpoint and branch coverage

The initial 698-path checkpoint is `361437d4778b4f4a863fa37c00b40f0449d0eace`,
pushed to `AzureFoxStudios/wabi` on
`codex/security-boundary-hardening-20260930` after explicit destination/payload
approval. The integration began at local main
`db86954a4062c1401c7c0873476a509c60864697` and includes that checkpoint.

The frozen inventory has 57 distinct previously unmerged tips. All 56 application
tips are ancestors of `codex/all-branches-integration-20261002`.
`docs-history` has unrelated history and remains an archive, as the repository
orientation requires. Exact tips and aliases are in
[the machine-readable inventory](2026-10-02-branch-integration-inventory.json).
This covers the frozen source snapshot; ongoing original-checkout edits made by
other chats after the checkpoint are preserved and are not implicitly included.

History coverage does not mean every old branch snapshot was restored. Merge
commits state their disposition. Newer consolidated source wins where old
snapshots would restore retired workflows, weaker authorization, duplicated
shells/storage paths, or obsolete runtime behavior. No branches are deleted and
no history is rewritten.

## Recovered and combined work

- One active Yjs Documents/Sheets/Present implementation, with current channel,
  credential and rules admission retained through accepted operations. The
  alternative Office storage path and retired development workflows are kept
  in history. Optional client packaging and server sharing remain independent.
- Native credential persistence, mobile notification plumbing, chronological
  mobile Back behavior, and viewport handling retain current session fences.
  The incoming large native dependency refresh was replaced by a minimal OS
  credential-store closure that retains all existing package versions.
- Voice policy, account-counted room capacity, entry modes, and default-off
  experimental broker device binding preserve the later durable mute/deafen,
  consent, credential and fail-closed relay behavior. The old selective relay
  facade is superseded; no immediate revocation or HA claim is made.
- Album attachment size/MIME metadata passes through the current guarded write
  path using fields already present on durable records. No postcard record
  fields are reordered for this repair.
- Pointer controls, Thai translations, the loopback-only development showcase,
  desktop evidence tools, TUI work, and the standalone Sabi subtree are retained.
- A late Tailcat listener result cannot publish after disable intent; current
  lifecycle and forwarder admission remain intact.
- Isolated client fixtures now expose and assert the new native refresh
  persistence seam; one SvelteKit init hook installs the showcase boundary and
  awaits native credential hydration before session bootstrap.

## Dependency disposition

All 15 dependency proposal tips are represented in history, with current
repository pins retained. This is **history reconciliation, not acceptance of
those proposed upgrades**. It avoids importing an old whole-tree lock over the
combined feature dependency graph. In particular, X25519 3 requires rand_core
0.10 while the current handshake passes rand 0.8's ThreadRng (rand_core 0.6);
that needs an explicit RNG/API migration and crypto tests. TOML 1.1 is a parser
major, base64 0.23 crosses a breaking 0.x boundary, reqwest's proposal adds that
base64 version, and serde's proposal changes its derive graph. None is claimed
validated here. All ten npm proposal direct upgrades also remain unapplied.

Required Office and mobile additions have reconciled lockfiles. Office changes
include targeted parser/devalue/cookie/esbuild overrides and remove redundant
nested esbuild packages; the mobile lock retains its existing 810 package
versions/checksums and adds only its credential-store closure. Network fetches
recovered with `CARGO_HTTP_MULTIPLEXING=false`.

## Verification

Checks use repository Rust 1.93, Node 22.22.3 and Bun 1.3.14. Builds and fixture
state are isolated from the original checkout and live data. Rust builds are
serialized and reuse the existing target with one job, no incremental test
compilation and test debug info disabled to bound disk use.

| Check | Candidate result |
| --- | --- |
| Frontend locked install | Passed |
| Full isolated frontend suite | 1,253 passed, 3 skipped, 0 failed |
| Svelte check | 0 errors, 128 warnings |
| Locale key parity | Passed, Spanish and Thai |
| Default static SPA | Passed; index.html and offline asset manifest emitted |
| Python controller/packaging/runtime tests | 40 passed |
| Node script contracts | 64 passed |
| Core ts-rs generation on media union | 166 passed |
| Sabi own locked tests/check/build | 30 passed; Svelte/TypeScript clean; static build passed |
| Combined pinned Rust compilation/tests | In progress |
| Native Linux compilation/tests | Pending serialized slot |
| Optional Office bundle inventory/browser contracts | Pending |

Browser/native/mobile-device, real SFU/provider and converter acceptance remain
separate release gates where they cannot be exercised locally. A source merge
must not be presented as deployment, physical-device acceptance, independently
verified E2EE, or production replication/HA.
