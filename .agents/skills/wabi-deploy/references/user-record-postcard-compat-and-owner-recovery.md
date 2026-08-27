# UserRecord postcard break + owner "killed" after deploy

## Symptom (Tim 2026-07-17 / 2026-07-19)

After a normal WabiDB binary swap + restart:

- `GET /api/setup/status` → `{"setupRequired":false}`
- `server_meta` / owner pointer still `owner_user_id: 1` (often username `wabi`)
- Login for real accounts fails (401) or feels like "owner got killed"
- `docker logs wabi-server` contains (ONLY in the postcard-schema variant):

```
ERROR wabidb::engine::replay: replay: handler error for user_registered seq=N:
corrupt users projection: postcard decode failed: Hit the end of buffer, expected more data
```

(often a range, e.g. seq 15–42)

NOTE (2026-07-19): the symptom also occurs with **no** postcard error in the
logs — see "Verified mechanism" below. A clean replay log + 401 login means the
event is missing from the commit log entirely, not a decode failure.

## Root cause

`wabidb::projections::users::UserRecord` is **postcard**-encoded into the event log.

Postcard is **not** forward-compatible when new trailing fields are required. Adding:

- `profile_picture: Option<String>`
- `username_font: Option<String>`
- `bio: Option<String>`
- `status_message: Option<String>`

made the **new** decoder reject **old** `user_registered` payloads (shorter layout). Replay logs the error and **skips** the event. Accounts vanish from the live `users` projection while:

- owner pointer in `server_meta` / legacy `server_owner.json` can still say "owner exists"
- `needs_setup()` stays false because it only checks `owner_user_id.is_none()`

So the server looks claimed, but username/password lookup has nothing (or only a partial set).

### Verified mechanism (Tim 2026-07-19 — the deeper "owner killed")

The dual-decode fix (try `UserRecord`, then `UserRecordV1`) only helps when the
`user_registered` event is **present in the replayable commit log**. On Tim the
real owner (`wabi`, `user_id 1`, correct `Please1` bcrypt hash) was found **only
in `projections/snapshot.json`** — its original `user_registered` event is
**absent from the commit log** (written out-of-band during the 2026-07-17
recovery, never as a durable event). The server loads the live `users_by_name`
index by **replaying the commit log only** (it does NOT seed from the snapshot
on boot). Therefore **every container restart drops the owner** from the index,
and `GET /api/auth/login` returns 401 (`get_user_by_username` → `None`) even
though the snapshot is intact.

Confirm with an offline decode (no production mutation):

```bash
scp tim@100.96.11.45:~/Desktop/Wabi/data/wabi-server/wabidb/projections/snapshot.json /tmp/snap.json
python3 - <<'PY'
import json, binascii
d=json.load(open('/tmp/snap.json'))
for name,data in d['indexes']:
    if name=='users':
        for rec in data:
            if isinstance(rec,dict) and rec.get('key')=='0000000000000001':
                b=binascii.unhexlify(rec['value'])
                i=0; shift=0; uid=0
                while True:
                    c=b[i]; i+=1; uid|=(c&0x7f)<<shift
                    if not c&0x80: break
                    shift+=7
                def rd(b,i):
                    n=0; s=0
                    while True:
                        c=b[i]; i+=1; n|=(c&0x7f)<<s
                        if not c&0x7f: break
                        s+=7
                    return b[i:i+n].decode(), i+n
                uname,i=rd(b,i); ht=b[i]; i+=1
                if ht==1: _,i=rd(b,i)
                color,i=rd(b,i); phash,i=rd(b,i)
                print("OWNER id",uid,"username",uname,"hash",phash[:20])
                import bcrypt
                print("Please1 matches:", bcrypt.checkpw(b"Please1", phash.encode()))
PY
```

If this prints the owner with a matching password but login 401s → the event is
missing from the log (this scenario), not a wrong password and not a schema issue.

## Code fix (required in tree)

`core/crates/wabidb/src/projections/users.rs` — `decode_record` must try current schema, then **legacy V1** (no profile fields):

```rust
// Prefer UserRecord, then UserRecordV1 → map Options to None
```

Unit test: `decode_legacy_v1_user_record`. **Never** ship a UserRecord field add without a dual-decode path or a real migration.

User IDs: on `user_registered`, projection sets `user_id = event.commit_seq` (matches adapter `create_user` return).

## Post-deploy checks (accounts)

After every Tim restart / binary swap:

```bash
ssh tim@100.96.11.45 'docker logs --since 2m wabi-server 2>&1 | grep -iE "postcard|user_registered|corrupt|replayed|engine already"'
# expect: no postcard/user_registered corrupt errors

# Owner pointer vs setup
curl -sS http://127.0.0.1:3001/api/setup/status
# on Tim host files (compose data dir):
#   ~/Desktop/Wabi/data/wabi-server/  → container /data
#   engine store: /data/wabidb/
#   legacy STDB-era owner file may still exist at ~/Desktop/Wabi/data/server_owner.json
#   AppState load_owner uses WDB first, then <data_dir>/server_owner.json (= /data/server_owner.json)
```

If setup is false but nobody can log in → treat as projection/user decode issue, **not** "rerun first-user wizard" and **not** "register a new owner" until you understand the event log.

## Diagnostic rules (do not make it worse)

**FORBIDDEN on production without explicit user consent:**

1. `POST /api/auth/register` "is this username free?" probes — creates real accounts and can reassign/overwrite owner if projection is empty and first register claims ownership. **Confirmed incident 2026-07-19:** a `register wabi` probe created a NEW `wabi` with `user_id 2` and a probe password, because the live index had no `wabi`; this duplicates the owner and orphans id-1's channels/messages. Do NOT do this.
2. Deleting `projections/snapshot.json` casually "to force rebuild" without a confirmed decoder fix **and** a recovery plan.
3. Leaving probe passwords on live owner accounts.

