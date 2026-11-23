/**
 * The translator a helper receives from its caller. Pass svelte-i18n's `$_` (or a test
 * dictionary) so the helper returns text in the current language. Callers should invoke
 * the helper inside a reactive statement that reads `$_`, so a language switch recomputes it.
 */
export type Translate = (id: string, options?: { values?: Record<string, unknown> }) => string;
