# Tailcat reconnect field regression

This is a real, opt-in two-host integration test. Keep the server on a different network from the client (Janya was the original server). It does not use Tim, wabi.chat, Cloudflare ingress, or SSH forwarding for payloads. SSH is solely the fixture control channel. No ISP-level CGNAT claim is made without separate evidence.

The invariant is **fresh direct file delivery must remain direct after restarting the client with the same saved identity**, against the same still-running server. Three random 1 MiB downloads in each session must match their SHA-256. Incoming tunnel counters must show at least 3 MiB direct IPv4 and zero DERP bytes. Outgoing control traffic may use DERP. Mixed incoming paths conservatively fail this strict direct-payload gate.

## Build the diagnostic client

Requires Python 3.12+, Go **1.27.0**, HTTPS access to GitHub/Go modules, SSH/SCP, curl, and Python on the remote Linux machine. Output directories must be new.

```sh
python3 scripts/tailcat/build_counter_client.py \
  --go /path/to/go1.27.0/bin/go \
  --output /tmp/tailcat-counter-build
```

The builder uses immutable release revision `ce6fedcabc220bab3b94d470ab330219111eeae8`, its pinned dependency graph, and read-only instrumentation of existing magicsock counters. It does **not** include the rejected reannouncement patch, call DiscoPing, modify the dependency cache, or replace the packaged sidecar. Default diagnostic build features differ from the stripped release; preserve `build.json` with results and also use release-binary observations for release claims.

## Run against an authorized host

```sh
python3 scripts/tailcat/reconnect_regression.py \
  --ssh user@authorized-host \
  --server-binary /path/to/pinned/release/tailcat \
  --client-binary /tmp/tailcat-counter-build/tailcat-counters \
  --output /tmp/tailcat-reconnect-evidence
```

This copies an isolated helper and server binary under a unique remote user-data directory, serves only a loopback file fixture, and allowlists only the generated client identity. It starts no Wabi Authority and changes no firewall, VPN, router mapping, or production configuration. It deletes its test key and remote directory afterward. Logs/output are private: they may contain peer addresses and connection metadata. Publish only sanitized summaries. An SSH interruption or cleanup error needs operator review of that exact temporary directory.

Exit codes:

- **0:** both sessions passed direct payload assertions.
- **1:** fresh baseline passed, reconnect failed — the known defect is a real failure, never an expected-pass/xfail.
- **2:** baseline was not direct, fixture/measurement failure, or cleanup failure; cannot assess the reconnect regression.

This is a strict IPv4 field gate, not a universal NAT guarantee or performance benchmark. A relay-capable network can correctly carry files yet fail the direct-connectivity prerequisite. Do not rerun selectively and present only passes.

## Permanent evidence and CI

[Original and follow-up counters](../../docs/testing/tailcat-janya-2026-09-21/followup-results.json) are immutable evidence. [Field report](../../docs/testing/TAILCAT_JANYA_2026-09-21.md) explains build differences and excluded invalid harness trials.

```sh
python3 -m unittest discover -s scripts/tests -p test_tailcat_reconnect.py -v
```

The CI workflow runs these offline verdict tests, including replaying the actual fresh-direct/reconnect-relayed evidence and requiring **failure code 1**. It prevents weakening the assertions to accept a ping, missing counters, corrupt files, or relay traffic. CI does **not** simulate or claim a multi-network field pass. Run the real two-host gate for Tailcat updates and reconnect/transport refactors; retain every result, including nonzero outcomes.

## Hardening checks and discovery traces (2026-09-21)

Use `--cycles 3 --fallback --boundaries` for three saved-identity reconnects,
a process-only forced-DERP session, and adversarial TCP admission probes.
`--lan-target <authorized-LAN-IP>:<port>` additionally checks another LAN service;
the fixture first requires a successful direct TCP connection from the server.
Only use a target you are authorized to test. These probes send no application
commands. The temporary unrelated HTTP listener binds all IPv4 interfaces on an
OS-assigned port and serves only random test bytes; it is removed with the fixture.
The actual allowed payload listener remains loopback-only.

The allowed service must accept TCP before and after probes. SSH 22, SMB 445,
an unrelated known-live random listener, literal loopback, the server's LAN
interface, and the optional other LAN target must not accept through the tunnel.
A successful forbidden TCP connection aborts immediately. Explicit SOCKS failure
and timeout are recorded separately; neither proves a universal firewall property.
Protocol/measurement errors are inconclusive. Existing source/HTTP contracts
separately verify the numeric service argument, fixed Authority forwarding,
reserved-header replacement, account authentication and admin gates.

The direct-payload assertion is unchanged for every reconnect. Forced fallback
requires three correct files, at least 3 MiB incoming DERP bytes and zero direct
IPv4 bytes. A passing fallback cannot turn a failed reconnect into a pass.

Add `--trace-discovery` to the diagnostic builder (requires Git) for read-only
logs of advertised endpoints, reused peer disco-key equality, received discovery
messages, outgoing UDP ping results and disco rejection diagnostics. This applies
the two checked-in trace patches to isolated pinned source copies. It does not
add endpoint reannouncement, reset peers, rotate identities, or alter discovery
behavior. Raw logs contain addresses and public identities; keep them private.

See [hardening evidence](../../docs/testing/TAILCAT_HARDENING_2026-09-21.md).
