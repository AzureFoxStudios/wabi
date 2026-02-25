# Plugin Porting Master Plan

## Goal
Port high-value plugin functionality into Wabi in controlled phases, with clear scope, risk controls, and auditable implementation notes.

## Execution Rules
1. Functionality-first, but no blind copy/paste.
2. Build Wabi-native implementations (Svelte + existing backend services) in small, shippable slices.
3. Every phase must ship with:
   - scope checklist
   - test checklist
   - rollback notes
   - version bump note
4. Keep one source of truth for status in this file.

## Plugin Grading System
Grade each candidate before implementation so effort stays focused on high-value wins.

### Core vs Addon Routing Rule (User Approved)
- `Core`: any plugin/feature marked `A+`, `B+`, `C+` (or otherwise explicitly marked with `+`).
- `Addon`: everything else unless explicitly promoted.
- This rule takes precedence over raw letter score when deciding packaging surface.

### Inputs (1-5)
- User Impact: how much day-to-day value users get.
- Usage Frequency: how often the feature is expected to be used.
- Differentiation: how much this helps Wabi stand out.
- Implementation Effort: engineering complexity (higher = harder).
- Runtime Risk: performance/security/stability risk (higher = riskier).

### Weighted Score
`Score = (Impact*0.35 + Frequency*0.25 + Differentiation*0.20 + (6-Effort)*0.10 + (6-Risk)*0.10) * 20`

### Letter Grade
- `A` = 85-100 (ship early)
- `B` = 70-84 (strong candidate)
- `C` = 55-69 (nice-to-have)
- `D` = 40-54 (low priority)
- `F` = 0-39 (skip unless strategic reason)

## Phase Model
1. `Phase 0 - Discovery`
   - Capture behavior, UX, and integration points.
   - Define security/perf constraints and data limits.
2. `Phase 1 - MVP`
   - Core feature, minimal UI, safe defaults.
3. `Phase 2 - Harden`
   - Edge cases, abuse protection, telemetry, better UX.
4. `Phase 3 - Polish`
   - Quality-of-life options, accessibility, docs cleanup.

## Plugin Queue
| Plugin | Priority | Grade | Score | Track | Status | Current Phase | Owner Notes |
|---|---|---|---|---|---|---|---|
| ZipPreview | P0 | A+ | 88 | Core | In Progress | Phase 2 | MVP + hardening landed (cache TTL/LRU, filename filter, stricter malformed checks); smoke/build validation pending |
| VideoCompressor | P0 | B+ | 79 | Core | Planned | Phase 0 | Second target (desktop-first) |
| ImageFolder | P0 | B+ | 81 | Core | Approved | Phase 0 | Include shared persistent albums |
| MoreQuickReacts | P1 | C+ | 67 | Core | Backlog | - | Lower strategic value but core per `+` rule |
| GifCaptioner | P2 | C | 57 | Addon | Backlog | - | Heavier media processing |
| UnicodeEmojis | P3 | D | 48 | Addon | Backlog | - | Skip unless requested |

## Approved Product Feature: Shared Media Albums
- Status: `Approved`
- Track: `Core`
- Rationale: align media browsing with Line/Discord-style album flows while keeping one consistent Wabi UX across desktop/mobile.
- Spec: `PROJECT_DOCS/FEATURE_SPEC_MEDIA_ALBUMS.md`

## ZipPreview Initial Breakdown
### Phase 0 - Discovery
- Enumerate how Wabi currently renders attachments.
- Define where ZIP metadata parsing lives (frontend-only vs backend assist).
- Set hard limits: archive size, entry count, preview bytes, timeout.

### Phase 1 - MVP
- Detect `.zip` attachments.
- Parse ZIP central directory without full extraction.
- Show file tree, entry count, total uncompressed size.
- Expand/collapse panel in message attachment UI.

### Phase 2 - Harden
- Add limits + graceful failure messaging.
- Cache parsed metadata.
- Add simple filename search/filter.

### Phase 3 - Polish
- Optional inline preview for safe text/image files.
- Better sorting and icons.
- Settings toggles.

### ZipPreview Progress Update (2026-02-25)
- Implemented in `frontend`:
  - ZIP detection in message attachments.
  - Reusable `ZipPreviewPanel` with expand/collapse.
  - In-browser central-directory parsing (`parseZipPreviewMetadata`).
  - Guardrails: archive-size cap, entry render cap, fetch timeout, encrypted-file fallback.
  - In-memory metadata cache keyed by URL+size with TTL + simple LRU eviction.
  - Entry-name filter/search in preview panel.
  - Parser hardening for split/multi-disk ZIP rejection and central-directory consistency checks.
- Pending for Phase 1 completion:
  - Manual smoke pass on real ZIP fixtures (valid, malformed, oversized).
  - Desktop packaged-app validation pass once current unrelated frontend check errors are cleared.

## VideoCompressor Initial Breakdown
### Phase 0 - Discovery
- Confirm desktop encoder strategy and output codec matrix.
- Lock max input size, timeout, and CPU safeguards.
- Confirm integration points in composer + resumable upload pipeline.

### Phase 1 - MVP (Desktop First)
- Trigger compression prompt for over-limit video attachments.
- Preset-based encode (resolution + frame rate).
- Queue compressed output into existing upload flow.

### Phase 2 - Harden
- Accurate size estimate improvements.
- Cancellation + retry + fallback behavior.
- Telemetry and failure classification.

### Phase 3 - Polish
- Optional default preset setting.
- Android capability tuning.
- Better UX copy and docs.

## Required Artifacts Per Plugin
- Spec: `PROJECT_DOCS/PLUGIN_SPEC_<NAME>.md`
- Decisions: `PROJECT_DOCS/PLUGIN_DECISIONS_<NAME>.md`
- Changelog note in final implementation PR/commit message.

## Working Checklist (Use Every Phase)
- [ ] Scope locked
- [ ] Integration points listed
- [ ] Security/perf limits documented
- [ ] Implementation merged
- [ ] Manual test pass complete
- [ ] Build produced (desktop where applicable)
- [ ] Docs/status updated
