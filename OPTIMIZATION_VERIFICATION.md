> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# Optimization Verification — Wabi Stack Audit

## Part 1: The Big 8 — What We Have vs What's Listed

### 1. Compression & Format Optimization
| Feature | Status | Notes |
|---------|--------|-------|
| JPEG/PNG → WebP/AVIF on upload | **MISSING** | `upload.rs` writes raw bytes verbatim. `sharp@0.34.5` in root package.json may be legacy Node backend dep; Rust backend does no image processing. |
| Client-side compression before upload | **MISSING** | No pre-upload resize or re-encode in frontend. |
| Adaptive codec by connection | **MISSING** | Same file served regardless of network. |

### 2. Deduplication
| Feature | Status | Notes |
|---------|--------|-------|
| Hash-based content-addressable storage | **MISSING** | `upload.rs` generates UUID per upload, stores as `{uuid}.{ext}`. Same file 5× = 5 copies on disk. No SHA-256/Blake3 check at completion. |
| Cross-album dedup | **MISSING** | Album items reference `attachmentUrl` (UUID path). No reference-counting or hash linking. |

### 3. Progressive/Lazy Loading
| Feature | Status | Notes |
|---------|--------|-------|
| Image lazy loading | **DONE** | Every `<img>` has `loading="lazy" decoding="async"` (MessageList, MediaAlbumsTab, EmojiPicker, etc.) |
| Thumbnail-first, full on demand | **PARTIAL** | Album grid uses full-res images scaled by CSS. No separate 200px thumb vs full-size asset. |
| Video streaming / preload="metadata" | **DONE** | Album videos use `<video muted playsinline preload="metadata">`. |

### 4. Delta Sync / Incremental Updates
| Feature | Status | Notes |
|---------|--------|-------|
| Message feed delta sync | **PARTIAL** | STDB subscriptions send row-level changes, not full table dumps. But whiteboard sends full canvas ops / image blobs. |
| Whiteboard delta (stroke-level CRDT) | **MISSING** | No Yjs, Automerge, or rust-crdt. Every stroke/image import is a full broadcast or full state sync. |
| File sync (block-delta / rsync) | **MISSING** | Chunked resumable upload exists, but no block-delta for post-upload changes. |

### 5. Server-side Rendering/Preview Generation
| Feature | Status | Notes |
|---------|--------|-------|
| PDF/doc/code preview | **MISSING** | No server-side preview generation. |
| Video thumbnail / poster frame | **MISSING** | No ffmpeg keyframe extraction for uploaded videos. `ffmpeg-srt-bridge.mjs` exists in media-gateway but only for calling relay. |
| Image proxy + caching | **DONE** | `preview.rs` proxies external images with `Cache-Control: public, max-age=86400`. |

### 6. Adaptive Quality Based on Context
| Feature | Status | Notes |
|---------|--------|-------|
| Image quality by device/connection | **MISSING** | No `?w=200` or `?format=webp` URL params. No resize-on-demand. |
| Call bitrate scaling | **PARTIAL** | `stdbMediaRelay.ts` has simulcast/SVC layer concepts but no active bandwidth-based layer locking. Memory notes this needs explicit `setSubscribedVideoQuality` pattern. |
| Video auto-downgrade on slow connection | **MISSING** | Album videos serve original file only. |

### 7. Smart Caching & CDN
| Feature | Status | Notes |
|---------|--------|-------|
| Service worker caching | **DONE** | Custom `sw.js` (no Workbox). 3-tier: API (1hr, 50 entries), Media (7 days, 300 entries), Shell. Registered in `+layout.svelte`. |
| CDN edge cache | **NOT APPLICABLE** | Self-hosted model (LAN/Tailscale). Cloudflare tunnel in docker-compose for quick tunnels, not R2/Workers edge cache. No Bunny/Cloudfront. |
| HTTP cache headers on static files | **PARTIAL** | `preview.rs` sets `max-age=86400`. `whiteboard.rs` sets `private, max-age=300`. No global static-file middleware with far-future expiry. |

### 8. Batch & Sprite Optimization
| Feature | Status | Notes |
|---------|--------|-------|
| Emoji sprite sheets | **MISSING** | EmojiPicker fetches per-emoji URLs individually. No concatenation or CSS `background-position` mapping. |
| Sticker pack batching | **MISSING** | Same as above. |
| UI asset batching | **MISSING** | No spritemap for icons/avatars. |

---

## Part 2: Resource Contention — Gaming Impact Verification

### Question: Will parallel transfers fight people playing games by taking multiple cores?

