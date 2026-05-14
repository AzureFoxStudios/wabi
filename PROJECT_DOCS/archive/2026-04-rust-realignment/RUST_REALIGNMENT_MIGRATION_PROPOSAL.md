# Rust Realignment Migration Proposal

## Summary

This proposal describes an incremental migration from the current Wabi structure toward a Rust-centered core while keeping the existing Svelte/TypeScript app usable.

The migration should not be a rewrite. The safer plan is to extract stable protocol and domain logic into Rust, expose it to TypeScript where needed, and build new native clients around that shared core.

Current bootstrap status:

- root Rust workspace added for `crates/wabi-core`
- existing Tauri and SpacetimeDB Cargo projects intentionally remain independent
- `wabi-core` currently owns message retention parity helpers, basic message/channel protocol enums, client message ID validation, `MessageCreateCommand`, `MessageView`, `MessageCreatedEvent`, send-message/read-message attachment metadata, and current message entity metadata
- Serde is the canonical Rust serialization layer for protocol types
- `packages/wabi-protocol` has been bootstrapped with generated TypeScript bindings from `ts-rs`
- frontend `sendMessage`, frontend live message receipt, frontend socket message attachment/entity types, backend socket message handling, and backend persisted client-message conversion now consume generated protocol types
- Specta remains reserved for future Tauri command/function typing if needed

## Target Shape

Proposed long-term layout:

```text
crates/
  wabi-core/        Pure Rust domain and protocol crate.
  wabi-wasm/        Wasm bindings for browser and Tauri webview use.
  wabi-node/        Future native self-host server/runtime.

packages/
  wabi-protocol/    Generated TypeScript protocol/types from wabi-core schemas.

apps/
  wabi-web/         SvelteKit browser client.
  wabi-desktop/     Tauri desktop app.
  wabi-tui/         Rust terminal client/admin tool.
  wabi-server/      Current TypeScript server until it is reduced or replaced.
```

The current repo does not need to move all directories at once. Early phases can keep `frontend/`, `backend/`, and `shared/` in place while adding `crates/wabi-core`.

## Phase 0: Stabilize The Current Contract

Before moving code, document and test the current Wabi contract:

- inventory Socket.IO events, HTTP routes, auth/session semantics, and persisted data shapes
- identify which events are public protocol versus internal implementation detail
- write a protocol glossary for commands, events, state patches, and errors
- choose one serialization baseline for cross-client protocol tests
- add snapshot tests around high-value current behavior before extraction

Exit condition:

- a collaborator can point to a documented Wabi protocol surface instead of reverse-engineering frontend/backend glue

## Phase 1: Create `wabi-core`

Add a Rust workspace and create a pure `wabi-core` crate.

Initial ownership should be deliberately narrow:

- shared IDs and primitive domain types
- message/channel/user/album structs where stable enough
- validation helpers
- permission decision functions for one selected workflow
- protocol version constants
- serialization/deserialization tests

Do not include networking, database access, Svelte/Tauri APIs, Docker assumptions, or filesystem paths in `wabi-core`.

Exit condition:

- `cargo test` validates core domain logic without starting Wabi
- one existing backend/frontend behavior can be checked against the Rust model

## Phase 2: Generate Or Export TypeScript Protocol Types

Expose the Rust-owned protocol to TypeScript without forcing the browser to become Rust-native.

Preferred options:

- generate TypeScript definitions from Rust protocol types with `ts-rs`
- maintain the generated `packages/wabi-protocol` package in the repo
- add CI that fails when generated TS protocol output is stale

The TypeScript backend and Svelte frontend should import protocol definitions from this package rather than redefining them ad hoc.

Exit condition:

- at least one frontend/backend event path uses generated/shared protocol definitions
- stale generated protocol output is caught by a check

## Phase 3: Define Add-On API v1

Before deeper runtime changes, define the stable add-on facade that future plugins should target.

Initial Add-on API v1 should:

- add `apiVersion` and `runtime` to plugin manifests
- keep current plugins working as `legacy`
- expose Wabi concepts instead of backend internals: messages, channels, users, events, commands, storage, UI extension points
- define capability tiers such as `ui`, `server-js`, `wasm`, and `native-trusted`
- mark direct `ctx.io`, raw Map mutation, and arbitrary socket access as legacy-only
- route add-on commands through Wabi validation and permission checks

