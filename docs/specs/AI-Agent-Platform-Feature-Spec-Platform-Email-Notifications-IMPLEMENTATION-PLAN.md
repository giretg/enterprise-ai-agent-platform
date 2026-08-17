# Implementációs terv — Platformszintű e-mail értesítések

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.2 (grillezés utáni, tiketesíthető bontás)
**Dátum:** 2026-08-12
**Alapdokumentum:** `AI-Agent-Platform-Feature-Spec-Platform-Email-Notifications.md` (v0.1, döntések D1–D9, munkacsomagok WP-1…WP-7)
**Státusz:** **Tiketesíthető.** A §6 grillezés-kérdések eldöntve (lásd §1), a WP-k konkrét issue-kra bontva (§4), sorrend és függőségek rögzítve (§5).

---

## 1. A grillezésen meghozott döntések (v0.1 §6 lezárása)

A négy nyitott kérdésre született válasz. Kettő **eltér az eredeti spec feltevésétől** — ezeket alább külön kiemelem, mert érintik az adatmodellt és a címzett-feloldást.

### D5-FRISS — Címzett-feloldás (⚠ eltér az eredeti D5-től)

Az eredeti D5 a határidő-értesítést kizárólag a ticket **felelőséhez** (`assignee`) irányította. A döntés kibővíti: a **készítő és a felelős egyaránt** megkapja.

| Kiváltó ok | Címzett (v1) | Feloldás |
|---|---|---|
| **Ticket-határidő** | a ticket **készítője ÉS felelőse** | `Ticket.createdById` → `User.email` **és** `assigneeType='human'` → `assigneeId` → `User.email`; mindkettő tenant-tagság ellenőrzéssel, deduplikálva (ha a kettő ugyanaz a user, egy levél) |
| **Rendszerhiba-riasztás** | a tenant **adminjai** | `TenantMembership` admin szerep → `User.email` |
| **Platform-szintű hiba** (`tenantId: null`) | platform-ügyelet | `email:platform-ops`, szerveroldali konfig (változatlan D7) |

**Következmény:** a WP-1 lánc a `createdById`-t **és** az `assigneeId`-t is szelektálja és vezeti át. A csatorna-nyelvtan (D5) bővül: `email:creator` és `email:assignee`. A resolver a két címzettet **deduplikálja** (azonos user → egy levél, egy `dedupKey`).

### D5b — Agent-felelős / nem-humán készítő → admin-eszkaláció

Ha a határidő-értesítés természetes címzettje **nem humán** (a ticketet agent hozta létre, vagy a felelős agent és nincs humán készítő), a jel **nem vész el**: a tenant adminjaihoz eszkalálódik (`email:role:admin`). Így nincs vak folt.

### D8-FRISS — Nudge-időzítés monitoronként konfigurálható (⚠ eltér az eredeti D8-tól)

Az eredeti D8 fix platform-politikát írt (T-24h / T-2h / lejárat után). A döntés: az időzítés **figyelő-szabályonként (monitoronként) állítható**. A három stage marad az alapértelmezés, de a monitor-szerkesztőben felülírható.

**Következmény:** új `nudgeStages` konfiguráció a monitoron (séma + validáció + UI). Ez a WP-5-öt és a WP-7-et is bővíti (lásd EMAIL-10, EMAIL-13). Az idempotencia-kulcs változatlan: `<ticketId>:<stage>`.

### D-Unsub — Leiratkozás nincs a v1-ben

A felhasználó a v1-ben **egyik levéltípusról sem** tud leiratkozni. Minden rendszer-levél kézbesül. A leiratkozás (különösen a nudge-okra) **v2 scope**. A sablonban (WP-6) így most **nincs** „leiratkozás" link, de a levél kimondja, mi váltotta ki és hol állítható a forrás-monitor.

### Egyéb (v0.1 §6 maradék)

- **Digest tenant-határa:** a digest tenantonként szegregált marad (D6 miatt kötelező); ha egy user több tenant tagja, **tenantonként külön** digestet kap.

---

## 2. Adatmodell-változások

Három séma-érintés. Mind Prisma-migráció (`app/prisma/schema.prisma`), tenant-scoped, a meglévő konvenciók szerint.

### 2.1 `EmailDelivery` (új tábla — WP-4)

Kézbesítési napló és idempotencia-horgony.

