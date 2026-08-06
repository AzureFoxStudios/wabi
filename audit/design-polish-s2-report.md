# Design Polish — Screen 2: Server rail + channel sidebar + user card

Gate: 6 pre-existing bun:test errors. Extracted from audit/design-polish.log.

alpha, ~1.5:1 | WCAG AA | → `color-mix(text-heading 88%, color-warning 12%)` |
| **REC tag** | same `--accent-danger-soft` bug | WCAG AA | → `color-mix(text-heading 88%, color-danger 12%)` |
| Voice chip initials | `color: white` on `--text-secondary` (~1.6:1) | WCAG AA | → `color: var(--text-heading)` on `var(--surface-raised)` |
| Speaking/online rings | `rgba(34,197,94,…)` ×2 | no hardcoded rgb | → `color-mix(status-online …)` |
| Leave button | `rgba(239,68,68,0.15/0.45)` | no hardcoded rgb | → `color-mix(color-danger …)` |
| Timer row | `.channel-item.has-timer` `rgba(255,77,77,…)` | no hardcoded rgb | → `color-mix(color-danger calc(var(--opacity-*) * 100%))` |
| Voice usercard | `border-radius: 10px` | off-scale | → `var(--radius-md)` (8px) |
| Off-scale radii | 6px×7 (thread, add-btn, profile/compact settings, modal controls), 3px (share-copied) | off-scale | → `var(--radius-sm)` (4px) |
| z-index literals | `z-index: 2`/`1` (status dot, drop lines, actions tray) | z token | → `var(--z-base)` (0) |
| Viewport | `.modal-content` `max-height: 80vh` | no 100vh family | → `80dvh` |
| Unread badge | `border-radius: 10px`, font 0.75rem | off-scale | → `var(--radius-full)`, `--font-size-xs` |
| Motion | `all 0.2s`, `0.18s`, `0.15s`, `0.14s`, `0.12s` — ~30 sites | motion tokens | → `--duration-fast`/`--duration-instant` |
| Font drift | ~40 micro sizes (0.5–1.5rem) across the 8 sheets | `--font-size-*` | → nearest token (2xs/xs/sm/base/lg/xl/2xl); **added `--font-size-2xs` (9px)** — was missing |
| Dead CSS | duplicate `.channel-btn:focus-visible` block + stray `;;` | dead weight | removed one copy |
| Dead file | `src/lib/components/ServerRail.css` (167 lines) — **zero refs**, superseded by `styles/components/server-rail.css` | dead weight | deleted |

### (a) Eyeball screens — in the real browser/Tauri window
1. **Rail**: hover pill radius (16 vs old 18), unread badge text, rail-list rhythm.
2. **Top bar**: banner scrim still gives text contrast after `surface-sunken` swap; server name 14px / tagline 11px.
3. **Workspace counter chip + Clear Unread** (radius 8, spacing 8/12px).
4. **Channel rows**: LIVE/NSFW/Muted/Saved/REC chips now readable; focus ring; actions tray on hover.
5. **Voice channels**: initials chips, speaking ring, REC tag, voice usercard (radius 8), leave button.
6. **Bottom user card**: status popup (radius 8), control-btn hover, share-copied badge (radius 4).
7. **Folder popout** now opens **above** the sidebar (z fix); radius 16.
8. **High-contrast + light** themes: tag text still ≥4.5:1.

### (b) Deliberate non-changes
- `.top-section > * { z-index: 1 }` — needs **>0** to out-paint the `::after` scrim; the z-scale only offers 0 (scrim would cover content) or 100 (outranks sidebar popovers). Kept, justified.
- Sub-4px paddings (0.02–0.22rem) left as rems — no spacing token that granular; forcing `--space-1` would change density.
- `.channel-btn { height: 32px }`, avatar sizes — layout dimensions, not spacing/radius.
- `.share-copied-badge` `color: #fff` kept — no white-on-accent token (`--text-on-accent` resolves dark); contrast ≈4.6:1 passes AA.
- Pre-existing shadow-as-color-arg bug (`.modal-content`, `.status-popup` `0 4px 20px var(--shadow-lg)`) — flagged for Pass 1, not this screen's risk.
- Mobile sheet 44px touch targets / 0.375rem gaps — intentional touch density.
- `--accent-primary` gradient guidance didn't apply here: themeManager sets it to the solid accent at runtime, and no border/color site used it.

### (c) Design-director critique
The screen was structurally sound; the real crimes were **(1)** two *defined* tag colors that resolve to 15%-alpha and render as invisible text on every channel row, **(2)** a folder popout stacking *under* the sidebar it floats over, **(3)** 18px radii matching nothing. All fixed. What I deliberately did **not** paper over: the rail's fixed 92px width vs 56px pills leaves uneven gutters; the active-channel state (inset accent bar + 14% tint) is fine but weak on high-contrast; `--channel-btn-font-size` (0.9rem) bypasses the `--text-*` scale. The 18→16px rail call is correct — 16 on a 56px pill is the Discord squircle. Type floor is now 9px via `--font-size-2xs`; I'd rather add that token than ship 8px content. Residual risk to eyeball: the banner-scrim hue shift (near-black blue → near-black indigo).

**STOP — one screen done. Rail/sidebar/user-card only; no other screen touched.**
