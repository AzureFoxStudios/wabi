# Forum, Wiki and server-home annotation follow-up

This is a follow-up to the Oct 1 annotated UI pass. This follow-up was deployed to wabi.chat on 2026-10-02; the artifact and runtime receipt are below.

## Implemented behavior

- Forum uses a dedicated icon matching forum channels, instead of the DM icon.
- Forum and Wiki author displays react to the complete server member roster, live users and the signed-in user. Offline authors retain their names; an absent record is not guessed or reassigned to the current owner. Profile media appears when present.
- Posted forum text, replies and composer previews use the shared sanitized Markdown renderer: formatting, lists, tables, code, links and mentions. Mentions open profiles. Same-server object links delegate to existing channel/map navigation. Copied forum/wiki/gallery/map references resolve only when the existing registry has an unambiguous target; unknown references remain literal. Code and escaped reference text do not navigate.
- Thread and reply action menus expose removal to the author or staff, with the existing server permission checks unchanged. A starter removal hides its thread from the list; replies remain stored. Confirmation states this limit. Failed acknowledgements retain the visible post; retired channel responses cannot mutate a replacement view.
- Forum categories open in a bounded optional browser with search. Selected categories appear as removable horizontal chips; multiple selected categories form a union. Category creation and renaming remain available.
- Wiki opens on an overview of top-level topics and recently updated pages. Existing parent/child structure, content search and breadcrumbs remain the organizing model; no new persistent schema is introduced.
- Wiki places Edit and Fullscreen icons at the toolbar's trailing edge. One page-action menu holds revision history, citation copying and existing sharing controls. “Browse pages” toggles the page browser at narrow/panel width. Contents precede the article, have bounded scrolling, and offer section search for long outlines.
- The server switcher is a quiet chevron beside server identity rather than a separate labelled rectangle. The vague “Edit my choices” action moves beside community roles with an explicit role/sidebar-management label.

## Validation

- Frontend check: zero errors; 121 existing warnings at final validation.
- Targeted identity, copied-reference and shared-link tests plus Wiki helpers and workspace navigation: 160 passed, zero failed.
- Server/account changes invalidate cached object references. Retired map reads and mutations cannot repopulate the new server’s reference directory.
- Isolated scope regression tests: seven passed, zero failed.
- Isolated deletion tests: three passed, zero failed. Covers acknowledgement, rejection and a stale response after channel replacement.
- Real browser fixture at `/__forum_review`: posted formatting/code/table/image rendering, composer preview, mention profile opening, offline author identity, management-menu availability, category search/filter chip, Wiki overview/topic opening, pre-article contents, and narrow page-browser toggle exercised. This route is development-only and returns 404 for release requests. No production forum content was deleted or posted during verification.
- Static build produced 273 immutable assets. Build ID `f4189b05f04e3495`, version `1790920941021`, index SHA-256 `73093d81e77e417e701691ea6b5272d6dcb768ea9cf0c3924520a73f5d1c5936`.
- Backend inputs matched the fresh 2,673-test workspace acceptance freeze, excluding the intentionally replaced frontend build. Source audit: `2026-10-02-forum-wiki-release-source-audit.json`.

## Deployment receipt

- Pinned Cargo 1.93 (rustc 1.93.1), addons enabled, offline/locked release build passed in 23m35s.
- Deployed binary SHA-256: `08fc046b72c436e5356bec93fc22299991e563cf2b92772c856b8023baca4ed3` (87,837,184 bytes).
- Tim backup: `/home/tim/wabi-backups/ui-20261002T063108Z`; previous binary and Authority data/uploads/plugins preserved before replacement.
- Existing Authority container recreated; advisory lock inode remained `6029360`. No lock file was unlinked.
- Disposable and live Authority checks passed: embedded UI/version, health/liveness/readiness/setup, immutable entry hashes, addons manifest, anonymous admin denial (401).
- Browser loaded the new production login page after the update reload. The existing signed-in session did not survive that reload; authenticated production Forum/Home interaction was therefore not repeated. Actual Forum/Wiki components were verified in the development browser fixture before deployment.
- Verification JSON: `2026-10-02-forum-wiki-live-verification.json`.
- Repository commit/push was not performed; the shared checkout contains other active work.
