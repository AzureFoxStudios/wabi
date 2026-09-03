# Rust Core Handoff

## Current Status

Wabi now has a real `wabi-core` Rust crate.

It is intentionally small. This is the first slice of the Rust realignment, not the finished core.

Current files:

```text
Cargo.toml
.cargo/config.toml
crates/wabi-core/
packages/wabi-protocol/
```

Current `wabi-core` owns:

- message retention duration values (`5s`, `24h`, `90d`, etc.)
- message retention label and millisecond conversion helpers
- message type string contract (`text`, `gif`, `file`, `emoji`, `role_gate`)
- channel type string contract (`text`, `voice`, `dm`, `group`, etc.)
- `MessageCreateCommand`, the client-to-server send-message command
- `MessageView`, the server-to-client readable message shape
- `MessageCreatedEvent`, the live server-to-client message event payload
- file attachment metadata used by send-message payloads
- attachment storage/encryption metadata used by uploaded files
- message entity metadata for current place links
- user/public presence status string contract (`active`, `away`, `busy`, `offline`)
- user profile/view shape shared by init, presence, and profile-update flows
- channel view shape shared by init and channel-create flows
- channel settings update payload shared by channel mutation flows
- session view shape for typed init session payloads
- voice channel settings + bitrate mode protocol metadata
- DM/group conversation event payloads and disconnect user-left payloads
- client message ID validation parity with the backend regex
- Serde serialization/deserialization for those protocol strings
- generated TypeScript bindings via `ts-rs`

Current generated TS package:

```text
packages/wabi-protocol/src/generated/MessageRetentionDuration.ts
packages/wabi-protocol/src/generated/MessageType.ts
packages/wabi-protocol/src/generated/ChannelType.ts
packages/wabi-protocol/src/generated/MessageCreateCommand.ts
packages/wabi-protocol/src/generated/MessageCreatedEvent.ts
packages/wabi-protocol/src/generated/MessageView.ts
packages/wabi-protocol/src/generated/FileAttachment.ts
packages/wabi-protocol/src/generated/AttachmentEncryptionMeta.ts
packages/wabi-protocol/src/generated/AttachmentEncryptionScheme.ts
packages/wabi-protocol/src/generated/AttachmentStorageMeta.ts
packages/wabi-protocol/src/generated/AttachmentStorageScheme.ts
packages/wabi-protocol/src/generated/AttachmentStorageCodec.ts
packages/wabi-protocol/src/generated/MessageEntity.ts
packages/wabi-protocol/src/generated/MessageEntityKind.ts
packages/wabi-protocol/src/generated/UsernameFont.ts
packages/wabi-protocol/src/generated/UserStatus.ts
packages/wabi-protocol/src/generated/UserView.ts
packages/wabi-protocol/src/generated/VoiceBitrateMode.ts
packages/wabi-protocol/src/generated/VoiceChannelSettings.ts
packages/wabi-protocol/src/generated/ChannelView.ts
packages/wabi-protocol/src/generated/ChannelCreatedEvent.ts
packages/wabi-protocol/src/generated/ChannelUpdatedEvent.ts
packages/wabi-protocol/src/generated/SessionView.ts
packages/wabi-protocol/src/generated/ConversationUserSummary.ts
packages/wabi-protocol/src/generated/DirectMessageChannelEvent.ts
packages/wabi-protocol/src/generated/GroupCreatedEvent.ts
packages/wabi-protocol/src/generated/GroupRemovedEvent.ts
packages/wabi-protocol/src/generated/GroupMemberAddedEvent.ts
packages/wabi-protocol/src/generated/GroupMemberRemovedEvent.ts
packages/wabi-protocol/src/generated/GroupAvatarUpdatedEvent.ts
packages/wabi-protocol/src/generated/UserLeftEvent.ts
```

Current app integration:

- `shared/messageRetention.ts` now imports its `MessageRetentionDuration` type from generated Rust-owned TypeScript.
- `frontend/src/lib/socket-manager.ts` now types `sendMessage` payloads with generated `MessageCreateCommand`.
- `frontend/src/lib/socket-manager.ts` now types the live `message` event with generated `MessageCreatedEvent`.
- `frontend/src/lib/socket-types.ts` now derives its user-facing `Message`, `User`, `Channel`, and `VoiceChannelSettings` shapes from generated Rust-owned protocol types, while keeping optimistic/frontend-only enrichment local.
- `backend/src/services/messagePipelineHandlers.ts` now uses generated `MessageCreateCommand` for the inbound socket message payload and generated `MessageCreatedEvent` for outbound live messages.
- `backend/src/services/channelMutationHandlers.ts` now types outbound channel settings updates with generated `ChannelUpdatedEvent`.
- `backend/src/services/conversationChannelHandlers.ts` now types DM/group socket payloads with generated conversation event contracts.
- `backend/src/services/disconnectCleanupHandler.ts` now types its `user-left` payload with generated `UserLeftEvent`.
- `backend/src/services/joinInitializationHandler.ts` and `backend/src/services/sessionProfileHandlers.ts` now emit a typed `session` object alongside the legacy `sessionId` init field during the transition.
- `backend/src/state-plane/records.ts` now derives `ClientMessage` from generated `MessageView`.
- `frontend/src/lib/socket-manager.ts` now consumes generated user/channel/session/conversation event shapes for init, presence, DM, and group flows.
- Runtime behavior is otherwise unchanged.

## What This Means

`wabi-core` exists, but it is not yet "all of Wabi core."

