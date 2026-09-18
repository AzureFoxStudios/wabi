# Addon Plugin Schema

Canonical schema for `core/addons/*/plugin.json`.

**Status:** Locked for Wave 0 / A1 (2026-08-01), extended for frontend-only bundled addons in September 2026.  
**Next:** A2 exposes server capabilities via `GET /api/addons`. A3 wires frontend capability checks. A5 deletes the dead Node/`.wabip` layer.

---

## Example

```json
{
  "id": "lore",
  "name": "Lore",
  "version": "0.1.0",
  "description": "Version-controlled binary asset storage via Epic Games Lore",
  "backend": {
    "runtime": "rust",
    "path": "backend",
    "crate": "wabi-lore",
    "cargo_feature": "wabi-lore"
  },
  "frontend": {
    "contributions": {
      "channelTypes": [],
      "workspacePanels": [],
      "settingsPages": [],
      "mobileTabs": []
    },
    "bundled": false
  },
  "permissions": [
    "network:outbound",
    "filesystem:read",
    "filesystem:write"
  ]
}
```

A frontend-only addon uses `"backend": null`. This is preferable to inventing a no-op server service merely to satisfy the manifest shape.

---

## Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Stable machine id (kebab-case). Matches directory name when possible. Used in capability checks and routes. |
| `name` | string | yes | Human display name (admin UI, settings). |
| `version` | string | yes | Semver string. |
| `description` | string | yes | One-line summary. |
| `backend` | object \| null | yes | Backend runtime config, or `null` for a genuinely frontend-only addon. |
| `backend.runtime` | string | when backend exists | Currently `"rust"` only. Future: node/python/wasm if ever supported. |
| `backend.path` | string | when backend exists | Path to backend source from addon root (usually `"backend"`). |
| `backend.crate` | string | when backend exists | Cargo package name (`Cargo.toml` `[package].name`). |
| `backend.cargo_feature` | string \| null | when backend exists | Feature flag on `wabi-server`, or `null` if always compiled (e.g. tailcat). |
| `frontend` | object | yes | Frontend integration block (may be empty contributions). |
| `frontend.contributions` | object | yes | Contribution maps; empty arrays are valid. |
| `frontend.contributions.channelTypes` | string[] | yes | Channel types this addon adds (e.g. `"lore"`). |
| `frontend.contributions.workspacePanels` | string[] | yes | Workspace panel IDs. |
| `frontend.contributions.settingsPages` | string[] | yes | Settings page IDs. |
| `frontend.contributions.mobileTabs` | string[] | yes | Mobile tab IDs. |
| `frontend.bundled` | boolean | yes | `true` if a static entry exists in `BUNDLED_ADDON_LOADERS`. Pure backend addons = `false`. |
| `permissions` | string[] | yes | Capability strings the addon requests. |

---

## Rules

1. `id` is stable. Do not rename without a migration note.
2. `backend.cargo_feature` is `null` for always-on backend crates; a string for optional feature-gated crates; the entire `backend` field is `null` for frontend-only addons.
3. `frontend.contributions` arrays may be empty today — schema must still exist so A3/A6 can fill later.
4. `frontend.bundled` is `false` unless a static frontend loader entry is expected.
5. Never remote-`import(manifest.frontendEntry)` — frontend code loads only via static bundled maps (Finding 14).
6. Canonical path is **`core/addons/*/plugin.json` only**.
7. Do not add a fake backend to a client-only addon. Keeping backend authority out of a feature is a valid security boundary.

---

## Canonical addons (A1+)

| id | crate | cargo_feature | permissions |
|----|-------|---------------|-------------|
| `lore` | `wabi-lore` | `wabi-lore` | network:outbound, filesystem:read, filesystem:write |
| `tailcat` | `wabi-tailcat` | `null` (always compiled, runtime-gated) | network:outbound, process:spawn |
| `webhooks` | `wabi-webhooks` | `wabi-webhooks` | network:outbound |
| `translator-assist` | frontend-only | n/a | network:outbound |

`persistence-disk` is an orphaned crate (no `plugin.json`, not a workspace member, not linked into `wabi-server`) — it does not attach to any build. See `ATTACH_DETACH.md`.

---

## Dead parallel layer (A5 — archived 2026-08-01)

Not canonical. Archived under `archive/addons-dead-node-layer/`:

- `packages/*.wabip` / `*.wabi-plugin` (was `addons/packages/`)
- `source/` Node-backend story (was `addons/source/`)
- Any runtime install path that POSTs packages into the server

See `archive/addons-dead-node-layer/README.md`.

---

## Validation

```bash
python3 -c "import json; [json.load(open(f)) for f in [
  'core/addons/lore/plugin.json',
  'core/addons/tailcat/plugin.json',
  'core/addons/webhooks/plugin.json',
  'core/addons/translator-assist/plugin.json'
]]; print('ok')"
```

Required keys on every manifest: `id`, `name`, `version`, `description`, `backend`, `frontend`, `permissions`.

---

## Out of scope for A1

- `GET /api/addons` (A2)
- Frontend `hasAddonCapability` wiring (A3)
- Addons settings UI (A4)
- Deleting Node packages (A5)
- Lore feature-gate UX (A6)

---

## Changelog

- **2026-09-14** — Frontend-only bundled addons may declare `backend: null`; Translator Assist is the first canonical example.
- **2026-08-01** — Schema locked. lore/mesh/webhooks aligned.