**Allowed diagnostics:**

- `docker logs` for postcard / replay errors
- `setup/status` + owner file / server_meta inspection
- Wrong-password login only (same 401 for missing vs wrong — weak signal)
- **Offline decode of `snapshot.json`** (the python recipe above) — proves the owner record + password without any production mutation
- Offline inspection of `data/wabi-server/wabidb/streams/other/users/events/*.wseg`

## Restart / lock (related)

Binary swap must:

```bash
docker compose stop wabi-server
rm -f data/wabi-server/.lock
# replace binary
docker compose up -d wabi-server
```

Stale `.lock` → crash-loop `Error: engine already running` even when previous process exited cleanly.
(Verified 2026-07-19: the live lock is `data/wabi-server/.lock`, NOT
`data/wabi-server/wabidb/.lock`. There is no `wabidb/` subdir lock in the
current tree. See SKILL.md pitfall 6.)

## Recovery shape

### Recovery recipe — owner missing from commit log (verified 2026-07-19)

Goal: get `wabi` (user_id 1, the snapshot's password_hash) back into the live
`users_by_name` index **durably**, so it survives restarts. The snapshot already
holds the correct record; the gap is only that the event isn't in the replay log.

1. **Do NOT probe with `POST /api/auth/register`** (creates a junk/duplicate
   account — confirmed 2026-07-19: probing `register wabi` created a NEW
   `wabi` with `user_id 2` and a probe password, because the live index had no
   `wabi`; this duplicates the owner and orphans id-1's channels/messages).
2. Re-emit the owner's `user_registered` event for `user_id 1` into the commit
   log with the **verified** snapshot password_hash + handle/color. The exact
   mechanism depends on a server-side path; prefer, in order:
   - an operator break-glass / owner-seed endpoint (loopback + `WABI_OPERATOR_SECRET`), or
   - a one-shot Rust tool that opens the WabiDB and appends a `user_registered`
     event (id 1, the snapshot's postcard `UserRecord` bytes) to the commit log,
     then the next restart replays it and repopulates the index.
3. If a duplicate owner (e.g. id 2 from a probe) exists in the log, decide:
   - **Safe:** leave it orphaned (harmless unused account), only re-emit id 1.
   - **Clean:** trim the id-2 `user_registered` event from the log (delicate —
     verify the log format/seq first; confirm the server replays cleanly after).
4. Restart with lock clear (`rm -f data/wabi-server/.lock`). Verify
   `POST /api/auth/login {wabi, Please1}` → 200 + token, and that the owner's
   channels/messages are owned by user_id 1.

The permanent fix for recurrence: once id-1's `user_registered` is durably in the
log, future restarts keep the owner. Diagnose the source of the original
out-of-band creation so it does not recur on the next binary swap.

If the postcard-schema variant (replay errors in logs) is the cause instead:
ship the dual-decode binary first, restart with lock clear, verify no postcard
errors. Historical events may still be on disk under
`streams/other/users/events/`; recover offline or rebuild projections with the
fixed decoder. Snapshot watermark skips already-applied seqs; full rebuild needs
intentional snapshot handling — do not invent register probes.

Re-establish owner password via user-chosen path (login + change, operator
break-glass, or controlled one-shot). Never leave diagnostic probe passwords.

## Post-deploy auth smoke (minimal, no junk accounts)

After every binary swap — **do not** stop at `/health`:

```bash
curl -sS http://127.0.0.1:3001/api/setup/status
# Owner lookup must resolve; do NOT use register to test "is this username free?"
# Correct signal: login with the real password → 200, wrong password → 401.
# A 401 from a KNOWN-good credential means the user is missing from the live
# index (owner-killed), NOT a wrong password. Use the offline snapshot decode
# above to confirm the credential before concluding.
curl -sS -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"wabi","password":"wrong-password-xxxx"}'
docker logs --since 2m wabi-server 2>&1 | grep -iE 'postcard|user_registered|corrupt|engine already'
```

**Incident note (2026-07-19):** a `register wabi` probe created a duplicate
`wabi` (id 2) on Tim during diagnosis. Treat `register` probes on production as
FORBIDDEN (SKILL.md pitfall 19). Recover via the recipe above; do not leave the
probe credential live.

## change-password (threat model)

`POST /api/auth/change-password` (Bearer + body `currentPassword`/`newPassword`):

- Updates **only** JWT `auth.user_id` — no target user id in body
- Requires bcrypt of **current** password; guests rejected
- `revoke_user` after success
- **Not** unauthenticated reset / not steal-any-account
- Residual: stolen JWT + online guessing of current password if no rate limit
- Wabi bar = basic door/lock (no email binding). Session/Signal are a different product class — do not oversell

Projection must apply non-empty `password_hash` on `user_updated` or change-password appears to succeed but login still uses old hash.

## Paths on Tim

| What | Host path |
|------|-----------|
| Compose project | `~/Desktop/Wabi` |
| Container data | `./data/wabi-server` → `/data` |
| WabiDB engine root | `/data/wabidb` (= `data/wabi-server/wabidb`) |
| Streams | `.../wabidb/streams/` |
| Snapshot | `.../wabidb/projections/snapshot.json` |
| Lock | `data/wabi-server/.lock` (NOT `data/wabi-server/wabidb/.lock`) |
| Bind-mounted binary | `target/release/wabi-server` → `/wabi-server` |

## Related

- `references/tim-update-runbook.md` — ship sequence + lock clear
- `references/pre-deploy-live-stack-audit.md` — audit before swap
- `references/user-schema-and-account-safety.md` — condensed checklist
- `references/chat-retention-default-ephemeral.md` — chat TTL default 24h (separate from auth/schema)
