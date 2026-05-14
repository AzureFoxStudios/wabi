# @wabi/protocol

Generated TypeScript protocol types from `wabi-core` Rust crate.

## What This Is

This package exports TypeScript types that are **automatically generated** from the Rust types in `crates/wabi-core/`. These types define the wire protocol for Wabi's client-server communication.

## Usage

```typescript
// Import generated types
import type { MessageCreateCommand, MessageView, ChannelType } from '@wabi/protocol';

// Use in your code
const message: MessageCreateCommand = {
  channelId: 'general',
  text: 'Hello!',
  type: 'text',
};
```

## Generation

Types are generated automatically when you run:

```bash
# Generate TypeScript types from Rust
npm run protocol:generate

# Or directly with Cargo
cargo build -p wabi-core --features ts
cargo test -p wabi-core --features ts
```

The generation uses [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs) to convert Rust types with `#[derive(TS)]` into TypeScript declaration files.

## Generated Files

All generated types live in `src/generated/`. Do **not** edit these files manually - they will be overwritten on every generation.

To add or modify types:
1. Edit the Rust types in `crates/wabi-core/src/*.rs`
2. Add `#[cfg_attr(feature = "ts", derive(TS))]` and `#[cfg_attr(feature = "ts", ts(export))]` to the type
3. Run `npm run protocol:generate`

## Architecture

```
crates/wabi-core/          # Rust source of truth
  └── src/
      ├── message.rs       # Message types, events, commands
      ├── workspace.rs     # User, Channel, VoiceChannel types
      └── message_retention.rs  # Retention duration enums

packages/wabi-protocol/    # Generated TypeScript
  └── src/
      ├── generated/       # Auto-generated .ts files (DO NOT EDIT)
      └── index.ts         # Public re-exports
```

## Adding New Types

1. In `crates/wabi-core/src/*.rs`:

```rust
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MyNewType {
    pub field: String,
}
```

2. Run generation:

```bash
npm run protocol:generate
```

3. Import in TypeScript:

```typescript
import type { MyNewType } from '@wabi/protocol';
```

## Version Compatibility

The generated types match the Rust types exactly. When updating `wabi-core`, always regenerate:

```bash
npm run protocol:verify
```

This runs the full test suite and ensures type parity.
