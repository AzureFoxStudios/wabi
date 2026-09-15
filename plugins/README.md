# Wabi Runtime Plugins

> **Status:** opt-in runtime extension framework under active hardening.  
> Backend plugins should currently be treated as **trusted operator-installed code**, not as hostile code Wabi has proven it can sandbox.

For the distinction between core features, curated addons/integrations, and runtime plugins, read [`../docs/ADDONS.md`](../docs/ADDONS.md).

## Enablement

`plugins/` is the runtime install directory. Plugin mode is disabled by default in the normal deployment; operators should enable it deliberately only when they need runtime extensions.

Bundled/sample addon material may live under `addons/` or curated integration code under `core/addons/`. Those are not automatically equivalent to a third-party runtime plugin.

## Package shape

```text
plugins/
└── your-plugin-name/
    ├── plugin.json
    ├── backend/
    │   └── index.ts
    └── frontend/
        └── index.ts
```

A plugin manifest describes identity, version, permissions/security notes, integrity/signing metadata, capability tier, and backend/frontend entry points.

Example skeleton:

```json
{
  "id": "your-plugin-name",
  "name": "Your Plugin Name",
  "version": "1.0.0",
  "description": "What the plugin does",
  "author": "Your Name",
  "enabled": true,
  "permissions": ["channels:read"],
  "security": {
    "threatNotes": "Describe data exposure, privilege boundaries, and abuse cases."
  },
  "integrity": {
    "algorithm": "sha256",
    "checksum": "<sha256-package-checksum>",
    "signature": "<optional-signature>"
  },
  "signer": {
    "keyId": "ed25519:<short-fingerprint>",
    "publicKey": "<pem-public-key>",
    "algorithm": "ed25519"
  },
  "distribution": {
    "source": "local"
  },
  "capabilities": {
    "tier": "ui-only"
  },
  "backend": {
    "entry": "./backend/index.ts",
    "socketEvents": ["example:event"]
  },
  "frontend": {
    "entry": "./frontend/index.ts"
  }
}
```

Follow the current schema/types in source when the example and runtime disagree; plugin APIs are still evolving.

## Backend hooks

Runtime plugins can provide lifecycle/event hooks and plugin routes according to the current backend plugin API. Common concepts include:

- `onLoad(ctx)`;
- connection/disconnection hooks;
- message/channel/user hooks;
- namespaced socket handlers;
- plugin-local storage/logging;
- HTTP routes mounted below `/api/plugins/runtime/:pluginId`.

Keep plugin events/routes namespaced and validate/authenticate every entry point. A plugin route is not exempt from Wabi's authorization/security model merely because the server loaded it.

## Security controls

Current tooling includes:

- SHA-256 package integrity validation;
- optional Ed25519 signature verification;
- trusted-signer policy;
- optional command-based malware scanning;
- lifecycle audit events;
- namespaced plugin logs;
- safe-mode/crash-loop handling.

Signing commands from the repository root:

```bash
npm run plugin:keygen -- --out-dir .wabi-keys
npm run plugin:sign -- --plugin plugins/your-plugin-name --private-key .wabi-keys/<key-id>.private.pem
npm run plugin:verify -- --plugin plugins/your-plugin-name --strict
```

Configured signature policy may include modes such as:

- `warn-allow`;
- `signed-only`;
- `curated-only`.

Check current server configuration/source for the exact supported values before deployment.

### What these controls do **not** mean

A valid checksum proves package bytes match an expected digest. A valid signature proves a signing key approved those bytes. Malware scanning can catch known/suspicious patterns. Audit logs help operators investigate changes.

None of those, by themselves, prove that arbitrary plugin backend code is isolated from every server/network/filesystem capability.

Do not write docs or UI that say a permission manifest “blocks all undeclared access” unless the relevant runtime boundary actually enforces that behavior and has regression tests.

## Security review checklist

Every plugin Wabi distributes/recommends should document and test:

- [ ] least-privilege declared permissions;
- [ ] threat notes and abuse cases;
- [ ] integrity/signing metadata for the distributed package;
- [ ] pinned/reviewed dependencies;
- [ ] validation for socket/API inputs;
- [ ] authentication and resource authorization;
- [ ] persistence/retention behavior;
- [ ] network/external-service dependencies;
- [ ] logging that avoids secrets/private content;
- [ ] disable/uninstall/restart behavior;
- [ ] failure behavior when required dependencies are absent.

## Dependency UX

If a plugin requires other extensions/capabilities, fail clearly. The operator should see something like:

> Cannot enable **Example**. Missing dependencies: `X`, `Y`.

Do not silently fetch/execute dependencies from an author's website. A manifest may link documentation/source, but installation remains an operator action.

## UI integration rules

Frontend extensions should use Wabi's existing design/workspace ownership:

- semantic theme tokens;
- existing dock/center-stage navigation where appropriate;
- accessible labels/focus states;
- narrow/mobile layouts;
- real loading/error/empty states;
- explicit external/network actions;
- no duplicate global navigation store just for one plugin.

Wabi's existing AI-generated UI is not sacred. A plugin should integrate coherently rather than imitate old floating-text/button mistakes.

## Installing local/test plugins

For a local plugin, place the complete reviewed package under `plugins/<id>/` and restart/reload according to the current operator flow.

For repository test plugins under `TEST/`, the helper script may be used:

```bash
npm run plugin:install:test
npm run plugin:install:test -- <plugin-name>
```

Do not enable third-party plugin mode on a production server merely to experiment. Use a disposable/test Authority first.

## Legacy mesh warning

The old `mesh` addon is **not** the production multi-node mechanism. Do not port/deploy it as an HA solution.

Current topology and experimental replication/standby boundaries are documented in:

- [`../docs/architecture/SERVER_MESH_PLAN.md`](../docs/architecture/SERVER_MESH_PLAN.md)
- [`../docs/NETWORKING.md`](../docs/NETWORKING.md)
- [`../docs/PROJECT_STATUS.md`](../docs/PROJECT_STATUS.md)

## Design principle

The extension ecosystem should make Wabi more capable without making the core server depend on an app store, one vendor, or unreviewed code. Prefer explicit capabilities, clear dependency errors, and operator control over magical installation.
