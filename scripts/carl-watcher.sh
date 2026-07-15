#!/bin/bash
# carl-watcher.sh — every 4 min via cronjob
# Detects new content from Carl (the other hermes session working on the wabidb
# engine) and pings the user with the file path + an excerpt.
#
# Watchdog pattern: empty stdout = silent (nothing to report), non-zero exit =
# broken (alert). New content -> prints a notification block to stdout, also
# appends a structured entry to the watch doc.

set -euo pipefail

WABI_REPO="/var/home/Ronin/wabi"
WATCH_DOC="$WABI_REPO/docs/wabi-carl-watch.md"
NOW="$(date '+%Y-%m-%d %H:%M:%S %Z')"
TS="$(date '+%H:%M:%S')"

# Ensure watch doc exists with a header.
if [ ! -f "$WATCH_DOC" ]; then
  cat > "$WATCH_DOC" <<'EOF'
# Carl Watch — Joey's view of Carl's engine work

> Auto-updated every 4 min by the carl-watcher cron job.
> Carl = engine side (wabidb). Joey = integration side (wabi-server).
> Mission: wabi + WDB working together, no STDB.
EOF
fi

# 1. New/modified wabidb commits in the last 5 min (window is wider than the
#    4-min cron interval to avoid races).
NEW_COMMITS=""
if [ -d "$WABI_REPO/.git" ]; then
  NEW_COMMITS=$(cd "$WABI_REPO" && git log --since="5 minutes ago" --oneline -- core/crates/wabidb/ 2>/dev/null || true)
fi

# 2. New/modified .md files in the docs dirs in the last 5 min.
NEW_DOCS=""
for dir in docs/research docs/architecture docs/proposals; do
  if [ -d "$WABI_REPO/$dir" ]; then
    found=$(find "$WABI_REPO/$dir" -type f -name "*.md" -mmin -5 2>/dev/null || true)
    if [ -n "$found" ]; then
      NEW_DOCS="${NEW_DOCS}${found}"$'\n'
    fi
  fi
done
NEW_DOCS=$(echo "$NEW_DOCS" | sed '/^$/d' | sort -u)

# 3. If nothing new, exit silently.
if [ -z "$NEW_COMMITS" ] && [ -z "$NEW_DOCS" ]; then
  exit 0
fi

# 4. Append a structured entry to the watch doc.
{
  echo ""
  echo "---"
  echo ""
  echo "## $NOW — Carl posted"
  echo ""
  if [ -n "$NEW_COMMITS" ]; then
    echo "### wabidb commits"
    echo ""
    echo '```'
    echo "$NEW_COMMITS"
    echo '```'
    echo ""
  fi
  if [ -n "$NEW_DOCS" ]; then
    echo "### New/updated docs"
    echo ""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      rel="${f#$WABI_REPO/}"
      echo "#### \`$rel\`"
      echo ""
      echo '```'
      head -25 "$f" 2>/dev/null || echo "(could not read)"
      echo '```'
      echo ""
    done <<< "$NEW_DOCS"
  fi
} >> "$WATCH_DOC"

# 5. Stdout notification (delivered to user via cronjob no_agent=true).
echo "Carl posted new content at $TS."
echo ""
if [ -n "$NEW_COMMITS" ]; then
  echo "wabidb commits:"
  echo "$NEW_COMMITS" | sed 's/^/  /'
  echo ""
fi
if [ -n "$NEW_DOCS" ]; then
  echo "New/updated docs:"
  echo "$NEW_DOCS" | sed 's/^/  /'
  echo ""
fi
echo "Watch doc: $WATCH_DOC"
