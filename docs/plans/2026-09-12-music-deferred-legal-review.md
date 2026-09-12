# Music add-ons — documented, implementation deferred

Decision: 2026-09-12

Music is intentionally **not** the next implementation lane. Existing OSS music applications are sufficient for now. A weekly quota reset does not automatically reopen this work.

## Retained ideas, not commitments

- local audio inspection: playback, seeking, A/B loop, timestamp/range notes
- collaborative review: stems, revision comparison, annotations bound to a revision
- shared listening: explicit join/leave, queue/control permissions, reconnect/drift behavior
- creation: small sequencer/MIDI sketchpad and deliberately licensed instruments/samples

## Required review before implementation resumes

Record the actual product scope and review, at minimum:

1. rights/content model for recordings, compositions, samples and included demo assets
2. client-local versus server-hosted/shared behavior
3. external provider terms for the exact proposed integration
4. software, codec, soundfont and sample licenses/redistribution duties
5. retention/privacy/listening-history behavior
6. moderation/rights-complaint requirements for any hosted/shared content
7. user-facing wording that does not imply cleared rights or provider endorsement

Reopening requires a dated review packet plus explicit owner approval. This document is a product stop condition, not legal advice and not a conclusion that any particular music workflow is lawful or unlawful.

MMD work must not bypass this deferral by quietly bundling music, samples or unreviewed audio integrations under an animation feature.
