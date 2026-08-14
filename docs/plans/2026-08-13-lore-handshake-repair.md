# Lore Handshake Repair Plan

> **For Hermes:** Execute this plan task-by-task. Do not dispatch OpenCode/Luna for the handshake bake. Do not invent a magic channel id.

**Goal:** Make every Lore channel a real repository surface: live addon routes, honest connect/empty states, and Code/Files bound to the channel the user is actually in.

**Architecture:** Lore is compiled into `wabi-server` behind `--features addons`. Creating a Lore channel already auto-creates a working tree under `/var/wabi/lore/<numeric-id>` and a WDB row. The UI must treat that channel as the repo. Persistent trees already exist; the live binary currently lacks the addon, so every `/api/addons/lore/*` call 404s. After the addon is live, remaining bugs are field-shape, empty-repo honesty, and last-channel hijack — not “find channel 2.”

**Tech Stack:** Rust `wabi-server` + `wabi-lore`, Embedded Lore CLI 0.8.6, Svelte 5 frontend, Tim compose bind-mount.

**Product rule (locked):**

- A Lore channel **is** the repo. Users never pick a numeric id.
- Channel wire id is `ch_<hex>`. Lore API path uses the same number parsed as hex (`ch_e1` → `225`).
- Creating a Lore channel must land inside that channel with a connected repo, or a clear Connect empty state.
- Empty native trees (metadata only) are “new repo, no commits yet,” not “Imported / No repository connected.”
- Do not hardcode channel 2, 215, 220, or 225 in product code.
- Channel 2 in the audit was only “one existing tree that happens to have the smoke-test fixture.” It is not special.

**Live evidence this plan is built on (2026-08-13):**

- `/api/addons` = `{ mesh }` only
- `/api/addons/lore/health` = 404 `not_found`
- Binary SHA `a9a161bf…` local == Tim, started `2026-08-13T05:05:56Z`
- `strings` marker `Lore addon initialized` count = **0**
- Env and trees are fine: `WABI_LORE_ENABLED=true`, `/var/wabi/lore/{2,215,220,225}`
- Only tree `2` has fixture files; 215/220/225 are empty native shells
- Frontend still misreads `{ type: "native" }` as Imported
- Code still remembers last Lore channel and can bind a different channel than chat

**Out of scope for this plan:**

- GitHub OAuth picker
- Path ACLs / secrecy
- Full citation pinning/drift
- 3D before/after compare
- Cloudflare beacon
- Peer-session dirty files (`docs/wabi-carl-watch.md`, `LoreEditorBridge.svelte`, research notes)

---

## Task 1: Prove the live binary is featureless

**Objective:** Record the failure so the bake cannot be declared done by SHA match alone.

**Files:** none (read-only)

**Steps:**

1. `curl -sS http://127.0.0.1:3001/api/addons` on Tim — expect no `lore` id.
2. `curl -sS http://127.0.0.1:3001/api/addons/lore/health` — expect 404.
3. `strings ~/Desktop/Wabi/target/release/wabi-server | grep -c 'Lore addon initialized'` — expect `0`.

Do not proceed to Task 8 until these three flip.

---

## Task 2: Normalize LoreRepo at the API boundary

**Objective:** One frontend object that understands the real Rust JSON.

**Files:**

- Modify: `frontend/src/lib/api/lore.ts`
- Modify: `frontend/src/lib/components/LoreWorkspace.svelte` (`repoKind`)

**Current bug:**

```ts
// backend
{ "type": "native" }          // RepoClass tagged enum
{ "repo_name": "...", "channel_id": 225 }

// frontend today
class === 'native'            // false
'repoName' in raw             // often undefined until normalize
```

**Required `normalizeLoreRepo`:**

```ts
function normalizeRepoClass(raw: unknown): LoreRepo['class'] {
  if (!raw) return 'native';
  if (raw === 'native' || raw === 'imported') return raw;
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj.type === 'mirror' || 'mirror' in obj || obj.upstream_url) {
      const upstream =
        (obj.mirror as { upstream_url?: string } | undefined)?.upstream_url ??
        (typeof obj.upstream_url === 'string' ? obj.upstream_url : undefined);
      return { mirror: { upstream_url: upstream } };
    }
    if (obj.type === 'native') return 'native';
  }
  return 'native';
}
```

`repoKind()` must treat `{ type: 'native' }` and `'native'` as Native. Never fall through to Imported unless `imported_from` is set.

**Also normalize** history/file list responses the same way (`hash`/`revision_hash`, `message`, `timestamp`/`created_at`). Do not treat Lore status lines like `changes: 3 added` as file paths.

**Verify:** unit-level asserts in an existing lore frontend test if one exists; otherwise a tiny `loreArtifactCompare`-style helper test is enough. `STATIC_BUILD=1 bun run build` must pass.

