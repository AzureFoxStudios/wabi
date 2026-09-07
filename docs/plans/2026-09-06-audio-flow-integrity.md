# Audio-flow integrity — 2026-09-06

Scope: make the selected microphone, screen sound, playback, and recovery
ownership coherent across P2P and the WabiDB-labelled relay, preserving the
shared Tauri frontend. Based on HEAD `2e19dfdb` and the screen-audio push
`5a9c5cd3`. No push, deployment, production restart, or data/schema changes.
Final verification continued on 2026-09-07.

## Diagnosis

The established signaling, transport policy, shared graph and media lanes were
substantial, but several success indicators did not establish working audio:

- opus-recorder 8.0.5 takes `sourceNode` in its constructor; `start(stream)`
  ignores the argument. Both microphone and display capture could open the
  default microphone. The display lane is deliberately independent of mic
  mute, making that wrong source a privacy defect.
- The playback worklet never accepted posted PCM. The decoder wrapper also
  treated a streaming worker as one-request/one-response, dropping additional
  outputs and timing out valid header-only pages.
- Room join was fire-and-forget; initial encoder headers could precede room
  authorization. Account-only stream keys mixed separate devices. The screen
  subscription retained its original relay rather than following its owner.
- P2P mute relied on asynchronous sender parameter changes. Device replacement
  shared tracks across independently routed calls; capture completion could
  outlive a leave or newer device choice.
- Recovery counted offer creation as connection success. Promotion could reuse
  an old teardown closure against its replacement. Decode-based retirement
  closed a whole bidirectional mesh on receive-only evidence from one user.
- The actual root Tauri config lacked codec worker/WASM CSP allowances. The
  standalone editor build used an unsupported Vite 8 chunk configuration and
  a case-sensitive transform target spelling that no longer worked.

These are media/lifecycle defects, not evidence that audio packets belong in
WabiDB's event store. No postcard record or engine boundary was modified.

## Implemented ownership model

`AudioCaptureOwner` owns acquisition/replacement; calls and transports borrow
its selected output. A late cancelled capture is disposed without publication.
The DSP context resumes separately from the playback graph and its gesture
listeners are released on disposal. Failed DSP construction releases the mic.
The microphone selector now applies changes to the active call. The settings
sample recorder uses its own capture owner with the same selected-device/DSP
factory; closing settings cancels pending acquisition and releases previews.
The touched settings component was migrated to Svelte 5 runes, following the
frontend architecture guidance, without changing its layout.

`peerMicrophone.ts` owns per-peer cloned microphone senders, synchronous mute,
serialized replacement and teardown. `RelayAudioCapture` borrows one explicit
track and owns only its encoder/source node. Relay pages use a 40 ms target
instead of the dependency's 800 ms default. Mute/leave invalidate emissions
before asynchronous cleanup; replacement and rejoin start fresh streams.

`relayRoom.ts` waits for a correlated authorization acknowledgment, with denial,
disconnect, abort and timeout cleanup. Server header cache keys include socket
identity and source, and disconnect forgets that socket's cache entries.

The receive pipeline accepts every streaming decoder output, downmixes channels,
rejects stale worker output, and bounds buffered PCM to half a second. The
worklet explicitly handles PCM/reset messages, underflow and overflow. Its
render acknowledgments drive diagnostics and per-user receive selection.

`peerAudioPlayback.ts` suppresses only redundant P2P reception after 500 ms of
that peer's relay microphone rendering. It restores reception on relay loss or
render timeout, preserving sender/camera connections. This replaces the old
whole-mesh close workaround while retaining its purpose: avoid duplicate audio.
The deliberate cost is backup P2P bandwidth until normal call teardown.

Watchdog continuations validate their owner after awaits. Promotion establishes
the primary without reusing the old primary's teardown. Manual channel handover
waits for actual peer connection readiness, settles all preparation before
rollback, and retains the original route on failure. Superseded PC callbacks
cannot mutate the replacement. The old unreferenced STDB relay was removed;
git history retains it, and no runtime data was deleted.

## Verification and reproduction

From `frontend/`:

```sh
bun test src/lib
bun run check
bun run build:static
bun run build:tauri
node scripts/audio-browser-smoke.mjs
```

Run web and desktop frontend builds sequentially: both write `build/` and
SvelteKit output. The browser test launches **headful** Chromium. It uses
generated tones, isolated test sockets/local PCs, no account/deployed server,
and a silent master output. Unexpected recorder `getUserMedia` is a failing
tripwire; the DSP portion explicitly stubs acquisition with a generated track.
It loads the real root Tauri CSP. It is media verification, not a full UI test.

