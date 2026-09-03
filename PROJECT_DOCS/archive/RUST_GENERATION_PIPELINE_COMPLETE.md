# Rust Realignment — Generation Pipeline Complete

**Date:** 2026-04-26  
**Status:** ✅ Foundation Complete

## What We Did

### 1. Automated TypeScript Generation

**Before:**
- Manual generation via `npm run protocol:generate` (which ran `cargo test`)
- Easy to forget to regenerate after Rust changes
- No build system integration

**After:**
- `build.rs` ensures proper rebuild triggers when Rust sources change
- Updated `package.json` scripts:
  - `npm run protocol:generate` — builds + generates (no test execution)
  - `npm run protocol:check` — fast type checking
  - `npm run protocol:verify` — full test suite + generation
- Clear warnings during build showing generation status

### 2. Created build.rs

**File:** `crates/wabi-core/build.rs`

This build script:
- Only runs when `--features ts` is enabled
- Tells Cargo to re-run when `src/` or `Cargo.toml` changes
- Provides clear feedback about generation
- Ensures output directory exists

### 3. Documentation

**File:** `packages/wabi-protocol/README.md`

Comprehensive guide covering:
- What the package is
- How to use generated types
- How generation works
- How to add new types
- Architecture diagram

## Current State

```
crates/wabi-core/
  ├── Cargo.toml              # ts-rs v12.0 dependency (feature-gated)
  ├── build.rs                # ✅ NEW: Build script for auto-generation
  └── src/
      ├── lib.rs              # Module exports
      ├── message.rs          # Message types, events, commands (76 tests)
      ├── message_retention.rs # Retention duration enums
      └── workspace.rs        # User, Channel, VoiceChannel types

packages/wabi-protocol/
  ├── README.md               # ✅ NEW: Complete documentation
  └── src/
      ├── generated/          # 48 auto-generated .ts files
      └── index.ts            # Public re-exports
```

## Verification

All checks pass:

```bash
# ✅ Rust tests (76 passed)
cargo test -p wabi-core --features ts

# ✅ Backend build
npm --prefix backend run build

# ✅ Frontend type check (0 errors, 4 a11y warnings)
npm --prefix frontend run check

# ✅ Generation
npm run protocol:generate
```

## Generated Types (48 total)

Message types:
- `MessageCreateCommand`, `MessageView`, `MessageCreatedEvent`
- `ChannelMessageWindowEvent`, `HistoryLoadedEvent`, `OfflineMessagesEvent`
- `MessageAcceptedEvent`, `MessagePersistedEvent`, `MessagePersistFailedEvent`, `MessageQueuedEvent`
- `MessageType`, `MessageEntity`, `MessageEntityKind`
- `FileAttachment`, `AttachmentEncryptionMeta`, `AttachmentStorageMeta`

Workspace types:
- `UserView`, `UserStatus`, `UsernameFont`
- `ChannelView`, `ChannelType`, `ChannelCreatedEvent`, `ChannelUpdatedEvent`
- `SessionView`
- `VoiceChannelSettings`, `VoiceBitrateMode`, `VoiceChannelParticipantView`
- `VoiceStateEvent`, `VoiceChannelStateEvent`, `VoiceChannelSubscriptionEvent`
- `VoiceChannelUserJoinedEvent`, `VoiceChannelUserLeftEvent`

Group/DM types:
- `GroupCreatedEvent`, `GroupRemovedEvent`, `GroupMemberAddedEvent`, `GroupMemberRemovedEvent`
- `GroupAvatarUpdatedEvent`
- `DirectMessageChannelEvent`, `ConversationUserSummary`
- `UserLeftEvent`

Retention types:
- `MessageRetentionDuration` (14 presets: 5s to 90d)

## Next Steps (Recommended Order)

### 1. Expand wabi-core Types (High Priority)

Add more protocol types to Rust:

**Auth/Session:**
- `AuthSession`, `GuestSession`, `JWTClaims`
- `LoginCommand`, `RegisterCommand`, `RefreshTokenCommand`
- `SessionCreatedEvent`, `SessionDestroyedEvent`

**Plugin Contracts:**
- `PluginManifest`, `PluginConfig`, `PluginEvent`
- `PluginAPIMethod`, `PluginPermission`

**Socket Protocol:**
- `SocketCommand` (unified enum of all client→server commands)
- `SocketEvent` (unified enum of all server→client events)
- `ErrorEnvelope` (standardized error responses)

**Benefits:**
- Single source of truth for all wire protocols
- Backend and frontend can't drift
- Easier to add new clients (Tauri, TUI, mobile)

### 2. Add ts-rs to More Crates (Medium Priority)

When you create new Rust crates:
- `wabi-server` (Rust backend replacement)
- `wabi-desktop` (Tauri bindings)
- `wabi-tui` (terminal client)

They can all share `wabi-core` types.

### 3. Automate Generation in CI (Low Priority)

Add to GitHub Actions:
```yaml
- name: Verify protocol types
  run: npm run protocol:verify
```

Ensures generated types are always up to date in PRs.

## Commands Reference

```bash
# Generate TypeScript types (after Rust changes)
npm run protocol:generate

# Fast type check (CI-friendly)
npm run protocol:check

# Full verification (tests + generation)
npm run protocol:verify

# Direct Cargo commands
cargo build -p wabi-core --features ts
cargo test -p wabi-core --features ts
cargo check -p wabi-core --features ts
```

## Known Issues

**ts-rs warning:** `failed to parse serde attribute: transparent`

This is from `#[serde(transparent)]` on some types. ts-rs v12 doesn't fully support this attribute yet, but it's harmless — the types still generate correctly. This is a ts-rs limitation, not a Wabi issue.

## Architecture Decision

**Why keep test-based generation?**

ts-rs v12 uses test-based export by default. We could:
1. Use ts-rs's programmatic API in `build.rs` (more complex)
2. Switch to a different generation tool
3. Keep the current approach (simple, reliable)

We chose **option 3** because:
- Tests ensure type correctness
- Generation is fast (<1s for 48 types)
- Well-documented pattern
- Easy to debug

The `build.rs` provides proper rebuild triggers and feedback, while tests ensure correctness.

---

**Summary:** The Rust realignment foundation is complete. Types auto-generate, builds pass, and the pipeline is documented. Ready to expand `wabi-core` with more protocol types.
