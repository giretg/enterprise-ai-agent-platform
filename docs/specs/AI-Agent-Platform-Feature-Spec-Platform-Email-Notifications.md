# Feature-spec — Platformszintű e-mail értesítések

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.1 (grillezésre váró tervezet)
**Dátum:** 2026-07-19
**Forrásdokumentumok:** `AI-Agent-Platform-Feature-Spec-Proactive-Monitor-done.md` (§7 értesítés, §8 governance), `AI-Agent-Platform-Feature-Spec-AuditLog-Observability-done.md` (§5 eseménykatalógus), `AI-Agent-Platform-Feature-Spec-IAM-RBAC-done.md` (tenant-tagság, szerepek)
**Olvasó:** fejlesztő(k). Feltételezi a `MonitorService`, a `MonitorNotifier` értesítési sín, a `Ticket` állapotgép, a `TenantMembership` és az append-only audit ismeretét.
**Státusz:** **Tervezet — kód nincs.** A döntések (D1–D9) rögzítve, a munkacsomagok (WP-1…WP-7) bontva. Grillezés után tiketesíthető.

---

## 1. Cél és hatókör

A platform ma **nem tud e-mailt küldeni**. Az egyetlen kimenő levél a Clerk meghívó-levele (`app/src/app/actions/platform.ts`, `inviteUser`); saját SMTP/ESP integráció nincs a kódbázisban.

Ez a spec **egyetlen funkciót** ír le: a **platform mint rendszer** küld tranzakciós e-mailt **belső, tenanton belüli felhasználóknak**. Tipikus kiváltó okok:

- humán felelősnek **lejáró vagy lejárt ticket-határidő**,
- **rendszerhiba-riasztás** (elakadt dispatch, blokkolt folyamat),
- monitor-eszkaláció, amit ma csak chat-webhookon lehet kiküldeni.

### Kifejezetten NEM tartozik ide

Az **agentenkénti, saját néven küldött e-mail** (per-agent identitás, bejövő ág, threadelt beszélgetés) **külön spec** tárgya. A két funkció kockázati osztálya gyökeresen eltér: itt sablonozott, rendszer-generált tartalom megy ismert címzettnek, ott LLM-generált tartalom kifelé. Az elválasztást a D2 invariáns kényszeríti ki.

Az agentek külső e-mail-küldése ma is megoldott a felhasználó által engedélyezett, delegált Gmailen keresztül (`gmail_send`, emberi jóváhagyási kapuval) — ez változatlan marad.

---

## 2. Kiindulási állapot (kód-alapvonal)

**Ami megvan és újrahasznosul:**

| Elem | Hol | Állapot |
|---|---|---|
| `MonitorNotifier` interfész | `app/src/lib/notify/monitor-notifier.ts` | Kész; a kommentben már szerepel az `email:` prefix mint tervezett eset |
| `RoutingMonitorNotifier` (prefix-alapú útválasztás) | ugyanott | Kész; ma csak a `chat` kulcs van bekötve (`app/src/domain/index.ts`) |
| `WebhookChatNotifier` (allowlistolt egress minta) | `app/src/lib/notify/webhook-chat-notifier.ts` | Kész; az e-mail-adapter ezt a governance-mintát követi |
| `deadline` monitor-collector | `app/src/domain/monitor/collectors/deadline-collector.ts` | Kész; a határidő-észlelés működik |
| Dispatcher- és folyamat-riasztás | `app/src/domain/dispatcher/dispatch-alert-notifier.ts`, `app/src/domain/playbook/process-alert-notifier.ts` | Kész; ugyanezen a sínen mennek, ma audit-only |
| `monitor.notify.sent` / `.failed` audit | `app/src/lib/audit/event-catalog.ts` | Regisztrálva |
| `Ticket.assigneeType` / `assigneeId` / `dueBy` | `app/prisma/schema.prisma` | Megvan az adat |

**A kritikus rés — a határidő-út névtelen:**

