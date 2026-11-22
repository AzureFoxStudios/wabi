# Linux desktop: microphone, camera, screen share and voice

Date: 2026-11-20, extended 2026-11-21. Branches: `fix/linux-desktop-media` (steps 1 and 2) and `feat/linux-native-voice` on top of it (step 3).

Evidence labels used below:

- **measured, app** — the real `wabi-desktop` binary on the test machine.
- **measured, harness** — `scripts/linux-webview-media-probe/`, a WebKit2 4.1 webview with wry's settings, the `tauri://localhost` origin and the app CSP. Same engine as the app, not the app.
- **source** — read from upstream or distro sources during research; not runtime-tested here.

Test machine: Bazzite 44 (Fedora Kinoite base), KDE Plasma on Wayland, NVIDIA RTX 3070 (driver 615), PipeWire 1.6, WebKitGTK 2.54.1, tauri 2.10.3, wry 0.54.4. It has no microphone or camera attached; the audio input used was an empty onboard jack.

## Outcome

The report was "the Linux desktop app cannot find a camera or microphone". The cause was the shell, not the calling design, and this branch fixes it (step 1 below). Two product requirements raised during the work are **not** met by this fix and need a native voice engine:

- audio on a par with Discord or TeamSpeak (echo cancellation, noise suppression, a real-time transport);
- joining LiveKit calls from the Linux desktop app.

Agreed order (Ronin, 2026-11-20):

1. Make the existing web calling path work in the Linux desktop app, provided it costs no memory at idle. **This branch.**
2. Profile where the desktop app's memory goes. The target is "about as light as Discord, measured the same way"; ~300 MB was the figure mentioned. **Done 2026-11-21; see Memory.**
3. Native voice engine in Rust, designed with the result of step 2. **Built 2026-11-21 as an opt-in; see Step 3 for what is and is not wired.**

A Chromium-based runtime (CEF) was considered and dropped: it would give WebRTC and in-engine audio processing, but it is heavier than the current webview and only exists as a Tauri v3 alpha (source).

## Root causes

1. **Nobody answered WebKit's permission requests.** WebKitGTK asks its embedder before a page may list or open capture devices and refuses by default. `src-tauri` and wry 0.54 connect no handler, so every `getUserMedia` failed with `NotAllowedError` (measured, app: the debug self-test with the handler left out).
2. **No WebRTC in WebKitGTK.** `RTCPeerConnection` is undefined (measured, app and harness, even with `enable-webrtc` on). Fedora, Debian, Ubuntu, Arch, openSUSE and the GNOME runtime all build without it; upstream turned it off in 2.54, removed the GStreamer backend, and hopes to enable LibWebRTC in 2.56, around March 2027 (source). Direct P2P calls, the P2P fallback, LiveKit and P2P file transfer cannot work in this engine. The frontend guarded one of its four `new RTCPeerConnection` sites.
3. **NVIDIA + Wayland.** The app dies within a second with `Error 71 (Protocol error) dispatching to Wayland display`; it survives with `__NV_DISABLE_EXPLICIT_SYNC=1` or `WEBKIT_DISABLE_DMABUF_RENDERER=1` (measured, app, 60 s each). The second leaves the web process without a GL display, and WebKitGTK 2.54 then aborts on the first WebCodecs `VideoDecoder` call unless the page has created a WebGL context (measured, harness). Upstream cause: `requestGLContext()` reaches `PlatformDisplay::sharedDisplay()`, a release assert; not fixed in 2.54.3 or main, no upstream bug found (source).
4. **Cameras go through the desktop camera portal** from WebKitGTK 2.50 (source). With a PipeWire camera present, KDE shows a prompt, `enumerateDevices()` and `getUserMedia` wait on it, and a dismissed prompt is stored as a permanent refusal for that app id (measured, harness; capture itself not verified).
5. **Engine gaps.** `echoCancellation` is advertised but the capture pipeline has no echo canceller; `noiseSuppression` and `autoGainControl` do not exist (source; the measured constraint list agrees). `getDisplayMedia` is video only (source). No `setSinkId`. The default `MediaRecorder` container (MP4/AAC) records 0 bytes on Fedora while `audio/webm;codecs=opus` works (measured, harness).

## What works in this engine

Measured in the harness with permission answered:

