# Lore × Chat integration — canonical spec (supersedes the 2026-08-28 v1/v2 drafts) — 2026-08-28

Status: **spec for handoff**. This doc merges the two prior drafts (the "Lore Integration UX &
Feature Specification" v1 and its v2 "comprehensive" rewrite, both external pastes from
2026-08-28) into one implementation-ready document, then diffs them against what actually
exists in this tree. Sections 3–5 are committed direction; section 6 is backlog; section 4
lists open decisions **with working defaults** so an implementer never blocks on a human.

Companion reading: `AGENTS.md` (golden rules), `docs/plans/2026-08-21-lore-planning-integration.md`
("link, never depend" philosophy — this spec is the write-side sibling of that read-side work).

---

## 1. Goal

Extend Lore beyond Asset Storage channels into ordinary chat channels: attachments become
promotable into a bound Lore repo path, with an explicit promote flow, review where configured,
system-message audit trail, and zero automatic interpretation of chat text. Chat stays chat;
attachments are the bridge.

## 2. Ground truth — what exists vs. what is actually new

The prior drafts were written as if from scratch. They are not. **Do not rebuild anything in
the left column.**

### Already built (verified in tree)

| Capability | Where |
|---|---|
| Repo engine: create/link repos (1 repo : 1 lore channel), stage_file, commit_staged, branches (create/switch/merge), **review approve/reject per branch**, locks, file+repo diffs & history, snapshots, mirrors, editor sessions, script runner, signed URLs, recordings upload, connect tokens (wabi-sync), auto-branch-on-upload | `core/addons/lore/backend/src/lib.rs` (~3,100 lines) |
| Full REST surface `/api/lore/...` incl. `/repos/{channel_id}/review/{branch_name}/approve` & `/reject`, `/repos/{channel_id}/recordings` | `core/crates/wabi-server/src/api/lore.rs` (route table at line ~176) |
| Coarse permission gate: `AuthUser::may_write_lore()` middleware + `can_edit_lore` + `ensure_channel_member` + owner/admin checks | `core/crates/wabi-server/src/api/lore.rs`, `src/auth_extractor.rs` |
| Lore repo registry persisted in WabiDB, rehydrated on startup (`load_existing_repos`, log "Rehydrated N Lore repo(s) from WDB") | `core/addons/lore/backend/src/lib.rs` |
| Attachment/upload storage with registry | `core/crates/wabi-server/src/upload_registry.rs` |
| Frontend: `LoreWorkspace.svelte`, `frontend/src/lib/components/lore/` (incl. `LoreCitationRegistry.svelte`) | `frontend/src/lib/` |
| Read-side chat↔lore bridge: `^c/` citation chips with Current/Drifted/Missing drift detection | see 2026-08-21 plan doc |
| Offline substrate: IndexedDB outbound queue + drain + scopes | `frontend/src/lib/wabidb/` |
| Addon capability gating (`hasAddonCapability('lore')`) | frontend lib (probes `GET /api/addons`) |

### The actual delta (what this spec adds)

1. **Channel bindings** — many chat channels → one repo path/branch/mode. Today only lore
   channels have repos; ordinary channels have nothing.
2. **Promote-from-attachment flow** — context menu + modal + server endpoint that moves chat
   attachment bytes into a lore repo via the existing engine calls.
3. **In-chat surfaces** — system messages, attachment badges, binding indicator. (The review
   queue UI is Phase 2: the backend approve/reject primitive already exists.)
4. **Granular `lore.*` capabilities** wired into the existing role/permission model
   (today there is only the coarse `may_write_lore`/`can_edit_lore` split).

## 3. Settled decisions (do not re-litigate while implementing)

1. **State home:** binding + promote metadata = WabiDB events + projections (same pattern as
   the repo registry); file bytes stay in lore working trees. This matches the existing
   rehydration architecture.
2. **One binding per channel.** Multiple destinations = Phase 2+ routing rules or more channels.
3. **Staging = the existing review-branch model.** The queue UX presents "pending items";
   under the hood it is branch-based review (`approve_review_branch` / `reject_review_branch`).
   v1 §5.1 explicitly allows this; the engine already does it.
4. **Text, code blocks, links, and embeds are never Lore content automatically.** Only file
   attachments are eligible. Code-block patching is an explicit action, Phase 2+.
5. **Binding resolution order:** channel > category > server > system default (`None`).
   Phase 1 ships channel-level bindings only; category/server inheritance is Phase 2.
