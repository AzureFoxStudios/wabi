# Wabi documentation

Wabi is a self-hosted, privacy-first chat platform (a "Discord alternative") built as **one Rust
binary**: REST API + socket.io live updates + the embedded SvelteKit frontend, all backed by the
in-process event-sourced engine **WabiDB**. Philosophy: *no spying, no bloat, just chill.*

> New here? **Operators** start at [deployment/FRESH_INSTALL.md](deployment/FRESH_INSTALL.md).
> **Contributors** read [architecture/overview.md](architecture/overview.md), then the repo root's
> `AGENTS.md`. **AI agents** read `AGENTS.md` first (it is the canonical orientation) and use the
> skills under `.agents/skills/`.

## The map

### Operating a server
| Doc | What it covers |
|---|---|
| [deployment/FRESH_INSTALL.md](deployment/FRESH_INSTALL.md) | Clean single-machine install (canonical entry) |
| [deployment/TIM_IYOKU_UPDATE_RUNBOOK.md](deployment/TIM_IYOKU_UPDATE_RUNBOOK.md) | Binary-swap update runbook (live hosts) |
| [deployment/HERMES_UPDATE_GUIDE.md](deployment/HERMES_UPDATE_GUIDE.md) | Teaching walkthrough for pushing the tree to hosts |
| [deployment/TURN_SETUP.md](deployment/TURN_SETUP.md) | coturn / calling media setup |
| [deployment/DERP_SELF_HOST_GUIDE.md](deployment/DERP_SELF_HOST_GUIDE.md) | Self-hosting a DERP relay for private access |
| [deployment/SELF-HOST-GUIDE.md](deployment/SELF-HOST-GUIDE.md) · [DEPLOYMENT-SCALING-GUIDE.md](deployment/DEPLOYMENT-SCALING-GUIDE.md) · [IPV6-CGNAT-DESIGN.md](deployment/IPV6-CGNAT-DESIGN.md) · [BUILD-NATIVE.md](deployment/BUILD-NATIVE.md) · [INSTALL.md](deployment/INSTALL.md) | Deeper guides: self-hosting, scaling, CGNAT connectivity, native builds |
| [NETWORKING.md](NETWORKING.md) | The networking model: LAN → private access → domain/HTTPS |
| [PRIVACY_STANCE.md](PRIVACY_STANCE.md) · [SECURITY-MODEL.md](SECURITY-MODEL.md) | Privacy stance; owner/admin security model |

### Building Wabi (contributors)
| Doc | What it covers |
|---|---|
| [architecture/overview.md](architecture/overview.md) | The distilled mental model (start here) |
| [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) | Full system architecture |
| [architecture/PERSISTENCE_MODEL.md](architecture/PERSISTENCE_MODEL.md) · [STORAGE_FORMAT.md](architecture/STORAGE_FORMAT.md) · [STORAGE_MANIFEST.md](architecture/STORAGE_MANIFEST.md) | Event-sourcing, on-disk engine formats |
| [architecture/ADDON_ARCHITECTURE.md](architecture/ADDON_ARCHITECTURE.md) · [ADDONS.md](ADDONS.md) | Addon/plugin system |
| [architecture/CALLING_TRANSPORT_ARCHITECTURE.md](architecture/CALLING_TRANSPORT_ARCHITECTURE.md) | Calling transports (WebRTC / relay / SFU) |
| [architecture/ENGINEERING_STANDARDS.md](architecture/ENGINEERING_STANDARDS.md) | Engineering standards |
| [architecture/SERVER_MESH_PLAN.md](architecture/SERVER_MESH_PLAN.md) · [WABI_MULTI_SERVER_ARCHITECTURE.md](architecture/WABI_MULTI_SERVER_ARCHITECTURE.md) · [policy-system](architecture/POLICY_SYSTEM.md) | Multi-node mesh, multi-server, policy system |
| [local-dev.md](local-dev.md) | Local development setup |
| [addons/](addons/) | Addon docs incl. plugin schema and authoring guide |
| [ai/](ai/) | WabiDB internals written for AI agents (engine, storage, projections, replication) |

### Features
[features/](features/) — media albums, reader mode, call recording, TUI, plugin porting,
**[PRIVATE_ACCESS_GUIDE.md](features/PRIVATE_ACCESS_GUIDE.md)** (family/friend tunnels via tailcat).
[payments/](payments/) — non-custodial payments. [tauri/](tauri/) — desktop builds.

### Working docs
- [plans/](plans/) — dated build plans. **Convention:** domain/projection/ChannelKind changes
  must append to the active plan doc here (repo policy, see `AGENTS.md`).
- [WabiDB write completion](plans/2026-09-05-wabidb-write-completion.md) — durability/application acknowledgments, whole-commit checkpoints, recovery evidence, and remaining guarantee limits.
- [research/](research/) and [proposals/](proposals/) — explorations and designs not yet committed to.
- [audits/](audits/) — recent actionable audits.

## Where did the old docs go?

Nothing was deleted. ~300 historical files (shipped plans, worker reports, STDB-era docs, the
old `docs-history branch: ` tree, the `audit/` dump) live on the **`docs-history`** branch at their
original paths — browse it on GitHub or use *Code → Download ZIP* on that branch for a bundle.
They are also importable into a Wabi wiki via `scripts/import-docs-to-wiki.sh`.

## Maintenance rules

1. New docs join this tree at the right depth — never the repo root, never `docs/` top level
   unless they are genuinely canonical front-door material.
2. Dated work docs go to `plans/` (`YYYY-MM-DD-name.md`); finished work's plan is left in place
   until the next cleanup pass moves it to `docs-history`.
3. The archive (`docs-history` branch) is append-only history — edit living docs, don't edit history.