- Microphone capture, labelled device list, selection by `deviceId`, 48 kHz `AudioContext`.
- The relay audio path with the production pieces — opus-recorder's encoder (an AudioWorklet module carrying WASM), the decoder as a blob Worker fetching its WASM from the app origin, and `audio-worklet-playback.js` — under the app CSP: 3 s of microphone and of a 440 Hz tone at 0.5 went through encode, decode and playback render with no errors; the tone came back at 0.52.
- WebCodecs video: VP8, VP9 and AV1 encode, all decodes, canvas → encode → decode round trip. H.264 encode is unavailable.
- Screen share: a click-triggered `getDisplayMedia` with the app's constraints reaches the portal picker (`CreateSession → SelectSources → Start`). What happens after picking was not verified.

Measured in the app (WebDriver session, where WebKit grants permission itself): origin `tauri://localhost`, secure context, live labelled microphone track.

## Step 1: what this branch changes

Shell (`src-tauri`):

- `src/linux_media.rs`: answers `UserMediaPermissionRequest` and `DeviceInfoPermissionRequest` for the app's own origin (`tauri://localhost`; the Vite dev URL in debug builds), refuses them from any other page, and leaves every other request type to WebKit. Sets `enable-media-stream`, which is off by default before WebKitGTK 2.46. The origin list was checked against the code: the shell opens no other window and never navigates, capabilities list no remote URLs, Tailcat and desktop hosting change the API base rather than the page.
- On the NVIDIA proprietary driver under Wayland it sets `__NV_DISABLE_EXPLICIT_SYNC=1` at startup unless a rendering override is already set or `WABI_NO_GPU_WORKAROUNDS=1`. Verified on one machine and one driver.
- A debug-only self-test (`WABI_MEDIA_SELFTEST`, `WABI_MEDIA_SELFTEST_NO_HANDLER`) and `scripts/desktop-media-native-smoke.mjs`, which runs the same debug binary with and without the handler. WebDriver cannot test this: WebKit's automation mode answers media permission itself.

Frontend (deliberately small; the native engine replaces this code):

- `mediaCapabilities.ts`: `hasPeerConnection()`, read at call time. `effectiveChain` drops `p2p` and `sfu` when it is false, so every call in such a webview uses the relay; the transport state records `fallback_wabidb_no_peer_connections` when that changed the first choice, and a P2P-only setting is refused with the reason before any capture. The three unguarded `new RTCPeerConnection` sites and the LiveKit entry throw that reason instead of a ReferenceError.
- Before the first `VideoEncoder`/`VideoDecoder` use on WebKitGTK the video lane creates and keeps one WebGL context (root cause 3). If none can be created, video is refused rather than attempted. Nothing is created at import, so idle memory does not move.
- The settings microphone test names its recorder container.

Verification on the test machine:

- `scripts/desktop-media-native-smoke.mjs` on the debug build: with the handler, a live labelled microphone track and labelled device list in `tauri://localhost`; without it, `NotAllowedError`.
- Entry-screen memory, release builds, same method: 415.2 MB before, 415.3 MB after.
- Live KDE Wayland session, release build, no environment flags: runs for the 60 s tested with the workaround; dies in 1 s with `WABI_NO_GPU_WORKAROUNDS=1`; leaves `WEBKIT_DISABLE_DMABUF_RENDERER=1` alone when the launcher sets it.
- Shell unit tests 60/60. Frontend `bun run check` and `check:i18n` pass. `bun test`: 126 failures before and after, none new (they fail on `origin/main` in this checkout).
- 2026-11-21, `scripts/desktop-voice-native-smoke.mjs` (release build, staged Authority built from this branch, headless): the desktop app and a Chromium client in one voice channel; each decoded and rendered non-silent audio from the other with no decode failures (desktop microphone was a virtual PipeWire source carrying a tone; `RTCPeerConnection` undefined on the desktop). With `WABI_SMOKE_VIDEO=1` the desktop decoded the Chromium client's relay camera, in both renderer modes; with DMABUF off this exercises the WebGL guard in the real app.
- Everything under "Not verified" below remains unexercised.

Found by that smoke:

