# User schema, owner health, and post-deploy account safety

Use when owners “disappear,” login fails while `setupRequired:false`, or after shipping a binary that touched `UserRecord` / projections.

## Root cause class (2026-07-17 Tim)

Expanding `UserRecord` with trailing fields (`profile_picture`, `username_font`, `bio`, `status_message`) without a dual decode path breaks **postcard** replay of older `user_registered` events:

```
replay: handler error for user_registered seq=N: corrupt users projection: postcard decode failed: Hit the end of buffer
```

Replay logs the error and **continues**. Events are skipped. Live projection loses those users. Owner pointer (`server_meta` / `server_owner.json` / in-memory `owner_user_id`) can remain set → `setupRequired: false` while login for real accounts fails. Feels like “owner got killed.”

**Required decode shape** (`core/crates/wabidb/src/projections/users.rs`):

1. Try current `UserRecord`
2. Fall back to legacy `UserRecordV1` (no profile fields) and map Options to `None`
3. Only then error

Never add trailing non-optional fields to postcard records without a versioned decode path.

## After binary swap — account health probe (safe)

```bash
ssh tim@100.96.11.45 'docker logs --since 2m wabi-server 2>&1 | grep -iE "postcard|user_registered|corrupt|engine already|Server ready"'
curl -fsS http://127.0.0.1:3001/api/setup/status
# login with known owner password → 200 + isOwner
# re-register same username → 400 Username already taken (proves user exists)
```

## NEVER do this on production Tim

Do **not** prove username existence with `POST /api/auth/register` probes. Register creates real accounts (and can reclaim low `commit_seq` user ids after a wiped projection).

Do **not** delete `projections/snapshot.json` casually “to force full rebuild” without a recovery plan — can empty live users if historical events still fail to decode.

Do **not** leave diagnostic probe passwords on owner accounts. Use `POST /api/auth/change-password` (Bearer + current password + new password) once the endpoint is present.

## change-password security (not a steal vector)

- Requires valid Bearer JWT (`AuthUser`)
- Target is **only** JWT `user_id` (no body userId)
- Requires current password bcrypt verify
- Guests blocked
- On success: `revoke_user` for that id

Residual risk: stolen session + online guessing of current password without rate limit. Not “set anyone’s password.”

## Owner files on Tim

- Authoritative engine data: `~/Desktop/Wabi/data/wabi-server/wabidb/`
- Legacy `~/Desktop/Wabi/data/server_owner.json` may still exist (STDB-era path); live app uses `data_dir=/data` → `data/wabi-server` + WDB `server_meta`
- `setupRequired:false` + missing loginable user = projection/schema issue, not “delete owner JSON and re-setup”

## Related

- Deploy lock file: `tim-update-runbook.md` (`rm -f data/wabi-server/wabidb/.lock` on every stop)
- Retention defaults: `wabi-frontend-polish` / product default 24h ephemeral — separate from ops `RUST_LOG` logs
