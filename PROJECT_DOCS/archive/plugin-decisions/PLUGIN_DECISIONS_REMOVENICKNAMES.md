# Plugin Decisions - RemoveNicknames

## 2026-02-28
### Decision: Resolve message authors by stable IDs before display fallback
- Reason:
  - Canonical account identity is more reliable than display-label text matching.
- Consequence:
  - Header rendering and popout interactions remain stable even with alias-style labels.

### Decision: Keep RemoveNicknames as an explicit opt-in toggle
- Reason:
  - Some users prefer seeing original message labels; others need canonical names.
- Consequence:
  - Behavior can be switched at runtime without data migration.

### Decision: Scope initial implementation to message timeline surfaces
- Reason:
  - Timeline is highest-impact surface and lowest-risk insertion point.
- Consequence:
  - Other surfaces can be expanded later if needed without blocking current delivery.
