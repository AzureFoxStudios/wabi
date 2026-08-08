Wabi repo at /var/home/Ronin/wabi. Dark nebula theme; semantic tokens in frontend/src/styles/tokens.css. Do NOT commit. Do NOT touch src-tauri/ or lib/tauri-*.ts.

TASK: Re-token the SCOPED <style> blocks of three admin Svelte components — replace raw hex / rgb() literals / undefined tokens / raw font-family with semantic tokens from tokens.css.

Files in scope (ONLY these three, scoped styles only — do not touch the <script> or markup):
- frontend/src/lib/components/AdminWorkspace.svelte
- frontend/src/lib/components/admin/AdminHeader.svelte
- frontend/src/lib/components/admin/FrontendMetadataPanel.svelte

Rules:
1. Read tokens.css FIRST to learn token names. It has a semantic block AND a later legacy block that wins for colors — pick the token that resolves to the currently-rendered color so nothing visually changes.
2. Replace every raw hex and rgb()/rgba() literal with the matching semantic token.
3. Replace undefined tokens with defined equivalents: --accent-red -> --color-danger; --accent-blue -> --color-info; --accent-green -> --color-success; --color-{info,success,danger,warning}-hover -> color-mix(in srgb, var(--color-X) 80%, white) or nearest defined hover token; --modal-text-secondary -> --text-secondary; --modal-text-muted -> --text-muted.
4. GRADIENT RULE: --accent-primary is a CSS gradient — invalid in color:, border-color:, color-mix(). Use --accent-primary-color there. Only background/background-image may use --accent-primary. Reference: frontend/src/lib/theme/themeManager.ts (path is src/lib/theme/themeManager.ts).
5. Fonts: raw font-family -> var(--font-sans) / var(--font-mono).
6. Color/font token pass ONLY inside <style>. No markup, script, layout, or behavior changes.

VERIFY before finishing:
- Re-grep the three files' style blocks: zero raw hex, zero rgb()/rgba() literals, zero undefined tokens, zero raw font-family.
- cd /var/home/Ronin/wabi/frontend && bun run check — no NEW errors (6 pre-existing bun:test errors elsewhere are NOT yours).

Write a short report to audit/worker-d2-admin-svelte-report.md with per-file old->new replacements and the check result.