- **Relay video from other clients never decoded on the Linux desktop.** The lane configured `VideoDecoder` with `width`/`height`, which are not `VideoDecoderConfig` members. Chromium decodes VP8 without dimensions; WebKitGTK reports "Decode error" on every frame until `codedWidth`/`codedHeight` are given (measured in the app: the same Chromium keyframe decodes with them and fails without). Fixed on this branch.
- **Startup can wait indefinitely on the keyring.** With the KDE wallet locked the app stayed at "Checking your session" and made no request to its server; on a private bus with no secret service it proceeded at once. Inferred from those two runs, not traced to the blocking call. `nativeAuthPersistence.ts` awaits `secure_auth_get` with no timeout.
- **A plain-HTTP LAN invitation cannot use voice in a browser.** `http://192.168.x.x` is not a secure context, so the browser hides the microphone API; the client says so. The smoke passes Chromium a flag to treat that origin as secure.

## Memory (step 2, measured 2026-11-21)

Proportional set size (PSS) from `/proc/<pid>/smaps` for the app's whole process tree, split by process and mapping with `scripts/linux-webview-media-probe/smaps_profile.py`. Release builds, test machine, one sample each unless noted. "Headless" is a 1280×720 `cage` output; "live" is the KDE Wayland session at the app's default window size. "GPU" is WebKit's default DMABUF renderer; "no DMABUF" is `WEBKIT_DISABLE_DMABUF_RENDERER=1`, which the test machine's launcher sets. The bundled Authority (40–55 MB when the app hosts a community) is left out of every figure.

| State | Headless, GPU | Headless, no DMABUF | Live, GPU | Live, no DMABUF |
|---|---|---|---|---|
| Hello-world Tauri app (same tauri, wry and WebKitGTK) | 312 MB | 164 MB | 327 MB | 172 MB |
| Wabi, entry screen, not logged in | 433–438 MB | 309–324 MB | 439 MB | 480 MB |
| Wabi, logged in, new empty community | 534 MB | 410–414 MB | not measured | not measured |
| + voice call, one other participant, ~45 s in | 686 MB | 526–528 MB | | |
| + the same call ~75 s later | not measured | 567 MB | | |
| + receiving one 640×360 VP8 camera | 852 MB | 708 MB | | |

What the split shows:

- **A webview costs 164–327 MB before Wabi loads anything.** The hello-world host process alone is 128 MB with the GPU renderer (49 MB heap, 20 MB anonymous, NVIDIA and GL libraries) and 72 MB without.
- **The renderer mode is not a dependable saving.** Without DMABUF the page is rasterised on the CPU and the cost follows the window's pixel count: it saved ~125 MB at 1280×720 headless and cost ~40 MB more than the GPU path on the live session. The WebCodecs abort that used to rule this mode out is covered by the WebGL guard, so the choice is memory against GPU compositing, per machine.
- **Wabi's own share at the entry screen is ~120 MB** (GPU, headless): ~90 MB in the web process (anonymous memory 123 MB against 63 MB for hello-world, plus more of the WebKit and JavaScriptCore libraries paged in) and ~27 MB in the host (the 61 MB binary, of which ~19 MB is resident; the frontend build is 27 MB before compression). Logging in to an empty community adds ~95 MB more, nearly all anonymous memory in the web process.
- **A voice call on the web path adds ~115 MB at 45 s. The 2026-11-20 harness figure of +77 MB was a bare page with the codec pieces, not the app.** Receiving one camera adds ~165–180 MB.
- **The web process grows for as long as a call lasts, at roughly 0.7–0.9 MB per second** (anonymous memory; six samples over six minutes rose in a straight line from 204 to 525 MB). Outside a call it is flat (four samples over four minutes within 1.5 MB). It is not the audio codec path: the growth is the same on the native engine. It continued after the page's microphone track was stopped and after the other participant left. The Chromium client in the same call did not grow: its JavaScript heap after a forced collection was 16.4, 15.1 and 15.0 MB at the same three moments the desktop's web process went 340, 412, 481 MB. So it is specific to the WebKitGTK side: the engine itself, something the app does that only leaks there, or WebDriver automation, which has not been ruled out. Not traced further. At this rate an hour-long call would add about 3 GB.
- **The Rust host is not where the weight is.** Wabi's host process is 27 MB above hello-world's at the entry screen and does not grow in a call.

What this means for the target of "about as light as Discord (~300 MB)": on this machine an empty Tauri window is already 164–327 MB, so a logged-in Wabi cannot reach 300 MB in this webview with the GPU renderer, whatever is done to the UI. Reaching it needs both a lighter UI (roughly 215 MB of Wabi-attributable memory when logged in) and a rendering path that stays cheap at real window sizes, or a UI that is not a webview. A native voice engine removes the in-call growth only. Discord was not installed, so there is no like-for-like figure for it.