A `collectUpcomingTicketDeadlines` lekérdezés **nem szelektálja az assignee-t** (`app/src/repositories/postgres/monitor-repository.ts`), így a `DeadlineCollector` payloadjába sem kerül be, és a `MonitorNotificationInput` típusban sincs címzett-mező. **A jel, ami az értesítőhöz eljut, ma nem tudja, kiről szól.**

Ez a spec munkájának nagyobbik fele: nem az e-mail-küldés, hanem hogy **a címzett végigérjen a láncon** (repository → collector → notifier).

**Ami teljesen hiányzik:** transport, címzett-feloldás, kézbesítési napló, retry/idempotencia, rate-limit, sablonréteg, bounce-visszacsatolás.

---

## 3. Döntések

### D1 — Szolgáltató: Scaleway Transactional Email (TEM)

**Döntés:** a transport mögé első adapternek a **Scaleway TEM** kerül.

**Indoklás:**
- **EU-szuverenitás.** Francia cég (iliad Group), `fr-par` régió, a DPA szerint nincs US-infrastruktúra-függés. A kiküldött levél nem csak e-mail címet tartalmaz, hanem **ticket-címet is** — ez tenant-üzleti adat. Európai enterprise ügyfeleknek eladva a „minden alvállalkozónk EU-n belül van" válasz értékesítési eszköz, nem csak compliance-higiénia.
- **Költség.** 300 levél/hó ingyen, utána **€0,25/1000**. A várható volumenen (néhány száz levél/hó) ez havi tört euró. A „nagy free tier" mint szempont itt irreleváns.
- **Képességek megvannak:** domain-verifikáció SPF/DKIM/DMARC-kal, webhookok delivery/bounce/complaint eseményekre, JS SDK, beépített reputáció-pontszám.

**Vállalt hátrányok:**
- A DX egy lépcsővel a Resend alatt; **nincs React Email** — magunk renderelünk (ez amúgy is a terv, lásd WP-6).
- A webhookok a Scaleway **Topics and Events** rendszerén mennek, nem sima HTTP-callbackként → pár óra plusz bekötés (WP-4).
- Fiatalabb termék, rövidebb kézbesíthetőségi múlttal. A D3 interfész ezt kezelhetővé teszi.

**Elvetett alternatívák:** Resend / Postmark / AgentMail (mind US); MailerSend (US-bejegyzésű cég belga DC-vel); ZeptoMail (Zoho, nem EU). **Tartalék: Mailjet** (francia, Sinch-tulajdon, 6 000/hó free, érettebb) — ha a Scaleway kényelmetlennek vagy megbízhatatlannak bizonyul.

### D2 — A rendszer-e-mail feladó-domainje sosem osztozik agent-forgalommal (INVARIÁNS)

A platform-értesítések dedikált domainről/subdomainről mennek (pl. `notifications.<domain>`). Ha egy jövőbeli agent-levelet spamnek jelölnek, az **nem ronthatja el** a határidő-figyelmeztetések kézbesíthetőségét. A reputáció-elválasztás a feladó-identitásnál történik, nem a fióknál.

### D3 — Transport interfész mögött, provider-váltás fél nap

`EmailTransport` interfész + adapter. A providerváltás nem érintheti a notifier-t, a sablonokat, a címzett-feloldást és a kézbesítési naplót. **Korlát:** a mindenkori adapter szolgáltatója EU-n belül marad (D1 indoklása szerint).

### D4 — A rendszer-e-mail nem válaszolható

`Reply-To` egy nem figyelt címre mutat; a levél törzse **közérthetően kimondja**, hogy erre a címre nem érkezik válasz, és linkel a board-ticketre mint a tényleges akció helyére. Így **(A)-hoz nem kell bejövő ág**, és a felhasználó sem érzi úgy, hogy a semmibe beszél.

### D5 — Strukturált címzett-csatorna, szabad e-mail cím SOHA

A `notifyChannel` string strukturált marad:

