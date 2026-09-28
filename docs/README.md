# Wabi Documentation

Wabi is a self-hosted communication and collaborative-workspace app built around an independent **Authority** server, an embedded event-sourced database (**WabiDB**), and web/native clients that can connect to more than one independent Wabi server.

The product is deliberately **not a federated network**: one client may know many servers, but accounts and community state stay inside each server's trust boundary.

## Start here

| You are… | Read this first |
|---|---|
| Evaluating Wabi | [PROJECT_STATUS.md](PROJECT_STATUS.md) |
| Installing a server | [deployment/FRESH_INSTALL.md](deployment/FRESH_INSTALL.md) |
| Exposing a server to users | [NETWORKING.md](NETWORKING.md) |
| Planning backups/upgrades | [deployment/BACKUP_AND_RECOVERY.md](deployment/BACKUP_AND_RECOVERY.md) |
| Reviewing privacy expectations | [PRIVACY_STANCE.md](PRIVACY_STANCE.md) |
| Reviewing auth/admin security | [SECURITY-MODEL.md](SECURITY-MODEL.md) |
| Contributing code | [architecture/overview.md](architecture/overview.md), then `../AGENTS.md` |
| Working on WabiDB | [architecture/PERSISTENCE_MODEL.md](architecture/PERSISTENCE_MODEL.md) and [ai/](ai/) |

