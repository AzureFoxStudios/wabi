# Visual stabilization — 20 September 2026

Shared control geometry, theme foreground selection, and ownership of feature CSS now prevent unrelated workspaces from changing each other's typography and controls. Settings keeps a stable frame and its declared overlay layer. Narrow DM and Reader layouts respond to available workspace width. Calendar columns remain aligned with long titles. Wiki keeps safe table structure and normal prose whitespace. Media selection/upload status is reactive and viewer/status controls use readable foreground tokens. Addon filters report visible results consistently; Admin read failures remain distinct from empty data.

The secondary workspace retains discrete pull-out stubs: no added closed-panel gutter, complete visible icons, overlay hover peek, click-to-pin, and existing multitasking layout. The peek animation checks hover on its own panel zone so a stationary pointer does not incorrectly retract it.

Verification: headful Chromium with a disposable Authority, 1000/1440px desktop and pinned panels; selected populated scenes also checked at1920px and in Daylight. Frontend tests, typecheck, static build, Planner and call-panel browser workflows, and Wiki sanitization checks run during the pass. Physical/two-device media, external integrations, and native-platform acceptance are separate boundaries.

Publication deliberately excludes unrelated hosting/backend/crash-harness changes and experimental DM encryption work from the working checkout. Main's existing DM and addon capabilities remain authoritative. Remaining follow-ups include literal Forum Markdown rendering, stale DM list previews, and minor secondary Admin typography.
