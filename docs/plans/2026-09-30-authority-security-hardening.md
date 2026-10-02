# Authority security hardening — 2026-09-30

Status: implemented and tested worktree candidate. The initial targeted phase passed the
full pinned workspace regression on 2026-10-01 after the computer interruption;
the expanded backend phase and its acceptance are recorded below. No deployment,
merge, remote push, credential rotation or history rewrite is claimed.

Starting point: local commit `138abe39e0` on the September development checkout.
The initial phase reconciled the supplied Sonnet report against current
Authority, Anchor, replication, secrets and storage code. Ronin subsequently
expanded the work to backend account/resource/realtime and network/file trust
boundaries. Upload implementation has a separate owner. Frontend, independent
E2EE verification, plugin isolation and complete API audit coverage are not
claimed.

## Verified plan and disposition

| Report item | Current evidence and action |
|---|---|
| Tracked `.claude/settings.local.json` | Confirmed. Untracked while preserving the local copy; ignored and rejected by the existing runtime-file CI guard. |
| History secrets | Scanned all available local refs with Gitleaks without publishing secret values. Follow-up proved the historical provider values match official upstream demo/browser configuration; no Wabi-owned private credential was confirmed. |
| Raw-path rate limiting | Confirmed. Governor keyed limiter uses canonical client IP plus Axum `MatchedPath`; unmatched paths share one bucket. Time-based cleanup removes refilled buckets, never arbitrary active buckets. |
| Replication traversal/hash | Already checked on this branch. Strengthened shared safe-component validation before local and replicated writes and before wire decoding. |
| Anchor peer forwarding, redirects, health URL | Peer forwarding, no-follow redirects and health redaction already existed. Remove public connection error details and preserve configured trusted-proxy identity through Anchor. |
| PID/mtime engine lock | Confirmed. Hold an OS exclusive advisory lock on one persistent inode through engine lifetime and all background disk writers. |
| Sync routes opt-in and stale unauthenticated comment | Already fixed: explicit `WABIDB_EXPERIMENTAL_REPLICATION=true` plus matching `WABI_SYNC_TOKEN`, receiver fencing and authenticated routes. |
| Weak JWT secret | Confirmed known default was accepted. Release policy rejects it and signing keys shorter than 32 bytes from canonical/legacy environment or persisted files; never silently replaces a key. |
| Hard-link portability | Add serialized atomic rename fallback for unsupported/permission-denied hard links; retain complete-file publication, exclusive winners, 0600 and directory sync. Other I/O failures remain errors. |
| Bad sync hex | Already strict on this branch; extend malformed metadata/hash regressions. |
| Step-up revocation | Confirmed absent. Both destructive admin and owner roster callers now check token/user/global revocation, subject, token purpose and valid issue time. |

## Cross-file findings added during verification

- Reaction removal embeds emoji IDs in stream directories. Local sequencer
  admission now validates every stream before writing any event, including a
  malformed second event. IDs remain exact Unicode strings bounded to 255 UTF-8
  bytes. Sonnet's ASCII-only proposal would break legitimate emoji streams.
- A single unmatched rate-limit bucket could throttle the app's cold-start
  assets. Only verified embedded immutable GET/HEAD files bypass this limiter;
  random or nonexistent asset URLs remain in the bounded fallback bucket.
- Trusted proxy identity must survive proxy → Anchor → Authority. Rebuild the
  chain from a trusted resolution and the actual peer, strip caller identity
  headers, and parse repeated forwarding fields from the right. A malformed
  authoritative entry falls back to the socket peer.
- Step-up issuance also needs the password proof's revocation snapshot. Like
  login, it now rejects a password proof that crosses a user/global reset and
  stamps fresh proofs at the current cutoff without extending the ten-minute
  expiry. Verification alone cannot fix stale proofs minted after a reset.
- Engine Drop can leave disk tasks draining or cloned command senders alive.
  Those tasks retain the advisory lock. Startup allows a bounded 100 ms drain
  grace without using PID/mtime ownership guesses. Failed startup must release
  its acquired lock before any retry.
- Stopped snapshot/fence/activation operations must acquire and hold the same
  advisory lock, rather than reject a persistent filename or probe then release.
  Runtime lock files do not belong in archive content or passive-state hashes.
- Tokio segment writes can still be buffered after `write_all` returns. Append
  now drains that buffer before claiming a complete record; the sequencer still
  owns fsync ordering. The mid-stream process-crash regression proves the next
  sequencer position remains above every complete observed orphan.
