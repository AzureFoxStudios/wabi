# Wabi Rust Realignment Decision Memo

## Purpose

This memo documents a proposed direction for making Wabi more durable as a tool, not a SaaS product.

The goal is not to rewrite Wabi in Rust for its own sake. The goal is to move the long-lived parts of Wabi into a portable core so the web app, desktop app, terminal client, and server all speak the same Wabi protocol.

## Product Position

Wabi should be treated as a private communication tool in the same broad category as Blender or LibreOffice: user-owned, installable, self-hostable, and useful without a platform account.

Wabi's strongest identity is not "a Discord clone." It is a private community workspace for people who communicate while doing things together:

- chat, voice, screen share, and presence
- whiteboards as a first-class voice/channel workflow
- multi-channel calls inspired by TeamSpeak-style community organization
- albums and lightweight media organization inspired by LINE-style groups
- server lists and account/session memory without heavy federation theory
- desktop and terminal clients that make Wabi feel like a tool, not only a website

## Current Technical Reality

Wabi is already mixed-language:

- `frontend/` is a SvelteKit browser client for the rich UI and browser APIs.
- `backend/` is a Node/TypeScript server with HTTP routes, Socket.IO, persistence, auth, and deployment glue.
- `frontend/src-tauri/` is already Rust for the desktop shell.
- `spacetimedb/wabi_state_bridge/` is already Rust for the SpacetimeDB bridge module.
- Docker Compose is currently the main self-hosting deployment path.

This is a reasonable current stack. The issue is not that JavaScript exists. The issue is that too much Wabi identity currently lives in UI/server glue instead of a stable protocol and domain core.

## Proposed Direction

Wabi should move toward five core packages/apps:

```text
wabi-core
  Rust crate for protocol, domain rules, validation, permissions, codecs,
  import/export, and other pure shared logic.

wabi-server
  Current TypeScript server path, gradually reduced as stable Rust modules
  or services take ownership of specific protocol/domain responsibilities.

wabi-web
  SvelteKit browser client for DOM-heavy UI, WebRTC/browser APIs, rich text,
  media controls, accessibility, and visual interaction.

wabi-desktop
  Tauri app using the web UI plus Rust-native desktop capabilities such as
  tray, notifications, filesystem access, encrypted local cache, update flow,
  and possibly local server hosting.

wabi-cli / wabi-tui
  Rust terminal client and admin tool that talks to the same Wabi protocol.
```

The important architectural rule:

```text
Wabi's identity should live in wabi-core and the Wabi protocol,
not in Svelte components or Socket.IO handlers.
```

## Rust Ownership

Rust should own logic that benefits from portability, correctness, speed, or native distribution:

- message, channel, user, call, album, and permission model validation
- command/event definitions and protocol versioning
- import/export/archive formats
- permission and policy decisions that must match across clients
- codecs and serialization formats
- crypto-adjacent helpers where correctness matters
- search/indexing or compression hotspots if profiling justifies them
- TUI and CLI clients
- Tauri native capabilities
- future single-binary self-hosting runtime

Rust should not own browser-native interaction just to avoid TypeScript.

## TypeScript/Svelte Ownership

Svelte and TypeScript should remain responsible for the browser-facing experience:

- DOM and accessibility behavior
- rich chat composer and text input
- WebRTC, MediaDevices, notifications, clipboard, drag/drop, service workers
- visual layout, whiteboard UI, albums UI, and docked conversation UI
- frontend state orchestration and optimistic interaction
- browser compatibility work

The browser is still a JavaScript-native platform. Wabi should use that reality instead of fighting it.

## Self-Hosting Direction

The long-term hosting target should be closer to:

```bash
wabi serve
```

That command should eventually:

- create or locate the Wabi data directory
- initialize SQLite or the selected local store
- serve the bundled web UI
- start the realtime API
- diagnose LAN/public reachability
- attempt optional UPnP/NAT-PMP/PCP router mapping where safe
- explain CGNAT or blocked inbound ports clearly
- offer direct, LAN-only, tunnel, or relay modes

Docker should remain supported, especially for VPS and homelab users, but it should not be the only understandable path.

## Add-On Direction

Rust realignment should not break Wabi's add-on story. It should make it more stable.

The current plugin system is powerful, but it is tied closely to the Node/Socket.IO backend. Backend plugins can access `ctx.io`, raw runtime maps, socket handlers, HTTP routes, plugin storage, and TypeScript types. That is useful today, but it makes future server/runtime changes harder because plugins depend on implementation details rather than Wabi concepts.

The long-term add-on target should be:

```text
wabi-core
  Defines protocol types, permissions, events, commands, capability tiers,
  and the stable add-on contract.

current TypeScript backend
  Keeps legacy plugins working and implements the Wabi Add-on API facade.

future Rust server / wabi-node
  Implements the same Wabi Add-on API facade without needing to emulate
  Node or Socket.IO internals.

wabi-web / wabi-desktop
  Host UI add-ons through declared extension points.
```

Add-ons should gradually move from raw runtime access:

```text
ctx.io.emit(...)
ctx.channels.get(...)
ctx.channelMessages.set(...)
```

to Wabi-level capabilities:

```text
ctx.events.emit(...)
ctx.channels.list()
ctx.messages.send()
ctx.messages.onCreated(...)
ctx.storage.get()
ctx.ui.registerPanel(...)
```

That means add-ons call Wabi commands and subscribe to Wabi events. `wabi-core` defines the command/event shapes and validates permission boundaries.

Suggested add-on tiers:

- `ui`: Svelte/JS panels, tabs, settings pages, workspace tools.
- `server-js`: current backend JS plugins for bots, routes, payment rails, and automations.
- `wasm`: safe compute add-ons such as parsers, codecs, filters, import/export helpers, and search.
- `native-trusted`: signed, explicit-trust integrations for local desktop/server capabilities.

The migration should preserve existing plugins as `legacy` while adding a versioned Add-on API for future-proof packages.

## Non-Goals

- Do not rewrite the Svelte UI in a Rust web framework just to be "more Rust."
- Do not pause product work until the realignment is complete.
- Do not break the current Docker/Tauri/server paths while extracting core logic.
- Do not break existing add-ons before a stable replacement API exists.
- Do not hide self-hosting complexity to create a paid setup dependency.
- Do not turn Wabi into a SaaS platform.

## Success Criteria

This realignment is working when:

- web, desktop, and TUI clients share the same protocol definitions
- permission/domain rules are tested once and reused across runtimes
- Wabi can add a new client without rewriting business rules
- the current server can coexist with Rust core modules during migration
- add-ons target a stable Wabi API instead of backend internals
- self-hosting becomes simpler and more diagnosable
- Wabi feels more like a durable tool and less like a browser app plus server glue

## Open Questions For Review

- Which domain slice should be the first `wabi-core` extraction: messages, permissions, albums, imports/exports, or call/channel state?
- Should the first Rust deliverable be `wabi-core`, `wabi-tui`, or `wabi serve`?
- How strict should protocol versioning be before Wabi is public?
- Should the long-term server become a Rust binary, or should Rust remain a set of core libraries and selected services?
- What self-hosting path should be considered the default: Docker, native binary, or both equally?
- Which current add-on APIs should remain legacy-only, and which should graduate into Add-on API v1?