| Mező | Típus | Megjegyzés |
|---|---|---|
| `id` | uuid (pk) | |
| `tenantId` | uuid \| null | `null` = platform-szintű (D7); indexelt |
| `dedupKey` | string **(unique)** | `<ticketId>:<stage>` határidőnél; hibánál `<source>:<correlationId>` |
| `channel` | string | a feloldott `email:*` csatorna |
| `recipientEmail` | string | a feloldott cím (audit + bounce-korreláció) |
| `recipientUserId` | uuid \| null | a feloldott user, ha van |
| `status` | enum | `queued` \| `sent` \| `delivered` \| `bounced` \| `complained` \| `suppressed` \| `failed` |
| `providerMessageId` | string \| null | Scaleway message id |
| `stage` | string \| null | `t-24h` \| `t-2h` \| `overdue` \| `system` |
| `errorReason` | string \| null | |
| `retryCount` | int | default 0 |
| `createdAt` / `updatedAt` / `sentAt` | datetime | |

Indexek: `@@unique([dedupKey])`, `@@index([tenantId, status])`, `@@index([recipientEmail])`.

### 2.2 Nudge-konfiguráció a monitoron (D8-FRISS — WP-5/WP-7)

A `Monitor` (vagy a monitor-konfig JSON) kap egy `nudgeStages` mezőt:

```jsonc
// alapértelmezés, ha nincs felülírva
{ "stages": [
    { "key": "t-24h",   "offsetMinutes": -1440 },
    { "key": "t-2h",    "offsetMinutes": -120  },
    { "key": "overdue", "offsetMinutes": 0, "afterDue": true }
] }
```

Validáció: legfeljebb N stage (pl. 5), egyedi `key`, monoton offset. Ha üres → nincs nudge (csak audit).

### 2.3 `SuppressedRecipient` (könnyű — WP-4)

Bounce/complaint után a címet meg kell jelölni, hogy ne próbálkozzunk vég nélkül. Megoldható az `EmailDelivery` lekérdezésével is, de dedikált kis tábla (`email`, `reason`, `since`) tisztább és gyorsan indexelhető. **Döntés a fejlesztőre bízva** — a terv az egyszerűbb, lekérdezés-alapú változatot preferálja v1-ben.

---

## 3. Címzett-feloldás nyelvtana (D5-FRISS konszolidálva)

A `RecipientResolver` a strukturált csatorna-stringből old fel, **minden ágon D6 tenant-invariánssal**:

| Csatorna | Feloldás | Fallback |
|---|---|---|
| `email:creator` | `Ticket.createdById` → `User` | nem-humán készítő → `email:role:admin` (D5b) |
| `email:assignee` | `assigneeType='human'` → `assigneeId` → `User` | nem-humán/nincs felelős → kihagyva (a készítő és/vagy admin viszi) |
| `email:role:admin` | `TenantMembership` admin tagjai | üres lista → `email.recipient.rejected` audit |
| `email:user:<uuid>` | konkrét user, tenant-ellenőrzéssel | tenant-idegen → elutasítás (D6) |
| `email:platform-ops` | szerveroldali konfig-lista | — (nem tenant-adat, D7) |

A határidő-értesítés a `creator` és az `assignee` **halmazát** oldja fel, majd **deduplikál** (azonos user egyszer kap). Szabad e-mail cím **soha** (D5). A feloldott cím kötelezően a monitor tenantjának **aktív** tagja (D6), kivéve `platform-ops`.

---

## 4. Issue-bontás (WP → GitHub issue)

13 issue, hét mérföldkőre osztva. Címkejavaslat mindegyikhez: `area:notifications`, plusz a jelölt típuscímke.

### Mérföldkő A — Címzett a láncon (WP-1)

#### EMAIL-1 — Deadline-lekérdezés + collector: készítő és felelős átvezetése
**Cél:** a határidő-jel tudja, kiről szól (készítő + felelős).
**Scope:**
- `app/src/repositories/postgres/monitor-repository.ts` — `collectUpcomingTicketDeadlines` `select`-je egészüljön ki: `createdById`, `assigneeType`, `assigneeId` (jelenleg csak `id, tenantId, title, dueBy, state`).
- `UpcomingTicketDeadline` típus bővítése ugyanezekkel.
- `app/src/domain/monitor/collectors/deadline-collector.ts` — a készítő és a felelős átvezetése a signal payloadba.

**Acceptance:**
- A `DeadlineCollector` payloadjában megjelenik a `createdById` és az `assigneeType`/`assigneeId` (a felelős közvetlen címzett, a D5b eszkalációhoz is ez kell).
- Meglévő deadline-tesztek zöldek; új egységteszt a payload-mezőkre.

**Függőség:** — **Becslés:** S (0,5–1 nap) · **Címke:** `type:enhancement`

