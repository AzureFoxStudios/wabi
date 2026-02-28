# Plugin Spec - UnicodeEmojis

## Metadata
- Plugin Name: UnicodeEmojis
- Source Link(s):
  - `https://betterdiscord.app/plugin/UnicodeEmojis`
  - `C:\Users\Willp\Documents\GitHub\BetterDiscordPlugins-main\plugins\UnicodeEmojis`
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `2`
- Usage Frequency (1-5): `2`
- Differentiation (1-5): `2`
- Implementation Effort (1-5, higher is harder): `2`
- Runtime Risk (1-5, higher is riskier): `2`
- Weighted Score (0-100): `48`
- Letter Grade (`A/B/C/D/F`): `D`
- Decision: `Build on demand (Addon)`

## Problem Statement
Some users want outgoing emoji text to be native Unicode characters instead of shortcode/image-token rendering, so copied text stays portable across apps and clients.

## Current Wabi Baseline
Wabi sends emoji picker selections as shortcode tokens (`:name:`) and renders matching tokens as inline emoji images, including default/OpenMoji entries.

## Functional Requirements
1. Convert outgoing default/OpenMoji emoji shortcodes to native Unicode when enabled.
2. Keep custom emoji shortcodes unchanged.
3. Provide an Add-ons toggle so users can opt in/out without backend changes.
4. Apply conversion consistently across normal chat send, DM send, and GIF caption text send.

## Non-Functional Requirements
- No backend schema/API changes.
- Conversion must be deterministic and derived from emoji metadata already available in client state.
- Conversion should be safe no-op when shortcode mapping is unknown.
- Keep conversion disabled by default to avoid compatibility surprises.

## Wabi Integration Points
- `frontend/src/lib/unicodeEmojis.ts`
  - local settings store
  - shortcode-to-Unicode conversion helpers
- `frontend/src/lib/components/Chat.svelte`
  - outgoing text send path
  - outgoing GIF caption path
- `frontend/src/lib/components/DMMessageView.svelte`
  - DM outgoing text send path
- `frontend/src/lib/components/Settings.svelte`
  - Add-ons toggle in settings UI
- `frontend/src/lib/markdown.ts`
  - widened shortcode token regex (`+`/`-`) for OpenMoji-style names

## Phase Plan
### Phase 0 - Discovery
- [x] Extract BetterDiscord behavior contract (replace outgoing emoji with Unicode surrogate).
- [x] Map behavior to Wabi emoji metadata model (`default/openmoji/custom` sources).

### Phase 1 - MVP
- [x] Add opt-in setting toggle for Unicode conversion.
- [x] Convert outgoing default/OpenMoji shortcodes to Unicode in chat + DM send paths.
- [x] Apply same conversion to outgoing GIF captions.

### Phase 2 - Harden
- [x] Add optional per-source conversion toggles (`default` vs `openmoji`).
- [x] Add explicit handling/telemetry for shortcode collisions and unknown mappings.
- [x] Expand compatibility validation coverage for mixed custom/default emoji-heavy channels.

### Phase 3 - Polish
- [x] Add richer UX hints in composer when conversion is active.
- [x] Consider import/export of per-user conversion preferences.

## Test Plan
- Automated smoke:
  - `bun run check:unicode-emojis`
  - validates mixed shortcode conversion (`default` + `openmoji` + `custom` + `unknown`) and source-toggle behavior.
- Manual:
  - Enable UnicodeEmojis, send `:smile:` in chat, verify outgoing text contains native Unicode.
  - Send mixed shortcodes (`:smile: :custom_pack_emoji:`) and verify custom shortcode remains unchanged.
  - Send DM message with default shortcode and verify conversion applies.
  - Send GIF with caption containing default shortcode and verify caption converts.
  - Disable UnicodeEmojis and verify baseline shortcode behavior returns.

## Rollback Plan
- Disable via Add-ons toggle (`UnicodeEmojis OFF`) or revert integration in:
  - `unicodeEmojis.ts`
  - `Chat.svelte`
  - `DMMessageView.svelte`
  - `Settings.svelte`

## Open Questions
1. Should conversion stay opt-in forever, or graduate to default-on for specific deployments?
2. Do we need source-specific conversion control (Twemoji default only vs OpenMoji too)?

## Current Implementation Snapshot (2026-02-27)
- Added `unicodeEmojis` add-on module with local persisted setting (`enabled`, default `false`).
- Added shortcode conversion utility that:
  - parses codepoint sequences from Twemoji/OpenMoji metadata (`url`/OpenMoji name fallback)
  - converts only non-custom emojis
  - leaves unknown shortcodes unchanged.
- Wired conversion into outgoing paths:
  - chat send
  - DM send
  - GIF caption send.
- Added Phase 2 hardening:
  - per-source conversion toggles for `default` and `openmoji`.
  - local telemetry counters for:
    - converted shortcode tokens
    - unknown shortcode tokens
    - shortcode collision events
  - settings-side telemetry reset control.
- Added Phase 3 polish:
  - real-time Unicode conversion preview hints in chat/DM/GIF-caption compose flows.
  - settings-side import/export for UnicodeEmojis preferences (with optional local-counter payload transfer).
- Added compatibility smoke coverage:
  - `frontend/scripts/unicode-emoji-compat-smoke.ts`
  - command: `bun run check:unicode-emojis`
  - validates mixed-source conversion behavior, unknown/custom preservation, and collision accounting.
- Updated shortcode parser regex to include `+`/`-` for broader shortcode compatibility.