6. **Modes:** `None` (default everywhere) / `Direct` / `Stage` / `Hybrid` (Hybrid = resolve
   Direct-vs-Stage at promote time from the user's capability: `lore.commit` → Direct,
   `lore.stage`-only → Stage).
7. **Lifecycle decoupling:** deleting a chat message never touches committed lore history.
   Links back to deleted messages degrade to "original message no longer available". Note:
   with `timed` retention channels this is the *normal* case, not an edge case.
8. **No silent failures.** Every blocked/failed promote produces a specific, human-readable
   message ("binding only accepts image/*", "you need lore.stage", …). This mirrors golden
   rule 8's "compiles but silently doesn't persist" failure class — same trust problem.
9. **Provenance:** commits promoted from chat carry uploader, channel, and message id in
   commit metadata; the promote event in WabiDB is the durable record.

## 4. Open decisions — with working defaults (implement the default unless overridden)

| # | Decision | Default for now |
|---|---|---|
| D1 | Lore Files vs. structured "Lore Entries" (v2 §4) | **Out of scope.** `ChannelKind::Wiki` covers structured knowledge; revisit after Phase 2. |
| D2 | Filename collision at target path | **Always prompt**: new revision / auto-suffix / choose path. No overwrite without an explicit choice. |
| D3 | Post-promote undo button (v1 §12.6) | **Omit in Phase 1.** Undo-vs-concurrent-commit semantics are an engine-capability question (see S1). Revert via lore browser history remains available. |
| D4 | Customizable terminology (v2 principle 5) | **Cut.** Fixed English labels, i18n-ready keys, no admin renaming. Renaming infects every string and the a11y/i18n story. |
| D5 | Moderation suite (quarantine, content scanning, takedown) (v2 §16) | **Deferred** pending the positioning call: privacy-first small teams vs. public-community servers. The VTuber/open-source personas drive ~all of this; if they're not the target, it collapses. |
| D6 | Cross-server lore references | **Out of scope**; keep repo IDs stable and permission checks explicit so the door stays open. |
| D7 | Right-to-be-forgotten vs. commit history (v2 §16.4) | **Defer**, but do not build anything that makes anonymization impossible (keep author identity in a swappable projection field, not baked into hashes). Must reconcile with the wabi-privacy skill's deletion semantics when decided. |

**Spikes (run before or during Phase 1):**

- **S1 — Engine capabilities:** verify against the live lore engine (Tim fixture): concurrent
  commit + revert semantics, collision behavior at `upload_file`/`commit_staged`, whether
  commit metadata can carry arbitrary provenance fields, diff guarantees at a path. Several
  spec items are engine questions wearing UI costumes (D3, Phase 2 patch conflict detection).

## 5. Phase 1 — walking skeleton

Ordered slices; each ships with tests (see §7 constraints).

### P1.1 Binding data model + API
- New WabiDB events (e.g. `LoreBindingSet { channel_id, repo_channel_id, path, branch, mode, allowed_types, auto_stage }` / `LoreBindingRemoved { channel_id }`) and a projection map keyed by channel id, rebuilt on startup like other projections.
- **Golden rule 5:** do NOT add fields to the postcard `Channel` record. Bindings are separate durable state (events), not channel-record fields.
- REST: `GET/PUT/DELETE /api/channels/{id}/lore-binding`, gated by a new `lore.manage-binding` capability.
- Category/server inheritance: not in P1 (resolution order still implemented so `None` default holds).

### P1.2 Granular capabilities
- Extend the existing permission model (`auth_extractor` / roles / channel overrides — extend, do not replace): `lore.view`, `lore.stage`, `lore.commit`, `lore.approve`, `lore.lock`, `lore.manage-binding`, `lore.admin`. Map the existing coarse `may_write_lore` onto `lore.commit` so current behavior is preserved.
- Per-channel overrides follow whatever precedence the existing role system uses — introduce no second precedence model.

### P1.3 Promote endpoint
- `POST /api/lore/promote/from-message { message_id, attachment_id, target: { repo_channel_id?, path, branch, mode_override? } }`.
- Server resolves binding defaults, checks capability + `allowed_types`, reads attachment bytes from `upload_registry`, writes via existing engine calls (`upload_file` → `commit_staged` for Direct; stage + review branch for Stage).
- Errors are explicit JSON reasons rendered verbatim by the client (rule 8 of settled decisions). Never a silent no-op.
- **Golden rule 8:** the emit call for the new provenance event must copy the shape from the target module's existing create method — check how `lore.rs` emits today and match it.

