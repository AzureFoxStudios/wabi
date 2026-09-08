# TURN runtime delivery — 2026-09-08

## Objective and observed failure

Deliver coherent optional TURN configuration without pretending it is required
by Wabi's existing Socket.IO media relay or advertising dead infrastructure.
The user explicitly requested checking STUN/TURN with deployment.

Production coturn was running, but server startup hardcoded TURN off. An
authenticated `/api/media/turn-credentials` request returned HTTP 400, `TURN
server not enabled`. Credential issuance and runtime media status used different
endpoint parsers. The frontend cached credentials globally across server/account
changes, used an unrefreshed raw request, and derived STUN only from build-time
settings. TLS URL generation also advertised an invalid UDP variant.

Actual authenticated coturn allocations over Tim's tailnet address succeeded
over UDP and TCP, but advertised an obsolete public IP and allocated ports
outside the Docker-published 49160–49200 range. TLS listeners lacked readable
certificates. Neither old nor current public IPv4 answered bounded UDP/TCP
3478 probes from Ronin. The operator then confirmed CGNAT and **no public port
forwarding**; only the existing app tunnel is available.

## Boundary and decision

- Keep Wabi's working Socket.IO media relay independent of coturn/LiveKit.
- Do not advertise public TURN on Tim without a genuinely reachable endpoint.
  Enabling a flag cannot resolve CGNAT. Do not introduce a paid or third-party
  relay without operator direction.
- Explicit runtime configuration selects optional TURN; validate selected
  endpoints/secrets without leaking their values in errors. Disabled core
  startup needs no TURN dependency or secret.
- One endpoint interpretation serves browser credentials and runtime status.
  Credentials remain authenticated, expiring, and scoped to the requesting
  account; the HMAC key never enters frontend assets.
- Fence frontend cache/in-flight work to server, account and session generation;
  use the bounded existing authentication recovery path. Keep default STUN
  self-hosted and TLS URL generation honest.
- Match coturn allocation ports to published UDP ports and require an explicit
  external IP. Do not guess an operator's network or print generated secrets.

The existing 24-hour credential lifetime is deliberately preserved: established
RTCPeerConnections currently retain their initial ICE credentials. Shortening
the lifetime without implementing in-call credential rotation could regress long
calls. This change does not claim to solve that separate lifecycle limit.

## Verification gate

Configuration/issuance/auth tests, cache cancellation and ABA regression tests,
real coturn allocation/traffic where reachable, frontend typecheck/library suite,
Tauri frontend and static builds, server tests and addon release build. Repeat
the existing headful synthetic P2P/WabiDB audio scenarios. Verify exact embedded
assets and public application/socket readiness after deploy.

Separate what is configured, what allocated, and what actually transported
bytes. Public TURN, TLS TURN, physical-device audio and a native installer are
not proven by passing local tests. The user-requested Lore source refresh must
record the final implementation commit through the authenticated snapshot path
and prove its WabiDB record/live-change cursor, not merely copy files.

### Direct-origin check requested by the operator

A temporary SSH local forward bound only to Ronin's loopback reached Tim's
existing server over Tailscale, bypassing both Cloudflare and Caddy. A headful
browser allowed HTTP requests only to that local origin. Readiness, real owner
UI login (HTTP 200), workspace rendering and authenticated Socket.IO `init`
passed; the one observed WebSocket used the local route, with no socket or
uncaught application errors. The browser reported a secure localhost context.
Evidence: `/tmp/wabi-admin-release-brO9bU9q/direct-origin.png`.

The browser and temporary SSH forward were closed afterwards. No DNS, tunnel,
firewall or account policy was changed. This was not a public-routing bypass,
physical microphone test or two-device audio test. With confirmed CGNAT, public
visitors still need the existing tunnel or another public entry point.

### Implementation acceptance

Runtime selection, one endpoint parser, account/session-scoped credential reads,
bounded refresh/body consumption, valid TLS/IPv6 URLs, explicit coturn IP and
matching relay ranges are implemented. No call transport ownership, postcard
record or generated protocol change was made. The old TURN setup guide now
describes actual runtime issuance instead of shipping static browser passwords.

- Frontend library suite: 630 passed, 12 existing skips, 19,504 assertions.
  Typecheck: zero errors, 144 existing warnings in 39 files. The first check
  caught Bun-specific fetch typing in the new isolated test fixture; the typed
  fixture helper was corrected without changing production behavior.
- Serial server suite: 497 passed, 2 intentional ignored (includes repeated
  lib/binary executions). Four pure startup/parser cases and five HTTP/coturn
  contract cases cover selection, malformed settings, current actor proof,
  HMAC/expiry, disabled status, port-range alignment and actual safe rendering.
- Tauri frontend and static web builds passed, followed by addon release build.
  All eight headful synthetic audio routes passed after the credential changes.
  This is not a native Linux installer or physical-device audio verification.
- Headful acceptance against the actual embedded minified candidate passed UI
  login, workspace draft roundtrips, real message acceptance and responsive
  Admin/Settings checks. Evidence: `/tmp/wabi-embedded-polish-CPMMnh`.
- A disposable, resource-limited coturn on Tim relayed 32 bytes outward and 38
  back from Ronin over both UDP and TCP control paths. Invalid and expired
  credentials returned 401; successful response integrity and allocated range
  were checked. Tests used only tailnet-bound ports and an ephemeral test key.
  The source entrypoint was exact; only the copied template's min/max ports
  changed to 49460–49465 to avoid the live service. No public TURN/TLS claim.
  Evidence: `/tmp/wabi-turn-probe.uCLeBo/evidence.json` and Tim's private
  `/tmp/wabi-turn-audit.7oUG9I`.
  The disposable container and network were removed after testing; the live
  coturn and public tunnel were not restarted or reconfigured.

Candidate SHA-256:
`4b5cc8e50dcaf553e89fb8b122584e921a0fe683334531ded0127e0bd9fba9a2`.
Logs: `/tmp/wabi-turn-{ui-final,check-fixture-fixed,server,tauri,static,release-build,audio}.log`.

Lore preparation was rehearsed against copies of the previous stopped-server
backup. Applying/staging the Admin source took 4.56 seconds. Exact deleted paths
require repository cwd; new empty files require explicit force-stage in this
external CLI. Exit status alone was not trusted. A copied-repo native commit and
all stored-versus-local content checks passed. The final live update must use
the final Git export and authenticated Wabi snapshot, followed by its WabiDB
receipt and content verification. Native CLI identity was not invented.
