# Three-site main Wabi access check — 2026-09-28

**Result:** Passed the disposable protocol and scoped byte-offload checks on
three independently connected computers. This advances Gate A; the complete
desktop/media gate remains open. Gates B, C and D remain open.

## Placement and qualification

| Simulated role | Computer | Wabi process | Client exercised |
|---|---|---|---|
| Roofing/fabrication | Iyoku | Authority | Local HTTP and authenticated Socket.IO client |
| Materials/sales | Ronin | Anchor | Local HTTP and authenticated Socket.IO client |
| Equipment storage | iRonin | Anchor | Harness HTTP and authenticated Socket.IO client |

The operator reported that iRonin had moved to another site. Immediately before
this run, two IPv4 echo services agreed on each computer's egress, and all three
computers had distinct values. This replaces the earlier same-network placement
for the current run. It does not measure geographic distance or establish the
partner's actual three business sites. Public IP values are not retained.

The run used domainless private IP endpoints over Tailscale. It did not exercise
Tailcat, public-IP HTTPS or a tailscaleless path. Iyoku used its existing TCP 3000
allowance; the Anchors used temporary high ports. No firewall rule or existing
Wabi installation was changed. The first owner was created through a loopback-only
SSH forward before the Authority listened on its private network address.

## Build and client

All three processes used the same frontend-embedded debug build:

```text
CARGO_INCREMENTAL=0 cargo build --locked -p wabi-server --features field-embed,addons --bin wabi-server
```

The frozen copy was stripped of debug symbols, not optimized as a release build.
Its SHA-256 was
`569323dcda9ae033a5fcd16a0cca06e360900dbb85d763d06d24cd2a6965cdde`
and its size was 142,562,632 bytes. Both remote copies matched before execution.
The checkout HEAD was `cf00e3cbe379` with uncommitted changes; that revision alone
does not identify this build. This is main Wabi, with disposable chat accounts
and data; no ERP workflow was exercised.

The added `scripts/three-site-remote-client.cjs` uses Wabi's existing Socket.IO
bundle with the remote Node runtime's native WebSocket. No remote dependency
installation was needed. Bundle size was 155,836 bytes, SHA-256
`bc425714aa8f2547d6939e3721ebafd3830a7562a1f6cb08acc1e794bd707954`.
Credentials entered the client on stdin rather than in command arguments.
SSH used existing trusted host keys without disabling host-key checks.

## Observations

`scripts/three-site-real-authority-smoke.mjs` returned `PASS` and exit zero:

- Sign-in, a signed three-entry roster, shared durable history, Engine.IO polling
  and bidirectional Socket.IO messages through the two Anchors passed.
- Client processes running on Ronin and Iyoku each signed in, read existing
  history, fetched an app asset, sent an HTTP message, authenticated a WebSocket,
  joined the channel and sent a live message. Each live acceptance ID matched its
  delivered message ID and appeared in durable history through the other site.
  The sequence took 4,290 ms on Ronin and 1,327 ms on Iyoku. These are single
  whole-sequence samples, not message-latency distributions or capacity results.
- Both Anchors served the same 28,424-byte versioned app chunk from their embedded
  build, byte for byte. Each request produced zero Authority-to-Anchor bytes in
  the temporary TCP meters.
- A 262,144-byte resumable attachment sent through Ronin downloaded correctly
  through iRonin's optional cache. Its miss and hit had these measured wire bytes:

| Equipment cache response | Authority to Anchor | Anchor to Authority |
|---|---:|---:|
| Miss | 263,175 | 1,105 |
| Hit after fresh HEAD validation | 504 | 553 |

The hit avoided retransmitting the attachment from the Authority. These counters
cover the chosen TCP path and include HTTP overhead; they are not whole-uplink
traffic, sustained hit rates or media measurements.

After the materials Anchor stopped, the equipment Anchor still read and accepted
a canonical write. After the Authority stopped, the equipment Anchor returned
503 for the API and previously cached upload, while still serving the public app
chunk locally. It did not become a writer or make community state available.

## Reproducibility and cleanup

The harness now runs the new client in loopback mode too. Both the original
embedded build and the frozen stripped copy passed that local check before the
field run. Early custom test-client attempts stalled; the replacement's first
launch failed because Node's inline evaluator cannot take the file hashbang in
its wrapper. Stripping only that first line for inline execution fixed it. The
first field attempt then stopped before binding because transfer had left the
temporary binary at mode 0644. Only the verified temporary copies were changed
to mode 0700 before the successful rerun. These were test setup failures.

For another authorized field run, stage matching executable copies plus
`socket.io.cjs` in new private temporary directories, verify their hashes and
execute permission, then provide a field config to:

```text
WABI_THREE_SITE_FIELD_CONFIG=<private-config> node scripts/three-site-real-authority-smoke.mjs <frozen-wabi-server>
```

The harness stopped its servers, client connections, SSH forward and TCP meters,
and removed its local test data. A subsequent process audit found no owned
remote server, meter or test client remaining. The exact remote temporary trees
were removed, including binaries, accounts, keys, uploads and logs: 143,022,436
bytes on Iyoku and 142,718,846 bytes on Ronin. The local frozen binary, field
config and transient logs were also removed after saving this receipt. Shared
build outputs and existing installations/data were preserved.

The [sanitized machine-readable receipt](three-site-2026-09-28/receipt.json)
records the artifact hashes, network qualification, successful checks, scoped
metrics and remote cleanup. It contains no account credentials or IP addresses.

## Remaining acceptance

The same Tauri desktop build at all three sites, signed-roster reconnect,
URL-scoped offline replay, sustained sessions, calls/media, per-site whole-uplink
measurements and privacy races remain open. This run proves regional access and
specific byte offload. All canonical chat still reaches one Authority. It does
not prove local room sequencing, selective regional delivery, complete live
recovery, standby promotion, automatic election or survival of Authority loss.
