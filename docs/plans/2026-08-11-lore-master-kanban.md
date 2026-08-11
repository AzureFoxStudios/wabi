# Wabi Lore Master Kanban

> **Purpose:** single source of truth for the Lore addon destination and remaining work.
> **Last updated:** 2026-08-11
> **Product rule:** this is a task board, not a release/version plan. Do not create competing Lore roadmaps without updating this file.

## Product destination — locked

- **Channels are repo boundaries.** Each `lore` channel owns one Lore repository.
- **Multiple repos are valid and intentional.** Different channels provide different membership, lifecycle, and chat scopes.
- **Code pill:** opens the current Lore channel's repo, otherwise the last Lore channel visited, otherwise the first Lore channel.
- **Files is separate from Code.** Artists can upload, browse, preview, restore, and download without entering a coder-shaped interface.
- **Code is repo/review/history/policy.** It is not the ordinary asset browser.
- **Chat remains the collaboration surface.** Lore files should be summonable from chat through citations/search.
- **Lore is first-class.** GitHub/GitLab/other Wabi sources are mirrors or import sources, visibly second-class/read-only unless a deliberate future write integration exists.
- **Secrecy boundary:** channel membership is the repo boundary today. Path filters are organization/convenience, not ironclad secrecy. Truly secret projects need a separate Wabi deployment until path ACLs are enforced end-to-end.
- **Git migration:** pragmatic files-only import is supported/planned; original history stays at the source. Full Git-history replay is deferred wizard territory.
- **Cloudflare beacon:** leave disabled/ignored. It is not Wabi admin analytics and is not worth retaining for telemetry.

## Board rules

- **NOW** means actively being corrected or verified before more feature work.
- **NEXT** means the next coherent implementation slice.
- **LATER** means deliberately deferred, not forgotten.
- A card is not DONE from a worker report alone: it needs path-scoped diff review, tests/checks, and real HTTP or browser verification where applicable.
- Do not silently stash or modify peer-session files. Do not commit noise files such as `data/`, `docs/wabi-carl-watch.md`, or unrelated research/test artifacts.
- Deploy only when the user explicitly says deploy/push.

---

# NOW — stabilize the current Lore foundation

## LORE-NOW-01 — Verify repo-first Code workspace
- **Status:** PARTIAL — repo header/channel switcher, Files, History, Review, and Settings wiring in working tree; browser verification remains
- **Scope:** Rework the Code pill into a repo-first view of the current/last Lore channel. Keep channels as the source of truth; no second repo rail.
- **Required UX:** repo header, channel switcher, branch picker, Overview/Files/History/Review/Settings, mirror badge, remembered last Lore channel.
- **Acceptance:** switching Lore channels updates the Code view without loops; non-Lore channels open the remembered Lore channel; the Code pill does not take over ordinary chat.
- **Verify:** `cd frontend && bun run check`; real-browser hard refresh and switch between two Lore channels.

## LORE-NOW-02 — Slim Lore channel card
- **Status:** PARTIAL — compact card implemented in working tree; browser verification remains
- **Scope:** Lore channels retain normal chat. Replace the full embedded repo shell with a compact activity/review card and an “Open in Code” action.
- **Acceptance:** chat remains visible; card is roughly banner-sized; opening Code remembers the channel; mirrors are read-only.
- **Verify:** real-browser Lore channel and ordinary message flow.

## LORE-NOW-03 — Lore channel header cleanup
- **Status:** PARTIAL — redundant Code surface label removed from ordinary Lore-channel messages; real-browser caret/description inspection remains
- **Scope:** Remove redundant “Code” label, stray caret/arrow, and incorrect description placement from Lore channel headers.
- **Acceptance:** header matches normal channel hierarchy; type icon remains understandable; no duplicate label or orphan control.
- **Verify:** real-browser inspection at desktop and mobile widths.

