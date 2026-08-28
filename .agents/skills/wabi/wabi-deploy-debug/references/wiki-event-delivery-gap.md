# Wiki Event Delivery Gap

**Status:** known gap — events are emitted but never delivered.

## What exists

The `WdbAdapter` wiki methods emit events into the WabiDB event log:

| Method | Event type | Line |
|--------|-----------|------|
| `create_wiki_page` | `wiki_page_created` | `adapter/mod.rs:1885` |
| `update_wiki_page` | `wiki_page_edited` (overwrite) + `wiki_revision_created` (pre-edit snapshot) | `adapter/mod.rs:1928,1978` |
| `delete_wiki_page` | `wiki_page_deleted` | `adapter/mod.rs:1999` |

The events are persisted (`self.run(...)` with `true` = persisted), but **nothing subscribes to them**. The API routes in `api/wiki.rs` serve the current state on demand; there is no push path.

## What already exists for messages (the reusable pattern)

`bot_delivery.rs` implements the fan-out pattern for `message.created`:

1. Load all webhooks registered on the channel via `wdb.get_webhooks(channel_id)`.
2. Spawn fire-and-forget POSTs to each webhook URL (reqwest, 15s timeout).
3. One retry on transient (5xx / transport) failure; **no retry on 4xx** (permanent).
4. No-op when the channel has zero webhooks (`webhooks.is_empty()` → return).

This is wired from both `api/messages.rs:233` and `api/bots.rs:208` via `spawn_message_created_delivery(wdb, channel_id, payload)`.

The webhook projection itself is real: `wabidb/src/projections/webhooks.rs`, `upsert_webhook` / `get_webhooks` on the adapter. Owner registers a URL on a channel, and message events get POSTed there.

## What is missing for wiki

No equivalent of `spawn_message_created_delivery` exists for wiki events. The events land in the log and then sit there. Consumers that want to know a wiki changed must poll `/api/wiki/{channel_id}/pages` (and revisions for edit diffs), which is the repeated-work pattern the owner explicitly wanted to avoid.

## What a wiki delivery path would reuse

The smallest credible version is a `spawn_wiki_event_delivery(wdb, channel_id, payload)` that:

- Reuses the existing webhook projection + `get_webhooks(channel_id)` lookup.
- Fans out to every webhook URL registered on that wiki channel.
- Carries `event_type`, `channel_id`, `page_id`, `title`, `body` (or pre/post pair for edits), `author`, `timestamp`.
- Is fire-and-forget with the same retry policy as message delivery.

The owner opt-in is already the webhook model: no webhooks registered → no delivery. Nothing opens by default.

## Why this matters for the AI-read box discussion

The "separate box" conversation (see SKILL.md body "AI read access: separate box, not wide-open") converged on push-based wiki updates as the right shape: the wiki pushes deltas to whatever URL the owner registered, the AI-side listener ingests, and there is no polling swarm. The delivery gap is the thing that blocks that shape from working with the existing webhook machinery.
