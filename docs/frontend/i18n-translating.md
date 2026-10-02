# Translating Wabi (App UI)

How to add or improve a translation of Wabi's **application UI** — menus, settings, dialogs, buttons. This is about interface chrome only. User-generated content (messages, notes, wiki pages) is never translated.

## Current state (read first)

The i18n system works end to end and is safe to translate against, but coverage is partial. Know these facts before starting so a "100% translated" catalog is not mistaken for a fully translated app:

- **Wired surfaces:** chat (composer, messages, context menus, uploads), login + first-run wizard, settings, storage/offline panels, admin dashboard header, emoji picker, camera/audio capture, image/ZIP viewers, mobile shell basics.
- **Not yet wired** (hardcoded English regardless of catalog): ServerRail, Notes, Wiki, Whiteboard, Voice view, Gallery, Forum, business tools, games, and the boot shell strings in `frontend/src/app.html` (`Starting`, `Reconnecting…`, `Work Offline` — pre-paint by design).
- **The catalog contains dead keys.** Only ~268 of the 525 keys in `en.json` are referenced in code. The rest were written ahead of adoption that never landed (e.g. the entire `settings.language_learning` section). Translating them is harmless but changes nothing on screen.

Any key not present in your locale — or a component not yet wired to i18n — falls back to English automatically. A partial translation never breaks the UI.

## Where things live

| Path | Purpose |
|---|---|
| `frontend/src/lib/i18n/index.ts` | svelte-i18n setup, locale registry, `<html lang>` sync |
| `frontend/src/lib/i18n/locales/en.json` | **Base catalog** — the source of truth for keys |
| `frontend/src/lib/i18n/locales/*.json` | One file per locale (`es.json`, `th.json`, …) |
| `frontend/scripts/check-i18n.mjs` | Key-parity checker (`bun run check:i18n`) |

## Adding a new language

### 1. Create the catalog

Copy `en.json` to `frontend/src/lib/i18n/locales/<code>.json` (BCP-47 code, e.g. `th`, `de`, `pt-BR`) and translate the **values only**. Rules:

- **Never change a key or the nesting structure.** Keys are stable identifiers, not prose.
- **Preserve every `{placeholder}` exactly**: `{user}`, `{count}`, `{percent}`, `{channel}`, `{size}`, `{error}`, … You may move a placeholder within the sentence to fit your grammar, but do not rename, add, or drop any.
- **Preserve `\n` escapes** in multi-line strings (e.g. `storage.alerts.export_success`).
- Keep the source's ellipsis style per string (`...` vs `…`) — some tests and layouts are sensitive to it.
- Do not translate product/protocol names: Wabi, WabiDB, Tauri, Cloudflare Tunnel, TURN, Caddy, SpacetimeDB/STDB, OpenMoji, GIF, ZIP, `.blend`, `data/launch-page.json`, `.env`, `%APPDATA%/Wabi`.
- Keep technical literals as literals: search operators (`by:username`, `has:image`), command examples (`/help`), keyboard shortcuts (`Shift+Enter`, `Ctrl+↑`), URLs, IP addresses, port numbers, CSS snippets.
- There are **no ICU plural forms**. Singular/variant pairs are separate keys (`search.results_one` / `search.results_many`). For languages without plural inflection (e.g. Thai), it is fine to give both keys the same text.
- Tone: concise UI language, no politeness particles or formal address unless natural for the target language. Status labels like `messages.encrypted` must be translated truthfully — see `docs/PRIVACY_STANCE.md` wording rules.

### 2. Register the locale in `index.ts`

Four small edits in `frontend/src/lib/i18n/index.ts`:

```ts
import th from './locales/th.json';                 // 1. import

export const availableLocales = [                   // 2. picker entry (label in the language itself)
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Español' },
	{ code: 'th', label: 'ไทย' }
] as const;

export type LocaleCode = 'en' | 'es' | 'th';        // 3. union

const localeSourceMap: Record<LocaleCode, typeof en> = { en, es, th };  // 3b. map

function normalizeLocale(input) {                   // 4. accept the code
	if (input === 'es') return 'es';
	if (input === 'th') return 'th';
	return 'en';
}
```

Once registered, the language appears automatically in both pickers (login page and Settings header) — no component changes needed. The choice persists in `localStorage` under `wabi_locale`, and `<html lang>` is set on the active locale by `applyLocaleMessages`.

### 3. Validate

```bash
cd frontend
bun run check:i18n     # key parity against en.json — must pass
bun run check          # svelte-check — must report 0 errors
```

`check:i18n` catches missing/extra keys. It does **not** yet catch placeholder drift or dead keys, so also verify placeholders manually (diff every `{…}` token between your file and `en.json`).

### 4. Test in a real browser

```bash
cd frontend
STATIC_BUILD=1 bun run build   # or: bun run dev
```

Open the app, switch to your language on the login page or in Settings, and walk the wired surfaces: login, chat, settings tabs, context menus. Check for text overflow — translated strings are often longer than English, and narrow/mobile layouts are the first to suffer. For scripts without inter-word spaces (Thai, Khmer, Lao, Burmese), also check line wrapping in narrow chat panes.

## Extending coverage (developers)

Strings are rendered with svelte-i18n's `_` helper, usually aliased:

```svelte
import { _ as t } from '$lib/i18n';
<label>{$_('settings.title')}</label>
<button aria-label={$_('common.close')}>…</button>
{$_('chat.dm.voice_call_title', { user: name })}
```

To wire a new component: import the helper, replace hardcoded UI strings with `$_('section.key')` calls, and add the keys to `en.json` **plus every existing locale file** (the checker enforces this). Run `bun run check:i18n` before pushing.

## Known gaps / roadmap

1. ~257 dead catalog keys should either be wired up or removed from all locales.
2. Unwired surfaces (see list above) — ServerRail and the mobile shell tab bar are the highest-visibility.
3. `check:i18n` could also validate `{placeholder}` parity and flag catalog keys unused in code.
4. Boot shell strings in `app.html` render before JS loads; localizing them needs an early `localStorage` read in the inline head script.
5. The font stack has no script-specific families; CJK/Thai rendering relies on system fallback fonts. Verify with a real browser (see golden rule 7 in `AGENTS.md`) rather than screenshots.