**Status vocabulary:** `Available` means integrated with a real runtime path; `Optional` needs explicit configuration/helper software; `Experimental` is not a production guarantee; `Planned` is design/branch work only. See [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Canonical architecture

| Document | Scope |
|---|---|
| [architecture/overview.md](architecture/overview.md) | Distilled contributor mental model |
| [architecture/WABI_ECOSYSTEM_DIRECTION.md](architecture/WABI_ECOSYSTEM_DIRECTION.md) | Optional ecosystem/control-plane direction, proven Tailcat evidence, authorization and privacy guardrails; not a shipped-feature claim |
| [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) | Full system reference; older sections should be read with PROJECT_STATUS when they discuss multi-node work |
| [architecture/PERSISTENCE_MODEL.md](architecture/PERSISTENCE_MODEL.md) | WabiDB persistence/retention model |
| [architecture/STORAGE_FORMAT.md](architecture/STORAGE_FORMAT.md) · [architecture/STORAGE_MANIFEST.md](architecture/STORAGE_MANIFEST.md) | On-disk storage details |
| [architecture/CALLING_TRANSPORT_ARCHITECTURE.md](architecture/CALLING_TRANSPORT_ARCHITECTURE.md) | Calling/media transport design and boundaries |
| [architecture/MEDIA_BACKEND_AND_CERTIFICATION.md](architecture/MEDIA_BACKEND_AND_CERTIFICATION.md) | Provider-neutral media contract, simple-setup invariant, CGNAT Media Node model, version strategy, and certification gates |
| [architecture/SHARED_MEDIA_NODES.md](architecture/SHARED_MEDIA_NODES.md) | Multi-tenant shared Media Nodes, tenant isolation, Media Pools, quotas, pairing, privacy, and CGNAT behavior |
| [architecture/WABI_MULTI_SERVER_ARCHITECTURE.md](architecture/WABI_MULTI_SERVER_ARCHITECTURE.md) | One client, many independent servers — **not federation** |
| [architecture/GEOGRAPHIC_COMMUNITY_WEB.md](architecture/GEOGRAPHIC_COMMUNITY_WEB.md) | Master design for one community across regions: room ownership, recovery, regional delivery and voluntary bandwidth |
| [architecture/INSTANCE_RECOVERY_INVENTORY.md](architecture/INSTANCE_RECOVERY_INVENTORY.md) | State paths and consistency boundary for whole-instance recovery and future standby work |
| [architecture/SERVER_MESH_PLAN.md](architecture/SERVER_MESH_PLAN.md) | Authority/helper/Anchor/replication/standby boundaries; experimental HA work |
| [architecture/ADDON_ARCHITECTURE.md](architecture/ADDON_ARCHITECTURE.md) · [ADDONS.md](ADDONS.md) | Curated integrations and runtime plugins |
| [architecture/ENGINEERING_STANDARDS.md](architecture/ENGINEERING_STANDARDS.md) | Engineering standards |

## Operating a server

| Document | Scope |
|---|---|
| [deployment/FRESH_INSTALL.md](deployment/FRESH_INSTALL.md) | Canonical clean single-Authority install |
| [deployment/BACKUP_AND_RECOVERY.md](deployment/BACKUP_AND_RECOVERY.md) | Conservative backup/restore procedure and HA non-claims |
| [deployment/EXPERIMENTAL_DB_REPLICA.md](deployment/EXPERIMENTAL_DB_REPLICA.md) | Development-only fenced WabiDB receiver setup and limits; not a standby |
| [deployment/LEGACY_UPLOAD_BACKFILL.md](deployment/LEGACY_UPLOAD_BACKFILL.md) | Explicit stopped-Authority migration for older registered uploads before experimental byte catch-up |
| [deployment/REGIONAL_UPLOAD_CACHE.md](deployment/REGIONAL_UPLOAD_CACHE.md) | Opt-in bounded Anchor upload cache, Authority revalidation, and field measurement limits |
| [NETWORKING.md](NETWORKING.md) | LAN, VPN/private access, HTTPS, tunnels, call networking, multi-node boundary |
| [deployment/TURN_SETUP.md](deployment/TURN_SETUP.md) | Optional coturn setup |
| [deployment/DERP_SELF_HOST_GUIDE.md](deployment/DERP_SELF_HOST_GUIDE.md) | Optional private-access relay infrastructure |
| [deployment/BUILD-NATIVE.md](deployment/BUILD-NATIVE.md) | Native build notes |
| [deployment/SELF-HOST-GUIDE.md](deployment/SELF-HOST-GUIDE.md) · [deployment/DEPLOYMENT-SCALING-GUIDE.md](deployment/DEPLOYMENT-SCALING-GUIDE.md) · [deployment/IPV6-CGNAT-DESIGN.md](deployment/IPV6-CGNAT-DESIGN.md) | Deeper deployment material; check PROJECT_STATUS before following old multi-node/mesh advice |

Named-host update runbooks under `deployment/` are operational history for specific environments, not the generic install contract.

## Product and feature docs

- [features/](features/) — feature-specific guides, including private access, media, Reader/call tooling, and other surfaces.
- [Profile designs](features/PROFILE_DESIGNS.md) and [profile artist guide](features/PROFILE_ARTIST_GUIDE.md) — current creator candidate, viewer controls, export templates and showcase gaps.
- [addons/](addons/) — curated integration documentation, including Lore.
- [tauri/](tauri/) — desktop/native client material.
- [payments/](payments/) — payment design/integration docs.
- [design/](design/) and [frontend/](frontend/) — UX/design-system documentation.

The root [README](../README.md) is the public product front door. [PROJECT_STATUS.md](PROJECT_STATUS.md) is the authoritative maturity boundary when a feature exists in code but is still experimental.

## Working documents

- [plans/](plans/) — dated implementation plans and work records.
- [audits/](audits/) — actionable audits.
- [research/](research/) — investigations that may never become product commitments.
- [proposals/](proposals/) — proposed designs, not shipped behavior by default.

Current proposals include [Wabi as an AI organizing center](proposals/multi-computer-ai-workers-and-kanban.md): AI DMs and channels, wiki playbooks and selective retrieval, scoped asset routing, optional Jev-assisted decisions, visible context/memory and run controls, authorized multi-computer agents, shared Kanban, project journals and live progress views. The described AI experience, shared Planner storage and worker execution remain unimplemented.

The [AI workspace implementation handoff](plans/2026-09-27-ai-workspace-first-slice.md) defines the first bounded milestone and the evidence needed before expanding it.

The [shared Project workspace](features/PROJECT_WORKSPACE.md) describes the current worktree's Authority-backed Plan and Wiki contract for people and authorized bots. It is not a deployed feature.

A dated plan may accurately describe what was true on the day it was written and still be stale today. Do not promote a statement from a plan/research/proposal into product documentation without checking current source and PROJECT_STATUS.

## Historical docs

Older documentation and completed/stale plans are kept on the **`docs-history`** branch. The archive is useful for archaeology; it is not a second source of current truth.

## Maintenance rules

1. Keep `README.md`, `PROJECT_STATUS.md`, and the relevant architecture/deployment doc aligned when a feature changes maturity.
2. Put dated implementation work under `plans/YYYY-MM-DD-*.md`; do not use a plan as the permanent operator manual.
3. Mark optional/experimental dependencies honestly. A source file existing is not proof that a feature is release-ready.
4. Never describe independent Wabi servers as federated, WabiDB experimental replication as production HA, or current DMs/private rooms as E2EE.
5. Keep the default single-Authority install boring. Advanced topology should be additive, explicit, and fail closed.
