# Calling transport architecture

Updated 2026-09-06. Implementation and verification details are in the
[audio-flow integrity work record](../plans/2026-09-06-audio-flow-integrity.md).

## Control, media, and persistence are different paths

Wabi's default `auto` calling policy prefers the WabiDB-labelled relay with a
P2P fallback; explicit P2P and optional LiveKit policies also exist. See
`callingFallback.ts` and `callingTransport.ts` for policy and selection.

The relay name does **not** mean that microphone samples are persisted as
WabiDB events. Call control uses the server's session/API/WebSocket machinery;
live audio/video envelopes use authenticated Socket.IO rooms. The server
maintains a bounded, ephemeral cache of initial Opus headers for late joiners.
The event-sourced database remains responsible for persistent application
state, not an append-only audio recording. Optional recording is separate.

## Microphone and screen sound

`audioCapture.ts` owns the shared microphone and optional browser DSP graph.
`AudioCaptureOwner` coalesces initial acquisition, invalidates superseded
permission requests, and retains the current input until a replacement commits.
Teardown also disposes capture results that arrive after the call ends.

The two media routes consume that selected, processed microphone:

- P2P owns a separate cloned send track per peer. Mute and transmit routing gate
  those clones synchronously, including pending device replacements. They do
  not mute an unrelated peer, recording source, or screen-share track.
- The relay passes an explicit `sourceNode` to opus-recorder. It must never ask
  the recorder to acquire another/default microphone. Screen audio has its own
  encoder borrowing the display track, and mic mute does not gate screen sound.

Relay capture starts only after correlated `wabidb-call-joined` authorization.
Socket loss stops both encoders immediately; rejoin restarts with fresh Opus
headers. Client and server changes to this acknowledgment must ship together.

## Receiving and handover

Relay decoders are keyed by account, sender socket, and microphone/screen
source. Decoder workers are streams: one Ogg page can produce zero or multiple
PCM outputs. Bounded PCM queues feed the playback AudioWorklet, then the shared
per-session audio graph. `playedChunks` counts render acknowledgments, not
successful decode calls or queued messages.

After 500 ms of microphone PCM has rendered for a participant, that participant's
redundant P2P **receive track** is suppressed. Screen audio and another peer's
audio cannot satisfy this gate. Room loss, stopped/suspended playback, or two
seconds without render acknowledgments restores the existing P2P receive path.
Stale relay teardown cannot override a replacement relay's selection.

Crucially, receive proof does not prove the outgoing direction. Handover does
not close a bidirectional P2P connection or its camera/sender. This intentionally
retains backup transport bandwidth; retiring it safely would require additional
bidirectional coordination, not a decode counter.

Manual channel switches prepare before tearing down the old route. A P2P switch
requires connected peers, not merely emitted SDP offers, and requires every
expected roster peer before leaving relay rooms. Failed preparation retains
the old route. DM/group manual switching and multiple channel-owned PCs for the
same peer are not supported by the current peer-key contract.

## Desktop and verification boundary

The actual native crate/config is at repository-root `src-tauri/`; the frontend
is shared with the browser. Its CSP permits the codec's WASM compilation and
blob decoder workers without general `unsafe-eval`. The standalone CodeMirror
build must also remain compatible with the installed Vite/Rolldown version.

Native media capability declarations are not proof that corresponding Rust
commands are registered. The current native crate does not implement a separate
microphone/DSP engine. Do not label browser processing as shipped native DSP.

Synthetic headful Chromium tests exercise actual codecs, worklets, local ICE,
mute, replacement, DSP recovery, and receive handover under the desktop CSP.
They do not certify physical microphones/speakers, NAT/TURN, two authenticated
Wabi clients, or WebKitGTK/WebView2/WKWebView behavior. Those remain release
checks. SRT/native enhancement proposals are not the current media baseline.
