# Lore / Asset Storage E2E wire

Durable client↔server rules for Wabi Lore (Asset Storage) channels. Validated showcase-prep W1 L1–L6 (2026-08-01). Complements `channel-type-surfaces.md` (wiki/forum/gallery).

## Domain / API

| Concern | Rule |
|--------|------|
| Kind | `ChannelKind::Lore = 11` — append-only; never renumber |
| Wire type | Explicit `channel_kind_to_type` → `"lore"` (not Debug fmt). `asset_storage: true` on ChannelResponse when Lore |
| Create | `"lore"` and/or `asset_storage: true` → `ChannelKind::Lore`; auto-provision lore repo when feature on |
| Nesting | Lore routes nest **inside** `/api/addons` at `/lore/...` so `/addons/{id}` cannot shadow `/addons/lore/...` |
| Capability | `GET /api/addons` lists lore when `--features addons`; FE gates UI on `hasAddonCapability('lore')` |

## Client URL construction

```ts
// Correct
loreUrl(path) => `${getApiBase()}/api/addons/lore${path}`

// Wrong (404)
`${getApiBase()}/addons/lore...`
`${getServerUrl()}/addons/lore...`
```

All fetch helpers and any leftover template URLs in `LoreChannel.svelte` must go through `loreUrl` / `loreFileUrl`.

## Channel id parse (hex)

Server assigns ids as `format!("ch_{:x}", commit_seq)`.

```ts
// Shared: parseLoreChannelId
/^ch_([0-9a-fA-F]+)$/  →  parseInt(match[1], 16)

// Wrong
/^ch_(\d+)/  →  parseInt(..., 10)  // breaks non-decimal hex ids
```

Use one shared parser from `api/lore.ts` in both `loreStore` and `LoreChannel` (no second regex).

## Socket hydrate

Init/upsert payloads may send `type`, `channel_type`, and/or `asset_storage`. Normalize once:

```ts
type = wireType === 'lore' || wireType === 'asset_storage' || assetStorage ? 'lore' : wireType
```

Without this, Chat never hits `currentChannelType === 'lore'` and LoreChannel stays unreachable after reload.

## Protocol ChannelType

Generated `packages/wabi-protocol/src/generated/ChannelType.ts` may lag ts-rs. Append `"lore"` and leave a comment so the next regen does not silently drop it until Rust enum export is updated.

## Sidebar / create UI

- Exclude `type === 'lore'` from text channel filters.
- Own **Asset Storage** section + list component.
- Create option only when `loreAvailable` / `hasAddonCapability('lore')`.
- Create always sends `asset_storage: true` for lore type.

## Auth'd media (in-app previews)

`download_file` requires `AuthUser` / Bearer. Raw `<img>` / `<video>` / `<audio>` / `<iframe>` **cannot** send Authorization → 401.

**L5 pattern (in-app):**
1. `downloadLoreFile(token, channelId, path)` → Blob
2. `URL.createObjectURL(blob)` for preview + grid thumbs
3. Generation counter to drop stale loads
4. `URL.revokeObjectURL` on channel change, deselect, destroy
5. Thumb cache `Record<path, objectURL>` with revoke-all on channel switch

**L7 (separate card):** short-lived signed URL or cookie/session for web download / membership-gated deep links — do not conflate with L5 blobs.

## Tokenize (L6) + notes hook

- Bare hex / rgba / raw `z-index: 2000|2001` in LoreChannel scoped styles → semantic tokens (`--z-lightbox`, `--color-danger`, `--surface-overlay`, `color-mix(...)`).
- Bare-scan after replace: strip `var(...)` and `color-mix(...)`, require zero bare leftovers (see `css-refactor-to-tokens` / scoped bare-scan).
- **Notes integration for L6** = header button → `layoutStore.openNotes()` only. **Not** N1–N4 notes rewrite.

## Verify

```bash
cargo check -p wabi-server --features addons
# optional: cargo test -p wabi-server --lib addons:: --features addons
cd frontend && bun run check   # ignore unchanged pre-existing bun:test errors
rg 'getServerUrl\(\).*/addons/lore|/addons/lore' frontend/src/lib   # should be empty for bare paths
rg 'ch_\\(\\d\\+\\)|parseInt\\(match\\[1\\], 10\\)' frontend/src/lib/api/lore.ts frontend/src/lib/loreStore.ts frontend/src/lib/components/LoreChannel.svelte
```

Final E2E: Ronin real browser (create Asset Storage channel, list files, image preview). Headless Chromium is useless for Wabi paint.
