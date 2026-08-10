# Lore Ignore Filtering — Plan

**Goal:** Protect Wabi Lore repos from accidental commits of build artifacts, secrets, and junk — at the Wabi layer (since `.loreignore` doesn't exist in Lore 0.8.6; EpicGames/lore#118 is open).

**Design principles (locked in chat 2026-08-09):**
1. Use the `ignore` crate (ripgrep's) for gitignore-correct matching — NO custom glob matcher.
2. Accident-prevention, not security boundary. Direct `lore` CLI bypasses it; that's acceptable (members are trusted, consistent with no-DRM ethos).
3. Safe defaults + user override. Default ignore list covers common footguns.
4. Forward-compatible: seed `.loreignore` into every new repo so it lights up when Lore ships #118.

---

## Tasks

### Backend — `core/addons/lore/backend/`

- [ ] **T1 — Add `ignore` crate dep.** `ignore = "0.4"` in `Cargo.toml`. Confirm version matches workspace lockfile conventions.
- [ ] **T2 — `ignore.rs` module.** Build a `RepoFilter` struct:
  - Loads `.wabiignore` from repo working-tree root (gitignore syntax via `ignore::gitignore::GitignoreBuilder`).
  - Falls back to default ignores if no file present: `node_modules/`, `target/`, `build/`, `dist/`, `.env`, `*.key`, `.DS_Store`, `.lore/`, `Intermediate/`, `Saved/`, `DerivedDataCache/`, `Binaries/` (UE dirs — Lore's core audience).
  - API: `filter.is_ignored(rel_path) -> bool`, `filter.allowed(paths) -> Vec<String>`.
  - Reload-on-change or load-on-demand per call (simpler: build fresh per list_files call — cheap at repo scale).
- [ ] **T3 — Wire into `list_files`.** Filter `lore status --scan` output through `RepoFilter` before returning. Never expose ignored paths to the frontend.
- [ ] **T4 — Wire into `upload_file`.** Reject upload if `repo_path` matches ignore (return 403-style error with reason). Defense-in-depth even though frontend also filters.
- [ ] **T5 — Wire into `delete_file`.** Ignore applies (can't delete what isn't tracked), but don't hard-fail — log + no-op is fine, or just allow (deletion of an ignored path is harmless).
- [ ] **T6 — Seed `.loreignore` + `.wabiignore` on `create_repo` and `link_repo`.** Write both files with the default list into the working tree and stage/commit them (message: "chore: seed ignore files"). `.loreignore` is dormant until Lore ships #118; `.wabiignore` is live immediately. User-editable in-repo.
- [ ] **T7 — Tests.** Unit tests for `RepoFilter`: negation patterns, dir-only patterns, root-anchored vs anywhere, last-match-wins, defaults-when-no-file, filter applies in list_files. Follow wabi-lore test conventions (tokio tests where async needed).

### Frontend — minimal

- [ ] **T8 — Hide ignored paths in tree.** No frontend work strictly needed (backend filters), but confirm `LoreFileTree` handles empty/2-file repos gracefully (fresh repo = just ignore files).
- [ ] **T9 — Show filter state (optional polish).** Small indicator in `LoreChannelShell` top bar: "N paths ignored" tooltip. Skip if it's noise — judge in browser.

### Ops

- [ ] **T10 — Build + deploy.** `cargo build --release -p wabi-server --features addons` → scp to `~/wabi-server.new` → mv to `~/Desktop/Wabi/target/release/wabi-server` → stop → clean BOTH locks → mv → up -d → verify `/api/addons/lore/health` ok + `/api/addons` shows lore.
- [ ] **T11 — E2E verify in real browser.** Create code channel → repo has only `.loreignore`/`.wabiignore` → upload a file to `node_modules/` path via API → expect rejection → upload a legit file → expect success + appears in tree.

---

## Verification checklist

- `cargo test -p wabi-lore` green (T7)
- New repo created via UI contains both ignore files committed at rev 1
- `GET /repos/{id}/files` excludes ignored paths even if staged directly via CLI
- `PUT /repos/{id}/files/node_modules/x.js` rejected with clear error
- `/api/addons/lore/health` → `{"addon":"lore","status":"ok"}` after deploy

## Risks / notes

- `link_repo` seeding: linked repos already have history; seed ignore files as a new commit on main (not force-anything, just a normal commit). If repo is read-only for us, skip seeding silently.
- Don't over-block: `.env` is in defaults but a user might legitimately track `.env.example`. `*.key` not `*.pem`? Include `.pem` too — judge: both are secret-class.
- `ignore` crate respects last-match-wins + negation automatically; do not re-implement.
- Peer session hazard: Wabi repo has a concurrent Hermes session that can wipe uncommitted work. Commit early, commit often.

---

**Effort shape:** T1–T7 are the meat (~3-5 focused hours solo). T8–T11 are short.
