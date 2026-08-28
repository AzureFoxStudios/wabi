# Post-login undefined-store crash (`e.subscribe is not a function`)

## The trap (learned 2026-07-19; expanded 2026-07-23)

The first pass "fixed" the SPA boot crash by switching `minify: 'terser'` → esbuild
(`minify: !process.env.TAURI_DEBUG`). That fixed the **guest/login boot** (stuck
"Starting Wabi"), but the deploy STILL crashed after login with:

```
Uncaught TypeError: e.subscribe is not a function
    Immutable 125
D9IyzCrU.js:1:5141
```

So: **esbuild minify is necessary but NOT sufficient.** Two distinct shapes:

### Shape A — real undefined store (re-export / init-order)

A store used as `$store` whose import resolves to `undefined` under minified
module-init order. Path-sensitive: only after socket init loads channels/users
and the main view mounts.

### Shape B — `$` on a plain object prop (VERIFIED 2026-07-23, expanded 2026-08-05)

Parent passes the **already-unwrapped** store value; child `$`-prefixes the prop.

Real stack (Ronin Firefox, full stack paste — critical):

```
e.subscribe is not a function
  r utils.js:26
  ge store.js:58
  i MessageContent.svelte:1
  yD MessageContent.svelte:82   ← effectiveSpoiler reactive
  … MessageItemContent → MessageList → channel-messages handler
```

Cause:

```svelte
<!-- MessageList.svelte -->
displayEnhancementSettingsStore={$displayEnhancementSettingsStore}
<!-- MessageContent.svelte — WRONG -->
$: x = $displayEnhancementSettingsStore.spoilerAllMessagesEnabled
<!-- FIX: prop is already a plain object — no $ -->
$: x = !!displayEnhancementSettingsStore?.spoilerAllMessagesEnabled
```

**Audit rule:** if a prop is named `*Store` but the call site passes `$fooStore`,
the child MUST NOT `$`-prefix it. Grep for `export let .*Store` then check whether
callers pass `$…` or the store handle.

Also check `userLookupStore`: import `users` from `./presenceStore` directly,
not via `./socket-manager` (re-export cycle risk under minify).

### Shape C — prop shadowing an imported store inside the child component (VERIFIED 2026-08-05)

The child component itself imports the store AND declares `export let <sameName>: any`
as a plain prop. The prop shadows the imported store in the module scope. Any
`$<name>` inside that component resolves to the prop (plain object), not the store,
and crashes with `e.subscribe is not a function`.

Real instance:

```svelte
<!-- MessageContent.svelte -->
<script>
  import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
  export let displayEnhancementSettingsStore: any;   // shadows the import
</script>
$: x = $displayEnhancementSettingsStore.spoilerAllMessagesEnabled; // crash
```

Fixes (pick one):
- **Rename the prop** to `displayEnhancementSettings` (drop the `Store` suffix),
  then read it as `displayEnhancementSettings.spoilerAllMessagesEnabled`.
- **Rename the import** to `_displayEnhancementSettingsStore` and keep the prop
  name unchanged.
- **Do NOT** pass `$store` into a prop with the same name as a store; if you must,
  use a different prop name like `displayEnhancementSettings` and never `$` it.

**Audit recipe:** for every component that `export let *Store`, verify it does NOT
also `import { *Store } from …` in the same module. Grep pattern:

```bash
rg -n 'export let (displayEnhancementSettingsStore|layoutStore|themeStore|chatFilterStore|personalPinsStore)' src/lib/components --glob '*.svelte'
```

Then for each hit, check whether that same file also imports a store of the same name.

## Before store-crash hunt — rule out these first

1. Login bounce with `/api/user/me` 401 `token revoked` → `login-bounce-token-revocation.md`
2. `Join as: null` after force-reset → `post-login-socket-and-channels.md`
3. Public 502 with Tim healthy → dead tunnel edge (not SPA)

Only then sourcemap / `$prop` audit.

## Why it hides from every automated probe

- **Headless OOMs** on post-login view — cannot read pageerror.
- **Unminified harness** false-negative for Shape A (not for Shape B — Shape B
  crashes regardless of minify once messages render).
- **Sourcemap throw site** is Svelte internals (`store/utils.js`); need FULL stack
  from user (right-click → Copy stack trace) to get caller file:line.

## Naming technique

1. Prefer user full stack first (2026-07-23: stack alone named MessageContent:82).
2. Else sourcemap build + Firefox click-through (`sourcemap-serving.md` for `.map` MIME).
3. Static SourceMapConsumer on the **caller** chunk, not D9IyzCrU (runtime only).

## Fix shape

- Shape B: remove `$` on plain props; rename prop to drop `Store` suffix if confusing.
- Shape A: fix import/definition; keep esbuild minify; break cycles
  (`userLookup` → `presenceStore`).
- Shape C: rename the shadowing `export let` or the import so they don't collide.
  Prefer dropping the `Store` suffix from props that are plain objects.

## Diagnostic runtime instrumentation (2026-08-05)

When static source audits are inconclusive, patch the **Svelte runtime chunk**
`build/_app/immutable/chunks/Z9Z8gdf2.js` to log the non-store value before it
crashes:

```js
function It(e,t,n){if(e==null)return t(void 0),n&&n(void 0),ee;
if(typeof e!=="object"||typeof e.subscribe!=="function"){
  try{console.error("[SUBSCRIBE_FAIL] non-store value:",e,
    "| stack:",new Error().stack.slice(0,600))}catch(_){}
  return t(void 0),ee}
const r=ht(()=>e.subscribe(t,n));...
```

This **must** happen AFTER `bun run build` (it regenerates the runtime chunk),
and BEFORE `cargo build --release` (which embeds it via rust_embed).

WARNING: every `bun run build` regenerates the chunk hash and wipes the patch.
Order: source patch → build → runtime patch → cargo build → scp → swap.