- Persistent runtime lock files alone are not evidence of missing database
  state; both JWT setup and root-key setup use the same rule for first-boot
  retry. Only exact regular coordination files qualify; symlinks, directories,
  unknown or real storage files still fail closed when keys/manifests are missing.

The initial phase changed no postcard record, encryption envelope, stream hash,
nonce format or projection schema. The expanded phase adds voice restriction
indexes with explicit legacy recovery, described below; persistent postcard
records remain unchanged. Replication remains experimental and off by default.

## History scan evidence and remaining owner work

Gitleaks **8.30.1**, downloaded from its official release and checked against the
release SHA-256 checksums, ran locally with 100% secret redaction:

```sh
gitleaks git --redact=100 --report-format json --report-path history-redacted.json \
  --log-opts='--all --full-history' --no-banner .
```

The local ref graph had **1,894 reachable commits**. Gitleaks reported scanning
**1,714 patch-bearing commits**, approximately **97.76 MB**, with **53 findings**:
40 generic-key matches, seven authorization-header matches and six Google-key
matches. A separate snapshot of **3,548 tracked regular files** produced **25
matches**. The current snapshot matches are code identifiers, placeholders,
protocol examples, test credentials or source-file hashes; no private production
credential was confirmed by that scan. This is not a proof of absence.

Historical findings include a browser Giphy API key in `GiphyPicker.svelte` and
`frontend/.env.example` at `bebaa380c7`, and an Excalidraw Firebase browser key in
old compiled assets at `941c1c8a41` / `b250d0553b`. October 1 follow-up proved
both values match official upstream public examples/configuration; see the
pinned provenance below. The current tracked source snapshot contains neither
key. No Wabi-owned private provider credential was confirmed. No provider API
was called with these values and no credential was rotated; upstream account
settings and separately configured deployment credentials were not audited.

Neither `.env.save` nor `frontend/.env` appears in the available reachable Git
history. The report's reference to a staged file does not establish a committed
leak. This scan excludes unavailable remote refs, dangling objects, reflogs,
private workstation files, hosting configuration, and provider access records.
Do not infer that historical secrets were rotated. Any history rewrite is a
separate destructive operation after backup and coordination with contributors.

Raw/redacted scanner artifacts and test logs were kept in temporary local
scratch; earlier temporary results were lost during the computer interruption.
This sanitized evidence persisted and is intended for version control. No scanner
allow-list was added to hide future findings.

## Initial-phase validation and release gates

Pinned Rust 1.93 validation completed:

- September 30 WabiDB library with crash harness: **1,007 passed**, seven ignored fixture or
  expensive-test entries. Real process exclusion/kill release and crash recovery
  tests ran.
- October 1 recovery rerun of `cargo test --locked --workspace --no-fail-fast`
  completed with exit status **0**: **2,351 passed**, seven ignored across 77
  test binary/doc-test groups (child results counted with their parent). Server library:
  **403 passed**; mirrored server binary unit suite: **408 passed**. The new
  proxy, preview, secret, blob, revocation and runtime-marker tests passed.
- Production-router body-limit contracts: **four passed**; real step-up/roster
  contracts: **two passed**; adapter first-boot process contract: **one passed**,
  one subprocess fixture ignored at top level and invoked by its parent.
- Stopped replica contracts: **five passed**; first-boot contracts: **21 passed**;
  payment contracts: **six passed**; upload-backfill contract: **one passed**.
- WabiDB in the fresh default-feature workspace run: **1,004 passed**, one ignored.
  The separate crash-harness run above exercises additional crash boundaries.
- Checkpoint/geographic peer's selected combined tests: **56 passed**, including
  old/new archive exclusions and operator controls. Core archive/checkpoint
  targets also passed in the full workspace run.
- Runtime-file guard and its **three tests** passed; selected changed files
  passed pinned formatting checks; `git diff --check` passed.

The initial full run exposed fixtures that blocked Tokio writer drain, assumed
lock-file deletion, omitted real connection information, or assumed fixed user
IDs. These now wait for actual OS lock availability and use registered actor
IDs. Production ownership and permission checks remain strict. All four
previously failing targets pass in the final full run.

Before releasing this candidate:

1. Review the sanitized history-scan disposition. The reported provider values
   are copied upstream examples/configuration, not confirmed Wabi-owned private
   credentials. This does not expand the scan to private operator configuration.
