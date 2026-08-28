# Lore Addon Integration Reference

## What is Lore?

Epic Games Lore is a **fully open-source VCS** (MIT license). Pre-built binaries, Docker, CLI, and server. Not proprietary.

- **GitHub:** https://github.com/EpicGames/lore
- **Docs:** https://epicgames.github.io/lore/
- **Quickstart:** https://epicgames.github.io/lore/tutorials/quickstart/
- **FAQ:** https://epicgames.github.io/lore/faq/

## Installation

```bash
# Install CLI + loreserver, start in demo mode (foreground)
curl -fsSL https://raw.githubusercontent.com/EpicGames/lore/main/scripts/install.sh | bash -s -- --demo

# Manual install (binaries only, no server)
curl -fsSL https://raw.githubusercontent.com/EpicGames/lore/main/scripts/install.sh | bash -s

# Binaries land in ~/.local/bin/
```

## Server Ports

| Protocol | Port | Notes |
|----------|------|-------|
| QUIC/gRPC | 41337 | Main protocol (`lore://host:41337`) |
| HTTP | 41339 | Health check (`http://host:41339/health_check`) |

**CRITICAL:** Wabi addon defaults to `lore://localhost:10000` — this is WRONG. Must be `lore://localhost:41337`.

## Core CLI Commands

```bash
# Repository
lore repository create lore://host:41337/repo-name
lore clone lore://host:41337/repo-name ./path

# Staging + committing (fully offline)
lore stage file1 file2
lore commit "message"

# Push + sync
lore push
lore sync

# Branching (subcommand pattern, NOT `lore checkout`)
lore branch list
lore branch create feature-x
lore branch checkout feature-x
lore branch delete feature-x

# Status + history
lore status --scan
lore history
lore diff file.rs

# Locking
lore lock file.bin
lore unlock file.bin
```

### Key differences from Git
- No `checkout` subcommand — use `lore branch checkout <name>`
- `stage` covers adds, edits, deletes, and renames
- No `pull` — use `sync`
- No `merge` subcommand yet (in development)
- Branching is free and offline (no server round-trip)

## Known Limitations (Lore v0.8.6)

- Locking is advisory only (informs, doesn't enforce)
- No `lore checkout` subcommand (use `lore branch checkout`)
- No `lore merge` subcommand yet
- Lock state queried globally (doesn't scale to millions of files)
- UEFN build uses proprietary compression format (not in open-source release)