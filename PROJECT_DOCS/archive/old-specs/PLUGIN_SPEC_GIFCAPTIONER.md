# Plugin Spec - GifCaptioner

## Metadata
- Plugin Name: GifCaptioner
- Source Link(s):
  - `https://betterdiscord.app/plugin/GifCaptioner`
  - `C:\Users\Willp\Documents\GitHub\BetterDiscordPlugins-main\plugins\GifCaptioner`
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `3`
- Usage Frequency (1-5): `2`
- Differentiation (1-5): `4`
- Implementation Effort (1-5, higher is harder): `4`
- Runtime Risk (1-5, higher is riskier): `3`
- Weighted Score (0-100): `57`
- Letter Grade (`A/B/C/D/F`): `C`
- Decision: `Build Later (Addon)`

## Problem Statement
Users often want short context text paired with a GIF so the intent is clear without a follow-up message.

## Current Wabi Baseline
Wabi already supports GIF sending via picker and normal message text rendering, but had no explicit "GIF + caption" flow semantics in the picker send path.

## Functional Requirements
1. Allow sending GIFs with a caption in one action from composer + GIF picker flow.
2. Render caption text with the GIF message in timeline UI.
3. Preserve existing composer protections (alias expansion + outgoing chat filter) for caption text before send.

## Non-Functional Requirements
- No backend schema changes for MVP.
- Reuse existing message type (`gif`) and text field semantics.
- Keep UI readable on desktop and mobile.
- Avoid heavy client media re-encode in Phase 1.

## Wabi Integration Points
- `frontend/src/lib/components/Chat.svelte`
  - GIF send path (`handleGifSelect`)
  - outgoing caption normalization (`resolveOutgoingAttachmentCaption`)
- `frontend/src/lib/components/MessageList.svelte`
  - GIF message renderer with caption block
- `frontend/src/lib/gifCaptionerSettings.ts`
  - per-user captioner settings persistence (enabled/dedicated-field/caption-style)
- `frontend/src/lib/components/Settings.svelte`
  - add-on controls for GIF caption behavior and caption style preset

## Phase Plan
### Phase 0 - Discovery
- [x] Extract BetterDiscord behavior contract (captioning/editing GIF media).
- [x] Define Wabi-safe MVP mapping that avoids heavy re-encode pipeline.

### Phase 1 - MVP
- [x] Send GIF with caption text from composer input.
- [x] Apply outgoing alias/filter pipeline to captions before send.
- [x] Render markdown caption under GIF media block when present.

### Phase 2 - Harden
- [x] Add explicit caption length guardrail + user-facing limit hint.
- [x] Add optional dedicated caption field to reduce composer ambiguity.
- [x] Add manual mobile layout pass for long captions.

### Phase 3 - Polish
- [x] Add optional caption styling controls if product wants richer expressiveness.
- [x] Evaluate optional media-overlay renderer parity (caption baked into output GIF/video) as an advanced mode.

## Test Plan
- Manual:
  - Enter text then pick GIF; confirm GIF sends with caption in one message.
  - Confirm reply-to + spoiler state still carry through GIF send path.
  - Confirm chat filter blocks hidden content and prevents send.
  - Confirm markdown formatting in caption renders safely and matches text-message behavior.
  - Confirm empty composer text still sends plain GIF.

## Rollback Plan
- Revert GIF caption handling in `Chat.svelte` and GIF caption rendering block in `MessageList.svelte`; baseline GIF send/view remains intact.

## Open Questions
1. Should GIF captions use a dedicated message field long-term (`caption`) instead of generic `text`?
2. Should Phase 3 include speech-bubble/overlay parity from BetterDiscord plugin, or remain text-first by design?

## Current Implementation Snapshot (2026-02-27)
- Added outgoing caption resolution in GIF send flow:
  - alias expansion + outgoing filter are applied before `sendMessage(..., 'gif')`.
  - blocked/empty-after-filter captions do not send and show explicit alerts.
- Added GIF timeline caption rendering:
  - `message.type === 'gif'` now renders caption markdown block below the GIF when `message.text` exists.
- Added Phase 2 hardening:
  - max GIF caption guardrail (`280` chars) with user-facing composer hint.
  - optional dedicated GIF caption field mode for picker sends.
  - long-caption readability tweaks for narrower/mobile layouts.
- Added Phase 3 polish:
  - optional caption style presets (`plain`, `accent`, `card`) exposed in Add-ons settings.
  - GIF caption renderer now respects per-user caption style preference in timeline UI.
- Advanced-mode evaluation complete:
  - in-media overlay/baked-caption parity remains intentionally out of core scope to avoid expensive decode/re-encode cost.
  - renderer-side style presets are the supported production path.
- No backend/API changes required for this slice.
