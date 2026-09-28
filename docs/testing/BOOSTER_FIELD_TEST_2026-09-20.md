# Volunteer booster field test — 2026-09-20

Status: bounded browser field pass, with remaining limitations below. No production
release, native-package certification, or media-helper capacity claim.

## Result

An isolated Authority on the coordinator served two separate physical browser
clients: Janya volunteered a cached file and Tim downloaded it. **All 12 final
scenarios passed, with no browser page errors.** Two successive 262,144-byte
attachments arrived with the correct Authority-derived hash and without another
Authority file request for either peer download. Admin eventually recorded
524,288 recipient-confirmed payload bytes and two completed transfers.

The selected WebRTC connection used public `srflx` UDP candidates on both ends,
not a TURN relay or a management-VPN candidate. Route checks to the other host's
observed public egress selected each computer's Wi-Fi interface, not `tailscale0`.
The observed peer round-trip estimate was about 14–18 ms; it is not an audio
latency measurement. Management Tailscale stayed enabled throughout.

[Final scenario results](booster-field-2026-09-20/three-machine.json) ·
[Route checks](booster-field-2026-09-20/route-checks.json) ·
[Build/source provenance](booster-field-2026-09-20/provenance.json)

## What passed

- Origin download with no volunteer and explicit member opt-in.
- Real cross-network peer payload and consecutive peer downloads.
- Admin process-memory observation compared with the actual Authority process;
  recipient confirmations compared with the known transferred file sizes.
- Opting out while peer discovery is pending prevents a peer request.
- A deliberately corrupted peer copy is discarded and downloaded from the origin.
- Stopping a volunteer clears its cache; normal downloads continue.
- Leaving after the first 16,384-byte chunk still completes through origin fallback.
- Switching server/account retires consent and local contribution counters.
- Tailcat device blocking denies the remote connection; reallow plus reconnect
  restores it. A live private-port change reconnects successfully without an
  Authority restart.
- Actual Admin, member and populated Tailcat controls render without page errors;
  the member view fits the 390px test viewport.

Screenshots: [Admin](booster-field-2026-09-20/three-machine-admin.png),
[member controls](booster-field-2026-09-20/three-machine-volunteer.png),
[narrow member view](booster-field-2026-09-20/three-machine-volunteer-mobile.png).
The populated Tailcat screenshot contains an expired disposable connection code
and is retained only with the private evidence.

## Performance tradeoff

This proves file-payload offload, **not faster downloads**. In this one small-file
trial, the origin scenario took 1.245 s, the first peer scenario 9.652 s and the
next peer download 9.164 s. These are end-to-end harness durations, including
setup, hashing and relevant assertions/receipt checks, not isolated payload
throughput measurements. The configured volunteer payload cap was 512 KiB/s.
Cold connection/signaling overhead is significant. Larger-file/steady-state
comparisons and any connection-reuse optimization need separate acceptance.

Avoided file requests and verified payload bytes do not independently measure
net uplink savings after signaling/protocol overhead. Interface counters were
not attributed wholly to Wabi. Contribution stays optional and disabled by default.

## Failures retained and focused fixes

1. **Populated Tailcat Admin crash — fixed.** The API serialized stored key records
   with snake_case fields while the browser expected camelCase. HTTP status/list/
   registration now use one response shape. The on-disk key format is unchanged.
   A populated-key API regression and the final real-browser view both pass.
2. **Discovery polling stopped too early — fixed.** The receiver checked for an
   answer only 20 times (~6 s between requests), despite a 22 s overall transfer
   allowance. A controlled test withheld offers from the volunteer for 7.5 s;
   the old loop fell back, while the corrected loop completed the verified peer
   transfer. Polling now uses the remaining transfer deadline, and timeout also
   cancels outstanding signaling requests. The separate 5 s per-request limit
   remains. The first attempted slow-HTTP reproduction hit that separate limit;
   the retained before/after discovery test isolates the polling defect.
   [Before](booster-field-2026-09-20/delayed-discovery-before.json) ·
   [After: all 12 local scenarios](booster-field-2026-09-20/local-after.json).
