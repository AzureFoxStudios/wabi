# Plugin Decisions - HideMutedCategories

## 2026-02-28
### Decision: Translate categories concept into local muted-channel filtering
- Reason:
  - Wabi does not currently use Discord server-category architecture.
- Consequence:
  - Feature is implemented as muted-channel hiding in sidebar lists.

### Decision: Keep mute state local-only
- Reason:
  - Fast delivery with no backend schema updates.
  - Avoids policy and synchronization overhead for MVP.
- Consequence:
  - Muted-channel preferences are per-device.

### Decision: Keep active channel visible even when muted
- Reason:
  - Prevents navigation dead ends and accidental loss of context.
- Consequence:
  - Active channel row is exempt from hide filtering.

### Decision: Expose explicit clear action in settings
- Reason:
  - Users need a quick reset path for local muted state.
- Consequence:
  - Add-ons panel provides muted count and `Clear Muted` action.