## LORE-NOW-04 — Repair stale repository registrations
- **Status:** PARTIAL — startup skips missing trees; persistent deployment and authenticated cleanup remain
- **Scope:** Remove or repair ghost registrations such as channels 3/5/8; preserve valid repositories. Missing trees must produce actionable 404/repair state, never unexplained 500.
- **Acceptance:** every registered repo has a valid persistent tree or an explicit repair state; restart does not lose repo data; delete channel/repo cleans metadata and files.
- **Verify:** authenticated repo list/files/history/branches calls; restart container; inspect `/var/wabi/lore`.
- **Current verification:** local `cargo test -p wabi-lore --lib` = 19 passed; local `cargo check -p wabi-server --features addons` = passed. Tim still runs the previous binary until an explicit deploy.

## LORE-NOW-05 — Persistent Lore data invariant
- **Status:** PARTIAL — Tim mount/data path corrected earlier; recreate verification is still deployment-gated
- **Scope:** Keep `WABI_LORE_DATA_DIR=/var/wabi/lore` aligned with the compose bind mount. Prevent future `/data/lore` container-local drift.
- **Acceptance:** fresh container recreation retains repos; startup logs/config expose the effective data directory; deployment verification checks the mount.
- **Verify:** recreate container, verify repo tree and history remain present.

## LORE-NOW-06 — Verify current Files workspace
- **Status:** PARTIAL — Files routes GLB/GLTF/OBJ/STL previews through ModelViewer3D and now has local file/path search; real authenticated fixtures remain
- **Scope:** Test separate Files UI against Embedded Lore: upload artwork/shader/document, preview, download, mirror read-only behavior, and review-pending copy.
- **Acceptance:** artist can use Files without entering Code; uploads return clear saved/pending-review state; no 500s; unsupported previews fail gracefully.
- **Verify:** real browser plus authenticated HTTP probes.

## LORE-NOW-07 — Verify upload review flow
- **Status:** OPEN
- **Scope:** Confirm auto-branch uploads, approve/reject, failure recovery, permissions, and activity/audit updates.
- **Acceptance:** upload branch is isolated until approval; rejection leaves mainline unchanged; approval lands safely; branch switching recovers on errors; unauthorized users cannot approve.
- **Verify:** backend tests, API probes, real browser review flow.

---

# NEXT — make Lore coherent across artifacts and chat

## LORE-NEXT-01 — Artifact-aware version timeline and comparison
- **Status:** PARTIAL — classifier and image comparison foundation implemented; image viewer foundation is ready; revision/timeline wiring and real fixtures remain
- **Scope:** Keep one shared timeline/revision selector but choose the comparison viewer by artifact type.
- **Viewers:** text/code diff, image split/overlay comparison, reader/block comparison for prose, metadata fallback for unsupported binaries, and 3D model comparison using the existing ModelViewer3D foundation.
- **Acceptance:** code uses line diff; images use before/after, split, overlay, zoom/pan; long text compares sections/paragraphs rather than pretending everything is code; unsupported binaries explain the limitation and offer both versions; supported 3D assets can be inspected consistently.
- **Verify:** classifier tests plus real-browser fixtures for text, image, Markdown/prose, binary files, and `.glb`/`.gltf`/`.obj`/`.stl` assets.

**Current implementation:** `frontend/src/lib/loreArtifactCompare.ts` classifies code, prose, images, 3D models, and binary files; `frontend/src/lib/components/lore/LoreImageCompare.svelte` provides split/overlay/reveal/zoom controls; `LoreWorkspace` now loads repo files, offers image comparison from the History tab, and fetches revision-specific signed URLs. The slice remains partial until browser-tested with real revisions.

## LORE-NEXT-01A — 3D asset viewer integration and polish
- **Status:** PARTIAL — existing viewer is now integrated into Files previews; comparison and real fixtures remain
- **Scope:** Reuse `frontend/src/lib/components/plugins/ModelViewer3D.svelte` for Lore file previews and later version comparison. It already has Three.js loading, textured/wireframe modes, grid/axes/rig overlays, animation controls, reset, fullscreen, and worker-aware loading for `.glb`, `.gltf`, `.obj`, and `.stl`.
- **Acceptance:** Lore Files recognizes supported 3D files and opens the existing viewer; model URLs are authenticated/signed correctly; loading/error states are understandable; viewer does not expose remote model data across channel permissions; comparison can select before/after models without duplicating the viewer engine.
- **Verify:** real browser with representative `.glb`, `.gltf`, `.obj`, and `.stl` fixtures; inspect network/auth behavior; test fullscreen and worker fallback.
- **Notes:** this is a touch-up/integration task, not a new renderer. Keep the existing viewer as the rendering foundation.

