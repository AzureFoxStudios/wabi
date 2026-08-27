# Message identity — "new message eats old" (2026-08-06)

Class-level failure mode for keyed Svelte `{#each}` lists fed by a websocket store.
Symptom Ronin reported: sending message B appears to delete/replace message A.

## Root-cause stack (never just one bug)

1. **Backend id generation** — `WdbAdapter::send_message` built the record with an EMPTY
   `message_id` and let the projection stamp `msg_{commit_seq}` afterward. Any collision or
   non-monotonicity in `commit_seq` → two messages share an id.
2. **Projection overwrite** — `MessagesProjection::apply_created` always did
   `record.message_id = format!("msg_{}", event.commit_seq)` regardless of what the writer
   stamped. Writer intent was discarded.
3. **Frontend merge** — `message` handler did `{...candidate, ...incoming}`: a wire payload
   with `clientMessageId: null` wiped the optimistic row's clientMessageId → the row's key
   flipped mid-flight → Svelte recycled the wrong DOM node.
4. **`channel-messages` hard replace** — full snapshot clobbered in-flight optimistic rows
   on every reconnect/join.
5. **`message-accepted`** — patch could set `id: undefined` when the payload omitted it.
6. **MessageList keys** — keyed on `clientMessageId` first; when a later duplicate-key row
   arrived, the list kept the FIRST (old) row, hiding the new one.

## The fix that shipped (commit 0d8f5ce + b6d30df)

Backend:
- Stamp `msg_<uuid4-simple>` into the record BEFORE commit (adapter); return it to the caller.
- Projection prefers `record.message_id` when present; only falls back to `msg_{seq}` for
  legacy events with an empty id.

Frontend (`socketConnectionCore.ts`):
- `messageRowKey(m)`: server id once accepted (non-`optimistic:`), else clientMessageId.
- `isSameMessageRow`: match on clientMessageId first; same-id match must NOT have conflicting
  clientMessageIds.
- `mergeMessageRow`: spread incoming but preserve `clientMessageId` and `id` when the wire
  value is null/empty.
- `dedupeMessagesKeepOrder`: keep LAST of a key (reconcile wins), preserve order.
- `channel-messages`: merge snapshot with in-flight local rows (deliveryState sending/failed)
  the server doesn't know yet — never a hard replace.
- `message-accepted`: only patch `id`/`timestamp` when present.
- Keep `dedupeByIdKey` for the init channel list — removing it when it still has callers is
  a `ReferenceError` on join (that was b6d30df).

`MessageList.svelte` keyed `{#each}`: `(m.id && !m.id.startsWith('optimistic:') ? m.id : null)
|| m.clientMessageId || ...` and keep-last dedupe in `visibleMessages`.

## Verification probes (no headless browser needed for Wabi)

- Send A then B in a real browser; both must persist across channel rejoin and page reload.
- Console must be free of `each_key_duplicate` and `SUBSCRIBE_FAIL` after login.
- Backend: new ids look like `msg_<32hex>`; legacy rows keep `msg_<seq>`.

## Adjacent gotcha found in the same audit

- `on_join_channel` session-message dedupe (presence.rs) originally kept the FIRST duplicate
  id and dropped messages with EMPTY ids entirely. Fixed to `.rev()` keep-last + pass-through
  on empty id. Any future id-collision dedupe on the server should keep-last, not keep-first.

## Avatar/profile-picture cross-account invisibility (audited same session, unresolved)

Upload → `/api/upload-profile-picture` → `/uploads/<uuid>.<ext>` → client emits
`update-profile` with the relative URL → `presence.rs::on_update_profile` sanitizes
(`/uploads/`, `/api/`, `https://` only) → persists via `update_user` → broadcasts merged
`UserView` via `user-updated` + `profile-updated`. Race fix B6 (94647a6) already merges the
patch into the pre-write snapshot. Client side: `peopleTracker`/`localWabiAccounts` keep the
LAST KNOWN snapshot when the server omits `profilePicture` — correct.

When "other accounts can't see other profile pictures": probe in order —
1. `curl -I https://<host>/uploads/<file>` → expect 200 + `image/*` content-type, NOT 404/HTML.
2. Uploads CSP header (`upload_response_headers`) must allow `img-src 'self' data:` — but
   note it also carries `default-src 'none'; sandbox`, which is fine for direct loads; if
   the browser blocks, check whether the img is loaded cross-origin through CF.
3. Check DB actually has `profile_picture` set: read the user via `/api/users` (admin route)
   or the projection state.
4. Check the WS `user-updated` payload in the observer's browser actually carries
   `profilePicture` (Network → WS frames). If absent, the merge-over-optimistic race regressed.
