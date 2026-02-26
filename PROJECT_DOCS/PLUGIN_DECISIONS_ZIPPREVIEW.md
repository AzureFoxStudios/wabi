# Plugin Decisions - ZipPreview

## Scope
Decision log for the Wabi-native ZipPreview port.

## Decisions

### 1) Parser Location
- Decision: Frontend-only parser for Phase 1.
- Why: No backend dependency needed for basic metadata; faster delivery for P0 UX.
- Consequence: Client fetches archive bytes directly for preview.

### 2) Parser Strategy
- Decision: Native central-directory parser (`DataView`) instead of adding ZIP libraries.
- Why: Keeps dependency footprint small and behavior auditable.
- Consequence: Limited to metadata preview (no extraction).

### 3) Guardrails
- Decision:
  - max preview archive bytes: `25 MB`
  - max rendered entries: `200`
  - fetch timeout: `4 seconds`
- Why: Avoid UI stalls and abuse paths from oversized archives.
- Consequence: Some valid archives are intentionally rejected in preview mode.

### 4) Unsupported Cases (Phase 1)
- Decision:
  - encrypted attachments are not previewed
  - ZIP64 metadata parsing is not supported
- Why: Keep MVP safe/simple; avoid high-risk parser complexity up front.
- Consequence: Explicit user-facing fallback errors for these cases.

### 5) Caching
- Decision: In-memory cache keyed by `url + size` in `ZipPreviewPanel` with TTL + LRU-style eviction.
- Why: Prevent repeated downloads/parsing while keeping memory bounded in long sessions.
- Consequence: Cache remains session-only and non-persistent, but old entries age out automatically.

### 6) Entry Filtering
- Decision: Add client-side filename filter directly in the preview panel.
- Why: Large archives need quick in-panel search without adding backend complexity.
- Consequence: Filtering is scoped to rendered entries (bounded by entry cap).

### 7) Parser Hardening Scope
- Decision: Reject split/multi-disk archives and validate central-directory boundaries strictly.
- Why: These formats are higher-risk for malformed edge cases and are uncommon in chat workflows.
- Consequence: Some uncommon but valid ZIP variants are intentionally unsupported with clear errors.

### 8) Fixture Smoke Coverage
- Decision: Add a lightweight fixture-based smoke script (`frontend/scripts/zip-preview-fixture-smoke.ts`) and wire `bun run check:zip-preview`.
- Why: We need repeatable parser regression checks without pulling in a full test harness first.
- Consequence: Fast local validation exists for malformed/split/ZIP64-boundary cases; full packaged-app manual pass remains separate.

## Follow-ups
- Consider worker-thread parsing for larger archives in Phase 2.
- Consider backend-assisted parsing for very large/remote archives in Phase 2+.
- Add fixture-based parser tests (valid/malformed/ZIP64/oversized).
