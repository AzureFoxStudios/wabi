# Plugin Spec - VideoCompressor

## Metadata
- Plugin Name: VideoCompressor
- Source Link(s):
  - `https://betterdiscord.app/plugin/VideoCompressor`
  - `C:\Users\Willp\Documents\GitHub\BetterDiscordPlugins-main\plugins\VideoCompressor`
- Wabi Target Version: `0.4.x+`
- Status: `In Progress (Phase 2)`

## Plugin Grade
- User Impact (1-5): `5`
- Usage Frequency (1-5): `4`
- Differentiation (1-5): `4`
- Implementation Effort (1-5, higher is harder): `4`
- Runtime Risk (1-5, higher is riskier): `4`
- Weighted Score (0-100): `79`
- Letter Grade (`A/B/C/D/F`): `B`
- Decision: `Build Next`

## Problem Statement
Users hit upload limits for videos and fail to send media that should be shareable.
They need a built-in flow to downscale/re-encode before upload, with clear size estimates and safe defaults.

## Current Wabi Baseline (Important)
Wabi now has a desktop-gated "compress before send" flow in chat composer intake.
Compression runs client-side in the renderer media pipeline, then reuses normal attachment upload handling.

## Functional Requirements
1. Detect over-limit video files in composer file selection and paste/drag paths.
2. Show "Compress before send" modal with:
   - resolution presets
   - frame-rate presets
   - estimated output size
   - cancel/keep-original options
3. Encode a compressed output, then queue the compressed file into normal upload flow.
4. Preserve filename intent (for example `myclip-compressed.mp4`) and MIME metadata.
5. If compression fails, return user to normal attachment state with explicit error.

## Non-Functional Requirements
- Performance:
  - hard timeout per compression attempt
  - cap input file size eligible for client-side compression
  - avoid blocking chat UI during encoding
- Security/abuse limits:
  - reject unsupported codecs/containers cleanly
  - do not run arbitrary binary decoders outside approved codec path
- UX:
  - clear progress indicator and abort action
  - never auto-send after compression; keep normal send confirmation path
- Platform scope:
  - Phase 1: Desktop (Tauri) first
  - Phase 2: Web capability-gated rollout
  - Phase 3: Android tuning

## Wabi Integration Points
- Frontend:
  - `frontend/src/lib/components/Chat.svelte`:
    - pre-queue file checks (`handleFileSelect`, drag/drop, paste paths)
    - upload queue kickoff (`uploadSelectedFiles`, `uploadFileResumable`)
    - attachment preview UI states (`filePreviews`)
- Backend:
  - `backend/src/server.ts`:
    - upload limit enforcement (`enforceUploadLimit`)
    - resumable endpoints (`/api/upload/resumable/init`, chunk, complete)
    - optional post-receive compression hook (`maybeCompressUploadPayload`) for fallback/verification

## Phase Plan
### Phase 0 - Discovery
- [x] Finalize initial codec strategy:
  - Desktop rollout path: client-side MediaRecorder canvas pipeline, runtime-gated in Tauri.
  - Web path deferred by runtime gate (feature currently desktop-scoped).
- [x] Define hard limits:
  - compression prompt threshold: `45 MB`
  - max upload file size remains `1 GB` per file
  - encode timeout budget: `3 minutes`
- [ ] Define telemetry:
  - attempts, success/failure rate, median encode time, median size reduction

### Phase 1 - MVP (Desktop First)
- [x] Over-limit video detection in composer flow.
- [x] Compression modal with presets (currently `balanced_720p` and `quality_1080p`).
- [x] Client-side compression path and progress UI.
- [x] Pipe compressed File into existing attachment/upload flow.
- [x] User setting toggle in `Settings` to enable/disable compression behavior.

### Phase 2 - Harden
- [x] Add cancellation and retry path.
- [x] Add fallback if local compression unavailable or too slow.
- [ ] Add backend verification metadata (original size, compressed size, codec).
- [ ] Improve estimate accuracy using sampled input metadata.

### Phase 3 - Polish
- [x] Per-user default preset setting.
- [ ] Optional auto-suggest ("compress recommended") for over-limit files.
- [ ] Android-specific preset tuning and thermal safeguards.

## Test Plan
- Unit:
  - preset-to-encoder option mapping
  - size estimate calculations
  - unsupported codec/container handling
- Integration:
  - over-limit file triggers modal
  - cancel keeps original file path intact
  - successful compress queues and uploads via resumable flow
- Manual:
  - desktop packaged build encode test (short/long clips)
  - low disk space + cancel + retry scenarios
  - regression test for non-video attachments

## Rollback Plan
- Keep all compression entrypoints behind feature flag.
- Rollback path disables modal and restores baseline upload behavior without schema changes.

## Open Questions
1. Should desktop compression run in Rust/Tauri sidecar for speed, or stay JS/WASM for shared code?
2. Do we enforce a single output codec (`H.264 + AAC`) initially for reliability?
3. Should server-side fallback compression be opt-in per deployment due CPU cost?

## Current Implementation Snapshot (2026-02-25)
- Frontend files:
  - `frontend/src/lib/components/Chat.svelte`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/video/videoCompressor.ts`
  - `frontend/src/lib/video/videoCompressionSettings.ts`
- Active behavior:
  - prompts on large videos before queueing upload
  - progress + cancel + retry controls
  - keep-original and remove-file fallback actions
  - desktop runtime gate (`isTauriRuntime`)
- Known gaps:
  - telemetry + backend verification metadata
  - Android tuning phase
