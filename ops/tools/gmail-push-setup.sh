#!/usr/bin/env bash
# #1032 — Gmail azonnali értesítés (Pub/Sub) beállítása a bejövő levelekhez, lépésenként.
#
# Miért kell: a Gmail nem tud közvetlenül a platform címére szólni új levélnél; a Google csak a saját
# üzenetsorán (Cloud Pub/Sub) keresztül értesít. Ez a szkript egyszer beállítja:
#   1. egy Pub/Sub topicot (üzenetcsatornát), amibe a Gmail írhat,
#   2. egy push-subscriptiont, ami a csatorna üzeneteit aláírt tokennel a platformnak továbbítja,
#   3. kiírja a 3 környezeti változót, amit az App Hostingban be kell állítani.
# Opcionálisan (4.) létrehoz egy gyakori Cloud Scheduler hívást („éjjel is figyeljen”).
#
# Nélküle sem romlik el semmi: a Gmail-postafiókot a platform időközönként megnézi.
# Futtatás: bash ops/tools/gmail-push-setup.sh   (gcloud CLI + bejelentkezett fiók kell)
set -euo pipefail

FORBIDDEN_PROJECT="e-ai-ab8f1"   # Ostorosbor CRM — ide SOHA
DEFAULT_PROJECT="enterprise-ai-demo"
DEFAULT_ORIGIN="https://ai.excellencepay.com"
TOPIC="gmail-inbound-push"
SUBSCRIPTION="gmail-inbound-push-to-platform"
PUSH_SA_NAME="inbound-mail-push"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ask() { local q="$1" def="${2:-}"; read -r -p "  $q${def:+ [$def]}: " a; echo "${a:-$def}"; }
confirm() { local a; read -r -p "  $1 [i/N]: " a; [[ "$a" =~ ^[iIyY]$ ]]; }
run() { printf '  \033[2m$ %s\033[0m\n' "$*"; "$@"; }

command -v gcloud >/dev/null || { echo "A gcloud CLI nincs telepítve: https://cloud.google.com/sdk/docs/install" >&2; exit 1; }

bold "0/4  Fiók és projekt"
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[ -n "$ACCOUNT" ] || { echo "Nem vagy bejelentkezve: gcloud auth login" >&2; exit 1; }
info "Bejelentkezve: $ACCOUNT"
PROJECT="$(ask 'GCP projekt (ahol a platform és a Google OAuth-kliens van)' "$DEFAULT_PROJECT")"
if [ "$PROJECT" = "$FORBIDDEN_PROJECT" ]; then
  echo "Ez az Ostorosbor CRM projektje — ide nem állítunk be semmit." >&2
  exit 1
fi
ORIGIN="$(ask 'A platform nyilvános címe' "$DEFAULT_ORIGIN")"
ENDPOINT="${ORIGIN%/}/api/webhooks/mail/google"
PUSH_SA="${PUSH_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
info "Projekt: $PROJECT (#$PROJECT_NUMBER) · push-cím: $ENDPOINT"
info "Fontos: a topicnak abban a projektben kell lennie, amelyikben a Gmailhez használt OAuth-kliens van."
confirm "Folytatod?" || exit 0

bold "1/4  Pub/Sub topic, amibe a Gmail írhat"
run gcloud services enable pubsub.googleapis.com --project "$PROJECT"
if gcloud pubsub topics describe "$TOPIC" --project "$PROJECT" >/dev/null 2>&1; then
  info "A topic már létezik: $TOPIC"
else
  confirm "Létrehozzam a(z) $TOPIC topicot?" && run gcloud pubsub topics create "$TOPIC" --project "$PROJECT"
fi
info "A Gmail rendszerfiókja (gmail-api-push@system.gserviceaccount.com) publish-jogot kap a topicra."
confirm "Megadjam a jogot?" && run gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project "$PROJECT" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" --role="roles/pubsub.publisher"