3. **Janya → coordinator peer route unavailable in earlier trials.** Both peers
   gathered public candidates and the answer was applied, but ICE did not
   establish a usable connection. The correct file arrived through origin
   fallback, and Admin reported zero peer bytes. This is not retrospectively
   marked a peer-delivery pass by the successful Janya → Tim route.
   [Retained trial](booster-field-2026-09-20/coordinator-peer-fallback.json).
4. **STUN reachability observation.** Direct binding probes from Janya and the
   coordinator timed out against both the configured self-hosted endpoint and
   Tim's observed current public address. The configured endpoint did not match
   Tim's current egress. Existing explicit Google-STUN opt-in in the test build
   supplied public candidates. No TURN/STUN configuration or production service
   was changed. [Probe results](booster-field-2026-09-20/stun-probes.json).

Harness-only preparation failures included missing executable permission after
copy, a stale management forward left by an interrupted setup, reconnect attempts
before the SOCKS listener was ready, and checking receipts before their async
arrival. The final harness waits for actual listener readiness and receipt
arrival. These were not counted as product passes. Earlier reallow attempts that
timed out are retained in the trial evidence; the final readiness-aware run passed.

## Scope, machines and access

- Coordinator: disposable loopback Authority and local Admin browser.
- Janya: separate isolated headful Chromium volunteer profile.
- Tim: temporary portable Chromium recipient, separate from its existing Wabi,
  Caddy, coturn and cloudflared processes. No system package or startup service.
- iRonin: read-only inventory confirmed a distinct egress. Its earlier explicit
  read-only restriction was rediscovered after isolated test files had been
  copied there. The run was stopped, owned files/processes removed, and an
  exception requested. No iRonin test was scored; permission remains pending.
- Redmi: excluded, as requested.

All four machines had distinct observed public IPv4 egresses. Addresses, account
tokens, Tailcat connection blobs, profiles and key material remain private.

SSH carried browser control and test fixture JavaScript. Remote **Wabi API and
file requests traveled through real Tailcat** and its loopback Wabi forwarder;
SSH HTTP forwarding did not substitute for that route. The disposable Python
client proxy implements a SOCKS-to-loopback test adapter, not the Tauri client.
Device keys were explicitly pre-enrolled using test accounts. This does not pass
fresh invitation-only onboarding, desktop packaging, or native reconnect UX.

The Authority used the locked Rust 1.93.1 debug build. The clients imported the
actual Svelte controls/booster module through a Vite fixture. This was a network
feature acceptance test; no new native installer was built or distributed.

## Validation and cleanup

- Server/Tailcat suites after the API fix: **644 passed, 0 failed, 2 ignored**.
  [Suite summary](booster-field-2026-09-20/server-test-summary.txt).
- Updated local headful browser suite: **12 passed**.
- Final three-machine headful browser suite: **12 passed**.
- Frontend check: **0 errors**, 132 existing warnings in 45 files.
- Static frontend build: **passed**.

Owned browsers, Tailcat clients/listeners, control forwards and disposable
Authorities were stopped. Remote test profiles, keys/helpers and Tim's portable
browser were removed. Tim's existing containers retained their uptime, its local
health returned 200, and the public health path returned 200 afterward.
[Cleanup record](booster-field-2026-09-20/cleanup.json).

Private source archive, manifest and raw logs are retained locally under
`~/.local/share/wabi-booster-field-20260920/`; transient Authority data under
`/tmp/wabi-boost-field-*` is stopped and contains disposable accounts only.
Do not publish these private artifacts. Reproduction uses
`frontend/scripts/volunteer-boosters-field.mjs` and
`scripts/field-browser-agent.py`, with an operator-private machine JSON specifying
`tailcat`, and each machine's `ssh`, `label`, `chrome`, `display`, `xauthority`.

## Still outstanding

- iRonin hotspot client execution, pending the read-only exception.
- Human-attended microphone/camera/speaker acceptance. No physical capture occurred.
- Media-helper off/on comparison: Tim has no isolated reachable LiveKit SFU;
  adding a public service or repurposing its hosted service was outside scope.
- Native WebKit, supported mobile browsers, long-duration load and battery cost.
- Faster peer startup and broader NAT success. The successful route is one pair,
  not evidence that every volunteer can serve every member.
