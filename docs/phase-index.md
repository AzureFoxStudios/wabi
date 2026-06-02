# Wabi Phase Index

This file exists because several Wabi workstreams use numbered phases. A bare phrase like "Phase 6" is ambiguous unless the workstream is named.

## Active phase namespaces

| Namespace | Canonical doc | Scope | Current meaning of Phase 6/7 |
|---|---|---|---|
| **Helper-node scaling phases** | `docs/futuresight-multi-anchor-helper-nodes.md` | Node registry, helpers, jobs, cache, media, LAN, standby, anchors | Phase 6 = privacy-first warm standby / backup node. Phase 7 = regional anchors. |
| **Calling/media transport phases** | `docs/calling-transport-plan.md` if present; otherwise code in `frontend/src/lib/calling*.ts` | STDB calling, LiveKit/SFU, store-and-forward voice, desktop-native audio | Past conversation used "Phase 6" loosely for LiveKit SFU helper wiring. That is NOT helper-node Phase 6. In the helper-node doc it maps to Phase 4: Media Node / Voice Offload. |
| **Frontend fracture phases** | `frontend/src/lib/components/FRACTURE_PLAN.md` | Breaking large Svelte components into smaller modules | Separate phase system. Do not interpret these as backend scaling phases. |
| **CSS/theme phases** | `PROJECT_DOCS/CSS_AUDIT_REWRITE_PLAN.md`, `OPENCODE_CSS_FINISH.md` | CSS tokenization and component style cleanup | Separate phase system. |
| **Relay/file-transfer phases** | `relay-node/README.md`, `PARALLEL_TRANSFERS_PROPOSAL.md` | Relay network, file transfer, media gateway | Separate phase system. |

## Rule going forward

Use a namespace in task titles and commits:

- `helper-phase-6: encrypted standby snapshots`
- `helper-phase-7: stateless regional anchor`
- `calling-phase-livekit: helper SFU wiring`
- `fracture: MessageList extraction`

Do not say only "Phase 6" in docs, commits, or handoffs.

## Current helper-node scaling status

| Helper phase | Name | Status | Notes |
|---|---|---|---|
| 1 | Real Node Registry | Implemented | Pairing, heartbeat, revocation, JSON persistence. |
| 2 | Job Offload | Implemented | Pull/claim/report/retry job queue. |
| 3 | Blob Cache/File Offload | Implemented | Hash-addressed blobs. |
| 4 | Media Node / Voice Offload | Implemented baseline | LiveKit helper spawn path + storefwd fallback exist. Runtime verification still needed. |
| 5 | LAN Acceleration | Implemented baseline | LAN route token/mDNS helper surface. Runtime verification still needed. |
| 6 | Warm Standby / Backup Node | Implemented baseline | Encrypted live-state snapshot export/receive/status exists. Import/promote are guarded manual stubs. Real standby restore drill still needed. |
| 7 | Regional Anchors | Implemented baseline | Stateless authority proxy mode exists. Real authority+anchor process smoke test still needed. |

## Privacy rule for helper phases 6/7

Helper Phase 6 and 7 must not introduce hidden durable surveillance:

- No append-only message/event log for standby.
- No raw STDB data-dir copy unless proven deletion-safe.
- Snapshot export must represent current live state after retention/deletion.
- Full backup/standby nodes are high-trust and opt-in.
- Anchors are stateless/proxy-first; any read cache is later, scoped, TTL-bound, and opt-in.
