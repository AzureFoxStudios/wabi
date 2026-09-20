# Wabi Showcase — Common Ground

This branch is a development-only demo, based on main's visual stabilization commit `f088da43`. Do not merge or deploy the showcase additions to the live service.

## Run

From `frontend`:

```sh
bun install --frozen-lockfile
bun run dev:showcase
```

Open `http://127.0.0.1:5196/showcase`. No backend, credentials, microphone, camera, or external assets are needed. The Showcase button opens six scene commands:

- **Reset demo community** restores the morning composition.
- **Morning activity** opens chat with People pinned on wide desktops and a small note beneath it.
- **Busy evening** opens a more active chat with unread indicators and exposed pull-out stubs.
- **Voice event** shows three simulated concurrent listening spaces, including a quieter background call and a muted call.
- **Project workspace** opens the populated field-guide Kanban board.
- **Forum discussion** opens a thread with three replies.

`Ctrl+Shift+S` hides or restores the controls. Scene URLs are bookmarkable, for example `/showcase?scene=project`. A scene change reloads the workspace to retire old view state. At narrow desktop widths the morning scene leaves People closed to preserve reading space; the stubs still open it.

## Capture

With a graphical desktop available:

```sh
bun run showcase:screenshots /absolute/path/to/output
```

The command starts the dedicated local server if necessary, opens headful Chromium with GPU acceleration disabled for repeatable rasterization, captures all six scenes at 1536×960 and 1000×900, and repeats each capture in a fresh browser context. It fails if repeated pixels differ beyond a tightly bounded GPU rounding tolerance (at most 4/255 per channel on 0.05% of pixels), the page overflows, an uncaught browser error occurs, or an external HTTP request is made. The gallery, 12 PNGs, and a JSON manifest include viewport, timezone, browser version, fixture version, hashes, and test results.

Use `SHOWCASE_CDP=http://127.0.0.1:9231` to connect to an existing headful Chromium debugging session (start that browser with `--disable-gpu` as well for strict capture comparisons). Otherwise install the matching Playwright Chromium first if it is not already available. Capture uses `en-US`, `Asia/Bangkok`, device scale 1, and reduced motion. Use the same browser, fonts, and operating system when comparing future pixel baselines; cross-platform font rasterization is not guaranteed identical.

## Isolation and scope

Showcase requires **all three**: a Vite development build, `VITE_WABI_SHOWCASE=1`, and the exact origin `http://127.0.0.1:5196`. A normal or production build cannot activate it, even with the flag. The root layout skips live connection/offline-queue startup on that isolated origin. Client initialization blocks external fetches, live sockets, event streams, beacons, peer connections, and media acquisition. API reads return local fixtures; unsupported operations and writes fail locally. Forum membership acknowledgments are synthetic and do not reach a server.

The clock is fixed to 21 September 2026, 09:42 or 19:42 in Bangkok. Ambient motion is off. IDs, people, messages, forum posts, tasks, project, and the scratchpad content are deterministic. The account is a fictional local fixture, not a live login. Reset overwrites those fixture collections and restores layout; it never clears all browser storage. Use this dedicated origin only for the demo. Other settings and notes that you deliberately add outside the fixture composition are not a whole-profile factory reset.

These are the real product components, not screenshot facsimiles. Chat and local Planner/Notes edits can be explored; reset discards fixture edits. Server operations such as posting a forum reply, installing an addon, or administering a community are intentionally unavailable. Voice participants are simulated, and no real audio/video works in this mode. The gallery describes that explicitly.

## Small supporting fixes

The forum's existing deep-link handoff now waits one Svelte update before selecting the thread. Previously a row could highlight while its reading pane remained empty. Mock message IDs include a sequence so the fixed clock does not produce duplicate IDs. These fixes are on the showcase branch; they have not been silently added to main after the stabilization push.

Known presentation limitation: the existing forum list's reply/view counters are placeholders; fixture replies are accurately shown in the open thread. This demo does not certify all product surfaces or real calling/backend behavior. The strongest public compositions are Morning activity, Project workspace, and Forum discussion at the wide size.
