# Channel history blank until leave+re-enter (2026-08-24, post-deploy)

Symptom: after a binary swap, opening a channel shows no messages; leaving and
re-entering the channel makes them appear. Server logs clean; `/health` green.
User phrasing: "loading of messages is sort of bugged, I have to leave channel
then go back."

## Root cause shape — `on_join_channel` either/or branch

Location: `core/crates/wabi-server/src/socketio/presence.rs::on_join_channel`.

- Session cache (`session_messages`) non-empty → serve in-memory messages
  (old path, always works).
- Session cache empty (**always true right after a deploy restart**) → fall
  back to WDB history via `list_messages_typed(channel_id, 50)` — the NEW
  bounded tail-query path. If that path returns empty/stale on first join,
  the user's first look at any channel is blank; by their re-enter, live
  traffic has populated the session cache so the OLD path serves fine.

This is why the bug "sort of fixes itself": the fallback branch is only
exercised while the cache is cold, i.e. exactly in the post-deploy window.

## Diagnosis sequence (worked headless)

1. Confirm deployed SHA ≠ your build (`ssh host sha256sum <bind-mount binary>`)
   then `git log` between your SHA and live to identify WHICH wave regressed.
   Peer deploys superseded the theme deploy within hours — the regression rode
   in with their wave (presence bridge + admin stats + calling fixes), not the
   theme work.
2. `docker logs wabi-server 2>&1 | grep -c "engine already running"` counts are
   cumulative across ALL restarts ever — NOT proof of an active restart loop.
   Check `docker inspect --format '{{.RestartCount}}'` instead (healthy = 0).
3. Unauthenticated socket probe gets `join-error "authentication required"` —
   expected, not a bug. To probe authenticated you need a guest token, but
   `POST /api/auth/guest` is rate-limited fast from one IP (403 after ~4
   attempts, long cooldown) — don't burn attempts; read the handler code
   instead. Code-reading found the suspect faster than another live probe.
4. Read the join handler for cache-vs-fallback branches before touching
   frontend stores — the frontend merge logic was fine here.

## Fix direction (proposed, not yet landed)

Make `on_join_channel` always serve WDB history overlaid with the live session
buffer (dedupe by message id), never either/or. Keeps the O(limit) perf win of
the tail query, kills the fragile cache-cold branch.

## Related shipped perf rewrite to watch

`list_messages_tail` + `messages_by_channel_time` secondary index
(commit `ab7e8224`, peer wave):
- Reverse prefix walk with early-exit; O(limit) records visited instead of
  decode-all + sort.
- Edit/delete duplicates collapsed via seen-ids walking backwards
  (first-seen = latest state).
- SEMANTIC CHANGE: channel-scoped query with limit now returns the NEWEST
  window, not oldest-N.

Any future "history looks wrong/short" report: diff the tail-query semantics
and its index rebuild behavior first before suspecting the client merge.
