#!/usr/bin/env bash
# Létrehozza a perf follow-up GitHub issue-kat.
# Szükséges: gh auth login olyan tokennel, amelyen van issues:write a repóra.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/../../.."

if ! gh auth status >/dev/null 2>&1; then
  echo "gh nincs bejelentkezve. Futtasd: gh auth login" >&2
  exit 1
fi

create_one() {
  local file="$1"
  local title
  title="$(head -n1 "$file" | sed 's/^# //')"
  echo "→ Creating: $title"
  gh issue create --title "$title" --body-file "$file"
}

create_one "$ROOT/001-findByIdWithDetails-split.md"
create_one "$ROOT/002-split-dispatcher-from-ui.md"
create_one "$ROOT/003-paginate-unbounded-lists.md"
create_one "$ROOT/004-fix-n-plus-one-queries.md"

echo "Kész."