#### EMAIL-2 — `RecipientResolver` + D5 nyelvtan + D6 invariáns
**Cél:** csatorna-stringből biztonságos, tenant-helyes címzett.
**Scope:**
- Új `app/src/domain/notify/recipient-resolver.ts` a §3 táblázat szerint.
- `email:creator` → `createdById`; `email:assignee` → `assigneeId` (humán); a határidő a kettő **halmazát** oldja fel és **deduplikál** (azonos user → egy címzett, egy `dedupKey`).
- Nem-humán készítő → `email:role:admin` (D5b); nincs/nem-humán felelős → az adott ág kihagyva.
- `email:role:admin` a `TenantMembership`-ből; `email:user:<uuid>` tenant-ellenőrzéssel.
- Sikertelen/tenant-idegen feloldás → `email.recipient.rejected` audit + üres címzettlista (nem dob — NFR-2).

**Acceptance:**
- **Valós-Postgres invariáns-teszt (D6):** cross-tenant user feloldása → elutasítás + audit. Ez a spec egyetlen kötelező valós-DB tesztje.
- Egységtesztek minden csatorna-ágra, a creator+assignee **deduplikációra**, és a D5b eszkalációra.

**Függőség:** EMAIL-1 · **Becslés:** M (2 nap) · **Címke:** `type:enhancement`, `security`

#### EMAIL-3 — `MonitorNotificationInput.recipients` mező
**Cél:** a feloldott címzettek végigérjenek a notifier-sínen.
**Scope:**
- `app/src/lib/notify/monitor-notifier.ts` — `recipients: ResolvedRecipient[]` a `MonitorNotificationInput`-ra.
- A `MonitorService` a resolvert hívja és tölti a mezőt (best-effort, NFR-2).

**Acceptance:** a `recipients` végigmegy a `RoutingMonitorNotifier`-ig; a meglévő `chat`/`telegram` ág nem törik (a mező opcionális rájuk nézve).
**Függőség:** EMAIL-2 · **Becslés:** S · **Címke:** `type:enhancement`

### Mérföldkő B — Transport (WP-2)

#### EMAIL-4 — `EmailTransport` interfész + Scaleway TEM adapter
**Cél:** provider mögé rejtett, fail-closed küldés (D3).
**Scope:**
- `EmailTransport { send(message): Promise<TransportResult> }` interfész.
- Scaleway TEM adapter; idempotencia-kulcs = `EmailDelivery.dedupKey`.
- Titkok a meglévő `resolveSecret` mintán, **fail-closed** (nincs kulcs → nem küld, auditál).
- Provider EU-korlát dokumentálva (NFR-1).

**Acceptance:** adapter-egységteszt mockolt Scaleway-vel; hiányzó secret → fail-closed + audit; interfész-szerződés teszt.
**Függőség:** — (párhuzamosítható A-val) · **Becslés:** M · **Címke:** `type:feature`

#### EMAIL-5 — Feladó-domain + DKIM/SPF/DMARC + dedikált subdomain (D2)
**Cél:** reputáció-elválasztás; az agent-forgalom sose ronthatja a rendszer-levelek kézbesíthetőségét.
**Scope (infra/ops, nagyrészt nem kód):**
- Dedikált `notifications.<domain>` subdomain a Scaleway TEM-ben, SPF/DKIM/DMARC rekordok.
- Domain-verifikáció; reputáció-monitor bekötése.

**Acceptance:** verifikált domain; teszt-levél átmegy SPF/DKIM/DMARC ellenőrzésen (mail-tester ≥ 9/10).
**Függőség:** — · **Becslés:** S (de átfutás DNS-propagáció miatt) · **Címke:** `type:ops`, `infra`

### Mérföldkő C — Notifier + audit (WP-3)

#### EMAIL-6 — `EmailNotifier implements MonitorNotifier` + bekötés
**Cél:** egyszerre éled a határidő-, dispatcher- és folyamat-riasztás.
**Scope:**
- `app/src/lib/notify/email-monitor-notifier.ts` a `TelegramMonitorNotifier` mintájára (delegál transport + delivery + resolver felé; best-effort, nem dob).
- Bekötés: `app/src/domain/index.ts` `RoutingMonitorNotifier` `email` kulcs (ma csak `chat` + `telegram` van, ~174. sor).

**Acceptance:** `email:*` csatornájú monitor valós levelet küld (staging); ismeretlen provider továbbra is audit-only fallbackre esik.
**Függőség:** EMAIL-3, EMAIL-4, EMAIL-8 · **Becslés:** M · **Címke:** `type:feature`

