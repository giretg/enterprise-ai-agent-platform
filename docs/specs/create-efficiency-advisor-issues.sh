#!/usr/bin/env bash
#
# 14 GitHub issue létrehozása a "Hatékonysági tanácsadó" problémakörhöz (#237 / #304).
# Egységes cím-előtag:  [Efficiency Advisor] EFF-NN — ...
#
# A jegyek TÖRZSÉT a docs/specs/efficiency-advisor-tickets.md-ből olvassa ki
# (a "## EFF-NN — ..." szakaszokat), hogy a dokumentum és az issue-k ne
# csússzanak szét. A címkéket és a mérföldkövet ez a szkript adja hozzá.
#
# Előfeltétel: gh CLI telepítve és bejelentkezve (gh auth status), a repo gyökeréből futtatva.
# Használat:   bash docs/specs/create-efficiency-advisor-issues.sh
# Szárazfutás: DRY_RUN=1 bash docs/specs/create-efficiency-advisor-issues.sh
#
set -euo pipefail

SRC="docs/specs/efficiency-advisor-tickets.md"
[[ -f "$SRC" ]] || { echo "Nem találom: $SRC (a repo gyökeréből futtasd)"; exit 1; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
MILESTONE="Efficiency Advisor"
PREFIX="[Efficiency Advisor]"
SPEC_ISSUE=304
IDEA_ISSUE=237

echo "Repo: $REPO"

# --- Címkék (idempotens, --force upsert) ---
ensure_label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null 2>&1 || true; }
ensure_label "area:efficiency"  "1D76DB" "Hatékonysági tanácsadó — token/költség-optimalizálás"
ensure_label "type:feature"     "0E8A16" "Új funkció"
ensure_label "type:enhancement" "A2EEEF" "Meglévő bővítése"
ensure_label "type:ops"         "5319E7" "Infra / üzemeltetés / migráció"
ensure_label "ux"               "FBCA04" "Felhasználói felület"

# --- Mérföldkő (idempotens) ---
gh api -X POST "repos/$REPO/milestones" -f title="$MILESTONE" \
  -f description="Hatékonysági tanácsadó (#237 / #304) — M0–M5 vertikális szeletek" >/dev/null 2>&1 || true

# --- Jegyenkénti címkék ---
labels_for() {
  case "$1" in
    00) echo "area:efficiency,type:ops" ;;
    01) echo "area:efficiency,type:ops" ;;
    02) echo "area:efficiency,type:enhancement" ;;
    03) echo "area:efficiency,type:feature" ;;
    04) echo "area:efficiency,type:feature" ;;
    05) echo "area:efficiency,type:feature" ;;
    06) echo "area:efficiency,type:feature" ;;
    07) echo "area:efficiency,type:feature" ;;
    08) echo "area:efficiency,type:feature" ;;
    09) echo "area:efficiency,type:feature" ;;
    10) echo "area:efficiency,type:feature,ux" ;;
    11) echo "area:efficiency,type:enhancement" ;;
    12) echo "area:efficiency,type:feature,ux" ;;
    13) echo "area:efficiency,type:ops" ;;
    *)  echo "area:efficiency" ;;
  esac
}

# --- A doc szakaszainak kibontása: "## EFF-NN — cím" ... a következő "## " vagy "# " címig ---
# (bash 3.2-kompatibilis: nincs mapfile — macOS-en az alapértelmezett bash 3.2)
HEADINGS=()
while IFS= read -r line_no; do
  HEADINGS+=("$line_no")
done < <(grep -n '^## EFF-[0-9][0-9] — ' "$SRC" | sed 's/:.*//')
TOTAL_LINES=$(wc -l < "$SRC")

created=0
for i in "${!HEADINGS[@]}"; do
  start="${HEADINGS[$i]}"
  # A szakasz vége a KÖVETKEZŐ bármilyen szintű címig tart (nem csak a következő
  # EFF-ig) — különben az utolsó jegy törzsébe belefolyna a doc záró fejezete.
  next_heading=$(awk -v s="$start" 'NR>s && /^#/ {print NR; exit}' "$SRC")
  if [[ -n "$next_heading" ]]; then
    end=$(( next_heading - 1 ))
  else
    end=$TOTAL_LINES
  fi

  heading="$(sed -n "${start}p" "$SRC")"
  title="${heading#\#\# }"                  # "EFF-01 — ..."
  num="$(printf '%s' "$title" | sed -n 's/^EFF-\([0-9][0-9]\).*/\1/p')"

  # A szakasz törzse a cím UTÁNI sortól, a záró "---" elválasztó levágásával.
  body_raw="$(sed -n "$((start+1)),${end}p" "$SRC" | sed -e 's/[[:space:]]*$//')"
  body_raw="$(printf '%s\n' "$body_raw" | sed -e '/^---$/d')"

  body="$(cat <<EOF
$body_raw

---

**Forrás:** #$IDEA_ISSUE (ötlet) · spec: #$SPEC_ISSUE ·
\`docs/specs/AI-Agent-Platform-Feature-Spec-Efficiency-Advisor.md\` ·
jegybontás: \`docs/specs/efficiency-advisor-tickets.md\`
EOF
)"

  labels="$(labels_for "$num")"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "── DRY_RUN ── $PREFIX $title"
    echo "              címkék: $labels · törzs: $(printf '%s' "$body" | wc -l) sor"
    created=$((created+1))
    continue
  fi

  gh issue create \
    --repo "$REPO" \
    --title "$PREFIX $title" \
    --label "$labels" \
    --milestone "$MILESTONE" \
    --body "$body"
  created=$((created+1))
done

echo
echo "Kész: $created jegy $( [[ "${DRY_RUN:-0}" == "1" ]] && echo '(szárazfutás)' || echo 'létrehozva' )."
