# Plugin Decisions - BetterSearchPage

## 2026-02-28
### Decision: Implement as sticky result-toolbar behavior, not a separate search page
- Reason:
  - Wabi search is embedded in chat; a dedicated page would add unnecessary navigation and state duplication.
- Consequence:
  - Search UX remains in-channel with improved control persistence.

### Decision: Keep existing header input and gate sticky controls behind an Add-ons toggle
- Reason:
  - Preserves current user expectations and avoids forced UI churn.
  - Supports incremental rollout with simple disable path.
- Consequence:
  - Users can switch between baseline and sticky-control behavior without losing search functionality.

### Decision: Reuse existing full-history scan logic
- Reason:
  - Existing backfill path already has guardrails and status signaling.
- Consequence:
  - BetterSearchPage adds UI placement improvements without introducing new search-engine logic.
