# Worker B — Admin Ops Rail + Dashboard Entry + Payments Rehome + Design Polish

Workdir: `/var/home/Ronin/wabi`
Plan: `docs/plans/2026-07-15-admin-hard-design-pass.md` (B2–B5)
Verify: `cd frontend && bun run check` → **0 errors** (75 pre-existing warnings, none from these changes).

## Design law honored
```
LEFT  = navigate
CENTER = full AdminCenterStage (intentional entry only)
RIGHT = ambient staff ops (AdminTab rail) — no form stacks
```

## 1. Admin Ops Rail (`AdminTab.svelte`)
Rewrote the stub into a compact, token-driven right-rail surface:
- Role badge (owner / admin / mod color-coded).
- Primary CTA **Open full dashboard** → `layoutStore.showAdminCenterStage()`.
- Server pulse: online/total from `GET /api/admin/stats` (token via `getAuthToken`), 30s refresh.
- Channel pulse: active channel name + type from `$channels`/`$currentChannel`.
- Compact text-channel list (click → `joinChannel`, stays in chat).
- Online count + online staff snippet (role-color-coded).
- Payments one-liner (enabled/disabled, guest tag, allowed-role count) via `getAdminPaymentAccessPolicy` for admin+; "admin only" otherwise.
- Scoped CSS in-component (dense cards, mock-inspired, Wabi tokens — no hard orange).

## 2. Right panel now hosts the rail (not a center flip)
`WorkspacePanelHost.svelte` previously auto-flipped the right "Admin" tab straight to the center stage (zero rail). Changed it to render `<AdminTab />` in the right dock. The center flip now only happens on the explicit "Open full dashboard" CTA.

## 3. Dashboard entry points
- Ops rail button (required) — done.
- `AdminSettingsTab.svelte` — added **Open Admin Dashboard** button → `layoutStore.showAdminCenterStage()` (token-styled, `.admin-open-dashboard-btn` in `settings-core-part2.css`).
- `MainLayout.svelte` — optional deep link: `#admin` on load opens the dashboard for staff (owner/admin/mod), with a `hashchange` listener and a short retry while auth resolves.

## 4. Payments rehome
- `AdminCenterStage.svelte`: removed the thin top-level `payments` nav item (and its dead nav-icon branch).
- `OverviewSection.svelte`: added a **Payments Access** summary card (enabled state, guest chip, allowed-role count) fed by a new `fetchPaymentPolicy()` in the stage.
- `AdminWorkspace.svelte`: the **Server Policy** (`settings`) section now composes `ServerPolicyPanel` + `PaymentAccessPanel`. The legacy `payments` section is retained but re-pointed to the same composition (nested, not a lonely two-checkbox screen). User-level payment blocks on the Users list are untouched.

## 5. Design polish (`admin-center-stage.css`)
- Active sidebar item: token-driven (`--accent-primary`), left accent bar, tighter padding (was hard-coded `#F26522` orange).
- Stat-segment, top-user XP, card-accent, and branding drop-zone hover all moved off hard orange to Wabi tokens via `color-mix`.
- Branding upload drop zones already present (large icon/banner) — left intact so Worker A's upload wiring is unaffected.

## Files touched
- `frontend/src/lib/components/AdminTab.svelte` (rewrite → ops rail)
- `frontend/src/lib/components/WorkspacePanelHost.svelte` (render rail, drop auto-flip)
- `frontend/src/lib/components/AdminCenterStage.svelte` (drop payments nav, fetch policy, pass to overview)
- `frontend/src/lib/components/admin/OverviewSection.svelte` (payment summary card)
- `frontend/src/lib/components/AdminWorkspace.svelte` (settings = ServerPolicy + PaymentAccess; payments nested)
- `frontend/src/lib/components/settings/AdminSettingsTab.svelte` (Open Dashboard button)
- `frontend/src/lib/components/MainLayout.svelte` (`#admin` deep link)
- `frontend/src/styles/components/admin-center-stage.css` (token polish + payment card styles)
- `frontend/src/styles/components/settings-core-part2.css` (dashboard button style)

## Not touched (per forbidden list)
- No backend / worker A branding upload wiring.
- No commits.
- No full AdminWorkspace re-introduced into the right panel.
