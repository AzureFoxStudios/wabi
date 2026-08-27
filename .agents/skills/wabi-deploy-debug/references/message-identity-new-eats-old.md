# Message identity — "new eats old" (2026-08-06)

## Symptom

Sending text replaces/deletes the previous message in the list (keyed UI collapse). Also saw `each_key_duplicate` / SUBSCRIBE_FAIL around the same era.

## Root causes (stack, not one bug)

1. **Backend IDs were `msg_{commit_seq}` only** — projection overwrote writer id with seq. Any collision → client keyed `{#each}` + dedupe collapse.
2. **Frontend `message` merge** spread null `clientMessageId` over optimistic rows → key flipped mid-flight.
3. **`channel-messages` hard-replaced** the whole list (wiped in-flight sends).
4. **`message-accepted` could patch `id: undefined`**.
5. **MessageList** preferred cmid / dropped later same-key rows poorly.

## Canonical fix shape

### Backend
- Stamp **UUID** into `MessageRecord.message_id` **before** commit (`msg_{uuid_simple}`).
- Projection: **keep non-empty writer id**; only fill empty with `msg_{seq}_{uuid}`.
- Adapter returns the stamped id (not a post-hoc seq-only string).

### Frontend (`socketConnectionCore.ts`)
- `messageRowKey`: prefer stable **server id** once not `optimistic:*`; else cmid.
- `mergeMessageRow`: never wipe cmid/id with null wire fields.
- `channel-messages`: soft-merge pending local sending/failed rows.
- `message-accepted`: only set `id`/`timestamp` when present.
- **`dedupeByIdKey` must remain** — `init` channel list still calls it. Removing helpers without grepping callers → `ReferenceError: dedupeByIdKey is not defined` on join (breaks send/join loop).

### MessageList
- Key: server id when accepted; cmid while optimistic.
- Dedupe: keep **last** of a key (reconcile wins).

## Presence join history

When collapsing session_msgs by id: keep **last** occurrence; do **not** drop idless messages.

## Verify

1. Send A then B — both remain.
2. Reload channel — both remain with distinct ids (`msg_<uuid>`).
3. Console: no `dedupeByIdKey is not defined`.
4. After deploy: new JS chunk names (not stale SW — see `cf-stale-js-chunk-and-diagnostic-runtime.md`).

## Related

- Audit: `audit/message-eat-old-audit.md` (repo)
- Memory note: UUID message ids end-to-end; preserve clientMessageId on merge
