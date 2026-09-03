# Plugin Decisions - LocalNicknames (Wabi Extension)

## 2026-02-28
### Decision: Store local nicknames client-side only
- Reason:
  - Nicknames are private preference data and should not be shared by default.
- Consequence:
  - Nicknames do not sync across devices unless future sync is explicitly designed.

### Decision: Key nicknames by stable identity (`user-<dbId>` fallback runtime id)
- Reason:
  - Prevents display-name/alias drift and keeps mapping stable across sessions.
- Consequence:
  - Nickname entries survive normal username/display-name changes.

### Decision: Add set/clear actions in existing people surfaces
- Reason:
  - Avoids introducing new modal frameworks for MVP while keeping flow discoverable.
- Consequence:
  - Fast iterative UX with clear rollback path.
