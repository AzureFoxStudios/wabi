# Wabi STDB Source Reconciliation

Use this when localdev or deploy work touches `spacetimedb/wabi_state_bridge`, generated STDB bindings, or Tim's live `wabi.chat` database.

## Key lesson

Do not treat a missing local `spacetimedb/wabi_state_bridge` as proof that Wabi no longer uses STDB. Audit three separate things:

1. Live DB/runtime state — containers, health, SQL queries, published database name.
2. Module source state — whether `spacetimedb/wabi_state_bridge/src/lib.rs` and `Cargo.toml` exist in the active checkout or backups.
3. Generated binding state — `stdb_bindings_out/` and `frontend/src/lib/stdb_bindings/` may be newer than the live published module.

## Read-only audit sequence

### Local active checkout

Check:

```bash
test -d spacetimedb/wabi_state_bridge && find spacetimedb/wabi_state_bridge -maxdepth 3 -type f | sort
sed -n '1,140p' docker-compose.yml
sed -n '1,140p' scripts/local-dev.sh
find stdb_bindings_out frontend/src/lib/stdb_bindings -maxdepth 2 -type f | sort | sed -n '1,120p'
```

Important localdev mismatch found in June 2026:

- `scripts/local-dev.sh` built debug Rust with `cargo build -p wabi-server`.
- `docker-compose.yml` mounted `./target/release/wabi-server:/wabi-server:ro`.

Fix localdev by either building release or using a dev override/mount for `target/debug/wabi-server`. Prefer debug for localdev speed; keep release for Tim deploys.

### Tim live runtime

Tim SSH:

```bash
ssh tim@100.96.11.45
cd ~/Desktop/Wabi
```

Read-only checks:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | grep -Ei 'wabi|space|caddy'
docker compose -p wabi ps
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3030/v1/ping
curl -fsS http://127.0.0.1:3100/v1/ping
```

Expected current architecture:

- `wabi-server` healthy on host port 3001.
- `wabi-spacetimedb` healthy on 127.0.0.1:3030.
- `wabi-stdb-proxy` healthy on 3100.
- `wabi.chat` public route returns 200.

Use `.env` keys only, redact values containing token/secret/key.

### Query live STDB counts

Use Tim's configured DB name (`WABI_STDB_BRIDGE_DATABASE` or `WABI_STDB_DATABASE`) and token (`WABI_STDB_AUTH_TOKEN` or `WABI_STDB_TOKEN`). Query via proxy:

```bash
curl -fsS -X POST "http://127.0.0.1:3100/v1/database/$DB/sql" \
  -H 'Content-Type: text/plain' \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary 'SELECT COUNT(*) AS n FROM state_message'
```

Useful tables:

- `state_channel`
- `state_message`
- `state_user`
- `state_session`
- `state_whiteboard`
- `ingested_event`
- call-specific probes: `state_call_session`, `state_call_participant`, `state_call_signal`

If normal tables query successfully but call tables return SQL 400, the live module predates the call-enabled schema even if local generated bindings mention calls.

## Source candidate comparison pattern

Search for source copies without using destructive git operations:

```bash
find /home/tim /var/home/Ronin /home/Ronin \
  -path '*/target' -prune -o \
  -path '*/node_modules' -prune -o \
  -path '*/.git' -prune -o \
  -path '*spacetimedb/wabi_state_bridge*' -print 2>/dev/null
```

For each candidate module:

```bash
wc -l "$d/src/lib.rs" "$d/src/payment.rs" 2>/dev/null
sha256sum "$d/Cargo.toml" "$d/src/lib.rs" "$d/src/payment.rs" 2>/dev/null
grep -nE 'StateCallSession|call_session_create|state_payment_intent|StateWhiteboard|ingest_wabi_event|set_ingest_key' "$d/src/lib.rs" | sed -n '1,100p'
grep -c '^#\[spacetimedb::table' "$d/src/lib.rs"
grep -c '^#\[spacetimedb::reducer' "$d/src/lib.rs"
```

Known candidate classes from the June 2026 audit:

- Tim live-like source: `/home/tim/wabi/spacetimedb/wabi_state_bridge`
  - 36 tables, 2 reducers (`set_ingest_key`, `ingest_wabi_event`), no call tables.
  - Closest to Tim's live published schema.
- Tim call-enabled source: `/home/tim/wabi-merged/wabi/spacetimedb/wabi_state_bridge`
  - 39 tables, 7 reducers, includes `StateCallSession`, `StateCallParticipant`, `StateCallSignal` and call reducers.
  - Treat as a source artifact only; do not trust or sync the whole `wabi-merged` worktree.
- Ronin local backups under `/var/home/Ronin/Desktop/Wabi/backups/.../spacetimedb/wabi_state_bridge`
  - Older source candidates; compare before restoring.

## Restoration rule

Before copying any candidate into the active repo:

1. Compare against generated bindings and Rust server SQL expectations.
2. Prefer source that matches current generated bindings if localdev is the target.
3. Prefer source matching Tim live only if the goal is to reproduce current production behavior exactly.
4. Copy only the `spacetimedb/wabi_state_bridge` folder, not whole old/broken worktrees.
5. Publish to a fresh local STDB first; do not migrate Tim live while the user is distracted/sleepy.

## Dev seed/bot direction

Bot/seed tooling should exercise the real Rust + STDB path, not frontend mock state.

Suggested commands:

```bash
bun run dev:reset-stdb
bun run dev:seed
bun run dev:bot -- --user Mina --channel general --message 'testing localdev'
```

Implementation target:

- `dev:reset-stdb`: local-only wipe of local STDB data + republish module.
- `dev:seed`: create generated users/channels/messages through Rust backend or reducer path.
- `dev:bot`: send a message as a generated user through the same backend/STDB event path used by real messages.

Keep `dev:mock` visual-only and clearly separate from real localdev.
