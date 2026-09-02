# Wabi Native Media Pipeline — Futuresight Proposal

**Status:** Not for implementation now. Current media stack works (browser APIs). This is a roadmap for when native Rust audio/video becomes a priority.

**Core principle:** Additive only. Rust media pipeline feeds into existing Svelte UI via Tauri commands. No UI rewrite.

---

## Why This Exists

Current Wabi media pipeline lives entirely in browser APIs:
- Audio: Web Audio API + browser Opus encoder
- Video: MediaRecorder (VP9/VP8/H264 presets in `videoCompressor.ts`)
- Thumbnails: Canvas `drawImage`
- Upload: JS FormData + fetch

This works but has hard ceilings:
- Browser audio latency is non-deterministic
- MediaRecorder quality control is coarse
- No hardware acceleration exposed
- Spatial audio is fake (panner node, not HRTF)
- Video compression happens on main thread
- No native codec choice (browser picks, not Wabi)

A Rust media pipeline in Tauri gives:
- Sub-10ms audio capture via cpal
- True Opus encoding via opus-rs (bitrate control, FEC, DTX)
- Spatial audio via hrtf or ambisonics
- Hardware-accelerated video via VAAPI/VideoToolbox/MediaCodec
- AV1 encode via rav1e or svt-av1
- Background threading (no main thread blocking)
- Direct device access (not browser sandboxed)

---

## Architecture

```
Svelte UI (unchanged)
  ↓ invoke / listen
Tauri Rust bridge
  ├─ Audio Command: cpal → opus → spatial → packet
  ├─ Video Command: ffmpeg-next / rav1e / svt-av1 → encode
  ├─ Thumbnail Command: image-rs / libavif
  ├─ Upload Command: Rust HTTP client with resume
  └─ Platform native API access
```

UI stays Svelte. The media heavy lifting moves to Rust. The boundary is Tauri's command system.

---

## Crate Stack

### Audio

| Crate | Purpose | Status |
|---|---|---|
| `cpal` | Cross-platform audio capture/playback | Mature, used by many projects |
| `opus-rs` | Opus encoder/decoder bindings | Mature, wraps libopus |
| `rubato` | Sample rate conversion | Mature |
| `dasp` | Digital audio signal processing | Mature |
| `spatial-audio` or custom HRTF | Spatial audio engine | Needs research |

### Video

| Crate | Purpose | Status |
|---|---|---|
| `ffmpeg-next` | FFmpeg bindings (encode/decode/transcode) | Mature, complex dep |
| `rav1e` | Pure Rust AV1 encoder | Mature but CPU-only |
| `svt-av1` bindings | Hardware-friendly AV1 encoder | Needs FFI wrapper |
| `v4l` / `av-foundation` / `mediafoundation` | Platform capture APIs | Platform-specific |
| `image` | Thumbnails, image ops | Mature |
| `avif-decode` / `ravif` | AVIF encode/decode | Mature |

### Network/Upload

| Crate | Purpose | Status |
|---|---|---|
| `reqwest` | HTTP client (already in server) | Mature |
| `tokio::fs` | Async file I/O | Mature |
| `sha2` | Hash for verification (already in server) | Mature |

---

## Implementation Path

### Phase 1: Audio Pipeline Proof of Concept

Goal: Desktop Tauri can capture microphone via cpal, encode Opus, and send packets to existing calling system.

Steps:
1. Add `cpal`, `opus-rs`, `rubato` to `src-tauri/Cargo.toml`
2. Implement `AudioCaptureCommand` — cpal stream → opus encode → packet queue
3. Bridge to existing WebRTC calling (feed encoded packets into existing pipeline)
4. A/B test latency vs browser Web Audio API

Verification:
- Record audio in Tauri desktop
- Play back with lower latency than browser path
- Measure round-trip latency with local loopback

### Phase 2: Video Compression Command

Goal: Replace browser MediaRecorder for desktop uploads.

Steps:
1. Add `ffmpeg-next` or `rav1e` to Tauri build
2. Implement `CompressVideoCommand` — file path in, compressed file path out
3. Support presets matching current JS compressor (mobile_540p, balanced_720p, quality_1080p)
4. Add hardware acceleration detection (VAAPI on Linux, VideoToolbox on macOS, MediaCodec on Android)
5. Svelte calls `invoke('compress_video', {input, preset})` and shows progress

Verification:
- Compress same test video with Rust path and JS path
- Compare quality, file size, and encode time
- Verify hardware acceleration where available

### Phase 3: Thumbnail Generation

Goal: Server-side or desktop-side thumbnail generation without browser canvas.

Steps:
1. Use `image` crate for downscale/crop
2. Use `ravif` for AVIF thumbnails
3. Implement `GenerateThumbnailCommand`
4. Fallback to browser canvas for web users

Verification:
- Generate thumbnails for test image set
- Compare quality and speed vs browser canvas

### Phase 4: Upload Resume

Goal: Rust-side chunked upload with resume and integrity.

Steps:
1. Implement `UploadChunkCommand` — reads file, hashes chunk, uploads via reqwest
2. Maintain upload state in Rust (not JS memory)
3. Resume from last confirmed chunk on reconnect
4. Report progress back to Svelte via Tauri events

Verification:
- Upload 100MB file, interrupt mid-upload
- Resume and verify hash of completed file

### Phase 5: Spatial Audio

Goal: True HRTF spatial audio for voice calls.

Steps:
1. Research HRTF dataset or ambisonics approach
2. Implement spatial mixer in Rust (position → HRTF filter → binaural output)
3. Feed speaker positions from calling system
4. Output via cpal

Verification:
- Two users in voice call, pan them left/right
- Listener perceives clear positional audio
- Compare to browser's fake PannerNode spatialization

---

## What Not to Do

- Do not rewrite the UI in Rust/WASM
- Do not eliminate Svelte
- Do not eliminate the web/PWA fallback
- Do not add crates to the server binary unnecessarily
- Do not build a custom codec from scratch (use mature bindings)

---

## Current Dependencies to Add (when ready)

```toml
[dependencies]
# Audio
cpal = "0.15"
opus = "0.3"  # opus-rs bindings
rubato = "0.14"
dasp = "0.11"

# Video
# ffmpeg-next = "7"  # heavy dep, evaluate need
# rav1e = "0.7"      # pure Rust AV1, CPU only
# image = "0.25"     # already transitive dep, pin explicitly
# ravif = "0.11"     # AVIF encode

# Already in server, share with Tauri:
# reqwest = "0.12"
# tokio = "1"
# sha2 = "0.10"
```

---

## Trigger for Implementation

Start when:
1. Calling system works reliably end-to-end (not yet verified)
2. Fracture work is complete and stable
3. A concrete user asks for lower audio latency or hardware video encoding
4. Or when the builder wants to experiment

Do not start because npm is scary. Start because the media quality ceiling matters.

---

*Companion to futuresight-multi-anchor-helper-nodes.md and futuresight-scaling-middleware.md.*