## LORE-NEXT-01B — 3D comparison fallback policy
- **Status:** OPEN
- **Scope:** Define comparison behavior for 3D assets: side-by-side synchronized viewers first; optional overlay/scrub later. If formats or scenes cannot be compared semantically, show before/after inspection plus metadata/hash changes rather than fake a diff.
- **Acceptance:** users can identify which revision they are viewing, compare camera/view state, and download either revision; unsupported 3D formats receive an honest fallback.
- **Depends on:** LORE-NEXT-01A.
- **Verify:** real-browser comparison fixture and permission checks.

## LORE-NEXT-01C — 3D viewer placement
- **Status:** OPEN
- **Scope:** Keep 3D preview available from Files for artists, while Code/Compare may open the same viewer for revision inspection. Do not force artists into Code just to preview a model.
- **Acceptance:** Files → model opens viewer directly; Code → history/compare can inspect before/after; returning to Files/Code preserves channel and selected file.
- **Depends on:** LORE-NEXT-01A.
- **Verify:** real-browser navigation from Files and Code.

## LORE-NEXT-02 — Rename user-facing Diff to Compare
- **Status:** OPEN
- **Scope:** Use “Compare versions” for general users while retaining technical diff terminology inside developer-oriented views.
- **Acceptance:** timeline launches the appropriate compare viewer; no artist/writer is dropped into a code-shaped diff by default.
- **Depends on:** LORE-NEXT-01.

## LORE-NEXT-03 — Citations in ordinary chat
- **Status:** PARTIAL — ordinary Lore chat now renders `^c/path[:lines]` and `^c/#channel/path[:lines]` chips and opens Code at the cited channel/path; pinned/tracking/drift remain
- **Scope:** Wire existing `^c/` citation types/chips/previews into normal message rendering, not only the Lore shell registry.
- **Behavior:** bare path resolves against current Lore channel; explicit channel reference supports cross-channel lookup; click opens Code at file/revision.
- **Acceptance:** citation chips render inline, preserve pinned/tracking semantics, show drift, and enforce membership on resolution.
- **Verify:** message rendering tests and real-browser chat interaction.

## LORE-NEXT-04 — Librarian/search integration
- **Status:** PARTIAL — Files workspace now has scoped filename/path search plus an Enter-driven all-spaces filename/path search across visible repo channels; content indexing and richer librarian results remain
- **Scope:** Add file/code search to existing discovery rather than building an all-repo browser.
- **Behavior:** search filename/path/content across visible Lore channels; result opens the correct channel Code view and file; channel refs remain summonable with `#`.
- **Acceptance:** no result leaks paths from inaccessible channels; multiple Lore channels remain discoverable without a new global repo rail.
- **Depends on:** LORE-NEXT-03 for consistent file references.

**Current verification:** all-spaces result selection now passes the target channel id directly into preview loading, avoiding a reactive state race when switching repositories.

## LORE-NEXT-05 — External mirror reliability
- **Status:** PARTIAL
- **Scope:** Finish mirror lifecycle: registration, lazy cache, refresh webhook, readable upstream errors, expiry, read-only affordances, and cleanup.
- **Acceptance:** mirror channel can browse files/history when upstream is available; stale/failing upstream produces a useful status; no write path mutates mirror data.
- **Verify:** local fixture repository and authenticated API/browser probes.

## LORE-NEXT-06 — Files-only Git import polish
- **Status:** PARTIAL
- **Scope:** Make “Import into Wabi” explicit: clone current files, create native Lore history from the import point, retain source URL, and explain that original history remains external.
- **Acceptance:** clone errors map to readable 502; existing repo maps to 409; imported repo persists after restart; source is visible in Code settings.
- **Verify:** public/test Git fixture and persistent restart test.

## LORE-NEXT-07 — Templates and new-file flows audit
- **Status:** PARTIAL
- **Scope:** Verify template creation, path policy, `.wabiignore`, empty folders, and artist-safe asset templates after the Files/Code separation.
- **Acceptance:** templates land in the correct channel repo and review policy; empty-folder behavior is honest; no UI promises unsupported Lore semantics.

