# Linux desktop: microphone, camera, screen share and voice

Date: 2026-11-20. Branch: `fix/linux-desktop-media`.

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
2. Profile where the desktop app's memory goes. The target is "about as light as Discord, measured the same way"; ~300 MB was the figure mentioned.
3. Native voice engine in Rust, designed with the result of step 2.

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
- Not exercised in the app: the WebGL guard (needs a video call) and everything under "Not verified" below.

## Memory

Proportional set size of the whole process tree, test machine, headless, NVIDIA GL (which inflates these figures).

| What | Memory |
|---|---|
| Blank page in WebKitGTK (harness) | ~230 MB |
| Wabi desktop, entry screen, not logged in (app, `origin/main`) | ~415 MB |
| Voice call on the web path, 1 sending and 3 receiving (harness) | +77 MB, flat over 30 s |
| Voice plus video, 1 sending 640×360 VP8 and 2 receiving (harness) | +320 MB |
| After the call ended (harness) | ~+90 MB retained |
| One WebGL context (harness) | +8 MB |

The webview is ~230 MB before Wabi loads anything, and Wabi's UI adds ~185 MB before login. A native voice engine removes the in-call cost; it cannot bring the app near 300 MB without also shrinking or replacing the webview UI. That is what step 2 is for.

## Call paths without peer connections (read from code, not run)

- **Voice channels** use the relay or the SFU only, by design; here that means the relay.
- **Direct calls** in the default `auto` mode connect the relay and return before any peer is built. If relay video cannot start, the P2P camera attempt fails and the call continues as voice. A caller whose own setting is P2P-only sends an offer this client cannot answer; that call does not connect, and the caller is not told why.
- **Group calls** join the relay first and then build a redundant P2P mesh leg per participant. Here that leg throws the refusal and is logged; the relay carries the call. How the other participants' unanswered offers behave is unverified.

## Not verified

- A real call: the app, a server and a second client. This is the acceptance check for step 1. It can be automated: `scripts/desktop-host-native-smoke.mjs` already starts an Authority and admits a second Chromium client, and WebDriver granting media permission is harmless for the call path.
- Real voice (no microphone was attached) and audible playback.
- Camera capture and screen-share frames end to end; both need a person at the desktop's prompts.
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

# Engine capability table, relay audio path, memory:
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- \
  python3 scripts/linux-webview-media-probe/probe.py --origin tauri --csp --permissions allow --mode matrix --out /tmp/matrix.json
```

Do not run camera or screen-share probes with nobody at the machine: an unanswered camera prompt is stored as a refusal (`flatpak permissions devices` shows it).
