#!/usr/bin/env bash
#
# 13 GitHub issue létrehozása a "Platform e-mail értesítések" problémakörhöz.
# Egységes cím-előtag:  [Platform e-mail értesítések] EMAIL-NN — ...
#
# Előfeltétel: gh CLI telepítve és bejelentkezve (gh auth status), a repo gyökeréből futtatva.
# Használat:   bash docs/specs/create-email-notification-issues.sh
# Szárazfutás: DRY_RUN=1 bash docs/specs/create-email-notification-issues.sh
#
set -euo pipefail

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
MILESTONE="Platform e-mail értesítések"
PREFIX="[Platform e-mail értesítések]"

echo "Repo: $REPO"

# --- Címkék (idempotens, --force upsert) ---
ensure_label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null 2>&1 || true; }
ensure_label "area:notifications" "1D76DB" "Platform e-mail értesítések problémakör"
ensure_label "type:feature"       "0E8A16" "Új funkció"
ensure_label "type:enhancement"   "A2EEEF" "Meglévő bővítése"
ensure_label "type:ops"           "5319E7" "Infra / üzemeltetés"
ensure_label "security"           "B60205" "Biztonsági érintettség"
ensure_label "ux"                 "FBCA04" "Felhasználói felület"

# --- Mérföldkő (idempotens) ---
gh api -X POST "repos/$REPO/milestones" -f title="$MILESTONE" \
  -f description="Platformszintű e-mail értesítések (spec v0.2 implementációs terv)" >/dev/null 2>&1 || true

create_issue() {
  local title="$1"; local labels="$2"; local body="$3"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "── DRY_RUN ── $title   [$labels]"
    return
  fi
  gh issue create \
    --repo "$REPO" \
    --title "$title" \
    --label "$labels" \
    --milestone "$MILESTONE" \
    --body "$body"
}

# ────────────────────────────────────────────────────────────────────────────
# Mérföldkő A — Címzett a láncon (WP-1)
# ────────────────────────────────────────────────────────────────────────────

create_issue "$PREFIX EMAIL-01 — Deadline-lekérdezés + collector: készítő és felelős átvezetése" \
"area:notifications,type:enhancement" \
'## Cél
A határidő-jel tudja, kiről szól: a ticket **készítője ÉS felelőse** is kell a payloadba.

