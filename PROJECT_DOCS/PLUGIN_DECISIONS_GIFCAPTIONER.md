# Plugin Decisions - GifCaptioner

## 2026-02-27
### Decision: Ship a text-first caption workflow before media-overlay rendering
- Reason:
  - BetterDiscord parity requires GIF/video decode + re-encode, which is expensive and higher risk.
  - Wabi already has a reliable message text pipeline that can carry caption intent now.
- Consequence:
  - MVP delivers "GIF + caption" communication value quickly, but not baked-in visual overlays yet.

### Decision: Reuse existing `gif` message type and `text` field for caption content
- Reason:
  - Avoid backend schema migration and keep compatibility with existing message persistence/search surfaces.
  - Keeps rollout low-risk while validating real usage.
- Consequence:
  - Caption semantics are implicit for GIF messages; a dedicated caption field remains a future option.

### Decision: Run outgoing chat alias/filter processing on GIF captions
- Reason:
  - Caption text should follow the same safety and normalization rules as text messages.
  - Prevents bypassing outgoing filter policy through GIF send path.
- Consequence:
  - Captions can be blocked or transformed before send, with explicit user feedback.

### Decision: Render caption below GIF using existing markdown pipeline
- Reason:
  - Reuses known rendering and sanitization path with minimal additional code.
  - Maintains consistent typography/formatting behavior with normal messages.
- Consequence:
  - Visual presentation is clean and accessible, but does not mimic in-frame caption style from BetterDiscord.

### Decision: Enforce a hard caption length ceiling (`280` characters)
- Reason:
  - Prevents oversized captions from degrading message layout and keeps GIF captions aligned with compact media intent.
  - Keeps moderation/filter UX predictable by bounding caption payload size pre-send.
- Consequence:
  - Over-limit captions are blocked client-side with an explicit message.

### Decision: Add optional dedicated GIF caption field
- Reason:
  - Some users want GIF caption drafting without repurposing the main composer text.
  - Preserves text-first MVP behavior while reducing ambiguity in picker workflows.
- Consequence:
  - Caption source can be switched per user preference without backend schema changes.

### Decision: Add renderer-side caption style presets instead of overlay media rendering
- Reason:
  - Styling captions in the message renderer delivers richer expressiveness without introducing GIF/video re-encode cost.
  - Keeps caption rendering accessible and reversible with low implementation risk.
- Consequence:
  - Users can choose `plain` / `accent` / `card` caption styles in settings.
  - Overlay/baked-caption parity remains deferred as an advanced mode.

### Decision: Close advanced overlay parity as out of core delivery scope
- Reason:
  - Core product goal (clear GIF context text in one send path) is already met without introducing decode/re-encode infrastructure.
  - Baked-media overlays add high complexity and performance risk for limited incremental value.
- Consequence:
  - GifCaptioner is treated as complete with renderer-side caption styles.
  - Overlay/baked-caption mode will only be revisited as a separate scoped feature request.
