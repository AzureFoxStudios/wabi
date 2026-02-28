# Plugin Decisions - UnicodeEmojis

## 2026-02-27
### Decision: Keep Unicode conversion opt-in and disabled by default
- Reason:
  - UnicodeEmojis is a low-priority addon with compatibility tradeoffs for existing shortcode workflows.
  - Opt-in avoids surprising users who expect image-style emoji rendering from shortcodes.
- Consequence:
  - Feature is available immediately but requires explicit user enablement.

### Decision: Derive Unicode output from existing emoji metadata instead of static mapping tables
- Reason:
  - Twemoji/OpenMoji sources already include codepoint sequences in URL/name metadata.
  - Avoids maintaining a separate static alias map and reduces drift risk.
- Consequence:
  - Conversion stays lightweight and follows whichever emoji packs are shipped.

### Decision: Convert only non-custom emojis
- Reason:
  - Custom pack emojis do not have guaranteed Unicode equivalents.
  - Preserving custom shortcodes avoids breaking custom emoji semantics.
- Consequence:
  - Mixed messages can contain Unicode for stock emojis and shortcode/image rendering for custom ones.

### Decision: Apply conversion consistently across chat, DM, and GIF caption send paths
- Reason:
  - Behavior should follow user intent ("emoji I send") across message surfaces, not only one composer.
- Consequence:
  - One toggle governs conversion for all outgoing text surfaces currently in scope.

### Decision: Widen shortcode token parser to support `+`/`-` characters
- Reason:
  - OpenMoji-style names and generated shortcodes can include hyphenated codepoint segments.
- Consequence:
  - Broader shortcode compatibility for render/convert paths without impacting custom emoji IDs.

### Decision: Add per-source conversion toggles (`default` and `openmoji`)
- Reason:
  - Users need finer control when one emoji source behaves differently across clients.
  - Supports safer incremental adoption without disabling Unicode conversion entirely.
- Consequence:
  - Conversion behavior is more predictable for mixed emoji catalogs.

### Decision: Track local conversion telemetry for unknown/collision scenarios
- Reason:
  - Hardening requires visibility into missed shortcode mappings and shortcode collisions.
  - Local counters provide immediate debugging signal without backend telemetry endpoints.
- Consequence:
  - Settings can expose/reset these counters to guide compatibility tuning.

### Decision: Add compose-time Unicode preview hints without mutating telemetry
- Reason:
  - Users asked for clearer visibility into what gets converted before send.
  - Preview must not inflate telemetry counters that are intended to reflect sent-message behavior.
- Consequence:
  - Chat/DM/GIF-caption compose flows now show conversion previews from a telemetry-free preview path.

### Decision: Use JSON import/export for per-user UnicodeEmojis preferences
- Reason:
  - Preferences portability is useful for multi-device setups and troubleshooting conversion behavior.
  - A local JSON format avoids backend schema/API coupling for a low-priority addon.
- Consequence:
  - Settings now provide import/export controls for UnicodeEmojis settings, with optional telemetry payload transfer.
