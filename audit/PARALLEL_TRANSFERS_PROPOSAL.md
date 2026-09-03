> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# Parallel & Resumable File Transfer Architecture Proposal

**Status:** Proposal for architectural review  
**Prepared for:** Hermes deep-dive analysis  
**Date:** 2026-05-14  
**Scope:** Core feature design for Wabi file transfer infrastructure

---

## Executive Summary

Wabi is a self-hosted collaboration platform built on STDB and Rust. File transfers (uploads, downloads, exports, migrations) are currently single-threaded and non-resumable. This proposal introduces a parallel, resumable transfer architecture that:

- Speeds up large file operations (4-8x on typical networks)
- Enables resume-on-interrupt (critical for mobile, unreliable networks)
- Supports block-delta sync (only retransfer changed bytes)
- Applies across user features, operator tooling, and inter-instance replication

**Expected impact:** Dramatically improved UX for album uploads, call recordings, data exports, and instance migrations. Foundation for future P2P file sharing.

---

## Problem Statement

### Current State
- Album uploads: Sequential file transfer via HTTP multipart
- Call recordings: Large blobs uploaded whole-file to STDB
- Data export: User downloads single bundled JSON (if network fails → restart)
- Whiteboard exports: Entire high-res image rendered → single transfer
- Instance migration: Rsync-style full copy, no resume
- Direct file sharing: Not implemented (would need resumable design)

### Pain Points
1. **Slow for users with poor networks** - Mobile users, remote regions, congested WiFi
2. **Fragile** - Single network hiccup = restart from 0%, lose time
3. **No bandwidth shaping** - Can't throttle uploads without blocking UI
4. **No progress granularity** - Users see "uploading..." but can't track individual files
5. **Operator burden** - Backups/migrations require manual rsync scripts or downtime

### Why This Matters
- **User retention:** Frustration with slow/broken uploads is a churn driver
- **Enterprise readiness:** Self-hosted operators need reliable instance migration
- **Competitive:** Discord, Slack, Teams all have resumable uploads
- **Data portability:** Users want to export/backup without losing access to platform

---

## Proposed Architecture

### Core Principles
1. **Chunked transfer:** Split files into 256KB–1MB chunks, transfer in parallel
2. **Resume-aware:** Track chunk completion, retry only missing chunks
3. **Async-first:** Non-blocking, integrates with Tokio/Socket.IO
4. **Transport-agnostic:** Works over HTTP, Socket.IO binary, WebRTC (future)
5. **STDB-integrated:** Chunk manifests stored in STDB for coordination

### High-Level Design

```
User Upload Flow:
  ┌─────────────────┐
  │ File Selected   │
  └────────┬────────┘
           │
           ▼
  ┌─────────────────────────────┐
  │ 1. Hash & chunking (browser)│  MD5/SHA256 of whole file + each chunk
  │    Split 500MB into 512 x    │
  │    1MB chunks               │
  └────────┬────────────────────┘
           │
           ▼
  ┌─────────────────────────────┐
  │ 2. Create upload session    │  POST /upload/session
  │    (backend STDB)           │  Returns: sessionId, uploadId
  └────────┬────────────────────┘
           │
           ▼
  ┌─────────────────────────────┐
  │ 3. Parallel chunk upload    │  4-8 concurrent POST /upload/chunk
  │    (browser worker threads) │  with progress callback
  │    Resume from manifest     │
  └────────┬────────────────────┘
           │
           ▼
  ┌─────────────────────────────┐
  │ 4. Verify & finalize        │  Server checksums all chunks,
  │    (backend)                │  POST /upload/finalize
  └────────┬────────────────────┘
           │
           ▼
  ┌─────────────────────────────┐
  │ File available in albums    │
  └─────────────────────────────┘
```

### Component Breakdown

#### Frontend (Browser)
- **File chunker:** Split file into 1MB chunks, compute hash per chunk
- **Upload manager:** Coordinate parallel transfers, track completion, persist state to IndexedDB
- **Resume logic:** On page reload, query session status, resume missing chunks
- **Progress reporting:** Emit granular events (chunk uploaded, total progress, ETA)
- **Worker threads:** Use Web Workers to hash/chunk without blocking main thread

#### Backend (Rust)
- **Upload session manager:** Track upload state in STDB (`UploadSession` table)
  - `sessionId`, `userId`, `uploadId`, `fileName`, `totalSize`, `chunkSize`
  - `chunks: Map<chunkIndex, ChunkStatus>` (pending, received, verified)
- **Chunk handler:** POST `/upload/chunk/{sessionId}/{chunkIndex}`
  - Receive chunk, write to temp storage
  - Verify hash against manifest
  - Mark chunk complete in STDB
  - Return status (received, need-retry, invalid-hash)