2. Stop every old PID-based Authority/receiver before opening the tree with this
   version. Leave `wabidb/.lock` in place. Resolve a legacy root `.lock` only after
   all old processes have exited. Advisory locking is local filesystem exclusion,
   not distributed fencing, safe failover or HA.
3. Check operator JWT configuration. A release using a signing key shorter than
   32 bytes or the known development default will refuse startup; explicitly
   configure a strong random key. Changing the signing key invalidates sessions.
4. Configure `WABI_TRUSTED_PROXIES` narrowly on Anchor and Authority. Authority
   must trust the Anchor and the intended upstream proxy chain, otherwise users
   share the proxy address allowance. Do not trust arbitrary client networks.
5. Take a stopped full backup and run disposable restart/read/write acceptance
   before a production swap. This task does not authorize that swap.

## Footer findings confirmed during the final targeted pass

The supplied report also named blob headers, the global body limit and SSRF.
Checking those current paths confirmed additional work:

- Blob download reflected declared MIME without the existing upload path's
  sandbox/nosniff controls. Reuse those controls, safe attachment naming and
  private/no-store/no-referrer headers while preserving its read policy.
- Streamed request bodies need the configured maximum enforced globally;
  `DefaultBodyLimit` alone only constrains participating extractors. Preserve
  the existing operator-controlled large-file allowance.
- URL preview validation resolved a safe address but discarded it before
  reqwest's connection, allowing a second DNS resolution. IPv4-mapped IPv6
  also bypassed the IPv4 private-address checks. Pin each vetted destination,
  disable ambient proxy/redirect escape paths, and cap upstream bodies before
  buffering. Validate oEmbed's separate destination too.

These three repairs are implemented and independently reviewed. Blob downloads
validate MIME syntax, use bounded attachment names and preserve payload bytes.
Image proxy responses also sandbox SVG documents without forcing normal images
to download. HTML/oEmbed responses are bounded to 2 MiB and images to 10 MiB;
the vetted address stays pinned while Host/TLS verification uses the URL host.
The global body cap uses the same 50 GiB default or operator override and retains
CORS on declared-size refusals. Production-router tests exercise Socket.IO and
buffering extractors with unknown or false declared lengths.

The first final server run caught a MIME parser accepting an empty subtype
(`image/`); explicit subtype validation fixes that boundary in both response
paths. Those regressions pass in both server suites and the full workspace run.
Legacy multipart handlers that
buffer fields can still allocate up to their applicable configured cap; this
does not complete the deferred streaming-upload work. Ronin assigned remaining
upload implementation to another chat; this chat will preserve that scope.
That initial targeted pass did not complete upload/blob authorization or review
the remaining API/socket routes. The expanded backend work below is a separate
implementation and acceptance phase; upload implementation keeps its own owner.

## Expanded backend implementation — October 1

The expanded candidate fixes confirmed backend findings beyond Sonnet's list:

- Account admission serializes refresh-token use, commits password changes and
  revocation together, rejects stale profile/password snapshots and ambiguous
  login identities, and preserves singleton owner transfer. New passwords above
  bcrypt's 72-byte UTF-8 input limit are rejected without breaking legacy checks.
  Bot registry publication retains owner-only permissions and leaves live state
  unchanged on persistence failure; human JWTs cannot impersonate bot IDs.
- Selected content, roster, Project card/wiki/assistant, job and media routes
  retain current credentials and ownership/membership admission through the
  completed write. Accepted work owns that boundary even when its requester
  disconnects. Nested resource IDs must belong to the authorized parent; roles
  and private-conversation admission cannot be recovered from stale caches.
- Ordinary API JSON now has a 2 MiB streaming budget, distinct from the large
  file/transport ceiling. Unauthenticated auth requests previously inherited
  the 50 GiB upload allowance before JSON parsing. Auth POST and whiteboard
  document PUT enforce the small budget regardless of MIME; ordinary JSON uses
  Axum's MIME rules. Exact route/method exceptions preserve raw JSON files,
  resumable chunks, CAD and Lore transfers. Smaller operator and route-local
  limits still apply; declared, unknown-length and false-length overflow retain
  CORS and 413 responses without collecting later chunks.
- Compiled realtime callbacks retain one current credential proof through
  publication. Revocation removes idle receivers before returning; namespace
  admission, account bans, breakout parent restrictions and transfer signaling
  use current server-owned identity and channel policy. Established healthy calls
  retain their intended token-expiry behavior while revocation still applies.
