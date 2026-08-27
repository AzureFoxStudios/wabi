---
name: wabi-postdeploy-runtime
description: "Use when Wabi live runtime breaks after a deploy."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [Wabi, Deploy, Debugging, Svelte, Axum, SPA, Auth]
    related_skills: [wabi-deploy, post-deploy-ui-debugging, systematic-debugging, rust-axum-server]
---

# Wabi Post-Deploy Runtime

Class-level playbook for **live Tim/wabi.chat runtime failures** after a binary ship: first-user setup, SPA/API contract, and Svelte `$store` crashes. Complements `wabi-deploy` (ship path) without replacing it.

**User prefs (Ronin):** direct execution; no account creation (`DO.NOT.MAKE.A.USER`); if he says nothing is in production, skip backup theater and wipe engine when needed; hard-refresh instructions for his real browser (headless Wabi is unreliable).

## When to use

- `setupRequired: false` but nobody can log in / user wants first user
- Console `e.subscribe is not a function` after join or send
- Console `each_key_duplicate` (https://svelte.dev/e/each_key_duplicate) right after Init
- Theme/wiki XHR → HTML body / `JSON.parse` unexpected character
- CF Insights beacon CORS/SRI red noise mixed with real bugs
- FE/BE path mismatch (`/api/wiki/...` vs `/api/channels/.../wiki/...`)
- Send "technically works" but draft clears on fail / optimistics flash-vanish
- New messages replace/eat older bubbles in the channel list
- "Deploys don't change the site at all" — binary SHA + StartedAt + CSS hash all verified live, user hard-refreshed, SW unregistered, UI STILL stale-looking → suspect **CSS duplicate-selector cascade** (not cache): same class defined in two stylesheets, later `@import` in `styles.css` wins. Real case 2026-08-08: `.kanban-board` defined as horizontal flex in `kanban-board-part1.css` AND as `display: grid` (no template columns) in legacy `todo-list.css` — todo-list imported later → grid won every load → planner kanban columns stacked vertically ("fall through the floor"). Grep the selector across ALL of `frontend/src` before blaming cache/SW. Fix = delete legacy dupes, never import reorder. **SW note (audited 2026-08-08):** `static/sw.js` is network-first, passes `/api/*`, never caches `_app/immutable/*` chunks — an SW version bump changes nothing served online; don't spend hours on SW rituals. If the deployed SW version looks old, the REAL bug is usually an UNCOMMITTED `__WABI_SW_VERSION__` bump in vite.config (it never reached the binary) — commit + redeploy. See `wabi-deploy-debug` `references/sw-truth-and-css-cascade.md` + `scripts/css-cascade-audit.py`.

## Protected skills note

`wabi-deploy`, `post-deploy-ui-debugging`, `rust-axum-server` may be **user-owned**. If those need the same lessons merged, user should run `hermes curator adopt <name>`. Until then, this skill is the curator-managed SoT.

## 1. First-user / setupRequired

**Truth:** `needs_setup()` = `owner_user_id.is_none()` after load from **WabiDB OwnerProjection** (`claim_owner` / `get_owner_user_id` on `WdbAdapter`).

- Legacy `server_owner.json` was a one-time migration shim (integer user id only — not credentials, not HTTP). Prefer removing the load path; delete file on host if present.
- Phantom owner: setup false + empty/broken users projection → wipe **`data/wabi-server/wabidb`** (engine), clear **both** locks (`.lock` and `wabidb/.lock` if present), keep **`.env`**.
- **Forbidden:** `POST /api/auth/register` probes on live (creates users / can steal first-owner).
- Agent never creates the owner account — hand registration to user after `setupRequired: true`.

Verify:

```bash
curl -sS https://wabi.chat/api/setup/status
# {"setupRequired":true}
```

## 2. SPA must not HTML-fallback `/api/*`

Unmatched `/api/*` through `serve_static` → `200 text/html` index.html → FE `JSON.parse` crash.

**Server (before index.html):**

```rust
if path == "api" || path.starts_with("api/") {
    return (
        StatusCode::NOT_FOUND,
        [(CONTENT_TYPE, "application/json")],
        Json(json!({ "error": "not_found" })),
    ).into_response();
}
```

Verify: `curl -sS -w '%{content_type} %{http_code}\n' https://host/api/missing` → `application/json` 404.

Wiki: routes nest at `/api/wiki/{channelId}/pages`. FE `apiBase` + templates must not double `/wiki/pages`. API domain types: `#[serde(rename_all = "camelCase")]` when FE expects camelCase.

Details: `references/spa-api-fallback-and-wiki.md`.

## 3. `e.subscribe is not a function`

Svelte `store_get` → `subscribe_to_store`. Null is handled; **truthy non-store** throws.

### Diagnose

1. **Rebuild order matters**: source patches → `STATIC_BUILD=1 bun run build` → **patch built runtime chunk** → `cargo build --release`. If you cargo-build before patching, `rust_embed` embeds the unpatched JS. Verify with `strings target/release/wabi-server | grep -c "SUBSCRIBE_FAIL"` (should be `1`).
2. Live chunk SHA == local `build/_app/immutable/chunks/<hash>.js` (else cache first).
3. Runtime chunk (often `Z9…`) is Svelte-only; app sites are importers.
4. Sourcemap build; find `store_get` calls with string `"$storeName"`.
5. Resolve minified binding to **last** writable/derived assign (name reuse; first hit is often vendor).

### Diagnostic instrumentation

Patch Svelte's `subscribe_to_store` to self-report the non-store value:

```js
// In build/_app/immutable/chunks/<runtime>.js AFTER `bun run build`:
const old = `function It(e,t,n){if(e==null)return t(void 0),n&&n(void 0),ee;const r=ht(()=>e.subscribe(t,n));`;
const nu = `function It(e,t,n){if(e==null)return t(void 0),n&&n(void 0),ee;if(typeof e!=="object"||typeof e.subscribe!=="function"){try{console.error("[SUBSCRIBE_FAIL] non-store value:",e,"| stack:",new Error().stack.slice(0,600))}catch(_){}return t(void 0),ee}const r=ht(()=>e.subscribe(t,n));`;
```

⚠️ **Re-apply after every `bun run build`** — the runtime chunk is regenerated.

### Definitive root cause that actually fired (2026-08-05)

`[SUBSCRIBE_FAIL]` logged a **plain settings object** (`clickableMentionsEnabled`, `spoilerAllMessagesEnabled`, …) = unwrapped `displayEnhancementSettingsStore` **value**, not the Svelte store.

Pattern:
- Parent passes `displayEnhancementSettingsStore={$displayEnhancementSettingsStore}` (plain snapshot) — OK if child wants a value.
- Child does `export let displayEnhancementSettingsStore` then **`$displayEnhancementSettingsStore.foo`** → Svelte `.subscribe`s the plain object → crash.
- Same name as the module store + `$` is the trap. Snapshot props: **bare** `displayEnhancementSettingsStore.foo`, never `$…`.

Landed fix: `MessageContent.svelte` effectiveSpoiler uses bare prop. Do not `export let` the same name as an imported store if you also `$` it. **This fix has regressed once** after parallel/message work — gate every message-path ship with the hunt below.

**Automated hunt** (from `frontend/`, or skill script):

```bash
python3 scripts/find-prop-store-shadow.py
# skill copy:
# python3 ~/.hermes/skills/software-development/wabi-postdeploy-runtime/scripts/find-prop-store-shadow.py
```

Empty stdout = clean. Declare `export let` **before** any `$:` that reads the prop.

**Runtime chunk filename changes every FE build** (`Z9Z8gdf2.js` → `BM2WwTHT.js`). Locate `subscribe_to_store` by body content containing `e.subscribe(t,n)`, never a hardcoded hash name.

### 3c. `each_key_duplicate` after Init

Keyed `{#each}` throws on duplicate keys. Wabi cause: blank `message.id` (`""`) with key `message.id ?? fallback` — `??` does **not** treat `""` as missing, so every blank-id row keys as `""`.

```svelte
<!-- BAD -->  (message.id ?? fallback)
<!-- BAD -->  (message.id || message.clientMessageId || …)  // key flips on message-accepted id rewrite
<!-- GOOD --> (message.clientMessageId || message.id || message.clientNonce || `__missing_${i}`)
```

Also: reject blank ids in `isRenderableMessage`; dedupe `channel-messages`; live merge via `isSameMessageRow` (clientMessageId first). Server session dump: drop empty ids + HashSet dedupe.

Details: `references/each-key-duplicate.md`.

### 3d. New messages literally eat old ones

Symptom: send #2 replaces #1 in the UI; list collapses toward one bubble while emit "works".

| Cause | Fix |
|-------|-----|
| Merge matched by `id \|\| clientMessageId` interchangeably | `isSameMessageRow`: clientMessageId first; never collapse different client ids onto one server id |
| Keyed each preferred `id` first → key changes on accept | Prefer `clientMessageId \|\| id` (stable from optimistic create) |
| Wire `message` nulls `clientMessageId` on spread | `clientMessageId: incoming \|\| candidate` |
| Server `msg_{commit_seq}` only + projection overwrite | Stamp **UUID into MessageRecord before commit**; projection **keeps non-empty writer id** (do not force `msg_{seq}`); return that same id on the wire |
| Wire nulls `clientMessageId` on spread | `mergeMessageRow`: `clientMessageId: incoming \|\| candidate` |
| Keyed each after accept | Prefer **server id once accepted** (`id` not starting `optimistic:`); else cmid. Keep **last** of a key |
| `channel-messages` hard replace | Soft-merge pending `sending`/`failed` |

**Landed 2026-08-06:** UUID-in-record + projection keep-writer-id + soft history merge + `messageRowKey`. Gate: send A then B then hard-refresh. Full recipe: `references/message-send-path.md` §8.

### Other fix patterns (same day)

| Smell | Fix |
|-------|-----|
| `$layoutStore.isMobile` on facade | `$isMobile` from `layoutStoreStates` |
| `layoutStore.ts` imports `$lib/calling` | import `isInCall` from `callingStateStores` only |
| `placeRegistry` from barrel in hot path | store from `placeStore`; helpers/types from barrel |
| `layoutStore.subscribe = layout.subscribe` | method `subscribe(run, inv) { return layout.subscribe(run, inv) }` |
| Dead `business/store` imports in composer | remove |

### Cloudflare edge cache

New binary + new CSS hash does **not** guarantee new JS chunks — BUT only suspect CF when the public hash genuinely differs from the binary's embedded hash (`strings <binary> | grep -oE '0\.[A-Za-z0-9_-]+\.(css|js)'`). The custom SW never caches chunks (audited 2026-08-08). If hashes match and UI still looks wrong → source bug (CSS cascade, capability gate, z-index banner, stub handler), not cache. Prefer a **new hashed CSS** so you can prove the SPA shell moved.

Details: `references/svelte-store-subscribe-crash.md`, `wabi-deploy-debug` `references/sw-truth-and-css-cascade.md`.

### Ignore

Cloudflare Insights `beacon.min.js` CORS/SRI — not the send path.

## 3b. Text message send path (feels wrong but "works")

After subscribe is fixed, audit send if it still feels flaky. Full recipe: `references/message-send-path.md`.

1. **Never clear draft until emit/queue succeeds.** `sendMessage` returns `{ ok, reason }`; composer awaits and keeps input on failure. Silent `if (!sock) return` + unconditional `clearAfterSend()` loses the message.
2. **`channel-messages` must not hard-wipe optimistics.** Keep local `deliveryState === 'sending'|'failed'` not already in server list by id/clientMessageId.
3. **Optimistic identity = `user-${dbUserId}`** when available (then me.id / socket id).
4. **`message-accepted` only patches present finite fields** — never `id: undefined`.
5. **Pass `channelId={$currentChannel}` into ChatComposer** explicitly.
6. **Reset per-message spoiler after successful send** unless channel force-spoiler.
7. Lift only known Message fields into optimistic rows (no `...options` dump).
8. **New must not eat old** — `isSameMessageRow` + stable `clientMessageId` each-keys + unique server ids (`message-send-path.md` §8).

## 4. Ship gates (runtime honesty)

1. `STATIC_BUILD=1 bun run build` → `frontend/build/index.html` present.
2. `cargo build --release -p wabi-server` after FE build (embed order).
3. Stage `wabi-server.new`, SHA match, stop, **rm locks**, swap, up.
4. Prove `/health`, `/api/setup/status`, public CSS hash, `/api/*` 404 JSON.
5. User hard-refresh; agent does not invent UI success from SHA alone.

## 5. OpenCode / parallel work

Prefer deepseek-v4-flash-free for bulk FE; Hermes verifies. Gallery upload path: wire button + drag-drop via existing `POST /api/upload` + album helpers; keep semantic tokens only.

## Pitfalls

- Rebuilding alone does not clear OwnerProjection — must wipe/reset engine data for first-user.
- adapter-node build clobbers `build/` without index.html — rust_embed SPA dies while `/health` stays 200.
- Binary staged as `.new` is not live until swap+restart.
- Do not thrash CF/tunnel for origin-green public 502 patterns (separate CF diagnosis).
- User-owned `wabi-deploy`: run `hermes curator adopt wabi-deploy` before agent can patch that skill's lock/setup recipes.
- Static "all module stores have subscribe" audits miss **prop + `$` misuse** — instrument runtime when stack is only `It`/`store_get`.
- Patching `build/` runtime then re-running `bun run build` without re-patch = unpatched ship. `grep -c SUBSCRIBE_FAIL` the **binary** before scp when diagnosing.
- Runtime chunk **filename changes every FE build** — find by content, never hardcode `Z9….js`.
- `message.id ?? fallback` is wrong when id can be `""` — use `||` + blank-id filter (`references/each-key-duplicate.md`).
- MessageContent `$displayEnhancement…` fix **regressed once** — re-run `scripts/find-prop-store-shadow.py` before every message-path ship.
- **New eats old:** never merge by `id || clientMessageId` interchangeably; never null-out cmid on spread; MessageList keys prefer **server id once accepted**; stamp UUID into record before commit — projection must not overwrite with `msg_{seq}` only.
- **Design-deploy stash cascade (2026-08-06):** polishing Tim while another session holds uncommitted crash fixes, then stashing that WIP for a "clean" STATIC_BUILD, ships design CSS without MessageContent/MessageList/ChannelSidebar fixes. Live sequence after join: (1) `[SUBSCRIBE_FAIL]` plain settings object + `spoilerAllMessagesEnabled` on undefined `i()` — bare prop fix + redeploy; (2) hard refresh still shows `each_key_duplicate` — MessageList visible-message dedupe + `clientMessageId||id` keys + category unique filter + TextChannelList fallback keys. **Commit crash fixes before or with the design bake; never stash-and-forget them on production.** CF Insights CORS/SRI remains noise.
- Support files: `references/svelte-store-subscribe-crash.md`, `references/message-send-path.md`, `references/each-key-duplicate.md`, `references/css-cascade-duplicate-selectors.md`, `scripts/find-prop-store-shadow.py`.
