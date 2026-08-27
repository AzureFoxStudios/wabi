# parsyncfp Quick Reference for Bazzite

## What it is
A single Perl script that parallelizes rsync using `fpart` to chunk files. Designed for >10GB transfers. For smaller repos (like wabi, ~1GB), plain rsync is usually enough, but parsyncfp handles many small files well (node_modules, Rust targets).

## Install on Bazzite

```bash
# 1. Homebrew (best on immutable OS)
brew install fpart

# 2. Perl deps (bundled in Bazzite)
perl -e 'use Term::ANSIColor; use File::Path; use Getopt::Long; print "ok\n"'

# 3. parsyncfp + scut/stats helpers
curl -fsSL https://raw.githubusercontent.com/hjmangalam/parsyncfp/master/parsyncfp -o ~/bin/parsyncfp
chmod +x ~/bin/parsyncfp

cd /tmp && git clone --depth 1 https://github.com/hjmangalam/scut.git
cp /tmp/scut/scut /tmp/scut/stats ~/bin/
chmod +x ~/bin/scut ~/bin/stats
```

Result:
- `~/bin/parsyncfp`
- `/home/linuxbrew/.linuxbrew/bin/fpart`
- `~/bin/scut`
- `~/bin/stats`

Known quirk: `--version` prints two `Duplicate specification` warnings via Getopt::Long — benign, does not affect operation.

## Pre-Transfer Checklist

1. **SSH key auth must work** — tailscale SSH will prompt browser approval on first connect:
   ```bash
   ssh ironin@100.80.172.12 "echo ok"  # tailscale link appears first time
   # User approves via browser
   # Retry: now works
   ```
   If keys are not set up, use `ssh-copy-id`.

2. **Use the clean repo copy on ironin**, not the broken `wabi-merged`:
   - `ironin:~/wabi-merged/wabi` — all tracked files deleted (~600 staged `D`), DO NOT SYNC
   - `ironin:~/Documents/wabi` — 142 uncommitted changes, tracked files intact — USE THIS

## Usage (ironin -> local)

```bash
parsyncfp --NP=4 --chunksize=50M \
  --rsyncopts="-az" \
  --startdir=/home/ironin/Documents \
  wabi \
  Ronin@<your-local-tailscale-ip>:~/wabi/
```

## Key Flags

| Flag | Example | Purpose |
|------|---------|---------|
| `--NP=N` | `--NP=4` | Parallel rsync processes (default sqrt(CPUs)) |
| `--chunksize=SIZE` | `--chunksize=50M` | Files per chunk. Human abbrev: M, G, K |
| `--rsyncopts="OPTS"` | `--rsyncopts="-az"` | Pass through to rsync |
| `--startdir=DIR` | `--startdir=/path` | Working dir. Sources below are relative to this |
| `--maxbw=KBPS` | `--maxbw=50000` | Total bandwidth cap in KB/s |
| `--altcache=DIR` | `--altcache=/tmp/pfp` | Cache dir for multiple simultaneous runs |
| `--dispose=d` | | Delete cache/logs after run |
| `--fromlist=FILE` | | Read source files from explicit list (pre-generated) |
| `--trimpath=STR` | | Remove leading path from file list entries |

## Limitations
- **Only local SOURCE -> remote TARGET**. Cannot pull from remote. To pull, SSH to remote and run it pointing back, or use plain rsync.
- **No `--delete` in rsyncopts**. Parallel rsyncs are independent; deletions must be a separate final rsync.
- Not worth the overhead for <1GB or few files — use `rsync -az` instead.

## Reference
- https://github.com/hjmangalam/parsyncfp
- https://github.com/martymac/fpart
