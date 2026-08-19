#!/usr/bin/env bash
#
# 24 GitHub issue létrehozása az "AI Privacy Gateway" problémakörhöz (#272).
# Egységes cím-előtag:  [AI Privacy Gateway] APG-NN — ...
#
# A jegyek TÖRZSÉT a docs/specs/ai-privacy-gateway-tickets.md-ből olvassa ki
# (a "## APG-NN — ..." szakaszokat), hogy a dokumentum és az issue-k ne
# csússzanak szét. A címkéket és a mérföldkövet ez a szkript adja hozzá.
#
# Előfeltétel: gh CLI telepítve és bejelentkezve (gh auth status), a repo gyökeréből futtatva.
# Használat:   bash docs/specs/create-ai-privacy-gateway-issues.sh
# Szárazfutás: DRY_RUN=1 bash docs/specs/create-ai-privacy-gateway-issues.sh
#
set -euo pipefail

SRC="docs/specs/ai-privacy-gateway-tickets.md"
[[ -f "$SRC" ]] || { echo "Nem találom: $SRC (a repo gyökeréből futtasd)"; exit 1; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
MILESTONE="AI Privacy Gateway"
PREFIX="[AI Privacy Gateway]"
PARENT_ISSUE=272

echo "Repo: $REPO"

# --- Címkék (idempotens, --force upsert) ---
ensure_label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null 2>&1 || true; }
ensure_label "area:privacy"     "0052CC" "AI Privacy Gateway — pszeudonimizáció és feloldás"
ensure_label "type:feature"     "0E8A16" "Új funkció"
ensure_label "type:enhancement" "A2EEEF" "Meglévő bővítése"
ensure_label "type:ops"         "5319E7" "Infra / üzemeltetés / migráció"
ensure_label "security"         "B60205" "Biztonsági érintettség"
ensure_label "ux"               "FBCA04" "Felhasználói felület"
ensure_label "red-line"         "D93F0B" "Megsértése azonnali hiba — regressziós teszttel fedve"

# --- Mérföldkő (idempotens) ---
gh api -X POST "repos/$REPO/milestones" -f title="$MILESTONE" \
  -f description="AI Privacy Gateway (#272) — spec v0.2, M0–M4 vertikális szeletek" >/dev/null 2>&1 || true

# --- Jegyenkénti címkék (a doc "Prioritás"/tartalom szerint) ---
labels_for() {
  case "$1" in
    00) echo "area:privacy,type:ops" ;;
    01) echo "area:privacy,type:ops" ;;
    02) echo "area:privacy,type:feature,security" ;;
    03) echo "area:privacy,type:enhancement" ;;
    04) echo "area:privacy,type:feature,security" ;;
    05) echo "area:privacy,type:feature,security" ;;
    06) echo "area:privacy,type:feature,ux" ;;
    07) echo "area:privacy,security,ux,red-line" ;;
    08) echo "area:privacy,security,red-line" ;;
    09) echo "area:privacy,type:feature,security" ;;
    10) echo "area:privacy,type:enhancement" ;;
    11) echo "area:privacy,type:feature,security" ;;
    12) echo "area:privacy,type:enhancement,security" ;;
    13) echo "area:privacy,type:feature,security" ;;
    14) echo "area:privacy,type:feature,ux" ;;
    15) echo "area:privacy,type:enhancement,red-line" ;;
    16) echo "area:privacy,type:feature" ;;
    17) echo "area:privacy,type:feature" ;;
    18) echo "area:privacy,type:feature,security" ;;
    19) echo "area:privacy,type:feature,security,red-line" ;;
    20) echo "area:privacy,type:enhancement,security" ;;
    21) echo "area:privacy,type:enhancement" ;;
    22) echo "area:privacy,type:feature,ux" ;;
    23) echo "area:privacy,type:enhancement" ;;
    *)  echo "area:privacy" ;;
  esac
}

# --- A doc szakaszainak kibontása: "## APG-NN — cím" ... a következő "## " vagy "# " címig ---
# (bash 3.2-kompatibilis: nincs mapfile — macOS-en az alapértelmezett bash 3.2)
HEADINGS=()
while IFS= read -r line_no; do
  HEADINGS+=("$line_no")
done < <(grep -n '^## APG-[0-9][0-9] — ' "$SRC" | sed 's/:.*//')
TOTAL_LINES=$(wc -l < "$SRC")

created=0
for i in "${!HEADINGS[@]}"; do
  start="${HEADINGS[$i]}"
  # A szakasz vége a KÖVETKEZŐ bármilyen szintű címig tart (nem csak a következő
  # APG-ig) — különben az utolsó jegy törzsébe belefolyna a doc záró fejezete.
  next_heading=$(awk -v s="$start" 'NR>s && /^#/ {print NR; exit}' "$SRC")
  if [[ -n "$next_heading" ]]; then
    end=$(( next_heading - 1 ))
  else
    end=$TOTAL_LINES
  fi

  heading="$(sed -n "${start}p" "$SRC")"
  title="${heading#\#\# }"                  # "APG-01 — ..."
  num="$(printf '%s' "$title" | sed -n 's/^APG-\([0-9][0-9]\).*/\1/p')"

  # A szakasz törzse a cím UTÁNI sortól, a záró "---" elválasztó levágásával.
  body_raw="$(sed -n "$((start+1)),${end}p" "$SRC" | sed -e 's/[[:space:]]*$//')"
  body_raw="$(printf '%s\n' "$body_raw" | sed -e '/^---$/d')"

  body="$(cat <<EOF
$body_raw

---

**Forrás:** #$PARENT_ISSUE · spec: \`docs/specs/ai-privacy-gateway-spec.md\` (v0.2) ·
jegybontás: \`docs/specs/ai-privacy-gateway-tickets.md\`
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
