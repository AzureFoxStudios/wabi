# Compression Implementation Plan (Wabi)

## Goal
Reduce storage and transfer costs without breaking chat/file flows or increasing p95 latency.

## Non-Goals
- Do not invent a custom compression algorithm in phase 1.
- Do not change message semantics or E2EE behavior.

## Success Metrics
- Storage: >=30% reduction for compressible payload classes.
- Transfer: >=25% reduction on compressible downloads.
- Latency: p95 upload/download API latency increase <=10%.
- CPU: no sustained >20% server CPU regression at target concurrency.
- Reliability: zero data-loss events in soak test.

## Scope Split
1. HTTP text compression (fast win)
2. Attachment-at-rest compression for compressible file classes
3. Codec metadata/versioning and safe fallback
4. Benchmark harness and rollout controls

## Data Classes and Policy
1. Never recompress: jpg/jpeg/png/webp/gif/mp4/webm/zip/pdf
2. Candidate compress: txt/json/csv/log/md/svg
3. Unknown mime type: sniff + size threshold, default conservative

## Codec Strategy
1. Primary codec: zstd (balanced level)
2. Optional fast path: lz4 (if very low-latency profile is needed)
3. Keep codec+version metadata with each stored object

## Architecture Changes
1. Add `backend/src/lib/compression.ts`
- `compressBuffer(input, policy) -> { codec, level, originalSize, compressedSize, payload }`
- `decompressBuffer(payload, codec, metadata) -> Buffer`
- `shouldCompress(mime, ext, size)`

2. Extend upload metadata
- Add fields: `storage_encoding`, `storage_encoding_version`, `stored_size_bytes`, `original_size_bytes`
- Preserve current `attachmentEncryption` metadata unchanged.

3. Upload path integration
- Current flow writes raw/at-rest-encrypted bytes.
- New flow:
  - classify payload
  - optional compress
  - optional at-rest encrypt wrapper
  - write final bytes

4. Download path integration (`/uploads/*`)
- Read file
- If at-rest encrypted, decrypt first (existing)
- If compressed-at-rest, decompress before response
- Stream where possible; buffer only when required by codec/decrypt path

5. HTTP text compression
- Enable gzip/br for static/API text responses using middleware (or reverse proxy layer)
- Skip binary/media content types.

## Rollout and Safety
1. Feature flags
- `UPLOAD_COMPRESSION_ENABLED`
- `UPLOAD_COMPRESSION_MIN_BYTES`
- `UPLOAD_COMPRESSION_LEVEL`
- `UPLOAD_COMPRESSION_MIME_ALLOWLIST`

2. Backward compatibility
- Old uploads remain readable (no encoding metadata => raw)
- New uploads include encoding metadata

3. Observability
- Log compression ratio per class
- Track compress/decompress ms and payload size deltas
- Export counters for failures/fallbacks

## Benchmark Plan
1. Corpus
- Real sampled attachments by mime class
- Synthetic text corpus for worst/best cases

2. Tests
- Single upload/download latency
- Parallel uploads (N=4,8,16)
- Mixed chat+file traffic soak

3. Report
- ratio, p50/p95 latency, CPU, RAM, error rates
- compare baseline vs feature-flag on

## Implementation Phases
1. Phase A: Instrumentation + benchmark harness (no behavior change)
2. Phase B: HTTP text compression
3. Phase C: At-rest compression for safe mime allowlist
4. Phase D: Metadata migration + compatibility checks
5. Phase E: Controlled rollout (10% -> 50% -> 100%)

## Open Decisions
1. Exact zstd library for Bun/Node runtime compatibility
2. Streamed vs buffered decode path for large objects
3. Whether to keep optional lz4 path in phase 1 or defer