Not measured: a populated community (history, members, images), long sessions, other GPUs and drivers, heap attribution inside the web process (no heap profiler is installed; the split above is by mapping type).

## Step 3: native voice engine (2026-11-21, branch `feat/linux-native-voice`)

### What was measured first

- **LiveKit's Rust client is light at run time and heavy to build.** A minimal client (`livekit` 0.12) in a room with another participant: 14 MB PSS, flat over 30 s, audio both ways. It adds about 29 MB to a stripped binary, downloads a 156 MB prebuilt libwebrtc at build time and needs clang 21 or newer (measured in a Fedora 44 container; the test machine has no clang).
- **The test machine cannot build anything that needs audio headers**: no ALSA, PipeWire or PulseAudio development files and no clang. That rules out `cpal` and libwebrtc for the default build.

### Design

```text
page (unchanged owner of admission, signalling, the relay socket)
  │  received relay pages (base64, as they arrive)      ▲ microphone as relay pages
  ▼                                                     │
shell: src-tauri/src/voice.rs  (voice_* commands, watchdog)
  ▼                                                     │
crates/wabi-voice
  Mixer: Ogg → Opus decode → jitter queue → mix ──► playback ──► speakers
                                              └──► echo reference
  microphone ──► WebRTC processing (AEC3, noise suppression, AGC2) ──► Opus → Ogg pages
                                                                  └──► LiveKit track (feature `livekit`)
```

- **Wire format unchanged.** The engine reads and writes what `relayAudioCapture.ts` and opus-recorder do: Ogg Opus, mono 48 kHz, two 20 ms packets per page, OpusHead and OpusTags as envelopes 0 and 1. Browser clients and the server need no change.
- **Processing** is WebRTC's pipeline through `sonora` 0.3, a pure-Rust port (first released February 2026). It sits behind a trait so it can be swapped.
- **Devices** go through the PulseAudio protocol with the pure-Rust `pulseaudio` client. PipeWire desktops (pipewire-pulse) and PulseAudio desktops both serve it, and it is the audio socket Flatpak grants. Nothing audio-related is linked and no headers are needed; libopus is built from source by `opusic-sys` (needs cmake and a C compiler).
- **Off by default.** `WABI_NATIVE_VOICE=1` in the environment, or `localStorage.wabi_native_voice = '1'`, switches the relay to the engine; `'0'` in localStorage refuses it. Everything else keeps the web path.
- **The microphone cannot outlive the page.** It closes when the page's microphone track is muted or ended, when the page stops polling for five seconds, and when the webview starts loading a document.

### Verified

- `crates/wabi-voice`, 13 unit tests: Ogg framing against the `ogg` crate both ways, the header convention, a tone through encode, decode and mixing, restarts, deafen, per-call volume, overflow, and echo removal on a synthetic echo path (44.6 dB).
- Real PipeWire devices, `examples/echo.rs` with a `pw-loopback` echo path: what would be sent back fell from −19.6 dB to −78.2 dB with echo cancellation on. That is a wired, linear echo path, the easiest case.
- `scripts/desktop-voice-native-smoke.mjs` with `WABI_SMOKE_NATIVE_VOICE=1`: the same two-client call passes on the engine in both directions with no decode failures, and the engine's microphone closes within 10 s of a page reload and of the page going silent (`WABI_SMOKE_HOT_MIC=watchdog`). The default web path, with video, was re-run on the final build and passes.
- LiveKit, engine level (`examples/livekit_room.rs`, built in a container, against a local `livekit-server` and a second client): each side heard the other. The whole engine process in the room: 24 MB.
- Memory: the engine alone is 3–4 MB. In the app, the web process at the first in-call sample (~45 s) was 306–340 MB across five runs on the engine against 393–395 MB across two on the web path, so roughly 55–85 MB lower. The growth described under Memory is unchanged.
- Cost to the app: +2.2 MB of binary. `frontend` type check passes; 8 new bridge tests; shell tests 60/60.

### Not done