- The concurrently added whiteboard role controls now require the owner for
  policy changes. Malformed present policy fields fail closed; only absent legacy
  fields get defaults. Live patches cannot replace documents or permissions.
  A bounded, per-Authority set of 64 write locks orders policy/version checks,
  durable saves and publication across HTTP and Socket.IO. This closes the race
  where a participant could overwrite an owner's new drawing restriction.
  Standard and CAD boards share their owning channel's gate. Membership removal
  and role restrictions evict all derived board rooms; completed channel bans
  serialize eviction with fresh access checks so a waiting join cannot restore
  receive access after the sweep.
- Ordinary channel joins, message publication and WabiDB media receive joins
  share that bounded channel gate with completed ban eviction. Automatic safety
  bans run before a message takes the gate, avoiding recursive admission.
  Actual relay packets check durable publisher mute state before replay-cache
  insertion and fanout; current per-device receive consent and durable deafen
  state filter delivery. Corrupt restriction rows refuse packet publication or
  receipt, and deferred joins cannot restore a banned media subscription.
- Real mute/deafen events populate durable voice restrictions. Startup repairs
  old ignored events only from complete indexed history, preserving unrelated
  projections and refusing incomplete recovery. Corrupt restriction rows deny
  voice admission. Existing postcard records were not changed.
- Lore files use descriptor-relative confinement and private bounded snapshots;
  download/archive cancellation cannot publish unsafe intermediate state.
  Current repository capabilities and owner-only host operations are rechecked.
  API-selected Git operations use an anonymous pinned public-HTTPS bridge,
  bounded streams and processes, suppressed ambient Git configuration, and
  forced ref updates constrained by the previously observed remote revision.
- Actual moderation callbacks queue the current mute/deafen grants for the
  account identity used by the compiled LiveKit broker. The helper validates the
  assigned node, grants, fixed SFU destination and participant response; its
  authenticated HTTP calls reject redirects/proxies and bound responses. Broker
  tokens request a 60-second initial lifetime and recheck policy after helper
  waits. Raw operator MediaRelay jobs cannot bypass the broker gate.

LiveKit brokering is **off by default**, behind
`wabi-server/experimental-livekit-broker`. Queued participant updates are not
proof of delivery or immediate SFU packet enforcement, and self-hosted LiveKit
permission updates do not invalidate previously issued join tokens. Helper HTTP
fixtures do not certify real SFU reconnect/rejoin behavior. See the explicit
[operator acceptance gates](../deployment/SHARED_MEDIA_NODE_SETUP.md). Core Wabi
does not depend on enabling this experimental broker.

### Expanded acceptance record

Final pinned full-workspace acceptance completed with terminal
exit **0**: **2,635 passed, zero failed and 11 ignored across 88 groups**, using
Rust **1.93.1**, one build job, and local test sockets/disposable data enabled:

```sh
CARGO_BUILD_JOBS=1 cargo test --offline --locked --workspace \
  --features wabi-server/addons,wabi-server/experimental-livekit-broker \
  --no-fail-fast
```

The [machine-readable acceptance record](../testing/security-2026-10-01/acceptance.json)
retains every group result and ignored entry. Server library: **461 passed**;
mirrored server binary: **468 passed**; WabiDB library: **1,015 passed**, one
subprocess entry ignored at top level. The 11 ignored entries include owned
subprocess helpers, an external two-computer harness and the mDNS example;
they are not all standalone acceptance passes. The earlier 2,351-test result
above belongs to the initial phase.

The first expanded workspace run finished with 2,583 passes, 11 failures and
eight ignored tests across 87 groups. The failures exposed stale fixtures after
stronger identity admission, retained credentials, URL validation and lock
draining; those fixtures have narrow repairs that retain their original denial,
durability and checkpoint assertions. A separate final check found and repaired
the ordinary-JSON buffering exposure above. A socket-restricted retry was
excluded from acceptance, and the subsequent host run finished with 2,615
passes, nine failures and ten ignored tests across 88 groups. Eight successful
restart fixtures raced disk-worker lock draining; one whiteboard fixture shared
a process-wide version-cache key across independent servers. Test-only repairs
wait for the specific lock-drain condition and use unique durable channel
identities, preserving their denial, replay, fencing and publication assertions.
The next host run finished with 2,619 passes, five failures and ten ignored tests
across 88 groups. All nine preceding failures passed. The remaining five were
other successful restart fixtures with the same worker-drain assumption. A
systematic test-only repair now covers remaining successful reopen sites and
corrupt-startup checks: retry only `AlreadyRunning`, panic if the dropped
fixture's writers do not release their lock within five seconds, and return
every other startup error unchanged. Offline backup fixtures wait for the same
persistent lock inode before copying. First opens and genuine live-writer
refusals stay strict; no production grace or ownership check is weakened.
Those repairs passed the next complete host run.