Regression coverage includes the actual worklet (failed before its fix), actual
encoder/decoder WASM round trip, streaming zero/many output, per-device/source
isolation, room acknowledgment races, encoder cancellation, capture ownership,
P2P mic replacement/mute, per-peer receive selection and stale-owner teardown,
render failure/recovery, and watchdog promotion/late completion (failed before
their fixes).

Latest completed checks during implementation:

- Frontend: **273 passed, 12 skipped, 0 failed**; typecheck **0 errors**, 185
  existing warnings. Skips are existing cryptography tests, not hidden audio
  failures.
- Headful media test: selected mic vs display tones; mic-only mute; replacement;
  room loss/rejoin; real local WebRTC ICE/media; mute/replacement/unmute;
  suppress/restore reception without closing sender; real DSP render/resume.
- Headful settings component: device selection invokes call replacement;
  four-second selected-device DSP recording completes and releases capture;
  closing during permission disposes the late track without a preview leak
  or late error dialog. Application-service imports are isolated in this
  fixture: it proves the UI calls the update hook, not a full authenticated
  two-client device switch. Capture, DSP and MediaRecorder are real.
- Server: `cargo test -p wabi-server --features addons -- --test-threads=1`:
  **371 passed, 1 ignored, 0 failed**, including call-write visibility and
  authorization/cache coverage. The first sandboxed attempt could not bind
  test sockets (nine failures); the approved unrestricted rerun passed.
- Web static and Tauri frontend builds succeeded, including the desktop
  standalone CodeMirror asset. Emitted assets include the encoder worker,
  decoder WASM and playback worklet.
- Normal native Rust check now passes:
  `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline`.
  Initially only a test-only sidecar-excluded check could run. That limitation
  was resolved using `scripts/fetch-tailcat-sidecar.sh` to fetch the pinned
  genuine v0.4.0 artifact, not by weakening the checked-in bundle config.
  The release archive SHA-256 matched GitHub's published asset digest:
  `8b819c43dfdf806b5663e23535aba557bb106075b0b5839df289af9bba70bec2`.
  The sidecar is an ignored local build dependency; no private-access service
  was started and no network profile was changed.
- Full Tauri release invocation ran the real frontend pre-build hook and
  successfully linked the optimized Linux application at
  `src-tauri/target/release/wabi-desktop` (2m34s native compilation).
  Debian installer creation then aborted with `Can't detect any appindicator
  library`. Runtime libraries are installed, but neither appindicator nor
  Ayatana appindicator **pkg-config development metadata** is available.
  Tauri's [library discovery implementation](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-cli/src/interface/rust.rs)
  uses pkg-config rather than just looking for the installed `.so` files.
  No installer was produced; no tray feature was disabled and no host OS
  package installation was attempted. Use an appropriately provisioned build
  environment (the repository's Tauri builder Dockerfile lists the dependency).

## Release boundaries and remaining work

This is not a claim that all calling is production-certified. Before release:

- Ship the relay join acknowledgment server and client together. An older
  server produces an honest timeout/fallback, not a false ready state.
- Verify two authenticated clients on different networks, in both directions:
  selected physical mic, mute/deafen, screen sound while muted, device changes,
  token refresh/socket reconnect, and transport handover. Synthetic local ICE
  does not test TURN/NAT, acoustic echo cancellation, or physical audibility.
- Build/run the native package on each supported OS. The local Linux build
  dependency is supplied and release binary links; installer packaging still
  needs appindicator development metadata. Chromium under desktop CSP is not
  native webview verification.
- Call-session badges still summarize a transport; they are not per-participant
  bidirectional audio proof. The singleton watchdog, peer key without a session
  component, and global video-lane ownership remain architectural limitations
  for a subsequent call-session-wide objective. Manual switching now refuses
  to replace another call's peer merely to satisfy the requested channel.
- Long-lived decoder cleanup for departed remote devices, full multi-client
  handover integration, and end-to-end SFU/device-switch coverage remain useful
  follow-up work. Receive-path proof must never become a pretext to close an
  unverified outgoing path again.

Autoplay follow-up: relay receive setup no longer awaits a potentially
indefinitely pending `AudioContext.resume()`. Gesture handling is installed
before media startup, and an autoplay-blocked setup/teardown regression passes.