- **Nobody has listened to it.** Every check is a counter or a level. Whether it sounds right, with a real voice, real speakers and a real room, needs a person.
- **LiveKit is not reachable from the app yet.** The shell has `voice_livekit_join`/`leave`/`set_muted` behind the `livekit` cargo feature, but `callingLivekit.ts` still uses the browser client and the chain still drops `sfu` without peer connections. Wiring it means a second, audio-only implementation of that module's state (participants, moderation, token refresh). It could not be tested here: the server side is behind `experimental-livekit-broker` and needs a media node.
- **No device picker.** The engine uses the system defaults, or `WABI_VOICE_SOURCE`/`WABI_VOICE_SINK`. The page's saved microphone choice is a WebKit device id and does not apply.
- **The page still opens its own microphone** (for mute state and the local speaking indicator), so two captures run. Dropping it is the next memory step.
- **Not carried over from the web path:** per-user spatial position, the call-recording tap, screen-share audio capture (received screen audio is played).
- **Packet loss:** no concealment or reordering beyond a 60 ms playout buffer; Opus in-band FEC is switched on for sending but not used when receiving.
- **Build:** CI's Linux job now compiles libopus (cmake). `src-tauri/Cargo.lock` gained the optional LiveKit tree and `tokio-util` moved 0.7.18 → 0.7.20. Not run in CI.
- macOS, Windows, Android and iOS: the commands are written to report the engine as unavailable there, but the shell was only compiled on Linux after this change.
- The shell's LiveKit commands compile with `--features livekit` (checked in a Fedora 44 container) and have never run; only the crate-level module was exercised.

## Call paths without peer connections (read from code, not run)

- **Voice channels** use the relay or the SFU only, by design; here that means the relay.
- **Direct calls** in the default `auto` mode connect the relay and return before any peer is built. If relay video cannot start, the P2P camera attempt fails and the call continues as voice. A caller whose own setting is P2P-only sends an offer this client cannot answer; that call does not connect, and the caller is not told why.
- **Group calls** join the relay first and then build a redundant P2P mesh leg per participant. Here that leg throws the refusal and is logged; the relay carries the call. How the other participants' unanswered offers behave is unverified.

## Not verified

- A real call between two machines. The automated check above runs both clients on one machine.
- Real voice (no microphone was attached) and audible playback.
- Camera capture and screen-share frames end to end; both need a person at the desktop's prompts.
- The permission handler on a release build (the self-test is debug-only; the handler code is the same).
- Any other distro, GPU or driver; X11 sessions; the AppImage at runtime.
- Servers configured for LiveKit: a client without peer connections falls through to the relay, which may leave it in a different media plane from LiveKit participants.
- Whether P2P file transfer has a non-P2P fallback worth offering here.
- macOS, iOS and Android: no microphone or camera usage declarations exist under `src-tauri/`.

Packaging was left alone. deb and rpm declare no GStreamer or PipeWire plugin dependencies, and the AppImage on disk carried the build host's WebKit with no GStreamer plugins. Dependency names need checking per distro before they are added; a wrong name makes the package uninstallable.

## Re-running the checks

```bash
# Real app, handler on and off (debug build; headless):
frontend/node_modules/.bin/tauri build --debug --no-bundle
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- dbus-run-session -- \
  node scripts/desktop-media-native-smoke.mjs "$PWD/src-tauri/target/debug/wabi-desktop"

# Two-client voice call, with relay video. Build the Authority from the same
# source first so the browser client reports its counters:
(cd frontend && STATIC_BUILD=1 bun run build) && cargo build --release -p wabi-server
node scripts/stage-desktop-host.mjs --target x86_64-unknown-linux-gnu --binary target/release/wabi-server --overwrite
frontend/node_modules/.bin/tauri build --no-bundle
WABI_SMOKE_VIDEO=1 WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- \
  node scripts/desktop-voice-native-smoke.mjs "$PWD/src-tauri/target/release/wabi-desktop"
# Memory at each stage: WABI_SMOKE_CHECKPOINT=<script calling smaps_profile.py "$1" "$2" out.json>

# The same call on the native engine, then the hot-microphone checks:
WABI_SMOKE_NATIVE_VOICE=1 WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- \\
  node scripts/desktop-voice-native-smoke.mjs "$PWD/src-tauri/target/release/wabi-desktop"
(cd crates/wabi-voice && cargo test && cargo run --release --example loopback -- --list)

# Engine capability table, relay audio path, memory:
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- \
  python3 scripts/linux-webview-media-probe/probe.py --origin tauri --csp --permissions allow --mode matrix --out /tmp/matrix.json
```

Do not run camera or screen-share probes with nobody at the machine: an unanswered camera prompt is stored as a refusal (`flatpak permissions devices` shows it). Run app-driving checks on a private session bus (the voice smoke does this itself): on the real one they can raise wallet prompts and store throwaway tokens in the person's keyring.
