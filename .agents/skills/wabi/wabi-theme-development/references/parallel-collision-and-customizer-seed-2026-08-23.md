# Parallel-endpoint collision + customizer seed notes (2026-08-23 session)

Supplement to `references/media-backgrounds.md`. Session-specific detail
from the day the background-upload endpoint landed.

## What happened

Two agents implemented `POST /api/upload-background-image` concurrently on
different branches. The wip/combined-handoff merge then produced:

1. Duplicate handlers in upload.rs (`E0428` defined multiple times,
   conflicting `Serialize`/`Debug` derives) — compile broke tree-wide.
2. A client/server URL drift — merge kept one side's frontend fetch URL and
   the other's backend mount path, so uploads 404'd again silently.
3. The peer's uncommitted struct-field work (`shared.rs` `presence` field)
   sat behind a committed half (`presence.rs` referencing it), so neither
   HEAD nor the dirty tree compiled during the window.

Resolution kept the wip branch version (magic-byte sniffing, 25MB video,
`pub fn`) and reverted the duplicate; editor fetch restored to match
routes.rs.

## Durable rules

- **Check parallel branches BEFORE implementing any Wabi backend endpoint:**
  `git log --all -S <symbol_or_route_fragment>` — look at `wip/*` branches.
  If an implementation exists or is in flight, extend it, don't add a second.
- **After any merge touching shared API files**, diff the route mount path in
  `api/routes.rs` against every frontend `fetch('/api/...')` call site for
  that feature. Mismatches are silent (SPA fallback returns 404-as-page).
- **Proving "my commit compiles" in a shared tree:** when unrelated WIP breaks
  `cargo check`, use a throwaway worktree (`git worktree add /tmp/x HEAD`) —
  but if HEAD itself is broken by the peer's split commit/WIP pair, the only
  honest statement is which FILES compile clean, not that the tree does.
- **Scoped-commit hazard:** `git add <files> && git commit` can still sweep
  peer-staged files if the peer staged them before your add. Always verify
  with `git diff --cached --stat` and expect to `git reset --soft HEAD~1` +
  recommit when a stray file rides along.

## ThemeCustomizer palette-seed pattern

Customizer defaults now derive from the active theme instead of hardcoded
hexes:

```ts
function paletteToCustomSeed(paletteId: string) {
    const resolved = ALL_PALETTES.find((p) => p.id === paletteId) ?? DEFAULT_PALETTE;
    return {
        colors: { bgPrimary: resolved.bgSunken, bgSecondary: resolved.bgBase,
                  bgTertiary: resolved.bgRaised, textPrimary: resolved.textPrimary,
                  textSecondary: resolved.textSecondary, textTertiary: resolved.textMuted,
                  accent: resolved.accent, accentHex: resolved.accent,
                  accentRgb: hexToRgb(resolved.accent), border: resolved.bgRaised },
        gradients: { primary: resolved.bgPrimary ?? `linear-gradient(...)`,
                     accent: ..., accentHover: ... }
    };
}
```

Keep BOTH reactive paths wired: the `themeId === 'custom'` restore block AND
a non-custom reactive re-seed (`$: if ($themeStore.themeId !== 'custom')`)
so prefs arriving after mount still produce correct seeds.