**Commit:** `fix(lore): normalize native/mirror repo metadata`

---

## Task 3: Bind Code to the current Lore channel, not a remembered ghost

**Objective:** Opening Code from a Lore channel shows *that* channel’s repo.

**Files:**

- Modify: `frontend/src/lib/components/LoreWorkspace.svelte`
- Modify: `frontend/src/lib/loreWorkspace.ts` if last-channel helpers live there

**Rules:**

1. If `currentChannel` is a Lore channel → that is the selected repo. Always.
2. If current channel is not Lore → show the last *visited* Lore channel in Code, but **do not** `switchChannel()`.
3. Persist last Lore channel only when the user is actually in a Lore channel or explicitly picks one from the Code dropdown.
4. Never auto-switch chat to a remembered Lore channel on Code mount.

Empty state when the selected Lore channel has no repo row: Connect modal (`LoreConnectModal`), not “Imported / No repository connected.”

Empty state when the repo exists but has no commits: “New repository — add files in Files or commit from Code,” with the real `repo_name`.

**Verify:** `bun run build`. No `switchChannel` in `onMount`.

**Commit:** `fix(lore): bind Code workspace to the current channel`

---

## Task 4: Make create-Lore-channel land inside a connected repo

**Objective:** “New Lore channel” is how a user gets a repo. No numeric id, no second wizard unless create failed.

**Files:**

- Modify: `core/crates/wabi-server/src/api/channels.rs` (already auto-creates when `asset_storage` / lore kind)
- Modify: `frontend/src/lib/channelStore.ts` `createChannel` — already should `switchChannel(createdId)` for lore
- Modify: `frontend/src/lib/components/lore/LoreConnectModal.svelte` only if create failed and the user is staring at an empty lore channel

**Required behavior:**

1. User creates a Lore channel named whatever they want (`wabi`, `props`, `hades`).
2. Server: `create_channel` → `lore.create_repo(numeric_id, …)` → `wdb.lore_create_repo`.
3. Client: switch into that channel, open chat normally, Code/Files resolve `/repos/<numeric_id>` and get 200.
4. If addon is down, show “Version service unavailable” — never a fake connected card.

Do **not** special-case channel 2. The smoke fixture in tree `2` is just one existing repo; new channels get their own trees.

**Verify:** after Task 8, create a throwaway Lore channel in the real app and confirm `/api/addons/lore/repos/<new-numeric-id>` is 200.

**Commit:** only if client land-inside is actually broken. If already wired, leave it and record “already implemented” in the handshake note.

---

## Task 5: Honest empty-repo vs missing-addon vs missing-row

**Objective:** Three different failures must look different.

| Condition | HTTP | UI |
|---|---|---|
| Addon not in binary | `/api/addons` has no `lore` | “Lore is not running on this server” — hide fake repo chrome |
| Addon up, no WDB/tree row | GET `/repos/:id` 404 | Connect Repository |
| Addon up, tree exists, no commits | GET 200, files empty / history empty | Native repo, empty Files |
| Addon up, tree + commits | GET 200, files listed | Real explorer |

**Files:**

- `frontend/src/lib/components/LoreWorkspace.svelte`
- `frontend/src/lib/components/FilesWorkspace.svelte`
- `frontend/src/lib/components/lore/LoreChannelCard.svelte`

Capability check: `hasAddonCapability('lore')` is frontend-bundled and can stay true even when the **backend** addon is missing. Add a live `checkLoreHealth()` / `/api/addons` probe for the workspace empty state. Do not cache `false` forever.

**Commit:** `fix(lore): distinguish missing addon from empty repo`

---

## Task 6: Stop treating empty auto-created trees as broken imports

**Objective:** 215/220/225 stay valid empty native repos. Do not delete them in this plan unless the user asks.

They were created by `WABI_LORE_AUTO_CREATE` / lore-channel create. They have `.lore` + `.wabi-repo.json` and no user files. That is a new repo, not a ghost.

Optional later cleanup (not this plan): an admin “delete unused empty repo” on channel delete only.

**Do not:**

- `rm -rf /var/wabi/lore/215` as part of the handshake fix
- hardcode “prefer channel 2”

**Do:**

- Files/Code against whatever Lore channel is selected
- Seed the existing fixture into the channel the user actually wants to demo (Task 9), by name

---

## Task 7: History/file list must not invent paths

**Objective:** Kill the `signed-url?path=changes:+3+added` 500 class.

**Files:**

- `core/addons/lore/backend/src/lib.rs` `parse_history_output` / file list parser
- `frontend/src/lib/api/lore.ts` `getLoreRepoHistory` / `listLoreFiles`

