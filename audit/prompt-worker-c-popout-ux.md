You are working in the Wabi repo (/var/home/Ronin/wabi). Svelte 5 + plain CSS frontend. Dark nebula theme; semantic tokens in frontend/src/styles/tokens.css — use semantic tokens, never raw hex. Do NOT touch src-tauri/ or lib/tauri-*.ts. Do NOT commit anything.

TASK: Mention + user-popout UX cleanup. Four sub-items.

Files you may modify ONLY:
- frontend/src/lib/components/MessageList.svelte
- frontend/src/lib/components/UserPopoutImpl.svelte
- frontend/src/lib/components/UserPopoutActions.svelte
- frontend/src/styles/components/user-popout.css (only if it exists and is where popout styles live — check first; if popout styles are scoped in UserPopoutImpl.svelte, edit there instead)

SUB-ITEM 1 — Click a mention copies the username.
In MessageList.svelte, `handleMarkdownContentClick` (~line 493) has a branch: when the click target is inside `.mention-token`, it currently resolves the user and calls `openUserPopoutForUser(user, mentionTokenEl)` (~line 538-546). CHANGE this branch: instead of opening the popout, copy the mention text (the username, without the leading @) to the clipboard via `navigator.clipboard.writeText(...)` and show transient "Copied!" feedback. For feedback: check if the file/project already has a toast/copy-feedback pattern (grep for 'Copied' under frontend/src/lib — e.g. a toastStore or similar) and reuse it; if none exists, do a minimal inline approach: temporarily set the mention element's text or add a CSS class showing a small "Copied" tooltip via a `copied-mention` class + :after rule, removing it after ~1.2s with setTimeout. Keep event.preventDefault()/stopPropagation(). Do not break the `.mention-token-place` and `[data-ref-kind]` branches above it.

SUB-ITEM 2 — Remove dev-y affordances from the user popout.
- In UserPopoutActions.svelte: DELETE the "Copy User ID" context button (~line 69-71) and the now-unused `onCopyUserId` prop (line 15). In UserPopoutImpl.svelte: remove the `copyUserId` function (~line 320-324) and the `onCopyUserId={copyUserId}` prop pass (~line 564).
- Color-status decoration: in UserPopoutImpl.svelte the avatar has a `.status-badge` dot (~line 410) and there's a `.status-section` with a colored indicator (~line 457-460). Remove the `.status-badge` element inside `.avatar-ring` ONLY (keep the textual status-section with its label). Remove any now-orphaned `.status-badge` CSS.

SUB-ITEM 3 — Add mute/deafen + settings buttons to the user popout.
In UserPopoutActions.svelte add a new icon-button row BELOW the existing actions:
- A "Mute" toggle button and a "Deafen" toggle button (mic / headphone SVG icons, inline SVG like the existing buttons). These control the CURRENT USER's own voice state. Look at frontend/src/lib/components/CallControls.svelte (or callingStateStores.ts / calling.ts) for the existing mute/deafen state stores and toggle functions — import and reuse the same store/functions so the buttons reflect and control real state. If the existing toggle functions only work inside an active call, wire the buttons to the stores directly (set the muted/deafened flags) and disable the buttons (disabled attr + title tooltip "Join a voice channel to mute") when no call/voice session is active — follow whatever pattern CallControls.svelte uses.
- A "Settings" gear-icon button that dispatches/forwards an `onOpenSettings` callback. Thread it through: UserPopoutActions gets `onOpenSettings` prop; UserPopoutImpl passes a handler that dispatches `openFullProfile` (the existing event that ChannelSidebar already maps to opening settings — check ChannelSidebar.svelte ~line 854: `on:openFullProfile={() => dispatch('openSettings')}`). So the Settings button should call the same `openFullProfile()` path when isOwnProfile, and be hidden when !isOwnProfile.
Show the mute/deafen row only when `isOwnProfile` is true.

SUB-ITEM 4 — "Share profile" action on the expanded profile view.
In UserPopoutActions.svelte, when `profileExpanded` is true (non-own profile) OR always for own profile, add a "Share Profile" button in the actions area. On click: build a shareable reference — use the same share mechanism the app already has if one exists for users (grep for ObjectShareMenu usage; ForumChannel.svelte uses `<ObjectShareMenu record={{ kind: 'forum_post', ...}} />` — check whether 'user' is a supported kind in the ObjectShareMenu component; MessageList.svelte ~line 514 handles navRef kind 'user'). If ObjectShareMenu supports kind 'user', render it with the user's id/username as title. If it does NOT support users, fall back to a plain button that copies `@username` + user handle to clipboard with the same Copied feedback pattern as sub-item 1.

CONSTRAINTS:
- Svelte 5 runes are preferred project-wide, BUT these specific files use legacy `export let` / `$:` style — MATCH the existing file style, do not convert.
- i18n: existing labels use `{$_('user.popout.*')}`. Add new English strings to the locale file(s) under frontend/src/lib/i18n* (find the en locale) following the existing key pattern (e.g. user.popout.mute, user.popout.deafen, user.popout.settings, user.popout.share_profile). If the i18n setup is too tangled, plain English labels are acceptable — prefer i18n only if it's a simple key add.
- No emojis. No comments unless needed.

VERIFY before finishing:
- cd /var/home/Ronin/wabi/frontend && bun run check — no NEW errors in your touched files (6 pre-existing bun:test errors elsewhere are NOT yours).

Write a short report to audit/worker-c-popout-ux-report.md listing what changed, what store/functions you wired mute/deafen to, what share mechanism you used, and the bun run check result.