| Csatorna | Feloldás |
|---|---|
| `email:assignee` | a ticket humán felelőse (`assigneeType='human'` → `assigneeId` → `User.email`) |
| `email:role:admin` | a tenant adminjai a `TenantMembership`-ből |
| `email:user:<uuid>` | konkrét user, tenant-ellenőrzéssel |

Szabad e-mail címet **szándékosan nem** engedünk: az azt jelentené, hogy bárki, aki monitort szerkeszthet, tenant-adatot irányíthat tetszőleges külső postafiókba. Ez ugyanaz a deny-by-default egress elv, amit a `WebhookChatNotifier` az env-allowlisttel érvényesít.

### D6 — Tenant-határ invariáns (INVARIÁNS, teszttel)

**A feloldott címzett kötelezően a monitor tenantjának aktív tagja.** Ha a feloldás tenant-idegen usert adna, a küldés elmarad és `email.recipient.rejected` audit keletkezik.

**Indoklás:** a kódbázisban visszatérő minta a cross-tenant szivárgás (roster, KB, tool-broker, agent-memória). Az e-mail ennek a leglátványosabb kifutója, mert **kifelé megy és visszavonhatatlan**. Ez a spec egyetlen olyan invariánsa, aminek külön, valós-Postgres teszt jár.

### D7 — A rendszer-riasztás (`tenantId: null`) csak platform-ügyeletnek megy

A dispatcher-elakadás ma `tenantId: null`-lal is jöhet, tehát platform-szintű. Egy belső dispatcher-hiba részletei **nem szivároghatnak ügyfélnek** — ezek kizárólag a platform-üzemeltetői címlistára mennek (`email:platform-ops`, szerveroldali konfigból, nem tenant-adatból).

### D8 — Nudge-politika: eszkaláló, ticketenként korlátozva

A határidő-monitor a 24 órás ablakban minden söpréskor újra jelez. A jel-szintű dedup tompítja, de **levél-szinten külön politika kell**:

- **T-24h**, **T-2h**, és **lejárat után egyszer** — ticketenként legfeljebb 3 levél.
- Az `EmailDelivery` tábla `dedupKey`-e (`<ticketId>:<stage>`) garantálja az idempotenciát; ugyanaz a stage kétszer nem megy ki.

### D9 — Rate-limit és digest kötelező, nem opcionális

Napi és órás küldési plafon **per tenant** és **globálisan**. A plafon fölött a rendszer nem dob el üzenetet, hanem **összevont (digest) levelet** küld. Kill-switch a meglévő `PlatformSetting`-en át (`email.kill_switch`), a monitor kill-switch mintájára.

**Indoklás:** egy megbolondult dispatcher percenként több száz riasztást generálna. Ez nem elméleti — a `dispatch-alert-notifier` minden blokkolt ticketre tüzel.

---

## 4. Munkacsomagok

### WP-1 — Címzett a láncon (a legfontosabb, ez a valódi rés)

- `collectUpcomingTicketDeadlines`: `assigneeType`, `assigneeId` felvétele a `select`-be és az `UpcomingTicketDeadline` típusba.
- `DeadlineCollector`: assignee átvezetése a signal payloadba.
- `MonitorNotificationInput`: `recipients: ResolvedRecipient[]` mező.
- `RecipientResolver` szolgáltatás a D5 csatorna-nyelvtanhoz, **D6 tenant-invariánssal**.
- **Teszt:** valós-Postgres invariáns-teszt a cross-tenant feloldás elutasítására.

### WP-2 — `EmailTransport` + Scaleway TEM adapter

- `EmailTransport` interfész (`send(message): Promise<TransportResult>`).
- Scaleway TEM adapter; idempotencia-kulcs = az `EmailDelivery.dedupKey`.
- Titkok a meglévő secret-kezelésen át, fail-closed (`resolveSecret` mintája).

### WP-3 — `EmailNotifier implements MonitorNotifier` + bekötés

