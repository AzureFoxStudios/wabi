# Wabi Addons

**Last updated:** 2026-07-28

---

## What are addons?

Addons are optional extensions that add functionality to Wabi without modifying core code. Think of them like Blender addons or VS Code extensions — you install what you need, and the core stays lean.

The addon system is separate from the plugin system:
- **Addons** are official/curated extensions shipped in the `addons/` directory
- **Plugins** are third-party extensions installed into `plugins/` at runtime

---

## How addons work

Addons are manifest-based, integrity-signed, and hot-loadable:

1. **Manifest** (`plugin.json`) — declares the addon's ID, dependencies, permissions, backend entry, frontend mount points, and integrity checksums
2. **Backend** — can be Rust (compiled into the server) or TypeScript/JavaScript (loaded at runtime)
3. **Frontend** — Svelte components mounted at specific points in the UI (settings pages, channel toolbars, etc.)

Addons declare the permissions they need (e.g., `user:settings:write`, `payments:intent:create`). The server enforces these at runtime.

---

## Installing an addon

Addons are pre-installed by the server operator:

```bash
# Addons live in the addons/ directory
ls addons/
#  media/  content/  payments/  compliance/  infrastructure/

# To enable an addon, ensure it's present in addons/ and restart the server
docker compose restart wabi-server
```

For third-party plugins, copy the plugin directory to `plugins/` and restart:

```bash
cp -r my-plugin /var/lib/wabi/plugins/
docker compose restart wabi-server
```

---

## Creating an addon

### Manifest schema (`plugin.json`)

```json
{
  "id": "my-addon",
  "version": "1.0.0",
  "dependsOn": [],
  "permissions": ["user:settings:read"],
  "security": {
    "networkAccess": []
  },
  "backend": {
    "language": "typescript",
    "entry": "./backend/index.ts",
    "runtime": "node20"
  },
  "frontend": {
    "entry": "./frontend/MyAddon.svelte",
    "mountPoint": "settings/general"
  },
  "integrity": {
    "algorithm": "sha256",
    "checksum": "<sha256-of-manifest+backend+frontend>"
  }
}
```

### Backend structure

```
my-addon/
├── plugin.json          # Manifest
├── backend/
│   ├── index.ts         # Entry point
│   └── ...              # Additional modules
└── frontend/
    └── MyAddon.svelte   # UI component
```

### Frontend mount points

| Mount point | Location |
|---|---|
| `settings/general` | General settings page |
| `settings/payments` | Payment settings page |
| `channel/toolbar` | Channel toolbar |
| `message/actions` | Message context actions |

---

## Security model

| Concept | Description |
|---------|-------------|
| **Permissions scoping** | Each addon declares a list of required permissions. The server rejects calls outside the declared scope. |
| **Integrity verification** | The manifest includes a SHA-256 checksum covering the manifest + all shipped files. The server verifies this on load. |
| **Signature checking** | Addons can be signed with an Ed25519 keypair. The server can enforce trusted signer policies. |
| **Network access** | Addons declare outbound network access. The server blocks unlisted connections. |
| **Crash loop protection** | If an addon crashes repeatedly, the server enters safe mode and skips it. |

---

## Current addon categories

| Category | Addons | Description |
|----------|--------|-------------|
| **Media** | albums, screen-share enhancements | Extend media sharing and organization |
| **Content** | reader-mode, 3d-viewer, youtube-sync, spotify-sync | Rich content embedding and viewing |
| **Payments** | payments-core (Rust), bitcoin, thailand, psp | Non-custodial payment intent system |
| **Compliance** | server-auditor | Archival, retention, and export |
| **Infrastructure** | webhooks (Rust), mesh | Webhook delivery and multi-server sync |

---

## Deep technical details

For the full addon architecture specification (manifest schema v3, loading lifecycle, permission model, signing protocol, and integration patterns), see:

`docs/architecture/ADDON_ARCHITECTURE.md`

That document is intended for engineers building addons or extending the addon system. This guide is for users and curious newcomers.