Only emit paths that look like repo paths (`README.md`, `src/hello.rs`). Drop status prose.

**Verify:** `cargo test -p wabi-lore --lib`.

**Commit:** `fix(lore): ignore status prose in file and history parsers`

---

## Task 8: Bake and deploy with `--features addons`

**Objective:** Put Lore routes in the running Tim binary. This is the actual handshake.

**Do not start until Tasks 2–5 and 7 are committed.** Deploy only after the user says deploy, or when executing this plan as a whole after they approve it.

**Commands:**

```bash
# 1. Confirm dirty tree; do not git add -A
git status --short

# 2. Frontend
cd frontend
rm -rf build .svelte-kit
STATIC_BUILD=1 bun run build
test -f build/index.html && test -d build/_app

# 3. Force addon compile (touch a feature-gated file if SHA would no-op)
touch ../core/addons/lore/backend/src/lib.rs
cd ..
cargo build --release -p wabi-server --features addons

# 4. Content proof BEFORE scp
sha256sum target/release/wabi-server
test "$(strings target/release/wabi-server | grep -c 'Lore addon initialized')" -ge 1
test "$(strings target/release/wabi-server | grep -c 'wabi_lore')" -ge 1

# 5. Swap on Tim
scp target/release/wabi-server tim@100.96.11.45:~/Desktop/Wabi/target/release/wabi-server.new
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose stop wabi-server && rm -f data/wabi-server/.lock data/wabi-server/wabidb/.lock && mv target/release/wabi-server.new target/release/wabi-server && chmod +x target/release/wabi-server && docker rm -f wabi-server; docker compose up -d wabi-server'

# 6. Runtime proof
# StartedAt after binary mtime
# curl :3001/api/addons            → contains "lore"
# curl :3001/api/addons/lore/health → {"addon":"lore","status":"ok"}
# authenticated GET /repos/<id-of-current-lore-channel> → 200
```

If `/api/addons` still has only `mesh`, **stop**. Do not “fix the UI.” The binary is still featureless.

**Commit after bake only if source changed; the binary itself is not committed.**

---

## Task 9: Demo fixture is content, not an id

**Objective:** Put the Wabi-on-Wabi smoke files in the Lore channel Ronin actually opens — by channel name, resolved at runtime.

**Source of truth:** `tests/fixtures/lore-meta/` already in git (`e566fc5`).

**How to resolve the channel (no hardcode):**

```text
From the live channel list, pick type === 'lore' AND name the user is showcasing
  (today that is likely "wabi").
Wire id = ch_<hex>
Numeric Lore id = parseInt(hex, 16)
Working tree = /var/wabi/lore/<numeric>
```

If that tree is empty, copy the fixture files in and `lore commit` with `--identity` and `--local`. If it already has the fixture (currently true for numeric `2` only), do nothing.

If Ronin wants the `wabi` channel to be the demo, resolve `wabi` → its hex id → that tree. Do not say “use channel 2” in the UI or in new code.

**Lore commit identity already proven:**

```bash
/home/tim/.local/bin/lore commit "…" --identity "Wabi Test Fixture <wabi-test@localhost>" --local --non-interactive
```

**Triple gate after this:** Git already has the fixture. Lore commit on Tim if files were added. Binary deploy only if Task 8 has not run yet.

---

## Task 10: Real-browser showcase gate

**Objective:** Ronin hard-refreshes `wabi.chat` and we only call it connected if all of these pass.

1. DevTools: `GET /api/addons` includes `lore`.
2. Open the Lore channel named `wabi` (or whatever was created). Chat stays chat. Compact card, not a full shell takeover.
3. Open **Files**. See real files or an honest empty-repo state. No 404/500 storm.
4. Open **Code**. Header shows the **channel name / repo name**, badge **Native**, not Imported, not “No repository connected.”
5. Switching to another Lore channel in the sidebar updates Code to *that* repo without yanking a remembered ghost.
6. Creating a new Lore channel lands inside it; Files/Code talk to the new numeric id; no console `startsWith` / missing `title` crash from Lore code.
7. Cloudflare beacon errors may still appear — ignore.

If any of 1–6 fail, the handshake is still broken. Do not add more features.

---

## Done when

- Live addon routes exist.
- A Lore channel is a repo without anyone knowing its numeric id.
- Empty vs missing vs addon-down are three different UIs.
- Native is labeled Native.
- Code follows the current Lore channel.
- Showcase can be a Lore channel + Files + Code on real files.

## Do not do

- Hardcode `2`, `215`, `220`, `225`.
- Delete empty native trees as “ghosts” without user request.
- Trust worker logs or SHA-only deploys.
- `git add -A`.
- Showcase Lore while `/api/addons` lacks `lore`.
