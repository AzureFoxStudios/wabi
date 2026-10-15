# Wabi design language

The one-page map. Every value, component, surface and exact wording lives in the full contract, [`DESIGN_CONTRACT.md`](DESIGN_CONTRACT.md); the reference images are in [`reference/`](reference/). The contract is the target and is being rolled out surface by surface, so the code shows what ships today. Feature maturity comes from `docs/PROJECT_STATUS.md`, never from a mockup.

![Chat on desktop in Wabi Ink, the reference shell](reference/chat-desktop-wabi-ink.png)

## Thesis

**Wabi reads like a well-set book that a small community writes in together.** The sidebar is the table of contents (channels anchor where you are), center stage is the page (the one task you are doing), the companion panel is a margin note (optional, beside the page, never instead of it), the workspace tabs are folio words at the page edge, and the colophon under the composer says in plain words who can read this. Structure comes from type, measure and hairline rules, not boxes. Color appears only when it means something, and chrome stays quiet until you reach for it.

## Roles, not colours

`frontend/src/lib/theme/roles.ts` turns every theme (17 built in, plus custom ones) into `--w-*` role tokens, applied by `themeManager.applyTheme`. Components read roles, `color-mix()` of roles, and per-person identity ink. They never use hex, `rgba()`, named colors or the legacy `--surface-*` / `--accent-primary-*` / `--text-*` tokens.

| Role | Is for |
|---|---|
| `--w-bg` · `--w-bg2` · `--w-raise` · `--w-sink` | Page · columns and overlays · hover and selected rows · inside fields |
| `--w-lift` | Objects in flow: cards, attachments, composer, selects (lifts off the paper in Daylight) |
| `--w-text` · `--w-mute` · `--w-faint` · `--w-deco` | Content and the primary fill · secondary · times, kickers, placeholders (≥ 4.5:1) · decoration only, never text |
| `--w-line` · `--w-line-strong` | Hairline rules · control edges (≥ 3:1) |
| `--w-sig` | *Where you are*: active channel glyph, folio underline, the ensō |
| `--w-accent` (+ `-soft`, `--w-on-accent`) | *State*: focus, switch on, selection, links, the NEW rule. Never a primary fill |
| `--w-seal` (+ `-soft`) | *Who can read it*: privacy glyphs, encryption chips, permissions, moderation. Kept ≥ 30° of hue away from the accent |
| `--w-online` · `--w-danger` · `--w-warn` · `--w-info` · `--w-ok` | Presence · destructive and errors · status marks, always with a word |

A person's color is user data. It is never used raw: names use `identityInk(color, theme)` (hue kept, lightness clamped, 4.5:1 guaranteed), avatars a tinted disc.

## Character

`Theme.character` (`soft`, `ink`, `pixel`, `contrast`) sets `data-char` on `<html>`, and light themes set `data-mode='light'`. `styles/character.css` turns these into the radius scale `--w-rs` (Ink 0.7, soft 1, High Contrast 0.5, Joker 0.2), the border width `--w-bw`, `--w-pill`, `--w-avr`, the overlay shadow `--w-shadow` and the resting lift `--w-shadow-1`. Radii are `--radius-sm/inner/md/lg/xl` (4/6/8/12/16 × `--w-rs`). Three planes: the page has no shadow, objects in flow sit on `--w-lift` with `--w-shadow-1`, and overlays carry `--w-shadow`. Small floating tools (hover toolbar, selection bubble) take an edge, not a shadow. High Contrast makes every rule solid and draws selection and hover as rings. No gradients, glows or frost on surfaces.

## Type

Serif names places, sans carries voices, mono counts. **Shippori Mincho** is used for communities, channels, rooms, documents, titles and date rules. **Zen Kaku Gothic New** is used for everything people say and do. **IBM Plex Mono** is used for times, counts, handles, sizes and maturity tags. The styles are `--w-t-display`, `title`, `heading`, `subhead`, `read`, `chat`, `label`, `label-sm`, `ui`, `small`, `caption`, `kicker`, `mono` and `micro` (`styles/typography.css`, with matching `.w-t-*` classes). Each one scales with `--w-fs` and has integer line heights. Loaded weights are sans 400/500/700, serif 400/600 and mono 400/500, with an 11px floor. Fonts are self-hosted (the desktop CSP forbids CDNs). English is the base language; other languages are packs (`lib/i18n/packs.ts`) that bring their script's fonts and set `data-script`.

## Kit

- **Controls** live in `styles/controls-kit.css`: `.w-btn` (default, `--primary`, `--quiet`, `--danger`), `.w-ibtn`, `.w-field`, `.w-select`, `.w-seg`, `.w-switch`, `.w-check` and `.w-radio`, `.w-tag`, `.w-tag--mat`, `.w-role`, `.w-seal`, `.w-badge`, `.w-count`, `.w-react`, `.w-srow`, `.w-disclosure`.
- **Overlays and states** live in `styles/kit-overlays.css`: `.w-pop`, `.w-menu`, `.w-tool`, `.w-tip`, `.w-toast`, `.w-notice`, `.w-empty`, `.w-skel`, `.w-loadline`, `.w-dialog`, `.w-sheet`, `.w-scrim`.
- **Reading** lives in `styles/kit-prose.css`: `.w-prose`, `.w-dayrule`, `.w-newrule`, `.w-typing`, `.w-outline`, `.w-facts`.
- **Svelte wrappers** live in `lib/components/ui/`. One `Icon` registry covers all glyphs: a 24 grid, stroke 1.75, one meaning per glyph.

The grammar is the same everywhere:

- The primary action is ink on paper (`--w-text` fill), at most one per view.
- A selected row is a `--w-raise` fill with a `--w-sig` glyph. Never use left bars.
- The active tab has a 2px `--w-sig` underline. The selected segment is a paper key.
- Focus is a 2px `--w-accent` outline.
- Hover changes color, never size or position.
- Workspace tabs are words. Use no text glyphs or emoji in chrome.
- Motion uses `--w-dur-1/2/3` (120/180/240ms) and `--w-ease`. It respects the system setting and `data-motion='reduce'`.

## Truth labels

Truth is typography. Privacy, locality and maturity have a fixed place, fixed grammar and fixed words. Each is said once per screen at its entry point, and it never shrinks to a bare glyph, phones included.

| Kind | The only words |
|---|---|
| Privacy (`lib/privacy/privacyState.ts` + `PrivacyBadge`) | "Server-readable", "Server-readable by choice", "Encryption pending", "Experimental encryption" ("Not independently verified.") |
| Retention (its own clock chip, never a privacy claim) | "Kept until someone deletes them", "Kept 24 hours", "Live only · not saved" |
| Locality | "Only you · this device", "Private · this device", "Local draft", "Saved on this device", "Synced to server" |
| Maturity (`.w-tag--mat`) | `PREVIEW` (office tools are an integration candidate, not a deployed feature), `OPTIONAL ADD-ON · PREVIEW`, `EXPERIMENTAL` |

Member UI never says "Secure", "End-to-end encrypted", "E2EE", "verified", "operator-blind", "private" for live or timed retention, "Beta", "New" (as a feature badge), "Coming soon" or "Production".

## Layout

Channels anchor the shell. Center stage owns the task. The stub rail is additive. The companion panel is optional: it pins only while the stage keeps at least 600px, and otherwise it opens as a peek. The sidebar, stage and companion share one masthead rule at y = 96 and one 80px footer band. Layout follows the width: phone below 600, tablet 600 to 1249, desktop from 1250. Stage-dependent rules use container queries on the stage.
