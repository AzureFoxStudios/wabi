# Lore Runtime: Permission + Create-Repo URL Fixes (2026-08-09)

## Symptom 1 — Lore CLI Permission denied inside container

**Log evidence:**
```
WARN ... Lore command failed: [Error] loading global config: Permission denied (os error 13)
```

**Why it happens:** The Lore CLI runs as uid 1000 (`wabi`) inside the container. If `HOME` resolves to a path the container user can’t write, `lore` fails trying to create `$HOME/.config/lore/` for global config. Two common triggers:
- Host home dir lacks world-execute, so a bind-mounted path under `/home/tim` is untraversable from uid 1000.
- `HOME=/home/wabi` but `/home/wabi` does not exist in the image/container, so `mkdir -p /home/wabi/.config/lore` fails with EACCES before the CLI even starts.

**Preferred fix (general self-hosting):** In the Lore backend, set `HOME` to an already-writable bind-mounted path when spawning the CLI:
```rust
Command::new(binary)
    .current_dir(working_dir)
    .env("HOME", "/var/wabi/lore")
    .args(args)
    .output()
    .await?;
```
This avoids any host home-dir chmod and requires no compose changes. `/var/wabi/lore` is already bind-mounted by default (`./lore-data:/var/wabi/lore`).

**Ephemeral manual fix (existing container only):**
```bash
ssh tim@100.96.11.45 "docker exec -u root wabi-server mkdir -p /home/wabi/.config/lore /var/wabi/.config/lore && docker exec -u root wabi-server chown -R 1000:1000 /home/wabi /var/wabi/.config/lore"
```

**Host chmod fallback (legacy):**
```bash
ssh tim@100.96.11.45 "chmod o+rx /home/tim"
```
Only use this if you cannot change the spawn `HOME`. Changing `/home/tim` owner to uid 1000 breaks Tim's own login and desktop. Adding `o+rx` is the minimal correct fix when required.

**Verify:**
```bash
ssh tim@100.96.11.45 "docker exec wabi-server /usr/local/lorebin/lore --version"
# → lore 0.8.6+373
```

---

## Symptom 2 — `POST /repos/{channelId}` returns 405 for create

**Log evidence:**
```
request{method=POST uri=/api/addons/lore/repos/3} status=405
```

**Why it happens:** Backend defines two separate routes:
- `POST /repos` — create a new Lore repo (channelId in JSON body)
- `POST /repos/{channel_id}/link` — link an existing repo

Frontend was appending `/{channelId}` to the create URL, hitting no matching route → 405.

**Frontend fix (`LoreConnectModal.svelte`):**
```typescript
const url = `/api/addons/lore/repos${mode === 'link' ? `/${numericChannelId}/link` : ''}`;
const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: numericChannelId, repoName: repoName.trim() })
});
```

**Verify:**
```bash
curl -sk -X POST http://host/api/addons/lore/repos \
  -H "Content-Type: application/json" \
  -d '{"channelId":3,"repoName":"default"}'
# → {"id":...,"name":"default",...}

curl -sk -X POST http://host/api/addons/lore/repos/3/link \
  -H "Content-Type: application/json" \
  -d '{"repoName":"existing"}'
```

---

## Symptom 3 — Lore addon compiled out entirely

**`/api/addons` lists only `mesh`, no `lore` entry.**

`wabi-lore` is behind the `addons` feature flag in `wabi-server/Cargo.toml`. Build with:
```bash
cargo build -p wabi-server --release --features addons
```

This is distinct from "disabled" — when the feature flag is absent, the `lore` key is not present in the `/api/addons` JSON array at all.

---

## Symptom 4 — `engine already running` restart loop

**Log evidence:**
```
Error: engine already running
```

Container restart-loops after `docker compose up -d`. This is a stale WabiDB lock from a prior unclean shutdown. There are **TWO** lock files that BOTH must be removed:
- `data/wabi-server/.lock`
- `data/wabi-server/wabidb/.lock`

Fix:
```bash
ssh tim@100.96.11.45 "docker rm -f wabi-server && find ~/Desktop/Wabi/data -name '*.lock' -delete && docker compose -f ~/Desktop/Wabi/docker-compose.yml up -d wabi-server"
```

Only clearing the top-level lock leaves the deeper engine lock, causing an immediate restart loop. After cleanup, the container should become `healthy` within seconds.

---

## General Lore Health Check Order

1. `docker inspect --format='{{.State.Health.Status}}' wabi-server` — must be `healthy`
2. `curl /api/addons` — `lore` must appear with `"enabled": true`
3. `docker exec wabi-server /usr/local/lorebin/lore --version` — binary reachable
4. `docker logs wabi-server 2>&1 | grep -i lore` — no permission/init errors
5. `curl /api/addons/lore/health` — must be 200
6. `curl -X POST /api/addons/lore/repos` (with auth) — must return repo JSON, not 405

Only after all six pass should you probe `/repos/{id}/files`, `/branches`, `/history`.
