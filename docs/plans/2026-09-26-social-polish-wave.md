# Social polish wave (2026-09-26)

**Status:** working-tree candidate. No deployment claim.

Wabi should adopt four small, useful ideas from Discord's September update without copying its commerce or identity model. The changes stay scoped to one Authority; the client may render them consistently on desktop and mobile.

## 1. Audio device clarity

Show recognizable microphone, headset, speaker and camera icons beside device choices. Preserve the real device label, selected device, system default, and browser permission fallback. Icons are hints, not proof that a device is available or active. A device picker must remain keyboard and screen-reader usable.

## 2. Group conversation cleanup

Add a reviewed batch-leave flow to Messages for group DMs. Never include one-to-one DMs. Use authoritative activity data before labeling a group inactive; an unloaded local message cache is not proof of inactivity. The current candidate therefore asks users to select groups manually and does not claim an automatic inactivity filter. Show the exact selected groups and count before leaving, call the existing per-group membership operation, and report partial failures without claiming they were removed. Nothing is preselected. The action is server-local.

## 3. Optional name-style pack

Keep baseline names and a plain-name viewer override in core. A bundled, allowlisted cosmetic pack offers a small number of declarative presets; no remote code, arbitrary CSS, or font upload. Validate values on write and read, preserve legacy font settings as a fallback, and cap effects to keep dense chat readable. The server stores a stable preset ID alongside existing font settings; clients missing the pack show a normal name. No shop or monetization dependency.

## 4. Game references in chat

Use the existing Games board as the source. Suggest only explicitly server-shared game selections from the current Authority. The current candidate inserts readable, non-notifying game text and a safe store link for Steam entries. A protocol-level clickable game card is later work; custom games remain plain text. It must not expose private game choices or imply a server-wide broadcast. Handle missing/disabled Games and old clients with readable text fallback.

## Acceptance

- Relevant unit and UI checks pass; existing unrelated failures are reported separately.
- No new durable record layout break or unvalidated message entity kind.
- Desktop and narrow mobile flows are visibly usable with keyboard focus and reduced motion.
- `docs/PROJECT_STATUS.md` and relevant feature docs state the actual maturity and limits.

## Current verification

The static frontend build, addon-enabled release binary build, protocol generation, and 12 focused tests pass. A disposable local run served the embedded HTML page, returned healthy readiness, and kept the admin endpoint behind authentication. The frontend type check still reports four pre-existing missing exports in `NotesView.svelte`; it reports no errors from this wave. Device and narrow-screen visual review remain open before release. No deployment has been performed: the current branch has hundreds of unrelated working-tree changes, so a direct binary swap would ship more than this wave.