Think of it as the seed of the future shared protocol/domain layer. It should grow one stable slice at a time.

Good things to add to `wabi-core`:

- protocol commands and events
- validation rules shared by frontend/backend/desktop/TUI
- stable data shapes used by multiple clients
- import/export/archive formats
- permission/policy decisions once boundaries are clear

Bad things to add to `wabi-core`:

- Svelte components
- DOM/browser APIs
- Socket.IO runtime objects
- database connections
- Tauri window APIs
- Docker/self-hosting scripts
- plugin loader internals

## Verification Commands

From repo root:

```bash
cargo test -p wabi-core
cargo test -p wabi-core --features ts
npm --prefix backend run build
npm --prefix frontend run check
```

Generation command:

```bash
npm run protocol:generate
```

`protocol:generate` currently runs:

```bash
cargo test -p wabi-core --features ts
```

The `ts-rs` export tests write generated TypeScript into:

```text
packages/wabi-protocol/src/generated/
```

## Installed Tooling Notes

Local machine and Tim both have Rust/Cargo available now.

Tim path:

```text
/home/tim/Desktop/Wabi
```

On Tim, use:

```bash
cd /home/tim/Desktop/Wabi
. ~/.cargo/env
cargo test -p wabi-core
cargo test -p wabi-core --features ts
```

## Completed Message Command Slice

Already complete:

```text
MessageCreateCommand
```

Goal:

The frontend and backend now agree on the base outgoing message payload through generated Rust-owned TypeScript types.

Do not try to move the full chat message model yet. That object has many optional fields, persistence states, encryption pass-through fields, attachment variants, UI-only fields, and legacy behavior.

Current command fields:

```text
channelId: string
text: string
type: MessageType
clientMessageId?: string
replyTo?: string
isSpoiler?: boolean
encrypted?: boolean
iv?: string
roleGatePersist?: boolean
gifUrl?: string
emojiUrl?: string
emojiName?: string
fileUrl?: string
fileName?: string
fileSize?: number
files?: FileAttachment[]
attachmentEncryption?: AttachmentEncryption
attachmentStorage?: AttachmentStorage
entities?: MessageEntity[]
```

## Completed Message Read/Event Slice

Already complete:

```text
MessageView
MessageCreatedEvent
```

Goal:

- every client needs to receive and display messages
- the current send command is only half of the chat contract
- the read/event shape will force a clean split between protocol fields, persistence fields, and UI-only frontend state

Current split:

- protocol/read fields that every client should understand
- server persistence still stays in `DbMessage`
- frontend-only optimistic delivery state still stays in `frontend/src/lib/socket-types.ts`
- plugins still consume the legacy-compatible `ClientMessage` surface

## Next Recommended Slice

Move from message send/read types to channel/user/session protocol.

Recommended target:

```text
ChannelView
ChannelCreatedEvent
ChannelUpdatedEvent
UserView
SessionView
```

Current status:

- `ChannelView`, `ChannelCreatedEvent`, `ChannelUpdatedEvent`, `UserView`, and `SessionView` now exist in `wabi-core`
- channel create remains wire-compatible with the existing raw-channel event payload
- init currently emits both `session` and legacy `sessionId` for compatibility while downstream code migrates

Reason:

- TUI and desktop need channels/users/sessions as much as messages
- current channel/user payloads are still mostly handwritten TypeScript
- this will expose which fields are true protocol versus frontend convenience state
- permissions/RBAC needs stable channel/user/session identities before it can move cleanly into core

## Likely Files To Inspect

Backend:

```text
backend/src/services/messagePipelineHandlers.ts
backend/src/state-plane/records.ts
backend/src/services/uploadSupport.ts
```

Frontend:

```text
frontend/src/lib/socket-manager.ts
frontend/src/lib/socket-types.ts
```

Shared:

```text
shared/messageRetention.ts
packages/wabi-protocol/src/index.ts
```

Rust:

```text
crates/wabi-core/src/message.rs
crates/wabi-core/src/lib.rs
```

## Implementation Plan For The Next Contributor

1. Inspect channel/user/session payloads emitted at login and mutation time.
2. Mark which fields are protocol, persistence, UI-only, or legacy.
3. Derive `Serialize`, `Deserialize`, and `TS` behind the existing `ts` feature.
4. Use serde naming that matches current TypeScript payload names.
5. Add Rust tests proving JSON field names and enum strings match current payloads.
6. Run `npm run protocol:generate`.
7. Export generated types from `packages/wabi-protocol/src/index.ts`.
8. Update exactly one frontend/backend type path per slice.
9. Run:

```bash
cargo test -p wabi-core
cargo test -p wabi-core --features ts
npm --prefix backend run build
npm --prefix frontend run check
```

## Guardrails

- Keep runtime behavior unchanged for the first integration pass.
- Do not rewrite Socket.IO handlers yet.
- Do not move add-ons/plugins yet.
- Do not introduce Wasm yet.
- Do not make `wabi-core` depend on frontend/backend/Tauri code.
- Prefer a narrower working slice over a broad partial migration.

## Add-On Note

The Rust realignment changes the future add-on direction, but not immediately.

Current plugins stay legacy-compatible.

Future add-ons should target a stable Wabi Add-on API instead of direct backend internals like `ctx.io` or raw runtime maps. That design is documented in:

```text
PROJECT_DOCS/RUST_REALIGNMENT_DECISION_MEMO.md
PROJECT_DOCS/RUST_REALIGNMENT_MIGRATION_PROPOSAL.md
```
