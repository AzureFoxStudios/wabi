# Wabi Translation Guide

This guide is for contributors who want to translate Wabi UI text into another language.

## Where translations live

- Base locale: `frontend/src/lib/i18n/locales/en.json`
- Existing translation example: `frontend/src/lib/i18n/locales/es.json`
- i18n setup/registration: `frontend/src/lib/i18n/index.ts`

## Quick start for a new translator

1. Copy `frontend/src/lib/i18n/locales/en.json` to a new file, for example `fr.json`.
2. Translate only the values. Do not rename or remove keys.
3. Keep placeholders and markup unchanged, for example `{count}` or `\n`.
4. Save the file in `frontend/src/lib/i18n/locales/`.

## Add a brand new language to the app

After creating `xx.json`, update `frontend/src/lib/i18n/index.ts`:

1. Import the locale file.
2. Add it to `availableLocales` with display name.
3. Call `addMessages('xx', xx)` in `initI18n()`.

Minimal pattern:

```ts
import fr from './locales/fr.json';

export const availableLocales = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Espanol' },
  { code: 'fr', label: 'Francais' }
] as const;

// inside initI18n()
addMessages('fr', fr);
```

## Validate your translation

From repo root:

```bash
cd frontend
bun run check:i18n
```

What this checks:

- Missing keys vs `en.json`
- Extra keys not present in `en.json`

Optional type/build check:

```bash
bun run check
```

## Translation conventions

- Keep tone clear and natural for native speakers.
- Keep string intent the same as English.
- Do not translate usernames, IDs, or machine values.
- Preserve punctuation if it affects formatting.
- Keep messages concise in small UI areas (buttons, badges, tabs).

## Common mistakes to avoid

- Deleting keys that exist in `en.json`
- Adding keys only in a translation file
- Breaking JSON syntax (missing quote/comma)
- Changing placeholder names (`{count}` must stay `{count}`)

## Suggested contributor workflow

1. Pull latest `main`.
2. Translate in small chunks (one feature area at a time).
3. Run `bun run check:i18n`.
4. Open app locally and spot-check screens in that locale.
5. Submit PR with:
   - locale file changes
   - any `index.ts` registration changes (only if adding a new language)

## Maintainer notes

- `en.json` is the key source of truth.
- When adding new UI text, add English key first, then update all locale files.
- CI/review should run `bun run check:i18n` before merge.
