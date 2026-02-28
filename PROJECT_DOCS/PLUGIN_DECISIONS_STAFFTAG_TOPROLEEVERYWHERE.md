# Plugin Decisions - StaffTag + TopRoleEverywhere

## 2026-02-28
### Decision: Keep `StaffTag` and `TopRoleEverywhere` as separate toggles
- Reason:
  - Users may want staff visibility without full role chips, or vice versa.
- Consequence:
  - Independent control path in Add-ons with two settings keys.

### Decision: Use server role metadata only
- Reason:
  - Prevent local role inference drift and keep identity labels authoritative.
- Consequence:
  - No extra role-fetch mechanism or local role mutation path.

### Decision: Translate "everywhere" to primary identity surfaces, not every UI atom
- Reason:
  - Covers the highest-value contexts (`MessageList`, `UserPopout`, `UserListTab`) while avoiding UI clutter.
- Consequence:
  - Some lower-priority surfaces (for example niche overlays) remain out of scope.

### Decision: Style with Wabi role-tone chips, not Discord crown clones
- Reason:
  - Align visual language with Wabi themes and avoid direct Discord mimicry.
- Consequence:
  - Badge colors/tone are token-driven and consistent with other Wabi chips.