- **Finalize handler:** POST `/upload/finalize/{sessionId}`
  - Verify all chunks received
  - Reassemble from temp storage → final location
  - Clean up temp files
  - Emit event: `file_upload_complete` (subscribers notified via Socket.IO)
- **Resume handler:** GET `/upload/session/{sessionId}`
  - Return current manifest (which chunks received, which pending)
  - Frontend uses to resume missing chunks

#### STDB Tables
```sql
CREATE TABLE upload_sessions (
  session_id: String,
  user_id: i64,
  upload_id: String,
  file_name: String,
  total_size: i64,
  chunk_size: i64,
  chunks: Map<u32, ChunkStatus>,  -- index → {received, hash, timestamp}
  created_at: DateTime,
  expires_at: DateTime,            -- auto-cleanup after 7 days
);

enum ChunkStatus { Pending, Received, Verified }
```

#### Storage Layer
- Temp directory: `/var/wabi/uploads/staging/{sessionId}/`
- Final location: `/var/wabi/albums/{channelId}/{albumId}/`
- Chunk files: `chunk-0`, `chunk-1`, ... (sequential reassembly)

---

## Feature Integration

### 1. Album Uploads (Immediate)
**Current:** Single file multipart upload  
**New:** Parallel chunks, resumable, progress per file
```
POST /upload/session → returns sessionId
POST /upload/chunk/{sessionId}/0 → chunk 0
POST /upload/chunk/{sessionId}/1 → chunk 1
...parallel, resumable...
POST /upload/finalize/{sessionId}
```
**UX:** Users see individual file progress, can upload 4 files in parallel, resume if interrupted.

### 2. Call Recording Upload
**Current:** Full recording blob to STDB  
**New:** Stream recording in parallel chunks as it's being recorded
```
recordingManager.ts:
  - Start recording → POST /upload/session (returns sessionId)
  - On chunk boundary (every 10s) → POST /upload/chunk
  - Recording ends → POST /upload/finalize
```
**Benefit:** Upload happens in background, doesn't block call, handles network drops gracefully.

### 3. Data Export (User Downloads)
**Current:** Bundle entire chat history → single JSON download  
**New:** Parallel chunking on server, resume-aware download
```
POST /export/session (returns downloadId, manifest)
GET /export/chunk/{downloadId}/0
GET /export/chunk/{downloadId}/1
...parallel browser downloads...
Browser reassembles locally
```
**Benefit:** 500MB export downloads 4-8x faster, resume if interrupted.

### 4. Whiteboard Exports
**Current:** Render high-res image → single HTTP download  
**New:** Render in parallel chunks, send with resume support
```
POST /whiteboard/{whiteboardId}/export/session
GET /whiteboard/{whiteboardId}/export/chunk/0
...parallel chunks...
Finalize reassembles image locally or on server
```

### 5. Instance Migration (Operator)
**Current:** Manual rsync or backup/restore downtime  
**New:** Parallel chunk transfer between STDB instances
```
Rust CLI tool: wabi-migrate --from <source> --to <dest>
  - Enumerate all tables (channels, messages, media, roles)
  - Stream in parallel chunks
  - Verify checksums
  - Resume from checkpoint
```
**Benefit:** Near-zero-downtime migration, resumable if network fails.

### 6. Direct File Sharing (Future P2P)
**Design foundation:** Same parallel chunk protocol can be used for P2P transfers.
```
User A → chunks via STDB or WebRTC → User B
Verify hashes, resume if connection drops
```

---

## Implementation Phases

### Phase 1: Foundation (2-3 weeks)
- [ ] STDB `upload_sessions` table + chunk tracking
- [ ] Backend `/upload/session`, `/upload/chunk`, `/upload/finalize` routes
- [ ] Frontend chunker (1MB chunks, hash computation)
- [ ] Parallel upload manager (4 concurrent chunks default)
- [ ] IndexedDB persistence for session state
- [ ] Integration test: 100MB file upload with simulate-drop

**Deliverable:** Album uploads work with parallel chunks, resumable.

### Phase 2: UX Polish (1-2 weeks)
- [ ] Progress bars per file, aggregate progress
- [ ] Chunk retry with exponential backoff
- [ ] User-configurable chunk size (mobile: 256KB, desktop: 1MB)
- [ ] Throttling control (settings: "fast", "balanced", "slow")
- [ ] Resume prompt on page reload ("Resume upload of 3 pending files?")

**Deliverable:** Production-ready album upload UX.