## LORE-NEXT-08 — Security/audit pass
- **Status:** OPEN
- **Scope:** Audit every Lore route and blob path for channel membership, capability checks, signed URL binding, mirror read-only enforcement, and audit events.
- **Acceptance:** unauthorized users cannot list/read/write/approve/branch/refresh/import; signed URLs are short-lived and user-bound; audit covers uploads, deletes, reviews, imports, mirrors, and branch operations.
- **Security statement:** separate Wabi deployment remains the hard secrecy mechanism until path ACLs are enforced end-to-end.

---

# LATER — deliberately deferred

## LORE-LATER-01 — GitHub/GitLab OAuth repository picker
- OAuth login, repository list, select Track-as-mirror versus Import-as-native.
- Must not block native Lore or manual mirror URLs.

## LORE-LATER-02 — Full Git history replay into Lore
- Explicitly wizard territory. Not a v1 promise.
- Files-only import plus source mirror is the supported pragmatic path.

## LORE-LATER-03 — Ironclad path-level secrecy inside one Wabi
- Requires enforced ref/path policy across every list, preview, download, citation, search, mirror, and editor path.
- Until then, path filters are not a security boundary.

## LORE-LATER-04 — Reader mode redesign
- Defer the broader reader UI redesign until Lore’s artifact-aware comparison primitives are stable.
- Reader comparison should focus on changed sections/paragraphs, not a generic two-page book editor.

## LORE-LATER-05 — Rich binary/creative-app comparison
- PSD, Blender, FBX, 3D scenes, audio, video, shader rendering, and engine-native previews.
- Start with metadata/download fallback; add renderers only when a reliable pipeline exists.

## LORE-LATER-06 — CI/CD and hosted-fork features
- No GitHub Actions clone, social fork graph, stars, or Kubernetes orchestration in this Lore scope.

---

# Completion gate for the Lore pass

Before declaring this Lore work complete:

- [ ] No stale repo registration produces a generic 500.
- [ ] Persistent Lore data survives container recreation.
- [ ] Code pill is repo-first and channel-backed.
- [ ] Lore channel retains normal chat with a slim card.
- [ ] Files is independently usable by artists.
- [ ] Upload review flow works end-to-end.
- [ ] Native, mirror, and import states are visible and honest.
- [ ] Text/code comparison works.
- [ ] Image comparison works.
- [ ] Long-form comparison is block/section-aware, even if the broader Reader redesign is deferred.
- [ ] `^c/` works in ordinary chat.
- [ ] Search cannot leak inaccessible channel paths.
- [ ] Security/deployment checks are documented and verified.

## Source files and adjacent docs

- Backend: `core/addons/lore/backend/`
- API: `core/crates/wabi-server/src/api/lore.rs`
- Frontend: `frontend/src/lib/components/lore/`
- Files: `frontend/src/lib/components/FilesWorkspace.svelte`
- Code workspace: `frontend/src/lib/components/LoreWorkspace.svelte`
- Lore skill: `~/.hermes/skills/wabi/wabi-lore-coding-workspace/SKILL.md`
- Existing technical destination: `docs/proposals/lore-integration-workspace-vision.md`

## Change log

- 2026-08-11: Consolidated product destination and implementation backlog after Embedded mode, Files surface, mirrors, import, and channel-as-repo decisions.
- 2026-08-11: Added artifact-aware comparison, chat citations, librarian search, secrecy, stale-repo resilience, and deployment invariants to prevent the final destination from being lost between sessions.

---

# Current working state

- Code workspace rework worker is in flight: channel-as-repo Code view, slim Lore channel card, header cleanup.
- Do not treat that worker as complete until its diff, `bun run check`, and real-browser behavior are verified.
- Existing peer-session/unrelated dirty files must remain untouched unless explicitly assigned.
- Deployment remains gated by an explicit user request to deploy.

---

# Immediate next action

Verify the in-flight Code workspace worker, then execute `LORE-NOW-04` through `LORE-NOW-07` before starting artifact comparison or OAuth.