The first implementation can be a TypeScript facade over the current plugin loader. The key is that the facade contract should be defined in protocol/domain terms so a future Rust server can implement it without copying the Node internals.

Exit condition:

- one first-party add-on can run through Add-on API v1 without direct `ctx.io` or raw runtime Map access
- legacy plugin behavior remains available behind the existing loader
- docs explain which APIs are stable versus legacy

## Phase 4: Add `wabi-wasm` For Browser-Useful Core Logic

Create a thin Wasm binding crate only for logic that is useful inside the browser or Tauri webview.

Good first candidates:

- import/export validation
- archive parsing metadata
- permission preview checks
- message/state patch validation
- search/indexing prototype if profiling supports it

Avoid using Wasm for DOM-heavy UI behavior.

Exit condition:

- the web client imports one small Wasm-backed function
- fallback/error behavior is clear when Wasm loading fails
- bundle impact is measured

## Phase 5: Build `wabi-tui` Against The Same Protocol

Build a small Rust TUI/client early because it proves the protocol is real.

Initial scope:

- configure server URL and token
- list joined servers or known profiles
- list channels
- read messages
- send messages
- basic presence/status
- admin health checks if authenticated

Do not start with full voice/video in TUI.

Exit condition:

- a terminal user can join a Wabi server and chat using the same protocol as the web client

## Phase 6: Strengthen Tauri Desktop As A Native Tool

Keep using the Svelte UI, but move desktop-specific powers into Rust/Tauri commands.

Priority capabilities:

- local encrypted cache or draft store
- tray presence and native notifications
- local file helpers and safe filesystem access
- import/export helpers
- optional "host local Wabi node" controls once `wabi-node` exists
- signed installers and repeatable build targets

Exit condition:

- desktop has at least one meaningful native capability beyond being a wrapped web page

## Phase 7: Prototype `wabi-node`

After the core protocol is stable, prototype a Rust native server/runtime.

Initial goal:

```bash
wabi serve
```

Minimum behavior:

- serve bundled web UI
- initialize local data directory
- expose health check and realtime endpoint
- use the same core protocol definitions
- print LAN URL and configuration hints
- preserve Docker deployment compatibility

This does not need to replace the TypeScript server immediately.

Exit condition:

- `wabi serve` can host a minimal Wabi session locally without Docker

## Migration Guardrails

- Keep the current app working throughout the migration.
- Move behavior only when there is a clear test around the old and new behavior.
- Prefer one vertical slice over broad type churn.
- Do not move UI interaction into Rust unless it is truly runtime-independent.
- Do not move add-ons to a new runtime before Add-on API v1 exists.
- Do not let generated bindings become a manual maintenance burden.
- Do not block regular Wabi usability work on this realignment.

## Suggested First Vertical Slice

Recommended first slice: message/channel protocol and validation.

Why:

- central to every client
- useful for web, desktop, TUI, and server
- easier than voice/WebRTC
- exposes whether the generated TypeScript/Wasm path is ergonomic
- low enough risk to validate the architecture before moving security-sensitive logic

Concrete first milestone:

- create `crates/wabi-core`
- define message/channel string contracts, message command structs, and validation rules
- add Rust tests
- generate or mirror TS types in `packages/wabi-protocol`
- update one backend handler and one frontend callsite to use the shared protocol definitions
- leave plugin internals alone until Add-on API v1 is defined

Current status:

- this first milestone now covers message retention, message/channel enums, client message ID validation, `MessageCreateCommand`, `MessageView`, `MessageCreatedEvent`, file attachment metadata, attachment storage/encryption metadata, and message entity metadata
- the next protocol milestone should move to channel/user/session views and events, because permission/RBAC extraction depends on stable identities and channel membership contracts

## Review Questions

- Is message/channel validation the right first vertical slice, or should permissions be first?
- Should `wabi-tui` be built before `wabi-wasm` to force protocol clarity earlier?
- How much repo directory movement is acceptable in the first pass?
- Should `wabi-node` target SQLite first, or mirror the current SpacetimeDB-aware deployment assumptions?
- Which installer targets matter first for desktop distribution: Windows `.exe`, Linux `.deb`/AppImage, or macOS `.dmg`?
- Which first-party add-on is safest to migrate through Add-on API v1 first?
