# Plugin Decisions - MoreQuickReacts

## 2026-02-26
### Decision: MVP lives entirely in MessageList action bar
- Reason:
  - Reuses existing reaction APIs/state with minimal risk.
  - No backend/schema changes required for first delivery.
- Consequence:
  - Fast delivery, but no user customization yet.

### Decision: Candidate selection is heuristic (existing + curated + fallback)
- Reason:
  - Works immediately across servers with different emoji packs.
  - Avoids dependency on usage-history persistence in Phase 1.
- Consequence:
  - Some users may want custom quick sets; captured for Phase 3.

### Decision: Hide quick strip in mobile action layout for now
- Reason:
  - Preserve tap-target size and avoid crowding on narrow viewports.
- Consequence:
  - Mobile still uses existing reaction picker path until mobile-specific UX pass.

### Decision: Persist quick-reaction preferences locally per user/session
- Reason:
  - Avoid backend schema/API expansion for a UX-only preference surface.
  - Keeps rollout low-risk while still enabling user customization.
- Consequence:
  - Preferences are local-device scoped unless future account sync is added.

### Decision: Add bounded emoji-scan guardrail for quick-candidate resolution
- Reason:
  - Large emoji packs can make repeated candidate scans unnecessarily expensive.
  - Quick strip only needs a small visible set, so full-catalog scans are wasteful.
- Consequence:
  - Alias and fallback resolution scan a capped pool while still honoring top-reaction and user-custom IDs from full catalog.

### Decision: Use local telemetry counters for adoption signal
- Reason:
  - Requirement is lightweight quick-strip-vs-picker adoption visibility.
  - Local counters avoid new backend telemetry endpoints and auth/rate-limit work.
- Consequence:
  - Metrics are best-effort and device-scoped, but immediately useful for UX tuning.

### Decision: Surface quick strip in mobile long-press action tray with bounded width
- Reason:
  - Mobile users still need one-tap quick reactions once the action tray is intentionally opened.
  - Keeping the strip bounded/horizontally scrollable avoids overcrowding narrow screens.
- Consequence:
  - Mobile retains cleaner default layout while exposing faster reaction flow on demand.