That host run completed with exit 101: 2,634 passes, one failure and eleven
ignored tests across 88 groups. Every server/WabiDB target passed, including
the repaired restart/corruption fixtures and all new security contracts. The
sole failure was the unchanged experimental consensus success-write fixture:
its selected leader changed before proposal submission and returned
`ForwardToLeader`. All 5,145 source/embedded-build hashes remained unchanged
after the run. A coordinated test-only correction now follows that explicit
forwarding result within the existing five-second deadline, preserving identical
operation bytes and every scenario/assertion body. Fatal/other errors still fail,
and the direct minority refusal remains strict. All three focused contracts and
the final full run passed. Production consensus and security source did not
change for this correction.

All 11 production-router body-limit contracts now pass, including anonymous
unknown/false-length overflow, MIME handling, exact-boundary acceptance, actual
large JSON-file upload/readback, whiteboard documents and smaller route/operator
caps. The smaller-cap regression also caught nested Axum body errors being
reported as 400; preserving frames and flattening errors before reboxing now
retains 413. The direct `http-body-util` dependency uses the already locked
0.1.3 package without adding a package or changing its version.

The frozen [source/embedded-build receipt](../testing/security-2026-10-01/source-receipt.json.gz)
covers 5,145 files, with uncompressed JSON SHA-256
`32c17860fe6f080eaa8dee6fef52dffa1dcd1e0ba9c80768f475caf2699007df`.
Compared with the 2,619-pass red run, exactly 33 test/helper files and four
agreed isolated consensus files changed. Root manifests, Cargo.lock, production
security code and embedded frontend build stayed unchanged. The final correction
then changed only the consensus success-write fixture, relative to the completed
2,634-pass run. Both the
[preceding fixture receipt](../testing/security-2026-10-01/source-receipt-before-fixture-retry.json.gz)
and [receipt before systematic restart repairs](../testing/security-2026-10-01/source-receipt-before-systematic-restarts.json.gz)
are preserved, along with the [tested receipt before the consensus fixture correction](../testing/security-2026-10-01/source-receipt-before-consensus-fixture.json.gz).
After the actual exit-zero run, all 5,145 hashes matched the frozen source receipt.
Tauri files are hashed for source freeze only; this root-workspace command does
not accept the separate native shell build/runtime. The independent helper
workspace and external Live-room release smoke remain separate gates.

Already completed checks in this phase: the default Authority library passed
438 tests before the last media/whiteboard changes; the latest default media,
realtime and voice-recovery contracts passed 22 tests; Lore passed 61 tests; the
Python media helper passed 13 tests with resource warnings enabled; the tracked
runtime-file guard and its three regression tests passed. The whiteboard attack
test failed on the pre-fix implementation, and all three repairs passed an
independent compiled-callsite/lock-order review. The final suite includes its
new role, malformed-policy, replacement, concurrent restriction and idle-receiver
regressions, including standard/CAD boards and the channel-ban/join race.

The final dependency scan uses cargo-audit 0.22.2 and RustSec database revision
`9b3a3b73a7f42606494c943e95f8196e9994df46` (September 30). It reports zero
vulnerability-section matches after targeted dependency/provider repairs, four
maintenance warnings, and two unsoundness advisories for terminal-client-only
`lru` 0.12.5 (`RUSTSEC-2026-0002`, `RUSTSEC-2026-0253`). Those terminal warnings
remain; this is not a claim that every workspace dependency is free of issues.
Cargo.lock SHA-256:
`cbfc64c2947a2f4ccb11f0b64c127a66b18b635b032d754f2b68beb7578da8a0`.
Sanitized audit report SHA-256:
`9aff05c395ee1576c3b9f9a15a15c558deea7161987cf4deb9d66661a300835d`.

A coordinated consensus-only build slot added Snow 0.10.0 while preserving all
637 prior locked package identities/checksums. Its owner reported 39 passing
local contracts; the new transport remains unwired to the Authority and is not
a physical-WAN, HA or independent cryptographic acceptance claim. Its compiled
sources are included in the refreshed security source receipt. The independent
`helpers/wabi-project` workspace/migration remains separately owned and outside
this root-workspace acceptance.