- Bekötés a `RoutingMonitorNotifier` `email` kulcsára (`app/src/domain/index.ts`).
- **Ettől egyszerre él a határidő-, a dispatcher- és a folyamat-riasztás** — egy ponton kell hozzányúlni.
- Új audit-események regisztrálása a katalógusban: `email.sent`, `email.failed`, `email.suppressed`, `email.recipient.rejected`, `email.bounced`.

### WP-4 — `EmailDelivery` tábla + bounce-visszacsatolás

- Séma: `dedupKey` (unique), státusz, provider messageId, címzett, hibaok, retry-szám, időbélyegek.
- Scaleway **Topics and Events** webhook-végpont a delivery/bounce/complaint eseményekhez, aláírás-ellenőrzéssel.
- Bounce esetén a címzett jelölése, hogy ne próbálkozzunk vég nélkül.
- Enélkül nem megválaszolható a „miért nem kaptam levelet" kérdés.

### WP-5 — Rate-limit, digest, kill-switch (D8 + D9)

- Per-tenant és globális plafon; digest-összevonás a plafon fölött.
- Nudge-stage logika (T-24h / T-2h / lejárat után).
- `email.kill_switch` a `PlatformSettingsService`-ben + vezérlő a rendszer-oldalon.

### WP-6 — Sablonréteg

- Magyar nyelvű, **közérthető** sablonok a projekt UI-alapelve szerint: *mit észleltünk, miért kapod, mit tegyél, link a ticketre, hogyan állítsd le*.
- HTML + plain-text változat.
- D4: a „erre a címre ne válaszolj" közlés a sablon része.

### WP-7 — UI: csatorna-választó a monitor-szerkesztőben

A `notifyChannel` ma **szabad szöveges input** (`app/src/components/monitors/monitor-editor-form.tsx`). Emiatt ma beírható egy `email:...` csatorna, elmenthető, és a felhasználó **azt hiszi, megy a levél** — pedig audit-onlyra fut. Ezt strukturált választóra kell cserélni (provider + célt megadó mező), a D5 nyelvtan szerint.

---

## 5. Nem-funkcionális követelmények

- **NFR-1 (EU-adatkezelés).** A rendszer-e-mail alvállalkozója EU-n belül marad. Providerváltásnál is korlát.
- **NFR-2 (best-effort, nem blokkoló).** Az e-mail-küldés hibája **nem bukatja** a monitor-söprést, a dispatch-ciklust vagy a folyamat-futást — a `MonitorService` mai `try/catch` + audit mintája marad.
- **NFR-3 (auditálhatóság).** Minden küldési kísérlet auditált, a kézbesítés végállapota az `EmailDelivery`-ben visszakereshető.
- **NFR-4 (közérthetőség).** A levél hétköznapi nyelven íródik, magyarázó dobozzal és leállítási útmutatóval.
- **NFR-5 (idempotencia).** Ugyanaz a `dedupKey` kétszer nem eredményez kiküldött levelet, akkor sem, ha a söprés újrafut.

---

## 6. Nyitott kérdések a grillezéshez

1. **A `email:role:admin` a tenant *összes* adminjának menjen, vagy legyen egy dedikált „értesítési felelős" szerep?** A mai `TenantMembership.role` nem különbözteti meg.
2. **Kell-e per-user leiratkozás v1-ben?** Rendszer-kritikus riasztásnál a leiratkozhatóság kétélű — lehet, hogy csak a „nudge" típusú levelekre engedhető, a hiba-riasztásra nem.
3. **A digest-levél tenant-határa.** Ha egy user több tenant tagja, kapjon tenantonként külön digestet, vagy egyet? (A D6 invariáns miatt a tartalom mindenképp tenantonként szegregált.)
4. **A nudge-stage-ek (T-24h / T-2h) konfigurálhatók legyenek monitoronként, vagy fix platform-politika?**
5. **Mi történjen, ha egy ticket assignee-je `agent` típusú?** Ma a `DeadlineCollector` nem szűr rá — agent-felelősnél nincs kinek levelet küldeni, de a határidő attól még lejár. Menjen a tenant adminnak?
