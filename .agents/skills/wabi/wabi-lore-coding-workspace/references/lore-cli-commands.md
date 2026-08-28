# Lore CLI Command Reference (v0.8.6)

Source: https://epicgames.github.io/lore/tutorials/quickstart/

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/EpicGames/lore/main/scripts/install.sh | bash -s -- --demo
```

Installs `lore` CLI + `loreserver`. Server runs on `lore://127.0.0.1:41337` (QUIC/gRPC) + `http://127.0.0.1:41339` (HTTP).

## Core workflow

```bash
# Create repo
lore repository create lore://127.0.0.1:41337/my-project

# Stage files
lore stage hello.txt sample.bin

# Check status
lore status --scan

# Commit
lore commit "Initial revision"

# Push
lore push

# Clone
lore clone lore://127.0.0.1:41337/my-project my-project-b

# Sync
lore sync

# Branch
lore branch list
lore branch create feature-x
lore branch switch feature-x
lore branch delete feature-x

# History
lore history

# Diff
lore diff <from-rev> <to-rev> <path>

# Lock/unlock
lore lock <path>
lore unlock <path>
```

## Key differences from Git

- No `add` — uses `stage` for all file operations (add, edit, delete)
- No `checkout` — uses `branch switch`
- Revisions are numbered sequentially (1, 2, 3...) with hash signatures
- Fragments instead of blobs — chunk-level dedup across files
- Server-side locking for collaboration
- No merge conflicts in the Git sense — Lore handles binary merge automatically

## Addon method mapping

| API route calls | Addon method | Lore CLI |
|---|---|---|
| `lore.create_repo()` | `create_repo(channel_id, name, user_id)` | `lore repository create` |
| `lore.list_files()` | `list_files(channel_id, prefix)` | `lore file list` |
| `lore.upload_file()` | `upload_file(channel_id, local, repo, msg, author_id)` | `stage` + `commit` + `push` |
| `lore.commit_staged()` | `commit_staged(channel_id, msg, author_id)` | `commit` + `push` |
| `lore.delete_file()` | `delete_file(channel_id, path, msg)` | `stage` + `commit` + `push` |
| `lore.download_file()` | `download_file(channel_id, path, dest, rev)` | `lore file download` |
| `lore.lock_file()` | `lock_file(channel_id, path, user_id)` | `lore lock` |
| `lore.unlock_file()` | `unlock_file(channel_id, path)` | `lore unlock` |
| `lore.file_history()` | `file_history(channel_id, path_filter)` | `lore history` |
| `lore.file_level_history()` | `file_level_history(channel_id, path)` | `lore history <path>` |
| `lore.file_diff()` | `file_diff(channel_id, path, from, to)` | `lore diff from to path` |
| `lore.get_diff()` | `get_diff(channel_id, path)` | `lore diff path` |
| `lore.list_branches()` | `list_branches(channel_id)` | `lore branch list` |
| `lore.create_branch()` | `create_branch(channel_id, name, base_rev)` | `lore branch create` |
| `lore.merge_branch()` | `merge_branch(channel_id, name)` | `lore merge` |
| `lore.health_check()` | `health_check()` | `lore --version` |