### P1.4 Promote UX
- Attachment context menu: "Promote to Lore…" → "To channel binding (quick)" (only if binding exists) / "To…" (modal) / "Stage for review".
- Promote modal: repo, path (autocomplete, recent targets), branch, commit message (default "Promoted from #channel by @user"). Advanced options collapsed (lock after commit, notify role).
- Binding indicator: lore icon in channel header/sidebar with tooltip (repo/path/mode/types). Drag-over overlay is P1.5-optional; skip if cheap-flagged.

### P1.5 System messages + badges
- Compact, collapsible system message on promote/commit/stage with a lore link; same on reviewer action (Phase 2 wires reviewers).
- Attachment badge: solid = committed, outlined = staged; click → lore browser at the file. Badge state comes from the promote event, keyed stably (`clientMessageId || id`, golden rule 3) and must survive message deletion (decoupling).

### Acceptance criteria (Phase 1 done = all pass)
1. Promote from a bound ordinary text channel lands the file at repo/path/branch and posts a system message with a working lore link.
2. Promoting a type not in `allowed_types` returns and renders the specific rejection message; nothing is written.
3. User without `lore.stage`/`lore.commit` sees no promote actions (menu items hidden) and direct API calls 403.
4. Deleting the source message after promote leaves the repo file and history intact; badge/link degrades to "original message no longer available".
5. Restart + projection rebuild restores all bindings (unit/integration test against event replay).
6. Channels with mode `None` (the default) exhibit zero lore behavior aside from manual promote menu items.
7. `cargo test` and `bun run check` pass; new events have round-trip + replay tests.

## 6. Backlog (Phase 2+, condensed — full UX detail lives in v1/v2 drafts)

- **Review queue UI** over existing approve/reject-branch routes: queue panel, approve/approve-with-changes/request-changes/reject/reassign, bulk actions, staleness flags, notifications + digest mode.
- **Rich lore embeds** for pasted paths/hashes — build on the existing citation-chip + drift-detection system, don't parallel it.
- **Contextual side panel** that follows the channel binding; **reaction-based promote**; **routing rules** (MIME/role/pattern → path, with resolved-path preview).
- **Drop Zone channels** (auto-stage intake). Note: if this becomes a new `ChannelKind`, that's a domain change → postcard/record dual-decode + ts-rs regen + `ChannelView.ts` re-append of `position`/`parentId` (golden rules 4/5) and a docs+skills update per the DB-change policy.
- **Code patch system** (Suggest Edit, Proposal Cards, diff preview, `/lore patch|insert|replace`). Symbol targeting (`func:…`) is a per-language-parsing feature — scope it separately from line-range patches.
- **Annotations** (spatial pins on images, timestamps on A/V, carry-forward across revisions).
- **Offline promote queue** riding `frontend/src/lib/wabidb/` outbound queue + drain.
- **Branch workflows** (per-user/per-channel WIP + merge UI — engine support via `set_auto_branch_on_upload` exists), **unified search**, **webhooks**, **export/backup**, **wabi-sync conflict surfacing**, **moderation suite** (blocked on D5), **Lore Entries** (blocked on D1).

## 7. Implementer constraints (repo-specific, from AGENTS.md — violations have cost real debugging time)

1. Svelte 5 runes only (`$props`/`$derived`/`effect`); no `export let`, no `$:`; never switch the minifier to terser.
2. Message ids are UUIDs end-to-end; keep optimistic→accepted keys stable (`clientMessageId || id`) or keyed lists eat messages.
3. Never add fields to postcard-encoded records without a dual-decode `RecordV0/V1` fallback.
4. New adapter events must copy the emit shape from the target module's existing create method — a wrong emit compiles but silently doesn't persist.
5. `cargo test -p wabi-core --features ts` regenerates `packages/wabi-protocol` and strips manual edits — re-append `position`/`parentId` to `ChannelView.ts` after regen.
6. Lore startup rehydration is async and must be awaited (`load_existing_repos`); an `unused_must_use` there is a correctness defect.
7. Never hardcode lore channel ids (2/215/220/225) — resolve by wire id/name.
8. Frontend must build with `STATIC_BUILD=1`; backend embeds `frontend/build`.
9. Headless Chromium can't render Wabi (Skia crash) — verify UI in a real browser, headless only for HTTP checks.
10. Tests accompany changes; domain/projection changes append to the active plan doc and update the relevant wabidb skill.

## 8. Source documents

