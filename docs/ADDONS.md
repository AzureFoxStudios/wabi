# Wabi Addons and Plugins

**Updated:** 2026-09-14

Wabi has accumulated several extension mechanisms over time. The important distinction is **how trusted and how integrated the code is**, not what folder happens to contain it.

## Three extension levels

### 1. Core product features

Features compiled into `wabi-server` / the normal frontend are part of Wabi's core product and release/testing boundary. Examples include chat, WabiDB, the workspace shell, whiteboards, Reader, and the normal CAD/model viewers.

### 2. Curated integrations / addons

Curated integrations live under `core/addons/`, `addons/`, or related feature packages. They may be compiled Rust crates, bundled/sample packages, or optional bridges to an external tool.

They are **not automatically runtime-installable untrusted plugins**.

Examples:

- **Lore** — optional project/version-control integration; Wabi supplies the workspace/integration, while the backend depends on the external Lore service/tooling.
- **Tailcat private access** — optional transport integration for private reachability.
- **Webhooks/payments/media helpers** — scoped integrations with their own trust/deployment boundaries.
- **Legacy mesh addon** — compatibility/history only. It is **not** the current production multi-node mechanism and should not be enabled as a path to HA.

### 3. Runtime plugins

`plugins/` is the operator-installed runtime plugin surface. The framework supports package manifests and security controls, but plugin mode is still being hardened and is intentionally opt-in.

A backend plugin should currently be treated as **trusted operator-installed code**, not as hostile code that Wabi has proven it can fully sandbox.

## Runtime plugin security controls

The current plugin tooling includes mechanisms such as:

- package checksum verification;
- optional Ed25519 signatures;
- trusted-signer policy;
- optional external malware scanning;
- lifecycle/audit logging;
- namespaced plugin logs;
- safe-mode/crash-loop handling;
- declared permissions/security notes in plugin manifests.

These are valuable supply-chain and operator controls. They are **not the same thing as a complete process/OS sandbox**.

Do not document a declared permission as an enforced isolation guarantee unless the corresponding runtime boundary is actually implemented and tested. In particular, avoid language such as “plugins cannot access the network/filesystem outside their manifest” unless that behavior has a real enforcement mechanism and regression coverage.

## Operator guidance

- Leave plugin mode disabled if you do not need it.
- Read a plugin's source/manifest and threat notes before enabling it.
- Prefer signed/curated packages where possible.
- Keep plugin dependencies pinned and reviewed.
- Treat plugin upgrades like code deployment, not like installing a harmless theme.
- Verify the server still starts with third-party plugins disabled.
- Back up plugin configuration/data that matters before updates.
- Do not give a plugin a Wabi bearer token or broad server secret merely because it is convenient.

## Plugin package shape

A typical runtime package uses a manifest plus backend/frontend entry points:

```text
plugins/
└── example-plugin/
    ├── plugin.json
    ├── backend/
    │   └── index.ts
    └── frontend/
        └── index.ts
```

The authoritative current manifest/tooling examples live in [`../plugins/README.md`](../plugins/README.md) and `docs/architecture/ADDON_ARCHITECTURE.md`.

## Dependencies between addons/plugins

Wabi should make extension dependencies visible rather than failing mysteriously.

If an extension needs another extension/runtime capability, the UI should be able to say, in plain language:

> This addon cannot start because it requires: X, Y, Z.

A manifest may also point to the author's documentation/source page, but dependency resolution must not silently download or execute arbitrary code without operator approval.

## Frontend extensions

UI extension points should follow Wabi's normal design system and workspace/navigation ownership rather than adding random floating buttons or parallel layout stores.

Good extension behavior:

- uses semantic theme tokens;
- fits existing center-stage/dock navigation where appropriate;
- handles narrow/mobile layouts;
- clearly labels external/network actions;
- degrades cleanly when the backend/helper is absent;
- does not misrepresent local drafts as published/shared state.

## Backend extensions

Backend hooks/routes must preserve the same fundamental boundaries as core APIs:

- authenticate callers;
- enforce resource membership/authorization;
- validate input and bound request sizes;
- namespace events/routes;
- avoid logging secrets/private content unnecessarily;
- define persistence/retention behavior;
- survive disable/restart without corrupting core state.

Plugin HTTP routes are mounted under the plugin runtime API namespace described in [`../plugins/README.md`](../plugins/README.md).

## What not to use

### Legacy `mesh` addon

Do not use the old mesh addon to construct multi-node Wabi. The living topology is documented in [`architecture/SERVER_MESH_PLAN.md`](architecture/SERVER_MESH_PLAN.md): one Authority, scoped helpers, an experimental stateless Anchor path, and explicitly experimental WabiDB replication/standby work.

### Runtime plugins as a security sandbox

Do not install arbitrary untrusted backend code on the assumption that manifest permissions contain it. Until isolation is proven at the runtime/OS boundary, enabling a backend plugin is an operator trust decision.

## Creating a plugin

Use [`../plugins/README.md`](../plugins/README.md) for the current package schema, signing commands, HTTP/socket hooks, and test-install workflow.

When adding a new plugin/addon to Wabi itself:

1. document what data it can read/write;
2. document network/external dependencies;
3. request the least privilege actually needed;
4. include disable/uninstall behavior;
5. include failure-path tests;
6. keep core Wabi usable with the extension absent;
7. update [PROJECT_STATUS.md](PROJECT_STATUS.md) only when the integration is truly available, not merely prototyped.
