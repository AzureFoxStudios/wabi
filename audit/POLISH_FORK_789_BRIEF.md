# Wabi Polish Fork — Items 7 / 8 / 9 Brief
**For:** a separate OpenCode "fork" session (do NOT run inside the main UI-polish session)
**Frontend:** `/var/home/Ronin/wabi/frontend`
**Precondition:** Phases A / B / C / D are already complete. This fork ONLY does 7/8/9. Do not redo A–D.

## Context to attach / read
- `/var/home/Ronin/wabi/DESIGN_AUDIT_2026-07-13.md` — read **§3, §5, §11.3–§11.5**
- `/var/home/Ronin/wabi/UI_PHASE_A_PASS_2026-07-13.md`
- `/var/home/Ronin/wabi/UI_PHASE_BC_PASS_2026-07-13.md`
- `/var/home/Ronin/wabi/UI_PHASE_C_PASS_2026-07-13.md`
- `/var/home/Ronin/wabi/UI_PHASE_D_PASS_2026-07-13.md` (if available)
- `frontend/src/lib/api/admin.ts` (real endpoints)
- `frontend/src/lib/components/AdminCenterStage.svelte` + `components/admin/*` + `layoutStore.ts`

## Item 7 — Admin "settings" / server-policy section (real data only)
The dropped `settings` nav item should become a real section. Real data already exists in `api/admin.ts`:
- `getAdminUploadLimits` / `saveAdminUploadLimits`
- `getAdminPolicy<T>(key: AdminPolicyKey)` / `saveAdminPolicy` (generic key→value)
- payment access, community-node announcement/access policies, compression config/metrics, runtime guardrails (already surfaced in other sections).

**Ask:** add a real `settings` section to `AdminCenterStage` that aggregates **upload limits** + a **generic policy browser** over the `AdminPolicyKey` union (list keys, get/save). Reuse `AdminWorkspace` plumbing.
**Guardrails:** real data only — no fabricated stats/sections; token-driven; no new backend routes.
**Decisions to make:**
- Curated subset of policies vs a full `AdminPolicyKey` browser?
- Top-level nav item, or fold under existing sections?

## Item 8 — Motion cohesion app-wide
**Ask:** create one shared `styles/motion.css` containing:
- a standard `.live-dot` pulse spec (green, token-driven),
- a `.reveal` fade-up / stagger animation,
- a base `@media (prefers-reduced-motion: reduce)` that disables all motion.
Then replace the one-off animations currently in admin cards, sidebar LIVE pill, whiteboard, notes, and DM with these shared tokens.
**Guardrails:** no layout/density change; every animation must honor reduced-motion; performance-safe (CSS only, no layout thrash).
**Decision:** OS `prefers-reduced-motion` only, or add an in-app "motion intensity" setting? (Recommend OS-only to start.)

## Item 9 — Audit re-sweep of remaining surfaces
**Ask:** re-read `DESIGN_AUDIT` §5 + §11.3–§11.5 and enumerate polish for surfaces NOT yet touched in A–D: Members panel, Map, Media/Transfers, Reader, QuickResources, server rail, channel-sidebar density, login screen. **Output a prioritized plan** (do not blind-implement) — each surface needs separate sign-off.
**Guardrails:** frontend-only; never regress cozy chat density; token-driven; no commits.

## Forbidden (all items)
Backend writes, cozy chat density changes, right-panel width clamps, git commits, fabricated/mock-only data.

## Verification
`cd /var/home/Ronin/wabi/frontend && bun run check` → 0 errors; `bun run build` → success.
**Report to:** `/var/home/Ronin/wabi/UI_FORK_789_PASS_<YYYYMMDD>.md` with files changed, what 7/8/9 did, decisions taken, bun check + build result, remaining risks.
