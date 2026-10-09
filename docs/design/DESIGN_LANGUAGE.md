# Wabi design language

How the UI gets its look, and how to keep it consistent. Source of truth is code; this is the map.

## Roles, not colours

Every theme (built-in or custom) is turned into **role tokens** by `frontend/src/lib/theme/roles.ts` and applied
by `themeManager.applyTheme`. Components read these, never hex values:

| Token | Meaning |
|---|---|
| `--w-bg` / `--w-bg2` / `--w-raise` / `--w-sink` | stage, side columns, raised surface, sunken (inputs, code) |
| `--w-text` / `--w-mute` / `--w-faint` | primary, secondary, decoration only (can be < 3:1 — never for small text) |
| `--w-line` / `--w-line-strong` | hairlines |
| `--w-accent` / `--w-accent-soft` / `--w-on-accent` | the accent that reads best on the surface: thin lines, icons, active states |
| `--w-seal` / `--w-seal-soft` | the other accent. **Reserved for security-relevant rows** (encryption state, permissions, moderation) |
| `--w-sig` | community signature colour; defaults to the accent, set from operator branding |
| `--w-online`, `--w-danger`, `--w-scrim` | status colours |
| `--w-serif` / `--w-sans` / `--w-mono` | titles / reading / digital strings (times, hosts, ids, counts, retention values) |

## Character

`Theme.character` (`soft` · `ink` · `pixel` · `contrast`) sets `data-char` on `<html>`; `styles/character.css` turns it into
`--w-rs` (radius scale), `--w-bw` (border width), `--w-pill`, `--w-avr`, `--w-shadow`. Use
`calc(10px * var(--w-rs, 1))` for radii. The legacy `--radius-*` tokens follow it too.

## Control kit

`styles/controls-kit.css`: `.w-btn` (`--primary`, `--quiet`, `--danger`), `.w-field`, `.w-switch`, `.w-seg`,
`.w-row`, `.w-title`, `.w-seal`. New UI uses these. Older surfaces are mapped onto the same look in
`login-skin.css`, `stage-skin.css`, `settings-skin.css`, `admin-skin.css`, `modal-skin.css`, `shell.css`, `stream.css`.
Primary actions are the text colour on the background (never a bright fill); destructive actions are outlined in
danger and fill on hover; switches use the accent, never the seal.

## Message stream

`[time][wick][avatar][message]` at ≥ 820px (`styles/stream.css`). The wick shows the share of retention life left
(`MessageList.getMessageLife`). Compact density drops avatars and keeps the same columns. Narrow screens keep the
stacked layout.

## Right rail

`RightStubStrip` is a 46px column (`--w-rail-w`). Click pins a panel and the stage makes room
(`.app-container.rail-on` padding); hold the peek key (`railPrefs.railPeekKey`, Shift by default) and hover to peek
as an overlay; drag to reorder. Order is `layoutStore.stubStrip`. Rail and panel sit below modal overlays.

## Typefaces and languages

Latin faces are self-hosted (`styles/fonts.css`; the desktop CSP forbids CDNs). English is the base language; other
languages are packs (`i18n/packs.ts`) that download with their script's fonts and set `data-script` on `<html>`.

## Link cards

`/api/url-preview` classifies links (`kind`: post, repo, video, audio, article, link) and falls back to X's oEmbed
for posts. `LinkPreview.svelte` draws one flat card per kind and a "preview unavailable" card when nothing readable
came back.
