# Call Recording Plan

## Goal

Add local high-quality recording for DM, group, and voice-channel calls, including screen share, with the same recorder working across:

- direct WebRTC calls
- TURN-relayed WebRTC calls
- LiveKit-backed channel/group calls
- the current experimental STDB-labeled call path

This plan is for local creator-style recording, not server-side archival recording.

## Current Architecture Summary

- Call media converges in the frontend call layer in `frontend/src/lib/calling.ts`.
- Active call UI and participant/share layout already live in `frontend/src/lib/components/CallModal.svelte`.
- Layout behavior already exists in `frontend/src/lib/callLayoutManager.ts`.
- Browser-side recording patterns already exist in:
  - `frontend/src/lib/components/AudioRecorder.svelte`
  - `frontend/src/lib/video/videoCompressor.ts`
- Desktop/Tauri media preferences and capability flags live in:
  - `frontend/src/lib/tauri-media.ts`
  - `frontend/src-tauri/src/handlers.rs`
- The current STDB call path is metadata/signaling tagging only, not a separate media stack.

## V1 Scope

- Local recording only.
- Modes:
  - audio-only
  - video call
  - screen + audio
- One mixed output file.
- Browser and Tauri support.
- No server archive, no egress, no STDB-specific recorder branch.

## Implementation Plan

### 1. Recorder Core

Add a dedicated recorder module, likely `frontend/src/lib/callRecorder.ts`.

Responsibilities:

- subscribe to:
  - `localStream`
  - `activeCalls`
  - `localScreenStream`
  - `screenShares`
  - `callMode`
  - transport/diagnostic state
- expose:
  - `recordingState`
  - `startCallRecording`
  - `stopCallRecording`
  - progress/error stores

### 2. Audio Pipeline

Build a mixed output stream with Web Audio:

- `AudioContext`
- `MediaStreamAudioSourceNode`
- `GainNode`
- `DynamicsCompressorNode`
- `MediaStreamDestination`

V1 mix:

- local mic
- remote participants
- optional screen-share audio when present

Notes:

- Start simple with gain staging and a light limiter/compressor.
- Reuse the existing DSP ideas already present in `calling.ts`.
- Default behavior: local mute should mute the recording.
- Add a separate user-facing setting for outbound-only mute so VTuber/avatar-style workflows can silence transmission without silencing local recording.

### 3. Video Pipeline

Build a canvas compositor for video recording.

Use existing participant/share data and layout logic from:

- `frontend/src/lib/components/CallModal.svelte`
- `frontend/src/lib/callLayoutManager.ts`

Rules:

- screen share becomes hero when present
- otherwise use speaker/grid layout
- include local camera tile when relevant

Combine:

- canvas video stream
- mixed audio stream

Feed the final stream into `MediaRecorder`.

### 4. Format and Preset Handling

Select recording MIME type dynamically with `MediaRecorder.isTypeSupported`.

Initial presets:

- Podcast: audio-first, higher audio bitrate
- Class: balanced 720p/1080p
- Creator: higher video bitrate and frame rate when available

Desktop defaults should respect the existing local-enhanced media preference model.

### 5. Call UI

Add recording controls to `frontend/src/lib/components/CallModal.svelte`.

V1 UI:

- start/stop recording
- mode selector
- quality preset
- timer
- error state
- recording badge

Required product choice:

- show a visible in-call recording badge to everyone in the call even if files are local-only
- recording UX should favor explicit transparency over subtlety

### 6. Browser Save Flow

For web builds:

- create blob/object URL
- trigger file download

Keep this simple in V1.

### 7. Tauri Save Flow

For Tauri builds:

- add native save/export support
- avoid browser-style download UX

Likely work:

- extend `frontend/src-tauri/capabilities/default.json`
- add Tauri plugins or custom Rust commands for:
  - choose save location
  - write output file
  - optionally write incrementally in chunks

This is the main Tauri quality-of-life win over web builds.

Default format target:

- prioritize outputs that are both high quality and broadly usable in modern NLEs
- preferred desktop/Tauri target: MP4 with H.264 video and AAC audio when post-process/remux support is available
- browser fallback: use the best runtime-supported `MediaRecorder` format, but keep the long-term target aligned with editor-friendly output rather than WebM-only workflow

### 8. STDB Treatment

Do not build a separate STDB recorder path.

Treat STDB-labeled calls exactly like other calls at the media layer.

Optional:

- include transport/session metadata in the saved recording manifest

Examples:

- `p2p`
- `turn`
- `sfu`
- `experimental-spacechatdb-stdb-call`

### 9. Testing

Manual test matrix:

- DM call
- group call
- voice channel
- screen share
- P2P
- TURN-relayed
- LiveKit/SFU
- experimental STDB-labeled call
- browser build
- Tauri build
- reconnect while recording
- start/stop screen share while recording

Unit/integration coverage:

- MIME selection
- preset resolution
- layout decisions
- recorder state transitions

## Recommended Delivery Order

1. frontend recorder core and mixed audio recording
2. canvas-based video/screen recording
3. browser save flow
4. Tauri native save flow
5. Tauri chunked writing and optional remux
6. polish and diagnostics

## Tauri-Specific Opportunities

Rust can improve desktop quality of life around the recorder even though the actual call media remains WebRTC in the webview.

High-value Tauri additions:

- native save dialog
- chunked disk writing for long recordings
- persistent desktop defaults
- optional post-process/remux after recording
- optional prevent-sleep behavior during long recordings

## Voice Effects Opportunity

Yes, voice effects fit this area well.

Current code already has audio-processing concepts:

- audio processing modes in `frontend/src/lib/mediaRuntime.ts`
- runtime audio processing logic in `frontend/src/lib/calling.ts`
- DSP nodes already used in `calling.ts`

Recommended approach:

- V1 effects in the frontend/Web Audio graph
- apply effects to the outbound mic path before it is sent to peers
- optionally allow local monitoring

Good initial effects:

- EQ
- compressor/limiter
- pitch shift
- robot/telephone style filters
- reverb as an opt-in novelty effect

Even if users can route a virtual mic with external effects, in-app effects still add value because they are:

- easier to use
- portable across installs
- easier to combine with recording and soundboard features

## Soundboard Opportunity

Yes. This is a good adjacent feature because it can reuse the same outbound audio graph as recording/effects.

Two possible scopes:

### Local Soundboard First

- frontend-managed clip library
- inject selected clips into the outbound call mix
- no backend dependency required for V1

Best for:

- quick implementation
- personal creator workflows
- testing the UX

### Shared Soundboard Later

- backend storage for uploaded clips
- permissions/rate limits/moderation
- per-server or per-channel soundboards
- asset distribution and caching

Best for:

- Discord-like shared soundboard behavior

Recommended order:

1. local soundboard
2. shared/backend-backed soundboard if adoption is good

## Product Decisions Captured

- Local mute should mute the recording by default.
- Add an outbound-only mute setting for users who want to silence transmission without silencing local capture.
- Everyone in the call should always see a recording indicator.
- Default output should optimize for:
  - high quality
  - broad compatibility
  - smooth import into modern NLEs

## Open Decisions

- What exact browser fallback formats should be shown or hidden in the UI when MP4-style export is unavailable?
- Should V1 stay mixed-output only, or also save a separate mic-only track later?
- Should soundboard clips be audible only to the call, or optionally local-previewed first?