A second agreed isolated slot added a bounded local byte store, without changing
the dependency graph or wiring an Authority writer. Its owner retained a
49-pass/one-failure run for an unchanged leader-selection timing race, followed
by a same-source exit-zero run with 50 passes and four child entrypoints ignored
at top level. Eleven new parent tests include eight real process-kill save
boundaries. The source/slot return was verified before root started its final
workspace run; this does not clear the geographic writer/recovery gates.

This remains a local, uncommitted candidate on
`codex/security-boundary-hardening-20260930`, starting at `138abe39e0`.
Other chats' frontend, Project, geographic/consensus and upload changes are
preserved. Passing this recorded candidate does not certify subsequent changes,
real SFU behavior, independent E2EE, plugin isolation or production HA. It does
not perform a production deployment, credential rotation or history rewrite.

The expanded **Complete backend security hardening beyond the initial report**
card (`task_6f1a40e06c5444d8a10c185ef57abf81`) was verified **Done** at revision
**14**, after the actual full-run exit and unchanged-source readback. This is
separate from the initial targeted card's Done revision 8. Lore retirement and
the external Live-room release smoke retain their own unfinished cards.

## Shared organizer and Lore handoff

Verified execution computer: `dotRonin`; checkout `/home/ironin/wabi`; branch
`codex/security-boundary-hardening-20260930`, starting at `138abe39e0`. Other
chats are changing this checkout. The checkpoint/geographic chat explicitly owns
checkpoint controls, bounded restore, inbox and geographic harness work. Shared
archive and router files contain separate agreed hunks; preserve all other work.
The live archive validator required a follow-up to recognize both the old three
and new five runtime exclusions, preserving existing V2 archive compatibility.

The registered `wabi-codex-test-20260930` tools were absent from this chat's
injected tool list. Its configured stdio MCP bridge successfully called
`project_brief`, then read existing cards before creating, reading, claiming and
reading back **Authority security report remediation and regression handoff**:
`task_135c7e0c4e3a4c97b0036e948bdd3695` in **Codex test** (`ch_c72`). Detailed
sanitized notes were published only after Ronin's explicit approval and read
back at revision **4**, with subsequent progress updates through revision **5**
before final validation. No credential values
appear in them. Newly discovered private Lore host details remain local.

Testing feedback: existing chats need connection refresh/discovery; shared bot
user `3190` does not distinguish individual workers; card claims do not lock
repository files. The current connector covers cards/wiki, not Lore or shell.
Continue explicit file-scope coordination rather than inferring exclusion from
card assignment.

No `.wabi-sync.json` link or `.wabi-sync/state.json` baseline exists at this
checkout, and no local Lore CLI is installed. Read-only Tim discovery verified
the current CLI (`0.8.6+373`) and its active repository root, which differs from
the older delivery skill's smoke-fixture location. Candidate `ch_460` (1120)
has a Wabi-shaped source tree and native repository
`01a041f5628a7640bb6f1a78ff3555a2`: branch `main`, revision **8**, hash
`cb0badaa3907599f39136e0756238627400843872f614b60ca45554c857cc271`.
This is a queried candidate, not a selected publishing target. Other repositories
hold an uploads tree or fixtures. During discovery, **Wabi source mirror test**
(`ch_c93`, numeric 3219) changed from
an empty native repository to an external mirror of
`https://github.com/AzureFoxStudios/wabi.git`; its earlier native revision is no
longer current. Read-only disk inspection verified the mirror's current `main`
Git revision **f088da430add22e8b21b6779f1b3bec974c39083**, matching local
`origin/main`; the organizer chat's independent acceptance names this channel.
That revision differs from this checkout and does not include these uncommitted
repairs. No `.wabi-sync.json` or recorded synchronization baseline links them.
The public mirror is read-only; no Lore publication or automatic synchronization
is claimed here.

Ronin requested keeping the latest source repository and retiring duplicates.
Retirement is pending scope and owner/grant coordination: the older native
Wabi source contains approximately 68 MB of files and may contain unpublished
work, and uploads/smoke repositories contain separate data. A newer native
handshake test (`ch_c9b`, 3227) is an active proof fixture, so chronological
“newest” does not identify the canonical source. Preserve the source mirror
and other chats' active proof work. Back up selected trees, revisions and
bindings before a normal authorized durable detach; permanent filesystem
deletion is not a substitute for removing repository registration. No Lore
repository has been removed by this security chat.

