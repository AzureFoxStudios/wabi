# Network health, Tailcat controls and voluntary boosters — candidate acceptance

Date: 2026-09-20. Working-tree implementation; not merged, deployed, or packaged.
This extends the [first field-test findings](FIELD_TEST_2026-09-20.md).

## Implemented

1. Admin Infrastructure uses the actual helper registry and a new authenticated
   network-health sampler. Process/host/interface scopes and unknown values are
   explicit. Unsupported heap counters now return null instead of fabricated
   zero; cumulative CPU user/system time is read separately using the host's
   clock-tick rate. Calling diagnostics distinguish signaling RTT.
2. Tailcat shows its Wabi-only port map, accepts live private-port changes with
   conflict preservation, and supports allow/block for a member device.
   Equivalent key encodings cannot bypass blocking; no allowed keys means no
   listener. Changes serialize JSON settings/key mutations. The forwarder and
   upgraded connections have cancellation tied to their owned lifetime.
3. A real file-offload path has a measurable origin-only/peer/fallback comparison.
   Operator media assignments are visible separately from measured delivery.
4. Voluntary browser file boosters have per-session consent, bounded memory,
   payload rate/session caps, expiry, recipient integrity verification and
   automatic origin fallback. Sessions grant no operator/node authority.

See [operator instructions and limits](../deployment/VOLUNTEER_BOOSTERS.md).
No durable WabiDB records/events/projections were changed. The only new saved
operator state is `volunteer_boosters.json` containing the enable flag. Sessions,
cache inventories, tickets and contribution counters are memory-only.

## Verification

- Pinned `1.93` toolchain resolves to Rust/Cargo 1.93.1; locked dependency builds.
- Cache tests cover quota/eviction, expiry, dropped inventory, server scoping,
  and changed-payload hashes.
- Rust integration coverage exercises consent, owner/admin restrictions,
  channel access, private-file exclusion, bounded inventory, tickets, receipts,
  revocation/stop, disabled policy and no eligible peer fallback.
- Tailcat contracts cover fail-closed empty allow-list, canonical key blocking,
  port conflicts, live rebinding, lifecycle and persistence. Real upgraded
  byte-stream regression tests remain in place.
- Real headful Chromium + real disposable loopback Authority + separate browser
  accounts verify the actual WebRTC data channel, not a mocked transfer.

### Final results

- Full `cargo +1.93 test --locked -p wabi-tailcat -p wabi-server`: **644 passed,
  0 failed, 2 ignored** (counts include the server library/binary test targets).
  [Suite summary](network-boosters-2026-09-20/server-test-summary.txt).
- `bun run check`: **0 errors**, 132 existing warnings in 45 files.
- `STATIC_BUILD=1 bun run build`: **passed**.
- `bun test src/lib/boosterBudget.test.ts`: **3 passed**, 16 assertions.
- Headful browser acceptance: **11 scenarios passed**, no page errors.
  [Structured results](network-boosters-2026-09-20/browser-results.json).

Reproduce the browser check from `frontend/`:
`node scripts/volunteer-boosters-browser-smoke.mjs ../target/debug/wabi-server`.
It needs a real desktop display and Chromium (override executable with
`WABI_SMOKE_CHROMIUM_PATH`). Do not run `svelte-kit sync` concurrently: it can
reload the test clients and intentionally reset their session-only consent.

Screenshots: [Admin](network-boosters-2026-09-20/admin.png),
[private access](network-boosters-2026-09-20/ports.png),
[member controls](network-boosters-2026-09-20/volunteer.png),
[390px member view](network-boosters-2026-09-20/volunteer-mobile.png).

### Observed browser workload

The synthetic attachment is 262,144 bytes. An origin-only download succeeds.
After a volunteer downloads and advertises that file, a different account
receives identical hash-verified bytes directly with **no additional Authority
file request**. Consecutive peer downloads work. Corrupting a peer payload causes
an origin retry. Stopping the volunteer removes its cache and the next download
uses the Authority. Leaving after the first 16,384-byte chunk likewise finishes
through origin fallback. Opting out during pending discovery prevents a peer
request; server/account changes retire consent and reset local counters.

The actual member, Admin and Tailcat components were rendered. The member view
was checked at 390px width with the real theme initialized. HTTP fixtures contain
only disposable users/files. No production/community data or physical capture
was used.

### Outstanding field acceptance

- Independent-network direct connections and fallback across real NATs.
- Native WebKit and supported mobile browsers; suspension/background behavior.
- Long-duration load, real metered-connection cost and CPU/cache overhead.
- Matched physical-media SFU/helper off/on scenarios. No existing production
  coturn/SFU/helper was repurposed, and no generic mesh/HA result is claimed.
- Multi-service Tailcat ACLs beyond the single Wabi application destination.

The previous field report remains unchanged: its blocked media/helper scenarios
are not retroactively marked passed by this smaller file-transfer experiment.

## Subsequent field run

The [three-machine follow-up](BOOSTER_FIELD_TEST_2026-09-20.md) passed 12 scenarios
with public UDP peer delivery between Janya and Tim, and retained the earlier
Janya-to-coordinator fallback finding. It also fixed populated Tailcat key
rendering and the peer-answer polling deadline. Native, mobile and physical-media
acceptance remain separate.