- v1 draft: "Lore Integration UX & Feature Specification" (external paste, 2026-08-28 22:34) — full detail on promote flows, staging UX, snippets/patch system, context menus, templates.
- v2 draft: "…Comprehensive UX & Feature Specification (v2)" (external paste, 2026-08-28 22:29) — personas, content-model question, annotations, moderation/legal, lifecycle edge cases, open decisions.
- Both are superseded by this doc; where they conflict with the tree, the tree wins.

---

## 9. Implementation status — Phase 1 backend + frontend (2026-09-01)

**Done (verified: wabidb 886 tests, wabi-server 343 tests incl. 2 new contract tests, svelte-check 0 errors):**

- **S1 spike findings** (opencode audit of `lore/backend/lib.rs`): `upload_file()` overwrites
  unconditionally (no etag guard) → collision prompt enforced at the promote endpoint; commits
  carry no KV provenance and `commit_staged()` drops `author_id` → provenance lives in the commit
  message string + the WabiDB promote event; **no revert/undo exists** → D3 confirmed (no undo
  button; revert = delete_file commit or lore browser history).
- **P1.1** `LoreBindingRecord` + `LoreBindingProjection` (`lore_binding_set`/`lore_binding_removed`
  events, index `lore_bindings`) in `wabidb/projections/lore.rs`; registered in engine; `WabiStore`
  trait + adapter methods; REST `GET/PUT/DELETE /api/addons/lore/binding/{channel_id}`. Mode stored
  as string (rule-5-proof). Channel ids are `ch_{seq:x}` — hex-parsed to i64 for lore addressing
  (bug caught by contract test: plain decimal parse always failed).
- **P1.2** `can_lore(state, user, cap)` capability mapper over workspace roles in `api/lore.rs`:
  owner/admin → all 7 caps; developer → view/stage/commit/approve/lock; artist → view/stage/lock;
  others → view. `can_edit_lore`/`can_asset_write_lore` are now thin wrappers (behavior preserved).
  Binding management requires `lore.manage-binding`. Per-channel grant store deferred to Phase 2.
- **P1.3** `POST /api/addons/lore/promote/from-message` + `GET .../promotes/{message_id}`:
  resolves message → attachment (`file_url` → `uploads_dir`), binding defaults, type whitelist
  (`group/*` MIME globs + extensions), hybrid mode split by capability, collision guard returning
  `{collision: true, options}` (D2), direct commit via `upload_file`, stage via
  `create_branch("chat/u{id}-{ts}") + switch + upload_file`, provenance event
  (`LorePromoteRecord`, index `lore_promotes`, key channel+message+file_url), and a system message
  in the origin channel using `^c/path` citation syntax (renders as drift-detecting chip).
- **P1.4** Frontend: `getLoreBinding`/`setLoreBinding`/`deleteLoreBinding`/
  `promoteLoreFromMessage`/`getLorePromotesForMessage` in `api/lore.ts`;
  `LorePromoteModal.svelte` (runes, BaseModal) with attachment picker, binding prefill, mode
  override, collision flow (overwrite-as-new-revision / choose another path / cancel);
  "Promote to Lore…" context-menu item (gated on addon capability + role) threaded
  MessageList → MessageListOverlays → MessageContextMenu; channel-header binding pill
  (`ChatHeader`); binding config form in `ChannelSettingsModal` (repo select from lore channels,
  path/branch/mode/allowed types).
- **P1.5** Attachment badge (`📦 in Lore` / `📋 staged for review`) in `MessageFileContent`,
  backed by `lorePromoteCache.ts` (svelte store). Populated on promote success and on
  context-menu open; socket-push hydration is Phase 2. The `^c/` system message is the
  cross-client indicator in Phase 1.
- **Tests**: projection unit tests (binding set/remove, promote roundtrip + idempotent key) in
  `wabidb/projections/lore.rs`; `wabi-server/tests/lore_binding_promote_contract.rs` (restart
  replay durability, binding removal durability, promote provenance surviving message soft-delete).
  Also fixed pre-existing compile drift in `channel_lifecycle_contract.rs`
  (`create_dm_channel`/`upsert_group` now take `&[String]`).
- Golden-rule hygiene: `ChannelView.ts` re-appended with `position`/`parentId` after ts-rs regen
  (it had been committed without them).

**Known gaps / next:**
- Promote endpoint not yet covered by an HTTP-level test (store-level contract only — the lore
  engine isn't available in the test harness without the addon fixture).
- Badge has no socket push; multi-repo `^c/` citations resolve to the first lore channel —
  use `^c/#chan/path` form when multiple repos exist.
- Review queue UI, binding presets, and per-channel capability grants are Phase 2.
