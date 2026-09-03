# Wabi documentation history

This branch is the **read-only archive** of Wabi's historical documentation — everything that
lived in the working tree before the 2026-09-02 consolidation (see `docs/README.md` on `main`).

Files keep their **original repo paths**, so historical cross-references resolve as they did
at the time. Nothing here is maintained; `main` holds the living docs.

## What's in here

- `docs/` — pre-consolidation top-level docs (STDB-era plans, worker/verification reports,
  DM-planning series, session notes, handoffs, reports/, archive/)
- `PROJECT_DOCS/` — the old operator doc tree (incl. its own `archive/`, and the STDB-era
  DEPLOYMENT.md / BACKUP_AND_RESTORE.md, which carry stale-stack warning banners)
- `audit/` — 99-file audit dump formerly at the repo root
- root strays — SUMMARY.md, wabi-project-documentation.md, one-off audit reports

## How to use

- **Browse**: you're already here — files render like any GitHub markdown.
- **Download**: GitHub → Code → Download ZIP on this branch.
- **Search inside Wabi**: run `scripts/import-docs-to-wiki.sh` (on `main`) against a checkout
  of this branch to bulk-import pages into a Wabi wiki channel.

Provenance: files were moved here verbatim from `main` at commit-time 2026-09-02; the full
from→disposition map is in `MANIFEST.tsv`.
