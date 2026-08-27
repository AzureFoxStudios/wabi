# Wabi + WabiDB Data Dir Reset (for Owner Recovery)

Use when the server returns 500 on auth/user/theme/places or when `server_owner.json` shows stale/missing owner after DB drift, migration, or test data corruption.

## Ports (Critical Distinction)
- **5173**: Frontend only (Vite/SvelteKit dev server started by `bun run dev`).
- **3001**: Backend (`wabi-server` binary).

The frontend code in `src/lib/serverUrl.ts` **always** rewrites backend URLs to `:3001` when it detects the page is served from port 5173 (source: 'dev_vite'). 

This is why "switching" or "swapping" ports is a misconception — the two processes are deliberately separate. Infinite spinning on 5173 after backend changes is usually the client waiting for socket init or user data that the backend cannot provide.

## Exact Procedure (dev machine)

```bash
# 1. Stop only the backend (leave frontend dev server running on 5173)
pkill -f "wabi-server --port 3001" || true
sleep 1

# 2. Backup first (mandatory)
cd /var/home/Ronin/wabi
mkdir -p backups
tar czf backups/wabi-data-pre-reset-$(date +%Y%m%d-%H%M%S).tar.gz data/

# 3. Nuclear reset of durable state (keep uploads + blacklist)
cd data
rm -rf wabidb server_owner.json
rm -f wabidb/.lock 2>/dev/null || true   # stale lock can block restart

# 4. Verify what's left
ls -la   # should now show only blacklist.txt + uploads/

# 5. Restart with required bootstrap key (dev zero-key example)
cd /var/home/Ronin/wabi
WABIDB_ROOT_KEY="0000000000000000000000000000000000000000000000000000000000000000" \
target/debug/wabi-server --port 3001 --data-dir /var/home/Ronin/wabi/data > /tmp/wabi-server-current.log 2>&1 &
```

**Missing the key produces:**
`Error: validation failed for load_bootstrap_key: env var WABIDB_ROOT_KEY not set`

## Frontend / Client Side After Reset
Old persisted auth ("wabi" + token in localStorage) will cause:
- Infinite spinner on 5173 while waiting for Init or user load.
- 401/500 on protected calls.

**Fix:**
- Hard refresh (Ctrl+Shift+R).
- Or clear localStorage for the localhost origin (keys starting with `wabi:`).
- Or open in incognito/private window.
- Then register/login as the first user.

## What Gets Reset
- `data/wabidb/` — all event segments, commit index, projections, snapshots.
- `data/server_owner.json` — the owner marker (`{"owner_user_id": N, "owner_username": "..."}`).

## After Reset
- First user to register/login becomes owner (id usually 1).
- Use the registration endpoint or UI to create the owner.
- Example curl (after server up):
  ```bash
  curl -X POST -H "Content-Type: application/json" \
    -d '{"username":"wabi"}' \
    http://127.0.0.1:3001/api/auth/register
  ```

## Verification
```bash
curl -s -w "\nSTATUS:%{http_code}\n" http://127.0.0.1:3001/api/public/backend-endpoints
curl -s -w "\nSTATUS:%{http_code}\n" http://127.0.0.1:3001/api/places
tail -20 /tmp/wabi-server-current.log
```

Expected after clean start + first register:
- Public endpoints 200
- Data endpoints 404 until seeded
- Server log shows "Server ready"

## Pitfalls
- Do not delete the entire `data/` if you want to keep uploads or blacklist.
- Always set `WABIDB_ROOT_KEY` — the binary will exit immediately without it.
- Stale `.lock` in wabidb/ will prevent startup.
- **Client state is the most common cause of "still spinning after reset"** — backend may be perfect but browser still holds old token.
- 404 on theme/places/plugins is normal on fresh DB; 500s usually mean the server didn't start or a handler assumed existing data.
- Frontend dev server (5173) and backend (3001) are independent processes. Restarting one does not restart the other.

## Related
- wabidb-core-capabilities for on-disk layout.
- wabi-deploy for broader local-dev contract and remote deploy.
