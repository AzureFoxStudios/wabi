# Channel ordering — verification recipe (2026-08-20)

Three backend/frontend gaps broke channel reorder + create UX. All now fixed, but the verification pattern is the durable lesson.

## The bug class: reorder looks correct until reload

A reorder handler can write events successfully while the projection silently drops the fields that matter. The full trace to verify:

```
client payload → Socket.IO handler → durable event names → projection subscription
              → bootstrap query → client normalization → grouping/sort
```

A handler can write events successfully while the projection silently ignores those event names or strips fields.

## What to check

1. **Reorder handler double-patches** — the reorder code ingests BOTH `("channel","update_settings", {row})` (→ AuditProjection, verbatim store) AND `("channel","update", {row: patch})` (→ ChannelProjection merge). Both legs must carry `position` + `parent_id`. If the `("channel","update")` adapter handler strips them before emission, the merge leg never sees them.

2. **Adapter `("channel","update")` payload** — `adapter/mod.rs` ingest_event. Verify `position` and `parent_id` are forwarded alongside `name`/`description`/`force_spoiler`. If missing, reorder silently doesn't persist.

3. **`create_channel` position assignment** — hardcoded `position: 0` means every new channel jumps to the top. Fix: `max(position)+1` within the same `parent_id` scope via `list_channels`, then persist via `update_channel`, return real value.

4. **createdAt is always 0 on the wire** — `row_to_channel_view` reads `created_at`, domain field is `created_at_micros`. Use seq-based ordering, never createdAt, for tie-breaking.

5. **DM recency sort** — Wabi message ids are `msg_{commit_seq}` where seq = engine commit counter (monotonic). Two messages in the same millisecond need a deterministic tie-break; seq gives that for free (Discord `last_message_id` snowflake analogue). Comparator: `pinned → lastTimestamp → lastMsgSeq → name`.

## Verification commands

```bash
# Backend compile
cargo check -p wabi-server

# Frontend typecheck
cd frontend && npm run check

# Channel projection tests
cargo test -p wabidb projections::channels
```