bold "2/4  Push-subscription a platform felé (aláírt tokennel)"
if ! gcloud iam service-accounts describe "$PUSH_SA" --project "$PROJECT" >/dev/null 2>&1; then
  confirm "Létrehozzam a push service accountot ($PUSH_SA)?" && run gcloud iam service-accounts create "$PUSH_SA_NAME" \
    --project "$PROJECT" --display-name="Bejövő levél push (#1032)"
fi
info "A Pub/Sub saját szolgáltatás-fiókja tokent állíthat ki a push service account nevében."
run gcloud iam service-accounts add-iam-policy-binding "$PUSH_SA" --project "$PROJECT" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" >/dev/null
if gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project "$PROJECT" >/dev/null 2>&1; then
  info "A subscription már létezik — a címet és a tokent frissítem."
  run gcloud pubsub subscriptions modify-push-config "$SUBSCRIPTION" --project "$PROJECT" \
    --push-endpoint="$ENDPOINT" --push-auth-service-account="$PUSH_SA" --push-auth-token-audience="$ENDPOINT"
else
  confirm "Létrehozzam a(z) $SUBSCRIPTION subscriptiont?" && run gcloud pubsub subscriptions create "$SUBSCRIPTION" \
    --project "$PROJECT" --topic="$TOPIC" --push-endpoint="$ENDPOINT" \
    --push-auth-service-account="$PUSH_SA" --push-auth-token-audience="$ENDPOINT" \
    --ack-deadline=30 --message-retention-duration=1d
fi

bold "3/4  Környezeti változók az App Hostingban (gyökér apphosting.yaml)"
cat <<EOF
  Add hozzá az env listához (nem titkok), majd deploy:

  - variable: GMAIL_PUSH_TOPIC
    value: "projects/${PROJECT}/topics/${TOPIC}"
  - variable: GMAIL_PUSH_AUDIENCE
    value: "${ENDPOINT}"
  - variable: GMAIL_PUSH_SERVICE_ACCOUNT
    value: "${PUSH_SA}"

  A deploy utáni napi karbantartás a Gmail-postafiókokat azonnali értesítésre kapcsolja
  (a Postafiókok oldalon „Azonnal értesül” lesz).
EOF

bold "4/4  (Opcionális) Éjjel is figyeljen — gyakori Cloud Scheduler hívás"
info "Nélküle a push nélküli postafiókokat csak a platform használata közben nézzük meg (olcsóbb)."
info "Ha bekapcsolod, a megadott gyakorisággal felébreszti a platformot és az adatbázist — ez költséggel jár."
if confirm "Létrehozzam a gyakori hívást?"; then
  MINUTES="$(ask 'Hány percenként (5, 15, 30, 60)' '30')"
  [[ "$MINUTES" =~ ^(5|15|30|60)$ ]] || { echo "Csak 5, 15, 30 vagy 60." >&2; exit 1; }
  SCHEDULE="*/${MINUTES} * * * *"; [ "$MINUTES" = 60 ] && SCHEDULE="0 * * * *"
  LOCATION="$(ask 'Scheduler régió' 'europe-west1')"
  TOKEN="$(gcloud secrets versions access latest --secret=DISPATCHER_CONTROL_TOKEN --project "$PROJECT")"
  run gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT"
  if gcloud scheduler jobs describe inbound-mail-poll --location "$LOCATION" --project "$PROJECT" >/dev/null 2>&1; then
    run gcloud scheduler jobs update http inbound-mail-poll --location "$LOCATION" --project "$PROJECT" \
      --schedule="$SCHEDULE" --time-zone="Europe/Budapest"
  else
    gcloud scheduler jobs create http inbound-mail-poll --location "$LOCATION" --project "$PROJECT" \
      --schedule="$SCHEDULE" --time-zone="Europe/Budapest" --http-method=POST \
      --uri="${ORIGIN%/}/api/v1/internal/inbound-mail" --headers="x-dispatcher-token=${TOKEN}" >/dev/null
    info "Létrehozva: inbound-mail-poll ($SCHEDULE)."
  fi
  info "Kikapcsolás: gcloud scheduler jobs pause inbound-mail-poll --location $LOCATION --project $PROJECT"
fi

bold "Kész."
