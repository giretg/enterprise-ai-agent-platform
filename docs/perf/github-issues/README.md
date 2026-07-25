# Perf follow-up GitHub issue draftok

A cloud agent GitHub tokenje **nem tud issue-t létrehozni** (`createIssue` / `repository.issues` → 403).
Ezek a draftok a 2026-07-25-ös perf kör utáni következő feladatokat írják le.

## Létrehozás helyi tokennel

```bash
# a repo gyökeréből, olyan tokennel amelyen van `issues: write`
./docs/perf/github-issues/create-issues.sh
```

Vagy egyesével:

```bash
gh issue create --title "$(head -n1 docs/perf/github-issues/001-findByIdWithDetails-split.md | sed 's/^# //')" \
  --body-file docs/perf/github-issues/001-findByIdWithDetails-split.md

gh issue create --title "$(head -n1 docs/perf/github-issues/002-split-dispatcher-from-ui.md | sed 's/^# //')" \
  --body-file docs/perf/github-issues/002-split-dispatcher-from-ui.md

gh issue create --title "$(head -n1 docs/perf/github-issues/003-paginate-unbounded-lists.md | sed 's/^# //')" \
  --body-file docs/perf/github-issues/003-paginate-unbounded-lists.md

gh issue create --title "$(head -n1 docs/perf/github-issues/004-fix-n-plus-one-queries.md | sed 's/^# //')" \
  --body-file docs/perf/github-issues/004-fix-n-plus-one-queries.md
```

## Issue-k

1. `001-findByIdWithDetails-split.md` — runtime vs display loader
2. `002-split-dispatcher-from-ui.md` — UI / dispatcher Cloud Run szétválasztás
3. `003-paginate-unbounded-lists.md` — unbounded listák paginálása
4. `004-fix-n-plus-one-queries.md` — N+1 lekérdezések
