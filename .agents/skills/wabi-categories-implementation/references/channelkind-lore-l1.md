# ChannelKind::Lore wire path (L1–L2, 2026-08-01)

## Domain

- Append-only: `ChannelKind::Lore = 11` in `core/crates/wabidb/src/domain/mod.rs`
- Never renumber existing discriminants
- Test: `assert_eq!(ChannelKind::Lore as u8, 11)`

## Server wire (explicit maps — never Debug fmt)

Create (`api/channels.rs`):
- `"lore" | "asset_storage" => ChannelKind::Lore`
- `asset_storage` request or type lore → persist `asset_storage: true`
- Response `channel_type` always `"lore"` for Lore kind

Read/list:
- Prefer explicit `channel_kind_to_type` arms
- Legacy: `Text + asset_storage` may still serialize as `"lore"`

Adapter exhaustiveness: every `match c.channel_kind` needs a `Lore` arm (E0004).

## Protocol / FE

- `packages/wabi-protocol/src/generated/ChannelType.ts` includes `"lore"`
  (prefer Rust ts-rs regen; mid-burn hand-append only with follow-up note)
- Socket hydrate (`socketConnectionCore.normalizeChannel`): map
  `type` | `channel_type` | `asset_storage` → `Channel.type === 'lore'`
- Sidebar: exclude lore from text list; own Asset Storage section
- Chat already routes `currentChannelType === 'lore'` → `<LoreChannel />`

## Next cards (do not mix owners)

- L3: client URLs must hit `/api/addons/lore` (not bare `/addons/lore`)
- L4: `ch_` id parse hex vs decimal alignment
