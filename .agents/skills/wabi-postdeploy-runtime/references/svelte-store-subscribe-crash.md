# Svelte `e.subscribe is not a function` (Wabi)

## Symptom

```
Uncaught TypeError: e.subscribe is not a function
    Z9Z8gdf2.js:1:5204
```

Often 2–3 times right after socket `Init received`; may block send. With diagnostic patch:

```
[SUBSCRIBE_FAIL] non-store value: Object { clickableMentionsEnabled: true, spoilerAllMessagesEnabled: false, … }
```

## Mechanism

`store_get` → `subscribe_to_store` (`svelte/src/store/utils.js`). Null/undefined is OK. **Truthy non-store** throws.

`Z9….js` runtime chunk is Svelte-only. App call sites are importers (e.g. large chat chunk).

## Definitive cause (2026-08-05 production)

**Prop snapshot named like a store + `$` auto-subscribe.**

```svelte
<!-- Parent (OK if child wants a plain snapshot) -->
displayEnhancementSettingsStore={$displayEnhancementSettingsStore}

<!-- Child BAD -->
export let displayEnhancementSettingsStore: any;
$: x = $displayEnhancementSettingsStore.spoilerAllMessagesEnabled; // CRASH

<!-- Child GOOD -->
export let displayEnhancementSettingsStore: any;
$: x = displayEnhancementSettingsStore.spoilerAllMessagesEnabled; // plain field access
```

Or: child imports the real store AND `export let` the same name (shadow) then `$`s the prop.

**Hunt pattern:** run `scripts/find-prop-store-shadow.py` from `frontend/` (skill copy under this skill's `scripts/`). Strips comments so `$foo` in docs does not false-positive. Manual fallback: `export let fooStore` + `$fooStore` while parent passes `$store`.

Fixed site: `MessageContent.svelte` (effectiveSpoiler). Related: MessageHeader / MessageItemActions correctly use bare prop. **Regression:** the `$` line came back once — treat the script as a ship gate for message UI.

Runtime chunk names change every build. Find the file containing `function It(e,t,n){if(e==null)...e.subscribe(t,n)` rather than assuming `Z9Z8gdf2.js`.

## Diagnose without guessing

1. **Rebuild order matters**: source → `STATIC_BUILD=1 bun run build` → **patch built runtime** → `cargo build --release`. Verify: `strings target/release/wabi-server | grep -c SUBSCRIBE_FAIL` → `1`.
2. Live chunk SHA == local `build/_app/immutable/chunks/<hash>.js` (else cache first).
3. Ship with a **new CSS hash** so hard-refresh proof is obvious.
4. Ask user for `[SUBSCRIBE_FAIL]` line — value shape names the culprit immediately.

### Diagnostic instrumentation

After every `bun run build`, patch runtime before cargo:

```js
// build/_app/immutable/chunks/<runtime>.js — function body may shift by Svelte version
const old = `function It(e,t,n){if(e==null)return t(void 0),n&&n(void 0),ee;const r=ht(()=>e.subscribe(t,n));`;
const nu = `function It(e,t,n){if(e==null)return t(void 0),n&&n(void 0),ee;if(typeof e!=="object"||typeof e.subscribe!=="function"){try{console.error("[SUBSCRIBE_FAIL] non-store value:",e,"| stack:",new Error().stack.slice(0,600))}catch(_){}return t(void 0),ee}const r=ht(()=>e.subscribe(t,n));`;
```

Do **not** leave this in production long-term once fixed; re-apply only for diagnosis. Rebuild regenerates the chunk and wipes the patch.

### Static store audit (helpful but incomplete)

Vite SSR load of modules can show every imported store has `.subscribe` while runtime still crashes on **props**. Static "all stores OK" does not rule out prop-shadow `$` misuse.

## Other smells fixed same day

1. Chat/ChatComposer: `$isMobile` from `layoutStoreStates` instead of `$layoutStore.isMobile`.
2. `layoutStore.ts`: `isInCall` from `callingStateStores`, not `$lib/calling` barrel.
3. `layoutStore.subscribe` as method wrapping `layout.subscribe`.
4. `placeRegistry` store from `placeStore`; barrel for helpers/types only.
5. Remove dead `business/store` imports from ChatComposer.

## Not this bug

- CF Insights beacon CORS/SRI
- Theme 404 JSON once SPA API fallback is correct (optional endpoint)
- The service worker: audited 2026-08-08 — `static/sw.js` is network-first,
  passes `/api/*`, never caches `_app/immutable/*` chunks; an SW version bump
  changes nothing served online. When chunks look stale, prove hash mismatch
  against the binary first (see `wabi-deploy-debug` `references/sw-truth-and-css-cascade.md`).

## Cloudflare edge cache

New binary alone can still serve old `Z9…` from CF — but ONLY when the public
CSS/JS hash genuinely differs from `strings <binary> | grep -oE '0\.[A-Za-z0-9_-]+\.(css|js)'`.
If hashes match and the UI still looks wrong, it is a source bug (CSS cascade,
capability gate, z-index, stub handler), not cache — audit before advising
hard-refresh rituals. New CSS asset hash in index.html is a good "shell moved"
signal.