**Answer: Yes, on mobile and low-core laptops. Desktop is generally fine.**

### Conflict Zones

| Zone | Impact | Mitigation |
|------|--------|------------|
| **Frontend main thread** | Chunking/hashing blocks UI/game input if on main thread | Use Web Workers (already standard practice) |
| **Frontend worker threads** | Still consume CPU cores; mobile 4-6 core devices feel it | Reduce parallelism, defer to idle time |
| **Backend (Rust/Tokio)** | Async I/O shouldn't block user's game, but server saturation raises latency | Server-side backpressure |
| **Network** | 4 parallel uploads = bandwidth contention, higher ping | Throttle parallelism, user bandwidth cap setting |

### Realistic Scenarios

| Scenario | Impact | Severity |
|----------|--------|----------|
| Desktop gamer uploading album during League of Legends | Web Workers in background, network async → imperceptible FPS drop | Low |
| Mobile user uploading call recording during Genshin Impact | Hashing + compression use CPU → 60fps → 45fps | Medium-High |
| Uploading 1GB file while streaming Twitch | Bandwidth split → upload slower, stream quality lower | Medium |
| Slow laptop (2 cores) uploading + gaming | Parallelism = 2 workers competing with game for cores | High |

### Built-In Solutions to Add

1. **Idle-Time Hashing (Recommended)**
   - Don't chunk/hash immediately; schedule for `requestIdleCallback` or after user inactivity.
   - Pause on user input (mouse/keyboard/gamepad), resume when idle.

2. **Dynamic Parallelism Reduction**
   - Detect high GPU load or low frame rate → drop from 4 parallel chunks to 1.
   - Heuristic: `navigator.hardwareConcurrency <= 4` → default to 2 workers max.

3. **Web Worker Priority Hints**
   - `new Worker('hasher.js', { priority: 'low' })` (Chrome 94+, where supported).
   - OS deprioritizes worker threads relative to main thread / game.

4. **User Control**
   - Settings → Data Transfer:
     - [ ] Use parallel uploads (4 chunks)
     - [ ] Optimize for gaming (1 chunk, low CPU)
     - [ ] Pause uploads while I'm active (resume on idle)
     - [ ] Max bandwidth: [slider] Mbps

5. **Server-Side Backpressure**
   - If user latency > threshold (e.g., 150ms), server sends `429 Too Many Requests` or `Retry-After`.
   - Frontend backs off automatically.

### Honest Assessment

- **Desktop (typical, 6-8 cores):** Not a real problem. 1-2 FPS dip during peak, unnoticeable.
- **Mobile (4-6 cores flagship, 2-4 budget):** Real problem. Needs idle-time deferral and reduced parallelism.
- **Slow laptops (2 cores):** Mitigatable. Default to "optimize for gaming" mode on low-end hardware.

### Action Items

- [ ] Implement idle-time chunking in frontend upload manager
- [ ] Add `navigator.hardwareConcurrency` check to set default worker count
- [ ] Add frame-rate/GPU-load heuristic to throttle parallelism dynamically
- [ ] Add user-facing "Optimize for gaming" toggle in Settings
- [ ] Add server-side latency monitoring + `429` backpressure on saturated clients

---

## Summary: Ranked by ROI (Reality-Adjusted)

| Rank | Feature | Effort | Already Done? | Real Blocker |
|------|---------|--------|---------------|--------------|
| 1 | Lazy loading images | 0d | **YES** | — |
| 2 | Service worker caching | 0d | **YES** | — |
| 3 | Resumable chunked uploads | 0d | **YES** | — |
| 4 | Hash-based dedup | 1-2d | NO | Add SHA-256 in `upload.rs` completion |
| 5 | Thumbnail generation on upload | 2-3d | NO | Add `image` crate or call `ffmpeg` from Rust |
| 6 | WebP/AVIF conversion on upload | 2-3d | NO | Same as #5 |
| 7 | Gaming-friendly upload throttling | 3-5d | NO | Frontend upload manager + settings UI |
| 8 | Adaptive image serving (`?w=200`) | 3-5d | NO | URL param parsing + resize-on-demand or pre-gen |
| 9 | Video poster/thumbnail extraction | 1-2w | NO | ffmpeg integration for uploaded videos |
| 10 | Whiteboard delta sync (CRDT) | 2-3w | NO | Yjs/Automerge port or rust-crdt + protocol rewrite |
| 11 | Emoji sprite sheets | 1w | NO | Build-time concat + CSS mapping |
| 12 | CDN edge cache | N/A | N/A | Architectural shift to object store + edge |