#### EMAIL-7 — Audit-események regisztrálása
**Cél:** minden kimenet auditált (NFR-3).
**Scope:**
- `app/src/lib/audit/event-catalog.ts` — új kulcsok: `email.sent`, `email.failed`, `email.suppressed`, `email.recipient.rejected`, `email.bounced` (ma csak `monitor.notify.sent/.failed` van).

**Acceptance:** minden küldési kísérlet pontosan egy audit-sort ír; katalógus-teszt zöld.
**Függőség:** — (EMAIL-6-tal együtt mergelhető) · **Becslés:** S · **Címke:** `type:enhancement`

### Mérföldkő D — Kézbesítési napló + bounce (WP-4)

#### EMAIL-8 — `EmailDelivery` séma + migráció + idempotencia
**Cél:** „miért nem kaptam levelet" megválaszolható; NFR-5 idempotencia.
**Scope:** §2.1 tábla + Prisma-migráció; `dedupKey` unique; a notifier a küldés előtt beszúr/felold (upsert a dedupKey-re).
**Acceptance:** ugyanaz a `dedupKey` kétszer → egy kiküldött levél (idempotencia-teszt, söprés-újrafutás szimulációval).
**Függőség:** — · **Becslés:** M · **Címke:** `type:feature`

#### EMAIL-9 — Scaleway Topics&Events webhook + bounce-visszacsatolás
**Cél:** delivery/bounce/complaint állapot visszaírása; címek elnémítása.
**Scope:**
- Webhook-végpont (`app/src/app/api/.../scaleway-events/route.ts`) **aláírás-ellenőrzéssel**.
- `EmailDelivery.status` frissítése az eseményből; bounce/complaint → címzett suppress (§2.3).

**Acceptance:** szimulált bounce-esemény → `status=bounced` + suppress; aláírás nélküli hívás elutasítva.
**Függőség:** EMAIL-8 · **Becslés:** M · **Címke:** `type:feature`, `security`

### Mérföldkő E — Rate-limit / digest / kill-switch (WP-5, D8-FRISS + D9)

#### EMAIL-10 — Nudge-stage motor (monitoronként konfigurálható)
**Cél:** eszkaláló, ticketenként korlátozott nudge; a stage-ek monitoronként állíthatók (D8-FRISS).
**Scope:**
- §2.2 `nudgeStages` konfig + validáció.
- Stage-számítás a `dueBy`-hoz képest; a `dedupKey=<ticketId>:<stage>` biztosítja, hogy stage-enként max egy levél (ticketenként ≤ a stage-ek száma).

**Acceptance:** T-24h/T-2h/overdue pontosan egyszer tüzel ticketenként; egyedi monitor-config felülírja az alapértelmezést; söprés-újrafutás nem duplikál.
**Függőség:** EMAIL-8 · **Becslés:** M · **Címke:** `type:feature`

#### EMAIL-11 — Rate-limit + digest + kill-switch
**Cél:** megbolondult dispatcher se áraszthasson el senkit (D9).
**Scope:**
- Per-tenant és globális órás/napi plafon; plafon fölött **digest** (tenantonként szegregált).
- `email.kill_switch` a `PlatformSettingsService`-ben, a monitor kill-switch mintájára; rendszer-oldali vezérlő.

**Acceptance:** plafon fölött nincs eldobott üzenet, hanem digest; kill-switch = azonnali némítás; egységtesztek a küszöbökre.
**Függőség:** EMAIL-8 · **Becslés:** M–L · **Címke:** `type:feature`

### Mérföldkő F — Sablonok (WP-6)

#### EMAIL-12 — Sablonréteg (HTML + plain, magyar, D4)
**Cél:** közérthető levél (NFR-4): *mit észleltünk, miért kapod, mit tegyél, link a ticketre*.
**Scope:**
- Saját renderelés (nincs React Email); HTML + plain-text.
- D4: „erre a címre ne válaszolj" + `Reply-To` nem figyelt címre; link a board-ticketre.
- **Nincs** leiratkozás-link (D-Unsub, v1).

**Acceptance:** HTML+plain paritás; a válaszolhatatlanság-közlés jelen van; link a ticketre helyes; snapshot-teszt.
**Függőség:** — · **Becslés:** M · **Címke:** `type:feature`, `ux`

### Mérföldkő G — UI (WP-7)

