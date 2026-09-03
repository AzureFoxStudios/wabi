#!/usr/bin/env python3
"""Bulk-import a folder of markdown docs into a Wabi wiki channel.

Built for the docs-history archive (docs-history branch / wabi-docs-history
tarball) so historical docs become searchable inside Wabi itself — but it
works on any folder tree.

Mapping:
  directory  -> parent wiki page (hierarchy via parentPageId)
  .md file   -> wiki page (title = first `# ` heading, fallback filename;
                 slug = path-derived so re-runs are idempotent)

Usage:
  python3 scripts/import-docs-to-wiki.py --root /path/to/docs-history \
      --url http://127.0.0.1:3001 --channel <channel_id> --token $WABI_TOKEN \
      [--dry-run] [--limit N] [--parent-title "Documentation History"]

Requires a member token with wiki-write access on the target channel
(export WABI_TOKEN=... or pass --token).
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request

API_BASE = "/api/wiki/{channel}/pages"


def http(method: str, url: str, token: str, payload=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as res:
            body = res.read().decode()
            return res.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def first_heading(text: str, fallback: str) -> str:
    for line in text.splitlines()[:40]:
        m = re.match(r"^#\s+(.+)$", line.strip())
        if m:
            return m.group(1).strip()[:200]
    return fallback


def slugify(path: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", path.lower()).strip("-")[:180]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="folder to import")
    ap.add_argument("--url", required=True, help="Wabi server base URL")
    ap.add_argument("--channel", required=True, help="wiki channel id")
    ap.add_argument("--token", default=os.environ.get("WABI_TOKEN"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="import at most N files")
    ap.add_argument("--parent-title", default=None,
                    help="create all content under one top-level page")
    ap.add_argument("--skip-dirs", default=".git",
                    help="comma-separated directory names to skip")
    args = ap.parse_args()

    if not args.token:
        sys.exit("error: pass --token or export WABI_TOKEN")

    base = args.url.rstrip("/") + API_BASE.format(channel=args.channel)
    skip = set(args.skip_dirs.split(","))
    root = os.path.abspath(args.root)

    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for fn in sorted(filenames):
            if fn.endswith((".md", ".txt")):
                files.append(os.path.join(dirpath, fn))
    files.sort()
    if args.limit:
        files = files[: args.limit]

    print(f"{len(files)} files under {root}")

    pages = {}  # dir path -> page id
    root_parent = ""
    if args.parent_title and not args.dry_run:
        status, body = http("POST", base, args.token, {
            "title": args.parent_title, "body": "Imported documentation archive.",
            "slug": slugify(args.parent_title),
        })
        if status in (200, 201):
            root_parent = body.get("id", "")
            print(f"parent page: {root_parent}")
        else:
            print(f"parent page create: {status} {body}")

    ok = fail = 0
    for path in files:
        rel = os.path.relpath(path, root)
        dir_rel = os.path.dirname(rel)
        title = first_heading(open(path, encoding="utf-8", errors="replace").read(),
                              os.path.basename(rel))
        # Ensure chain of parent pages for the directory (root-first).
        parent = root_parent
        acc = ""
        for part in [p for p in dir_rel.split(os.sep) if p]:
            acc = os.path.join(acc, part) if acc else part
            if acc in pages:
                parent = pages[acc]
                continue
            payload = {"title": part, "body": f"Imported folder `{acc}`.",
                       "slug": slugify(f"dir-{acc}")}
            if parent:
                payload["parentPageId"] = parent
            if args.dry_run:
                print(f"[dry] dir-page  {part}")
                pages[acc] = "dry"
                parent = "dry"
                continue
            status, body = http("POST", base, args.token, payload)
            pid = body.get("id", "") if isinstance(body, dict) else ""
            pages[acc] = pid
            if status not in (200, 201):
                print(f"FAIL dir {acc}: {status} {body}")
                fail += 1
            parent = pid
        payload = {
            "title": title,
            "body": open(path, encoding="utf-8", errors="replace").read(),
            "slug": slugify(rel),
        }
        if parent:
            payload["parentPageId"] = parent
        if args.dry_run:
            print(f"[dry] page      {rel}  (title: {title[:60]})")
            ok += 1
            continue
        status, body = http("POST", base, args.token, payload)
        if status in (200, 201):
            ok += 1
            print(f"ok   {rel}")
        else:
            # slug collision = already imported (idempotent re-run)
            if status == 400 and "slug" in str(body).lower():
                print(f"skip {rel} (slug exists)")
                ok += 1
            else:
                fail += 1
                print(f"FAIL {rel}: {status} {body}")
        time.sleep(0.1)  # gentle rate limit

    print(f"\ndone: {ok} ok/skip, {fail} failed")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
