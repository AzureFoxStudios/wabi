# Login bounce = token revoked (permanent user ban)

## Symptom
User logs in → flash of main UI → immediately back on login. Console may show no SPA store crash. Distinct from `e.subscribe` post-login crash.

## Decisive API probe (do this BEFORE store/sourcemap work)
```bash
TOK=$(curl -s -X POST https://wabi.chat/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"USER","password":"PASS"}' | jq -r .token)
# Expect 200 + token
curl -s -w "\n%{http_code}\n" -H "Authorization: Bearer $TOK" \
  https://wabi.chat/api/user/me
# BAD: 401 {"error":"token revoked",...}
# GOOD: 200 {"userId":1,"username":"wabi","isOwner":true,...}
```
Also note: `/api/auth/me` is NOT a real route (SPA HTML 200). Real path is **`/api/user/me`**.
`/api/channels` may still 200 without AuthUser on some paths — do not use it as proof the token is valid.

## Root cause
On Tim: `data/wabi-server/revocations.json` e.g.
```json
{ "epoch": 0, "jtis": [], "users": [1] }
```
`AppState::is_token_revoked` rejects any JWT whose `sub` is in `users`. Login still mints a JWT; every `AuthUser` extractor fails → client drops session → bounce.

How user landed in `users`:
- `revoke_user(user_id)` used by change-password, admin force-logout, operator owner transfer.
- **Legacy semantics were a permanent set with no unrevoke-on-login** — one force-logout locked the account forever until the file was edited.

## Live fix (no rebuild)
```bash
ssh root@100.96.11.45
REV=/home/tim/Desktop/Wabi/data/wabi-server/revocations.json
cp -a "$REV" "${REV}.bak-$(date +%Y%m%d%H%M%S)"
# set users to []
python3 -c 'import json;p="/home/tim/Desktop/Wabi/data/wabi-server/revocations.json";d=json.load(open(p));d["users"]=[];json.dump(d,open(p,"w"),indent=2)'
cd /home/tim/Desktop/Wabi && docker compose restart wabi-server
# wait healthy, re-run login + /api/user/me → 200
```

## Code hardening (source; ship on next binary)
- `RevocationStore.user_epochs: HashMap<i64,u64>` — per-user iat floor.
- `revoke_user` writes floor = now+1 and **removes** legacy `users` entry (force-logout other sessions without permanent lockout).
- `is_token_revoked` checks global epoch, then `user_epochs`, then legacy `users`, then jtis.
- Successful password login calls `clear_legacy_user_revocation(user_id)`.

Never store real passwords in skills/memory. Probe with creds Ronin supplies in-session only.