#### EMAIL-13 — Strukturált csatorna-választó + per-monitor nudge UI
**Cél:** ne lehessen „vakon" `email:...`-t beírni, ami audit-onlyra fut; a nudge-stage-ek állíthatók.
**Scope:**
- `app/src/components/monitors/monitor-editor-form.tsx` — a `notifyChannel` szabad szöveges input helyett strukturált választó (provider + cél a D5 nyelvtan szerint).
- Per-monitor `nudgeStages` szerkesztő (D8-FRISS).

**Acceptance:** csak érvényes `email:*` csatorna menthető; a UI egyértelmű, ha nudge-t állít; a mentett config megjelenik EMAIL-10-ben.
**Függőség:** EMAIL-2 (nyelvtan), EMAIL-10 (config) · **Becslés:** M · **Címke:** `type:feature`, `ux`

---

## 5. Sorrend, függőségek, mérföldkövek

Kritikus út: **EMAIL-1 → EMAIL-2 → EMAIL-3 → EMAIL-6**, mert a „címzett a láncon" a valódi rés. Párhuzamosítható vele a transport (EMAIL-4/5) és a napló (EMAIL-8).

```
A: EMAIL-1 ─► EMAIL-2 ─► EMAIL-3 ─┐
B: EMAIL-4 ──────────────────────┤
   EMAIL-5 (infra, párhuzam)      ├─► C: EMAIL-6 ─► EMAIL-7
D: EMAIL-8 ─► EMAIL-9 ────────────┘        │
E: EMAIL-8 ─► EMAIL-10, EMAIL-11 ──────────┤
F: EMAIL-12 (párhuzam) ────────────────────┤
G: EMAIL-2,10 ─► EMAIL-13 ─────────────────┘
```

Javasolt szállítási vágások:
- **MVP (belső, staging):** A + EMAIL-4 + EMAIL-8 + EMAIL-6 + EMAIL-7 + EMAIL-12 → egy határidő-levél valósan kimegy, auditált, idempotens.
- **v1 (éles-kész):** + EMAIL-5 (domain), EMAIL-9 (bounce), EMAIL-11 (rate-limit/kill-switch), EMAIL-13 (UI).
- **v1.1:** EMAIL-10 per-monitor nudge finomítás, ha a fix alapértelmezés az MVP-ben elég volt.

Durva összbecslés: ~7 issue M, 4 S, 2 M–L → nagyságrend **3–4 fejlesztő-hét** egy emberrel, a domain-propagáció (EMAIL-5) átfutásától függően.

---

## 6. Nem-funkcionális garanciák (a spec §5 leképzése issue-kra)

- **NFR-1 EU-adatkezelés:** EMAIL-4 (adapter EU-korlát), EMAIL-5 (EU-domain).
- **NFR-2 best-effort:** EMAIL-2/3/6 — a küldési hiba nem bukatja a söprést (a `MonitorService` try/catch + audit mintája marad).
- **NFR-3 auditálhatóság:** EMAIL-7 + EMAIL-8.
- **NFR-4 közérthetőség:** EMAIL-12.
- **NFR-5 idempotencia:** EMAIL-8 (`dedupKey` unique) + EMAIL-10 (stage-kulcs).

---

## 7. Kockázatok és kontrollok

| Kockázat | Kontroll | Issue |
|---|---|---|
| Cross-tenant szivárgás (a kódbázis visszatérő mintája) | D6 invariáns + valós-Postgres teszt | EMAIL-2 |
| Megbolondult dispatcher elárasztja a postafiókot | rate-limit + digest + kill-switch | EMAIL-11 |
| Söprés-újrafutás duplikál | idempotens `dedupKey` upsert | EMAIL-8, EMAIL-10 |
| Rossz kézbesíthetőség / spam | dedikált domain + SPF/DKIM/DMARC + bounce-feedback | EMAIL-5, EMAIL-9 |
| Provider-kiesés / -váltás | `EmailTransport` interfész, tartalék Mailjet (EU) | EMAIL-4 |
| „Vakon" beírt e-mail csatorna audit-onlyra fut | strukturált UI-választó | EMAIL-13 |
| Webhook-hamisítás | aláírás-ellenőrzés | EMAIL-9 |

---

## 8. Lezárt döntés — a határidő-levél címzettje

**A határidő-levelet a ticket készítője ÉS felelőse is megkapja** (deduplikálva). Ez lezárja a v0.1 assignee-alapú irányát: nem vagy-vagy, hanem mindkettő. A resolver a `creator` + `assignee` halmazt oldja fel és deduplikál (EMAIL-2). Nincs séma-változás a bővítéshez — az `assigneeType`/`assigneeId` már a `Ticket`-en van, a `createdById` szintén.
