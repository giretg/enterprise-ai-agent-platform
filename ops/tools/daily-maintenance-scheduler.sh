#!/usr/bin/env bash
# A napi karbantartó hívás (DEPLOY.md 3.2) Cloud Scheduler-feladata. Ismételten futtatható:
# ha már létezik a feladat, frissíti. A gyakoriság a --schedule kapcsolóval állítható.
#
#   bash ops/tools/daily-maintenance-scheduler.sh                                 # létrehozás, alapból naponta 3:30
#   bash ops/tools/daily-maintenance-scheduler.sh --schedule "30 3,15 * * *"      # naponta kétszer
#   bash ops/tools/daily-maintenance-scheduler.sh --status | --pause | --resume | --run-now
#
# Alapértékek felülírhatók: PROJECT, LOCATION, ORIGIN, JOB. A tokent a Secret Managerből olvassa, és nem írja ki.
set -euo pipefail

PROJECT="${PROJECT:-enterprise-ai-demo}"
LOCATION="${LOCATION:-europe-west4}"
ORIGIN="${ORIGIN:-https://ai.excellencepay.com}"
JOB="${JOB:-daily-maintenance}"
SCHEDULE="30 3 * * *"
TIME_ZONE="Europe/Budapest"
ACTION="apply"

usage() { sed -n 2,9p "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --schedule) SCHEDULE="${2:?A --schedule után cron kell}"; shift 2 ;;
    --time-zone) TIME_ZONE="${2:?A --time-zone után időzóna kell}"; shift 2 ;;
    --status) ACTION="status"; shift ;;
    --pause) ACTION="pause"; shift ;;
    --resume) ACTION="resume"; shift ;;
    --run-now) ACTION="run"; shift ;;
    -h|--help) usage ;;
    *) echo "Ismeretlen kapcsoló: $1" >&2; usage 2 ;;
  esac
done

scope=(--location "$LOCATION" --project "$PROJECT")

case "$ACTION" in
  status)
    # A fejléc a tokent tartalmazza, ezért csak ezeket a mezőket írjuk ki.
    gcloud scheduler jobs describe "$JOB" "${scope[@]}" \
      --format="yaml(schedule,timeZone,state,lastAttemptTime,scheduleTime,status,httpTarget.uri)"
    exit 0 ;;
  pause|resume|run)
    gcloud scheduler jobs "$ACTION" "$JOB" "${scope[@]}" >/dev/null
    echo "Kész: $ACTION ($JOB)."
    exit 0 ;;
esac

read -r -a fields <<<"$SCHEDULE"
if [ "${#fields[@]}" -ne 5 ]; then
  echo "A --schedule öt mezős cron legyen (perc óra nap hónap hét napja), kaptam: $SCHEDULE" >&2
  exit 2
fi
# Microsoft 365-nél kb. 3 naponta, Gmailnél hetente kell megújítani a levél-feliratkozást.
if [ "${fields[2]}" != "*" ] || [ "${fields[3]}" != "*" ] || [ "${fields[4]}" != "*" ]; then
  echo "Figyelem: ez ritkább lehet a napinál. A levél-feliratkozások és a törlések ezen a hívásukon múlnak." >&2
fi

TOKEN="$(gcloud secrets versions access latest --secret=DISPATCHER_CONTROL_TOKEN --project "$PROJECT")"
common=(
  --schedule="$SCHEDULE" --time-zone="$TIME_ZONE" --http-method=POST
  --uri="${ORIGIN%/}/api/v1/internal/ai-audit-retention"
  --attempt-deadline=300s --max-retry-attempts=2 --min-backoff=60s
)

if gcloud scheduler jobs describe "$JOB" "${scope[@]}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${scope[@]}" "${common[@]}" --update-headers="x-dispatcher-token=${TOKEN}" >/dev/null
  echo "Frissítve: $JOB ($SCHEDULE, $TIME_ZONE)."
else
  gcloud scheduler jobs create http "$JOB" "${scope[@]}" "${common[@]}" --headers="x-dispatcher-token=${TOKEN}" >/dev/null
  echo "Létrehozva: $JOB ($SCHEDULE, $TIME_ZONE)."
fi
echo "Kipróbálás: bash ops/tools/daily-maintenance-scheduler.sh --run-now"