## Scope
- \`app/src/repositories/postgres/monitor-repository.ts\` — \`collectUpcomingTicketDeadlines\` \`select\` bővítése: \`createdById\`, \`assigneeType\`, \`assigneeId\` (ma csak \`id, tenantId, title, dueBy, state\`).
- \`UpcomingTicketDeadline\` típus bővítése ugyanezekkel.
- \`app/src/domain/monitor/collectors/deadline-collector.ts\` — készítő + felelős átvezetése a signal payloadba.

## Acceptance
- [ ] A payloadban megjelenik \`createdById\` és \`assigneeType\`/\`assigneeId\`.
- [ ] Meglévő deadline-tesztek zöldek; új egységteszt a payload-mezőkre.

## Kapcsolat
Döntés: D5-FRISS (készítő + felelős). Függőség: — · Becslés: S (0,5–1 nap).'

create_issue "$PREFIX EMAIL-02 — RecipientResolver + D5 nyelvtan + D6 tenant-invariáns" \
"area:notifications,type:enhancement,security" \
'## Cél
Csatorna-stringből biztonságos, tenant-helyes címzett-feloldás.

## Scope
- Új \`app/src/domain/notify/recipient-resolver.ts\`.
- \`email:creator\` → \`createdById\`; \`email:assignee\` → \`assigneeId\` (humán). A határidő a kettő **halmazát** oldja fel és **deduplikál** (azonos user → egy címzett, egy dedupKey).
- Nem-humán készítő → \`email:role:admin\` (D5b); nincs/nem-humán felelős → az ág kihagyva.
- \`email:role:admin\` a \`TenantMembership\`-ből; \`email:user:<uuid>\` tenant-ellenőrzéssel.
- Tenant-idegen/sikertelen feloldás → \`email.recipient.rejected\` audit + üres lista (nem dob — NFR-2).

## Acceptance
- [ ] **Valós-Postgres invariáns-teszt (D6):** cross-tenant user → elutasítás + audit.
- [ ] Egységtesztek minden csatorna-ágra, a creator+assignee **deduplikációra**, és a D5b eszkalációra.

## Kapcsolat
Döntés: D5-FRISS, D5b, D6. Függőség: EMAIL-01 · Becslés: M (2 nap).'

create_issue "$PREFIX EMAIL-03 — MonitorNotificationInput.recipients mező" \
"area:notifications,type:enhancement" \
'## Cél
A feloldott címzettek végigérjenek a notifier-sínen.

## Scope
- \`app/src/lib/notify/monitor-notifier.ts\` — \`recipients: ResolvedRecipient[]\` a \`MonitorNotificationInput\`-ra (opcionális a chat/telegram ágra nézve).
- A \`MonitorService\` a resolvert hívja és tölti a mezőt (best-effort, NFR-2).

## Acceptance
- [ ] A \`recipients\` végigmegy a \`RoutingMonitorNotifier\`-ig.
- [ ] A meglévő \`chat\`/\`telegram\` ág nem törik.

## Kapcsolat
Függőség: EMAIL-02 · Becslés: S.'

# ────────────────────────────────────────────────────────────────────────────
# Mérföldkő B — Transport (WP-2)
# ────────────────────────────────────────────────────────────────────────────

create_issue "$PREFIX EMAIL-04 — EmailTransport interfész + Scaleway TEM adapter" \
"area:notifications,type:feature" \
'## Cél
Provider mögé rejtett, fail-closed küldés (D3).

## Scope
- \`EmailTransport { send(message): Promise<TransportResult> }\` interfész.
- Scaleway TEM adapter; idempotencia-kulcs = \`EmailDelivery.dedupKey\`.
- Titkok a meglévő \`resolveSecret\` mintán, **fail-closed** (nincs kulcs → nem küld, auditál).
- Provider EU-korlát dokumentálva (NFR-1).

## Acceptance
- [ ] Adapter-egységteszt mockolt Scaleway-vel.
- [ ] Hiányzó secret → fail-closed + audit.
- [ ] Interfész-szerződés teszt.

## Kapcsolat
Döntés: D1, D3. Függőség: — (párhuzamos A-val) · Becslés: M.'

create_issue "$PREFIX EMAIL-05 — Feladó-domain + DKIM/SPF/DMARC + dedikált subdomain" \
"area:notifications,type:ops" \
'## Cél
Reputáció-elválasztás: az agent-forgalom sose ronthassa a rendszer-levelek kézbesíthetőségét (D2 invariáns).

## Scope (nagyrészt infra/ops, nem kód)
- Dedikált \`notifications.<domain>\` subdomain a Scaleway TEM-ben.
- SPF / DKIM / DMARC rekordok; domain-verifikáció.
- Reputáció-monitor bekötése.

## Acceptance
- [ ] Verifikált domain.
- [ ] Teszt-levél átmegy SPF/DKIM/DMARC ellenőrzésen (mail-tester ≥ 9/10).

## Kapcsolat
Döntés: D2. Függőség: — (DNS-propagáció miatt átfutás) · Becslés: S + átfutás.'

# ────────────────────────────────────────────────────────────────────────────
# Mérföldkő C — Notifier + audit (WP-3)
# ────────────────────────────────────────────────────────────────────────────

create_issue "$PREFIX EMAIL-06 — EmailNotifier + RoutingMonitorNotifier bekötés" \
"area:notifications,type:feature" \
'## Cél
Egyszerre éled a határidő-, dispatcher- és folyamat-riasztás e-mail ága.

## Scope
- \`app/src/lib/notify/email-monitor-notifier.ts\` a \`TelegramMonitorNotifier\` mintájára (delegál transport + delivery + resolver felé; best-effort, nem dob).
- Bekötés: \`app/src/domain/index.ts\` \`RoutingMonitorNotifier\` \`email\` kulcs (ma csak \`chat\` + \`telegram\`, ~174. sor).

## Acceptance
- [ ] \`email:*\` csatornájú monitor valós levelet küld (staging).
- [ ] Ismeretlen provider továbbra is audit-only fallbackre esik.

## Kapcsolat
Függőség: EMAIL-03, EMAIL-04, EMAIL-08 · Becslés: M.'

create_issue "$PREFIX EMAIL-07 — Audit-események regisztrálása" \
"area:notifications,type:enhancement" \
'## Cél
Minden kimenet auditált (NFR-3).

## Scope
- \`app/src/lib/audit/event-catalog.ts\` — új kulcsok: \`email.sent\`, \`email.failed\`, \`email.suppressed\`, \`email.recipient.rejected\`, \`email.bounced\` (ma csak \`monitor.notify.sent/.failed\`).

## Acceptance
- [ ] Minden küldési kísérlet pontosan egy audit-sort ír.
- [ ] Katalógus-teszt zöld.

## Kapcsolat
Függőség: — (EMAIL-06-tal együtt mergelhető) · Becslés: S.'

# ────────────────────────────────────────────────────────────────────────────
# Mérföldkő D — Kézbesítési napló + bounce (WP-4)
# ────────────────────────────────────────────────────────────────────────────

create_issue "$PREFIX EMAIL-08 — EmailDelivery séma + migráció + idempotencia" \
"area:notifications,type:feature" \
'## Cél
„Miért nem kaptam levelet" megválaszolható; NFR-5 idempotencia.

## Scope
- Új \`EmailDelivery\` tábla (Prisma-migráció): \`dedupKey\` (unique), \`tenantId\` (null=platform), \`channel\`, \`recipientEmail\`, \`recipientUserId\`, \`status\` (queued/sent/delivered/bounced/complained/suppressed/failed), \`providerMessageId\`, \`stage\`, \`errorReason\`, \`retryCount\`, időbélyegek.
- Indexek: \`@@unique([dedupKey])\`, \`@@index([tenantId, status])\`, \`@@index([recipientEmail])\`.
- A notifier küldés előtt upsertel a dedupKey-re.

## Acceptance
- [ ] Ugyanaz a \`dedupKey\` kétszer → egy kiküldött levél (idempotencia-teszt, söprés-újrafutással).

## Kapcsolat
Döntés: D8, NFR-5. Függőség: — · Becslés: M.'

create_issue "$PREFIX EMAIL-09 — Scaleway Topics&Events webhook + bounce-visszacsatolás" \
"area:notifications,type:feature,security" \
'## Cél
Delivery/bounce/complaint állapot visszaírása; címek elnémítása.

## Scope
- Webhook-végpont (\`app/src/app/api/.../scaleway-events/route.ts\`) **aláírás-ellenőrzéssel**.
- \`EmailDelivery.status\` frissítése az eseményből.
- Bounce/complaint → címzett suppress (ne próbálkozzunk vég nélkül).

## Acceptance
- [ ] Szimulált bounce → \`status=bounced\` + suppress.
- [ ] Aláírás nélküli hívás elutasítva.

## Kapcsolat
Döntés: D3 (webhook Topics&Events). Függőség: EMAIL-08 · Becslés: M.'

# ────────────────────────────────────────────────────────────────────────────
# Mérföldkő E — Rate-limit / digest / kill-switch (WP-5)
# ────────────────────────────────────────────────────────────────────────────

create_issue "$PREFIX EMAIL-10 — Nudge-stage motor (monitoronként konfigurálható)" \
"area:notifications,type:feature" \
'## Cél
Eszkaláló, ticketenként korlátozott nudge; a stage-ek **monitoronként** állíthatók (D8-FRISS).

## Scope
- \`nudgeStages\` konfig a monitoron + validáció (alapértelmezés: T-24h / T-2h / lejárat után).
- Stage-számítás a \`dueBy\`-hoz képest; \`dedupKey=<ticketId>:<stage>\` → stage-enként max egy levél.

## Acceptance
- [ ] T-24h/T-2h/overdue pontosan egyszer tüzel ticketenként.
- [ ] Egyedi monitor-config felülírja az alapértelmezést.
- [ ] Söprés-újrafutás nem duplikál.

## Kapcsolat
Döntés: D8-FRISS (monitoronként állítható). Függőség: EMAIL-08 · Becslés: M.'

create_issue "$PREFIX EMAIL-11 — Rate-limit + digest + kill-switch" \
"area:notifications,type:feature" \
'## Cél
Megbolondult dispatcher se áraszthasson el senkit (D9).

## Scope
- Per-tenant és globális órás/napi plafon; plafon fölött **digest** (tenantonként szegregált).
- \`email.kill_switch\` a \`PlatformSettingsService\`-ben (\`platform-settings-service.ts\`), a monitor kill-switch mintájára; rendszer-oldali vezérlő.

## Acceptance
- [ ] Plafon fölött nincs eldobott üzenet, hanem digest.
- [ ] Kill-switch = azonnali némítás.
- [ ] Egységtesztek a küszöbökre.

## Kapcsolat
Döntés: D9. Függőség: EMAIL-08 · Becslés: M–L.'

# ────────────────────────────────────────────────────────────────────────────
# Mérföldkő F — Sablonok (WP-6)
# ────────────────────────────────────────────────────────────────────────────

create_issue "$PREFIX EMAIL-12 — Sablonréteg (HTML + plain, magyar, D4)" \
"area:notifications,type:feature,ux" \
'## Cél
Közérthető levél (NFR-4): mit észleltünk, miért kapod, mit tegyél, link a ticketre.

## Scope
- Saját renderelés (nincs React Email); HTML + plain-text változat.
- D4: „erre a címre ne válaszolj" + \`Reply-To\` nem figyelt címre; link a board-ticketre.
- **Nincs** leiratkozás-link (D-Unsub, v1).

## Acceptance
- [ ] HTML+plain paritás.
- [ ] A válaszolhatatlanság-közlés jelen van; ticket-link helyes.
- [ ] Snapshot-teszt.

## Kapcsolat
Döntés: D4, D-Unsub. Függőség: — (párhuzam) · Becslés: M.'

# ────────────────────────────────────────────────────────────────────────────
# Mérföldkő G — UI (WP-7)
# ────────────────────────────────────────────────────────────────────────────

create_issue "$PREFIX EMAIL-13 — Strukturált csatorna-választó + per-monitor nudge UI" \
"area:notifications,type:feature,ux" \
'## Cél
Ne lehessen „vakon" \`email:...\`-t beírni, ami audit-onlyra fut; a nudge-stage-ek állíthatók.

## Scope
- \`app/src/components/monitors/monitor-editor-form.tsx\` — a \`notifyChannel\` szabad szöveges input helyett strukturált választó (provider + cél a D5 nyelvtan szerint).
- Per-monitor \`nudgeStages\` szerkesztő (D8-FRISS).

## Acceptance
- [ ] Csak érvényes \`email:*\` csatorna menthető.
- [ ] A UI egyértelmű nudge-állításnál; a mentett config megjelenik EMAIL-10-ben.

## Kapcsolat
Döntés: D5, D8-FRISS. Függőség: EMAIL-02, EMAIL-10 · Becslés: M.'

echo "Kész. Létrehozott issue-k: 13 (mérföldkő: \"$MILESTONE\")."
