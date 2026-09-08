# Read-only Wabi UI/UX source scout

Repo: /var/home/Ronin/wabi. User wants INFORMATION GATHERING AND A PLAN ONLY. Another Astra session owns security. Parent Hermes walks the actual website. Your task is a bounded SOURCE audit of shared shell/icon/placement behavior, not a code fix or a security audit.

Output ONE compact report to /var/home/Ronin/wabi/docs/plans/2026-09-07-ui-recon-source-scout.md (maximum roughly 120 lines). This report is the ONLY file you may create or modify. Do not change source, tests, config, skills, generated files, other docs, git index/history, or data. No installs, builds, servers, git checkout/reset/stash/commit/push, browser, network, credentials, or mutations. Reading git status/diff is allowed. Do not read .env, data, auth stores or secrets. Existing plan and peer work must remain untouched. Read-only reconnaissance, not implementation.

Keep discovery bounded: at most 18 source reads; search narrow regions rather than whole giant files. Finish with the evidence you have, not an exhaustive speculative audit. Repo AGENTS has dated assumptions; verify against actual source rather than repeating historical bugs.

Focus questions:
1. Where can controls become blank (SVG sizing/currentColor, parent clipping or zero width, hover-only actions, Unicode glyph dependencies, unmapped panel icons)? Trace consumer CSS, not just icon paths.
2. Which paths move navigation/context panels left/right or restore old placement? Identify accidental-looking state coupling and anchor inconsistencies; don't call intentional right docking or camera mirroring a bug.
3. Which shared navigation/overlay patterns create unclear entry/exit, clipped controls, inconsistent focus or duplicate navigation?

Starting paths (read targeted portions, follow only relevant imports):
- frontend/src/lib/components/MainLayout.svelte
- frontend/src/lib/components/WorkspacePanelIcon.svelte
- frontend/src/lib/components/WorkspaceViewBar.svelte
- frontend/src/lib/components/message/MessageItemActions.svelte
- frontend/src/lib/components/sidebar/ProfileCard.svelte
- frontend/src/lib/components/settings/SettingsTabIcon.svelte
- frontend/src/lib/layoutStoreNav.ts
- frontend/src/lib/layoutStoreStates.ts
- frontend/src/lib/layoutStoreRightPanel.ts
- frontend/src/lib/layoutStoreUtils.ts
- frontend/src/lib/components/ChannelSidebar.svelte
- frontend/src/styles/styles.css (actual loaded stylesheet entry)
- frontend/src/styles/components/sidebar-core-part1.css, part2.css, part3.css
- frontend/src/styles/components/chat-workspace.css, ml-actions.css

Report:
- source revision and exact inspected paths
- up to 8 high-value findings with severity, precise file:line evidence, concrete observable symptom, proposed fix direction, and browser reproduction to confirm
- explicitly separate CODE-CONFIRMED from RUNTIME-UNVERIFIED; parent will verify claims
- correct behavior worth preserving, and areas you did not inspect
- recommend the first narrow implementation batch with exact allowed files and acceptance tests

Do not inflate counts or call the website audited, broken, complete or production-ready from source alone. Do not run checks; parent owns baseline. Output in English. End once the report is written.