October 1 comparison verified that the older native source is not an exact
duplicate: among the mirror's 3,009 tracked paths, 2,366 are identical, 318
changed, 303 missing, and 22 symlink/non-regular. Its full 68 MB tree includes
approximately 44 MB of Lore history; preserve that history, revision caches and
private metadata in the backup. SSH read access does not establish authorized
application lifecycle access. The live detach/service-binding fix remains a
separate deployment gate, and referring channel bindings need explicit handling.

## October 1 recovery handoff

The computer and checkout were reverified after the interruption: `dotRonin`,
`/home/ironin/wabi`, the same security branch and `138abe39e0` HEAD. The earlier
temporary logs were no longer available; source and this plan persisted. Other
chats had added changes, so the full workspace was tested again rather than
claiming the old result covered them. The fresh runtime-file guard, its three
tests and `git diff --check` also passed. Independent read-only review found no
material gap in lock lifetime, first-boot classification or stream identity.

Wabi tools are now injected directly. `project_brief` and current card reads
confirmed access; a manual stdio bridge is no longer needed in this refreshed
chat. Shared bot attribution and the absence of file reservations still require
explicit ownership coordination. Preserve concurrent feature, checkpoint,
frontend, plugin and Lore edits; do not stage the whole checkout.

The security implementation/regression/handoff card was moved to **Done** and
read back at revision **8**. This
does not clear deployment or PR release gates. Separate follow-up cards record:

- **Retire duplicate Lore source repositories safely**:
  `task_b0137adb7db44f4f8c02fd5ae5b0536b`.
- **Review historical browser provider keys before release**:
  `task_dfc990e69c38416f9e67f501c639ce4d`; provenance investigation completed
  during the follow-up below.

Remaining upload implementation belongs to another chat. No cleanup, provider
rotation, Git commit/push/merge, Lore publication or production swap is claimed
for this security task.

## October 1 follow-up execution

Ronin asked this chat to work on both remaining cards. They were read, claimed
and moved to **In Progress** before work resumed. The completed security card
remains Done. Scope is provider provenance/account review and recoverable Lore
retirement; no upload implementation or peer-owned source changes are included.

The normal Wabi CLI configuration contains a session for its configured Tim
server. Read-only identity and repository requests all returned **401**. The
credential was never printed, sent to an alternate destination or replaced with
a forged token. Repository-owner UI coordination completed and the older native
source's whole tree/history backup passed restoration checks. Registration and
binding verification still needs normal authenticated API access. The Project
connector covers cards/wiki and has no Lore lifecycle grant.

### Refined provider findings

