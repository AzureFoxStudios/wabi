# Forum context previews, compact profiles, and Games follow-up

Status: final Wiki render-order correction deployed (636f133b, frontend 1790941697326). Exact artifact and origin checks pass. The user confirmed authenticated live Wiki navigation on 2026-10-03: the referenced article opens immediately.

The live annotations exposed a cold-session gap: copied Wiki/Gallery tokens only resolved after those workspaces mounted. Forum bodies now load the accessible matching workspace data through existing scoped clients and register references only while server/account/session ownership still matches. Code remains literal. Cards add Wiki excerpts and Gallery thumbnails alongside the title links.

Lore links show project/path/filename and an authenticated, text-only excerpt for files up to 64 KiB, bounded to 12 lines/1,600 characters. Missing permissions/dependencies or unsupported files have an explicit fallback. Website links reuse Wabi's existing metadata preview endpoint; authenticated internal Lore links never enter that external unfurl path.

Profile edit/dock actions move to upper icons, clicking the handle copies it, the last-message section is removed, and empty bio links stay hidden. Games closes the invoking popup. Personal bio, banner/avatar, full profile, friend/message and moderation capabilities remain.

Games shows save/discard only for unsaved board changes and fixes Discard's reactive-proxy cloning error. Empty boards use a compact hint. Manual entry needs only a title; pasted Steam store URLs automatically yield AppIDs. Available imported library titles provide bounded suggestions (12 results). This is not a general game catalog: Valve's current broader catalog API requires an operator API key. Live read-only configuration audit confirmed both STEAM_API_KEY and WABI_STEAM_PUBLIC_URL absent (values were not printed). No key, Steam connection, activity sharing, or integration setting is enabled by this UI patch. Owners/admins receive a shortcut to the existing Addons settings; the callback origin remains operator configuration. The Steam button is Valve's official unmodified asset, from https://steamcommunity.com/dev.

Wiki reference handoff waits for the reader render pass before opening the selected page. It rechecks channel/draft ownership and leaves blocked navigation pending when unsaved edits prevent selection. The Addons shortcut is admitted by the existing settings event handler.

Validation: 35 focused reference, file-preview, Games model/manual-entry and pending-navigation tests passed. Local real-browser fixture verified cold Wiki resolution, Wiki/Lore/website cards, handle copy, top profile actions and empty-section suppression, title-only private draft creation, Discard, and save-bar disappearance. Synthetic fixture changes were restored before packaging. Svelte check: zero errors, 121 pre-existing warnings. Static/release/live acceptance recorded separately.
