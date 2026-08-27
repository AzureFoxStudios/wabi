# Lore lost registration + "Repository already exist in path" (2026-08-21)

## Symptom

Project-channel setup click fails with:

```
Lore command failed: [Error] Repository already exist in path /var/wabi/lore/<id> at lore-revision/src/repository/create.rs:165:28
```

while the UI still offers "Set up folder" — a dead end: every retry collides with the orphan.

## Root cause

A previous `create_repo` completed **on disk** but its durable registration was lost
(crash, restart mid-flow, WDB write error). Lore's disk and Wabi's in-memory index
disagree:

- `<lore_data_dir>/<channel_id>/` contains `.lore/`, `.wabi-repo.json`, seeded ignores,
  and possibly user uploads — the repo EXISTS.
- `LoreService.repos` map has no entry → UI offers setup → `lore repository create`
  refuses because the path is taken.

Verified incident 2026-08-21, channel 97 on Tim: repo created 11:43, server restarted
12:07, index lost it. User uploads (`gallery-prototype.html`) were inside the tree —
wiping would have destroyed real content.

## Fix shipped (commit 71ac201)

`create_repo` in `core/addons/lore/backend/src/lib.rs` now **adopts** an existing
working tree instead of failing: if `.lore/` or `.wabi-repo.json` exists, rehydrate
class/review attributes from the sidecar state file (same as `load_existing_repos`),
register in-memory, re-persist state, return success. Adoption preserves uploads and
history — never advise wiping the tree.

## Diagnosis rules

1. **On-disk truth first**: check `<lore_data_dir>/<channel_id>/` for `.lore/` +
   `.wabi-repo.json`; compare mtime vs last container restart (`docker inspect
   --format '{{.State.StartedAt}}'`).
2. **Do NOT grep WabiDB segments.** Event streams are AES-256-GCM encrypted with a
   per-stream key — grepping `.wseg` files for plaintext event names
   (`lore_repo_registered`, usernames, anything) ALWAYS returns empty. Absence proves
   nothing in either direction; don't burn time building bigger greps.
3. Prove registration state via live API probes (`GET /api/addons/lore/repos` with a
   token), projection state, or the offline snapshot-decode recipe from
   `user-record-postcard-compat-and-owner-recovery.md` (in wabi-deploy).
4. Guest tokens work for auth-shape probes but get 403 on lore repo endpoints
   (role-gated) — don't misread that as "endpoint missing".

## Open question to watch

The durable event *should* have survived the restart (it was written pre-restart), so
the loss may be a WabiDB replay bug rather than a write failure. If repos keep
"forgetting" across restarts despite the adoption fix, chase replay of
`lore_repo_registered` through projection state — not segment inspection.