All historical Firebase matches have one SHA-256 fingerprint,
`831eae7f580f7721f62d7f654e8c071879bcafd6452d5613f8db051f15082b85`,
which exactly matches the Firebase browser configuration in the official
Excalidraw repository for `excalidraw-room-persistence`. The old compiled assets
contain upstream public configuration, rather than evidence of a Wabi-owned
private credential. This does not establish the upstream project's access-rule
safety. Do not rotate another project's key.
[Official Excalidraw configuration](https://github.com/excalidraw/excalidraw/blob/master/.env.production).

This is a **historical compiled-asset finding**, not the current whiteboard
implementation. The current checkout uses Wabi's `WhiteboardCanvas.svelte`,
its own `boardRenderer`, tools, board store and synchronization modules, plus
Authority whiteboard routes and durable documents. Current frontend source,
`package.json` and `package-lock.json` contain no Excalidraw/Firebase reference.
This source check does not independently identify the live Tim binary's build.

Firebase keys identify a project; data authorization depends on Security
Rules/IAM, with App Check covering supported abuse controls. Appropriate API
restrictions still matter, especially when enabling non-Firebase APIs.
[Firebase key guidance](https://firebase.google.com/docs/projects/api-keys).

The Giphy value was used both in `.env.example` and a fallback labelled as a
public demo key, with SHA-256 fingerprint
`9f0f64255558321459ece21393d811a8ec5b8741385e6d7f7ce28b0f3b7b125b`.
Commit `a944209147741c9fa69ce3a26d7f52710ee5f92d` removed that fallback on
January 10, 2026. The comment alone does not prove ownership or inactivity: Giphy
retains the key when upgrading it from beta to production.
[Giphy upgrade behavior](https://support.giphy.com/hc/en-us/articles/360035630412-I-ve-been-approved-for-a-production-key-Do-I-get-a-new-API-key).

Exact-byte comparison of both historical values with **3,548 current tracked
regular files found zero matches**. Current `GifPicker.svelte` requires
`VITE_GIPHY_API_KEY`; frontend Docker builds pass it as build configuration.
Vite embeds this variable into browser code, and Giphy expects direct client
calls for these endpoints. An environment file is configuration, not secrecy.
[Vite environment behavior](https://vite.dev/guide/env-and-mode),
[Giphy API requirements](https://developers.giphy.com/docs/api/).

Further bounded comparison proved an exact Giphy fingerprint match with its
official SDK examples at `96f1ab9d15e1f7f4b004b5ae13e02966ef96584d`, dated
July 8, 2025, before Wabi introduced the fallback on November 18. The same
fingerprint is present at current upstream revision
`901de2582d744d1627d75c6d7750aaa16763381d`. All 122 selected official source
reads succeeded; no historical value was used in a provider request.
[Official fetch example](https://github.com/Giphy/giphy-js/blob/96f1ab9d15e1f7f4b004b5ae13e02966ef96584d/packages/fetch-api/public/index.tsx#L3),
[official grid demo](https://github.com/Giphy/giphy-js/blob/96f1ab9d15e1f7f4b004b5ae13e02966ef96584d/packages/components/public/grid-demo.tsx#L7),
[official Svelte example](https://github.com/Giphy/giphy-js/blob/96f1ab9d15e1f7f4b004b5ae13e02966ef96584d/packages/svelte-components/README.md#L75).

The reported provider findings are therefore classified as copied official
public demonstration/browser configuration. The provenance review is complete;
no Wabi-owned private credential was identified and no rotation is claimed.
This does not establish upstream account safety or review an operator's
separately configured current key. Those account controls would require that
owner's console access, if requested as a separate task. **Review historical
browser provider keys before release** was moved to Done and read back at
revision **4** with the evidence and limits preserved.

### Lore retirement preparation

The older native `wabi` source (`ch_460`, numeric 1120) now has a private,
durable filesystem backup on Tim, outside the active Lore root. Its complete
20,811 files, 1,254 directories and 68,270,718 bytes include `.lore` history and
sidecars. No revision cache exists for this tree. Archive size: 47,182,794 bytes;
SHA-256: `2c451236606098708133b7ba6aa3daf1d181af9d9e83224155a256d55190738f`.
Source inventory fingerprint:
`071591a3054ed220d3c67ada9d933979222fedb46ed82eddbcc1e906703f7236`.

Private Tim backup directory:
`/home/tim/wabi-backups/lore-retirement-ch_460-20261001T031440Z/`.
The directory is 0700; `1120-complete-tree.tar.gz`, inventories and
`restore-manifest.json` are 0600. Independent extraction matched file types,
modes, sizes and content digests. Source inventories before/after copy and
after restoration were unchanged. The restored real Lore CLI confirmed the
same repository, main revision 8 and signature reported above. Persisted
checksum and permissions were independently rechecked. Revalidate the source
inventory before retirement; a backup of an earlier state is insufficient if
writes resume.

This is **not yet a complete retirement backup**: durable WabiDB registration
and referring channel-binding records are not saved. The mirror-owner chat
verified its existing ordinary OWNER browser session and current native source
read access, but the binding form silently blanks on GET errors. A blank form
cannot establish that no binding refers to the repository. The source exposes
per-channel authenticated binding reads, with no reverse-binding list. Require
successful status-bearing reads over the authorized channel inventory or a
supported metadata export before detaching/deleting.

The existing local CLI session returned 401; the owner browser is a separate,
valid session. A renewed normal CLI/API sign-in or supported authenticated
connection is still needed for complete metadata verification. The live detach
fix remains a candidate, and the mirror Files/settings UI hits a read-only 501
response. Neither UI failure proves a missing mirror: disk Git main still
reports `f088da430add22e8b21b6779f1b3bec974c39083`. No server restart, deployment,
repository detach/delete, binding change or alteration of the retained mirror
was performed. Active handshake/gallery fixtures remain intact. **Retire
duplicate Lore source repositories safely** remains In Progress, read back at
revision **5**, with the completed backup and access blocker recorded. Ronin
was asked to refresh the ordinary CLI/API sign-in or connect a supported
authenticated Lore API; passwords/tokens should not be pasted into chat.

References: [Gitleaks upstream](https://github.com/gitleaks/gitleaks),
[pinned fs4 API](https://docs.rs/fs4/0.13.1/fs4/),
[recovery runbook](../deployment/BACKUP_AND_RECOVERY.md),
[multi-node boundary](../architecture/SERVER_MESH_PLAN.md).
