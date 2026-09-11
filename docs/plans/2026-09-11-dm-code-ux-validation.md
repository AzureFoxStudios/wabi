# DM/code UX first batch: validation status

PR: #184, feat/dm-code-workspace-ux. Draft; not merged or deployed.

## Observed

The initial batch passed 18 local helper/source-wiring tests and compilation of 7 changed Svelte components for client and server with an available Svelte 5.48.0 compatibility compiler. This compiler is not the repository-pinned version and is not full dependency-aware checking.

Repository CI run 34585718416, job 103219333074, subsequently failed npm run check with three TypeScript errors: two group side-panel calls passed a Channel where CI expected User[], and the context-menu action did not accept danger. The source-proof and workspace-regression steps passed. Build and browser steps were skipped after the type errors. There were also 7 warnings, including the existing file-tree onOpen deprecation. No full-app visual or two-account security sign-off was obtained.

## Follow-up patch

Both group side-panel entry points now call a shared, explicit openRightGroupDm(Channel) helper. It uses the existing layout state stores and right-panel operation, preserving the complete group channel rather than casting types or substituting a member list. The optional danger metadata is removed; group leave still requires explicit confirmation. Two source-wiring regression checks cover these changes.

The resulting 20 focused checks and 7 client/server component compilations pass locally. These checks do not prove that repository CI, browser integration, live messaging, calls, or permissions pass. A successful repository-pinned check and build must be observed on the follow-up commit before merge.

Commands from frontend:

```sh
node --experimental-strip-types --test scripts/dm-code-ux.test.mjs scripts/dm-navigation-ux.test.mjs
node scripts/dm-code-ux-compile.mjs
npm run check
npm run build:static
```

Cross-server friends, actual remote live-draft observation, full DM controller parity, and universal dock-close draft recovery remain outside this first batch. Local code drafts are explicitly labeled private, not falsely presented as live collaboration. Full approved scope and acceptance gates are in 2026-09-11-dm-code-ux.md.