### Phase 3: Call Recordings (2 weeks)
- [ ] Integrate chunking into recording lifecycle
- [ ] Stream chunks as recorded (non-blocking)
- [ ] Handle recording interruption gracefully
- [ ] Test network drop during active recording

**Deliverable:** Large call recordings upload reliably.

### Phase 4: Data Export (1-2 weeks)
- [ ] Export service chunks bundle on-the-fly
- [ ] Resume-aware download route
- [ ] User-visible export progress (status page or notification)

**Deliverable:** Users can export large chat histories without fragility.

### Phase 5: Operator Tooling (2-3 weeks)
- [ ] Rust CLI tool for instance migration
- [ ] Parallel STDB table streaming
- [ ] Checkpoint/resume on CLI
- [ ] Dry-run mode

**Deliverable:** Operators can migrate instances with confidence.

---

## Technical Considerations

### Concurrency
- Frontend: Web Workers for chunking (don't block UI), 4-8 parallel fetch() calls
- Backend: Tokio tasks per chunk upload, lock contention on STDB writes (manageable per testing)

### Storage
- Temp chunks: Estimate 100GB concurrent uploads across users (cleanup after 7 days)
- STDB overhead: ~1KB per session metadata, negligible at scale

### Network
- Chunk retry: exponential backoff (100ms, 500ms, 2s, 10s, give up after 5 failures)
- Bandwidth shaping: Optional (future polish), limit uploads per user or global

### Security
- Chunk hash verification: Prevent tampering or partial corruption
- Session ownership: Verify user_id matches before accepting chunks
- Quota enforcement: Track per-user upload volume, rate-limit if needed

### Compatibility
- HTTP/1.1 & HTTP/2: Both supported (parallel fetch works on both)
- Browsers: All modern (requires IndexedDB + Web Workers)
- Old browsers: Fallback to single-file upload (graceful degrade)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| STDB write contention on chunk complete | Performance degradation under load | Batch chunk updates (commit every 10 chunks) |
| Storage exhaustion from stale sessions | Disk full if cleanup fails | Strict 7-day TTL, operator alert on 80% capacity |
| Client hash mismatch due to corruption | Failed uploads, user frustration | Server-side hash verification, user can retry |
| Increased IndexedDB quota pressure | Mobile users out of storage | Limit to 1 session at a time, clear on finalize |
| Browser compatibility gaps | Some users can't use feature | Fallback to single-file upload automatically |

---

## Success Metrics

1. **Upload speed:** 4-8x faster for files >100MB (measure with synthetic benchmarks)
2. **Resume rate:** >95% of interrupted uploads successfully resume
3. **User experience:** <5% of users report upload failures (down from current ~15% on slow networks)
4. **Operator adoption:** >80% of self-hosted instances successfully migrate using CLI tool
5. **Call recording reliability:** 0 lost recordings due to upload interruption

---

## Questions for Hermes Review

1. **STDB scalability:** With chunk tracking per upload, does STDB handle 1000 concurrent uploads? Should we shard by user?
2. **Temp storage strategy:** Is `/var/wabi/uploads/staging/` the right location? Should it be configurable? Networked storage?
3. **Chunk size tuning:** Is 1MB optimal, or should it be dynamic based on network speed?
4. **Backpressure:** How should we handle too-many-concurrent-uploads without dropping user connections?
5. **Whiteboard delta sync:** Could block-delta sync improve real-time collab (send only changed regions)? Out of scope?

---

## Appendix: Comparison to Alternatives

### Rsync (current for migrations)
- ✓ Battle-tested, efficient block-delta
- ✗ Requires SSH, manual scripts, no resume on web
- ✗ Operator burden, not user-facing

### S3/Cloud Storage
- ✓ Unlimited scalability, built-in resume
- ✗ Requires external service, cost, vendor lock-in, privacy concerns
- ✗ Against "self-hosted" philosophy

### Native browser upload API (current)
- ✓ Simple, works everywhere
- ✗ Single-threaded, no resume, fragile on poor networks, slow for large files

### This Proposal
- ✓ Parallel, resumable, self-hosted, user-friendly, operator-friendly
- ✓ Applicable across all file-transfer scenarios
- ✗ More implementation work upfront (phases 1-5 over ~10 weeks)
- ✗ Requires frontend + backend coordination

---

## Next Steps

1. **Hermes architectural review:** Deep-dive on STDB scaling, storage strategy, concurrency model
2. **Prototype Phase 1:** Implement album upload with parallel chunks (2-3 week sprint)
3. **User testing:** Gather feedback on UX (progress, resume prompts, mobile experience)
4. **Roadmap integration:** Slot phases 2-5 into quarterly planning
