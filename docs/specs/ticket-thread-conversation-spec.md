# Ticket-szál (Jira-szerű beszélgetés + agent-visszaadás) — fejlesztői specifikáció

**Státusz:** v0.2 — döntések lezárva, kód még nincs
**Dátum:** 2026-07-05
**Szerző-kontextus:** a ticket-detail ma csak az eredeti feladatot mutatja, a megoldó válaszát gyakran nem, és nincs Jira-szerű, időrendi, szerzőhöz kötött komment-szál. A user pontosítást akar tudni fűzni a ticketbe, majd visszaadni felelősnek az AI agentet, aki újrafeldolgozza.

---

## 1. Cél és nem-cél

### 1.1 Cél
1. **Jira-szerű szál a ticketen:** feladat → válaszok → viszontválaszok/kommentek **egymás alatt, időrendben, szerzőhöz (ember/agent) kötve.**
2. **A megoldó válasza mindig látszik** — függetlenül attól, hogy wiki, general vagy folyamat-step futásból jött.
3. **Pontosítás + visszaadás hurok:** a user kommentet ír, és egy kattintással **visszaadja felelősnek az agentet**, aki a releváns szál-kivonat (eredeti feladat + korábbi válaszok + a friss pontosítás + csatolmány-kivonatok) birtokában újrafuttat, majd az új válasz a szál **következő** eleme lesz — a régit **nem törli.**
4. **Komment-csatolmányok:** a user kommenthez fájlt vagy vágólapról beillesztett screenshotot csatolhat; ezek látszanak a szálban, és handback esetén az agent kontextusába is bekerülnek.
5. **Egységes szál-nézet** agent-interaction, ember-hozzárendelt és folyamat/step ticketeken.

### 1.2 Nem-cél (első kör)
- Nem építünk valós idejű (websocket) chatet; a szál oldalfrissítéssel (`router.refresh()`) jelenik meg, mint ma.
- Nem migráljuk a szálat a `Message`/`Conversation` modellre (lásd D1 döntés).
- Nem vezetünk be @-mention / értesítés / e-mail-notifikációt (későbbi kör; a horog meglesz).
- Nem bontjuk fészkes (nested reply-to-reply fa) szerkezetűre — **lineáris, időrendi** szál, opcionális `parentId`-vel a jövőre (lásd §4.2).
- Nem építünk teljes fájlkezelőt a kommentekhez: v1-ben csak feltöltés / vágólap-screenshot / preview / letöltés van, verziózás és csatolmány-törlés nincs.

---

## 2. Jelenlegi állapot (kód-térkép)

| Réteg | Fájl | Mit csinál ma |
|---|---|---|
| Adatmodell | `app/prisma/schema.prisma` — `Ticket` (1427), `TicketTransition` (1600) | `payload.answer` = **egyetlen** legutóbbi válasz; `payload.followUpNotes[]` = lapos pontosítás-lista; `payload.transitionNote` = legutóbbi indoklás. A `Message`/`Conversation` (1354/1382) szálmodell csak agent-chathez kötött. |
| Állapotgép | `app/src/domain/ticket/ticket-type-config.ts` — `DEFAULT_TICKET_TRANSITIONS` (45) | Nincs `needs_info` állapot. Az újrafeldolgozás ma: `done→rejected` (operator) → `rejected→ready` (operator) → dispatcher. |
| Payload-hurok | `app/src/lib/wiki-ticket-payload.ts` | `appendWikiFollowUpNote` a note-ot `followUpNotes`-ba fűzi; **`clearWikiAnswerFields` az `rejected→ready` átmenetnél letörli az előző választ** (`ticket-service.ts:141`). |
| Válasz-írás (general) | `app/src/domain/agent/general-task-runtime.ts:143-149` | Nem-folyamat: `payload.answer = answer`. **Prompt csak `readTicketPromptText`-ből (73. sor) → a `followUpNotes`/`previousAnswer` NEM kerül a promptba.** |
| Válasz-írás (folyamat) | `general-task-runtime.ts:132` + `process-step-payload.ts` | `buildStepCompletionPayload` → az output kulcsonként a payloadba, **nem `answer` alá** → a detail „Wiki-válasz" kártya nem mutatja. |
| Válasz-írás (wiki) | `app/src/domain/agent/wiki-runtime.ts:576` | `wikiUserPrompt(payload)` — ez **beépíti** az eredeti kérdést + előző választ + pontosítást. Csak a wiki úton jó ma. |
| UI | `app/src/components/tickets/ticket-detail.tsx` | Külön kártyák: „Feladat" (476), „Pontosító kérések" lista (484), „Wiki-válasz" 1 db (497). Nincs összefűzött szál. |
| UI (history) | `app/src/components/tickets/ticket-history.tsx` | `TicketTransition` idővonal — állapotváltások, nem beszélgetés. |
| Akciók | `app/src/app/actions/platform.ts` — `transitionTicket` (519), `createBoardTicket` (242), `getTicket` (430) | A komment csak a `transitionTicket.note`-on át megy, és kényszerít egy állapotátmenetet. Nincs önálló „komment hozzáadása". |
| Routing | `app/src/lib/ticket-process-route.ts` | `payload.source` alapján wiki vs general runtime. |

### 2.1 Az öt fő hiány
1. **Nincs megőrzött válasz-történet** — minden újrafutás felülírja/törli az előzőt.
2. **Nincs összefűzött, attribuált, időrendi szál-nézet** — 3 különálló kártya.
3. **A komment nem elsőrangú** — csak a visszadobás-textareán át, `rejected` állapotot kényszerítve.
4. **A general/folyamat runtime nem is látja a pontosítást** újrafuttatáskor (csak a wiki).
5. **Nincs kommenthez kötött csatolmány** — fájlok/screenshotok ma nem részei a beszélgetési szálnak.

---

## 3. Döntések (a tervezés kiindulópontja)

| # | Döntés | Választott irány |
|---|---|---|
| **D1** | Hol él a szál? | **Új `TicketComment` tábla** (a `TicketTransition` mintájára). A struktúrált gépi válasz maradhat a payloadban (visszafelé kompat.), de a **megjelenítés forrása és az igazság a `TicketComment` szál.** |
| **D2** | Hogyan adja vissza a user az agentnek? | **Új lágy állapot: `needs_info`.** Új átmenetek: `done→needs_info` / `awaiting_human→needs_info` (`creator_or_operator`), `needs_info→ready` (system/operator). A `rejected` marad a valódi elvetésre. |
| **D3** | Hatókör | **Mind:** agent-interaction + ember-hozzárendelt + folyamat/step ticketek egységes szál-nézetet kapnak. **Handback v1-ben csak nem-folyamat ticketeken**; folyamat/step ticketeken komment igen, agentnek visszaadás nem. |
| **D4** | Fészkelés | V1-ben **lineáris szál**. `parentId` bekerül a sémába, de a UI és az API nem használja még vizuális behúzásra. |
| **D5** | Backfill | Lesz visszamenőleges, idempotens backfill a meglévő `payload.answer` / `payload.followUpNotes` adatokból. Legacy fallback maradhat átmenetileg, de az új UI elsődlegesen komment-szálból olvas. |
| **D6** | Kommentjog | Viewer akkor írhat kommentet, ha ő a ticket létrehozója; minden operator+ írhat. Handbacket a ticket-létrehozó vagy operator+ indíthat, ha a ticket nem folyamat-ticket. |
| **D7** | Formázás | Komment body markdownként renderelhető, sanitizált whitelisttel. Méretlimit: 16 KB body / komment. |
| **D8** | Csatolmány | Kommenthez max. 8 csatolmány kapcsolható. Fájl és vágólapról beillesztett screenshot támogatott; a screenshot `image/png` `Document` lesz, preview-val. |
| **D9** | Auto-handback | Handback csak emberi akció lehet; agent nem adhatja vissza magának a ticketet. |
| **D10** | `payload.answer` | V1-ben duplán írunk (`payload` + `TicketComment`) kompatibilitásért. Kivezetés csak későbbi körben, miután minden olvasó átállt a komment-szálra. |
| **D11** | Hosszú szál prompt | Az agent nem kapja meg vakon a teljes végtelen szálat: token-budgetelt thread context kell (eredeti feladat + utolsó N releváns komment + legutóbbi agent-válasz + legutóbbi human pontosítás + csatolmány-kivonatok). |

---

## 4. Adatmodell

### 4.1 Új: `TicketComment` tábla

```prisma
enum TicketCommentKind {
  human_comment    // ember által írt komment/pontosítás
  agent_answer     // agent-futás végeredménye (a szál "válasz" eleme)
  agent_progress   // opcionális: agent köztes megjegyzés (nem-cél az 1. körben, de a kind engedi)
  system_note      // rendszerüzenet (pl. "újrafuttatásra visszaadva")
}

enum TicketCommentAttachmentKind {
  file
  screenshot
}

model TicketComment {
  id            String            @id @default(uuid()) @db.Uuid
  ticketId      String            @map("ticket_id") @db.Uuid
  seq           Int               // időrendi, per-ticket monoton (unique(ticketId, seq))
  kind          TicketCommentKind
  authorType    AuditActorType    @map("author_type")   // human | agent | system
  authorUserId  String?           @map("author_user_id") @db.Uuid
  authorAgentId String?           @map("author_agent_id") @db.Uuid
  authorDisplayName String?        @map("author_display_name") // történeti név-snapshot
  agentVersion  Int?              @map("agent_version")   // reprodukálhatóság az agent-válaszhoz
  body          String                                     // a látható szöveg (markdown-plain)
  structured    Json?                                      // agent_answer: {sources, rationale, confidence, model, toolCallCount}
  parentId      String?           @map("parent_id") @db.Uuid  // jövőbeli fészkeléshez; 1. körben null
  transitionId  String?           @map("transition_id") @db.Uuid // melyik állapotváltáshoz kötődik (ha van)
  createdAt     DateTime          @default(now()) @map("created_at") @db.Timestamptz

  ticket      Ticket                    @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  authorUser  User?                     @relation("TicketCommentAuthorUser", fields: [authorUserId], references: [id])
  authorAgent Agent?                    @relation("TicketCommentAuthorAgent", fields: [authorAgentId], references: [id])
  parent      TicketComment?            @relation("TicketCommentThread", fields: [parentId], references: [id])
  children    TicketComment[]           @relation("TicketCommentThread")
  attachments TicketCommentAttachment[]

  @@unique([ticketId, seq])
  @@index([ticketId, createdAt])
  @@map("ticket_comments")
}

model TicketCommentAttachment {
  id          String                      @id @default(uuid()) @db.Uuid
  commentId   String                      @map("comment_id") @db.Uuid
  documentId  String                      @map("document_id") @db.Uuid
  seq         Int                         // kommenten belüli determinisztikus sorrend
  kind        TicketCommentAttachmentKind
  filename    String
  mimeType    String?                     @map("mime_type")
  byteSize    Int?                        @map("byte_size")
  createdAt   DateTime                    @default(now()) @map("created_at") @db.Timestamptz

  comment  TicketComment @relation(fields: [commentId], references: [id], onDelete: Cascade)
  document Document      @relation(fields: [documentId], references: [id], onDelete: Restrict)

  @@unique([commentId, seq])
  @@index([documentId])
  @@map("ticket_comment_attachments")
}
```

**Indoklás a mezőkre:**
- `seq` — a `Message.seq` mintája: determinisztikus időrend, `@@unique([ticketId, seq])`. Verseny ellen **nem elég** a sima `MAX(seq)+1`: a repository `SERIALIZABLE` tranzakciót + unique-ütközés retryt használ, vagy PostgreSQL advisory lockot fog ticketenként. A választott implementációt teszt fedje.
- `authorDisplayName` — audit-szerű történeti snapshot. Ha a user vagy agent később átneveződik / törlődik, a szál továbbra is érthető marad.
- `structured` — az `agent_answer` gépi metaadata (források, konfidencia, model). A `body` a látható szöveg; a `structured` a badge-ekhez / reprodukcióhoz. Így a payload `answer`/`sources` mezők **kivezethetők** hosszú távon, de az 1. körben duplán is írhatók (kompat.).
- `parentId` — most mindig `null`; a séma előrelát a fészkes válaszokra anélkül, hogy migrálni kéne.
- `transitionId` — a `needs_info` visszaadás rendszer-kommentjét a hozzá tartozó `TicketTransition`-höz köti (audit-korreláció).
- `TicketCommentAttachment` — a tényleges fájl a meglévő `Document` táblában él, a kapcsolótábla pedig rögzíti, hogy melyik kommenthez, milyen sorrendben és milyen szereppel (`file` / `screenshot`) tartozik. Így a chatben már használt dokumentum-kivonatolás és kép-preview logika újrahasznosítható.

**`Ticket` reláció-kiegészítés:** `comments TicketComment[]`.
**`Agent`/`User` reláció-kiegészítés:** a fenti nevesített relációk visszfele.
**`Document` reláció-kiegészítés:** `ticketCommentAttachments TicketCommentAttachment[]`.

### 4.2 Fészkelés (viszontválasz-fa) — 1. kör vs. később
A user „viszontválaszok is lehetnek egymás alatt" kérése **lineáris időrenddel teljesül v1-ben** (mint egy Jira-komment folyam). A `parentId` a séma-szinten **jelen van**, de a UI és a logika 1. körben lineáris. Ha később kell vizuális behúzás/threading, csak UI/API munka, migráció nélkül.

### 4.3 Állapotgép-bővítés (`needs_info`)

Új `TicketState` enum-érték: `needs_info` (a `prisma` enumba, `TICKET_STATES` tömbbe, `TICKET_STATE_LABELS`/`TICKET_STATE_TONE`-ba).

Új transition policy actor: `creator_or_operator`. Ez akkor enged át, ha az aktor operator+ szerepű, vagy human viewer, akinek `userId === ticket.createdById`. Erre azért van szükség, mert a ticket ügyfele gyakran viewer, de a saját ticketjét visszaadhatja pontosításra.

Új szabályok a `DEFAULT_TICKET_TRANSITIONS`-ban (`ticket-type-config.ts`):

```
{ from: 'done',          to: 'needs_info', allowed: 'creator_or_operator' }, // "pontosítás + visszaadás" nem-folyamat ticketen
{ from: 'awaiting_human',to: 'needs_info', allowed: 'creator_or_operator' }, // agent kérdésére válasz + visszaadás nem-folyamat ticketen
{ from: 'needs_info',    to: 'ready',      allowed: 'system_or_operator' }, // dispatch-ra állítás
{ from: 'needs_info',    to: 'rejected',   allowed: 'operator' },   // meggondoltam, mégis elvetem
```

**Megjegyzés:** a `needs_info→ready` átmenetkor a runtime a szálból építi a promptot (lásd §6), így **nincs szükség a `clearWikiAnswerFields` törlésre** — sőt, azt ki kell vezetni (§6.3).

**Fontos migrációs pont:** a meglévő perzisztált ticket-type configok ma nem kapják meg automatikusan az új default átmeneteket. V1-ben vagy adat-migráció merge-öli a hiányzó default rule-okat minden mentett configba, vagy a `normalizeTicketTypeConfig` módosul úgy, hogy a default átmeneteket hozzáadja a valid perzisztált átmenetekhez, ha hiányoznak. Ezt külön teszt fedje.

### 4.4 Process-ticket handback policy
Folyamat/step ticketeken v1-ben:
- komment és csatolmány hozzáadható;
- agent-válasz szál-elemként megjelenik;
- **handback gomb nincs**, és `addTicketComment({ handBackToAgent: true })` szerveroldalon is hibát ad.

Indok: a process ticket `board_write` útja a Playbook state machine-en át zár, és könnyű lenne a folyamatot véletlenül továbbvinni vagy inkonzisztens step rework állapotba tenni. A későbbi megoldás neve legyen explicit, pl. `step_rework_requested`, ne a sima ticket handback viselje el rejtetten.

---

## 5. Szerver-oldali API / akciók

### 5.1 Új: `addTicketComment`
`app/src/app/actions/platform.ts`

```ts
addTicketComment(input: {
  ticketId: string
  body: string
  attachmentDocumentIds?: string[] // max 8, előzetesen feltöltött Document ID-k
  handBackToAgent?: boolean   // ha true: a komment után done|awaiting_human → needs_info → ready
})
```
Viselkedés:
1. Jogosultság:
   - operator+ bármely tenant-scope ticketen írhat;
   - viewer csak akkor írhat, ha ő a ticket `createdById` értéke;
   - handbacket operator+ vagy a ticket létrehozója indíthat.
2. Validáció:
   - `body.trim().length <= 16 KB`;
   - legalább `body` vagy 1 csatolmány kötelező;
   - max. 8 csatolmány / komment;
   - `attachmentDocumentIds` csak a jelenlegi user által feltöltött, tenant-scope-ban látható, még nem más kommenthez kötött dokumentum lehet.
3. Beszúr egy `TicketComment { kind: 'human_comment', authorType: 'human', authorUserId, authorDisplayName, body }`.
4. Beszúrja a `TicketCommentAttachment` sorokat a dokumentumokhoz.
5. Ha `handBackToAgent`:
   - csak ha a ticketen **van felelős agent** (`ticket.agentId != null`); ember-hozzárendelt ticketnél a gomb nem elérhető.
   - csak ha **nem** folyamat-ticket (`processInstanceId == null`); process/step ticketen szerveroldali hiba.
   - csak emberi aktorral hívható; agent/system nem indíthat handbacket.
   - `services.tickets.transition(→ needs_info)` majd `→ ready` (a `needs_info→ready` a re-dispatch trigger).
   - Beszúr egy `TicketComment { kind: 'system_note', authorType: 'system', body: 'Visszaadva újrafeldolgozásra', transitionId }`.
   - Meghívja a meglévő `runAgentTicketDispatch(ticketId, agentId)`-t (mint a `createBoardTicket`-ben).
6. Audit: `audit.append({ action: 'ticket.comment.add' | 'ticket.handback', targetType: 'ticket', ... })`.

Atomitás:
- a human comment + attachment linkek + transitionök + system note + audit-események egy adatbázis-tranzakcióban történjenek;
- a dispatch indítása a tranzakció után történjen. Ha a dispatch nem indul (budget/paused/error), a komment és a `ready` állapot megmarad, az action warningot ad vissza, és auditba kerül a dispatch warning/error;
- dupla kattintás ellen legyen idempotencia guard: ugyanattól a usertől ugyanarra a ticketre rövid időablakban azonos `body` + azonos attachment ID-k + `handBackToAgent` ne indítson két dispatch-et.

### 5.2 Új: `uploadTicketCommentAttachment`
`app/src/app/actions/platform.ts`

```ts
uploadTicketCommentAttachment(formData: FormData)
// mezők: ticketId, file, kind? = 'file' | 'screenshot'
```

Viselkedés:
1. Ugyanazt az írhatósági jogosultságot használja, mint az `addTicketComment` komment-írás része.
2. A fájlt a meglévő `Document` modellbe menti (`connectorId: null`, `uploadedById`, `mimeType`, `metadata.ticketCommentDraft = true`).
3. Screenshot vágólapról: a kliens `ClipboardEvent` / `navigator.clipboard` alapján `image/png` `File`-t készít, pl. `screenshot-2026-07-05-143012.png` névvel, és ugyanide tölti fel.
4. Engedélyezett típusok v1-ben: képek (`image/png`, `image/jpeg`, `image/webp`, `image/gif`), PDF, txt/markdown, CSV, docx, xlsx. Méretlimit: 25 MB / fájl.
5. Válasz: `{ documentId, filename, mimeType, kind, previewDataUrl? }`. Képnél preview visszaadható, vagy a kliens az eredeti `File` object URL-jét használja beküldésig.
6. Árva draft dokumentumok takarítása külön cron/script lehet: `metadata.ticketCommentDraft == true` és nincs `TicketCommentAttachment` 24 órán túl.

### 5.3 Új: `listTicketComments`
`listTicketComments({ ticketId })` → `TicketComment[]` időrendben (`seq ASC`), az author snapshotokkal és attachment view modellekkel dúsítva. Viewer olvashatja tenant-scope-on belül.

### 5.4 Módosítás: `transitionTicket`
- A meglévő `note`-alapú visszadobás **marad** (valódi elvetés), de amikor `note` van, a szerver **egyúttal beszúr egy `TicketComment`-et** is (`kind` a cél-állapottól függ: `human_comment`), hogy a note ne vesszen el a szálból. Így a régi „Visszadobás + indoklás" is a szálba kerül.

### 5.5 Content-guard / audit
- A `body` sanitizált markdownként renderelődik, és áthalad a meglévő audit content-guard rétegen (redakció), mint a `Message` tartalom.
- A csatolmány metaadatai auditba kerülnek (`filename`, `mimeType`, `byteSize`, `documentId`), de nagy bináris tartalom nem.
- Kép/screenshot promptba csak kontrollált formában kerül: ha a runtime támogat képet, image inputként; különben filename + extracted text / image marker összefoglalóként.

---

## 6. Runtime-változások (a szál mint kontextus)

### 6.1 Egységes szál→prompt építő
Új lib: `app/src/lib/ticket-thread-prompt.ts`
```ts
buildThreadContextPrompt(input: {
  comments: TicketCommentWithAttachments[]
  originalTask: string
  maxChars?: number
}): string
```
A `wikiUserPrompt` általánosítása: „Eredeti feladat" + token-budgetelt szál-lenyomat (ki mit mondott: `agent_answer` / `human_comment`), külön kiemelve a **legutóbbi pontosítást** („a felhasználó ezt kéri most"). A wiki-specifikus JSON-kimeneti utasítás **nem** kerül ide (az marad wiki-specifikus).

Kontextus-policy v1:
- mindig szerepeljen az eredeti feladat;
- mindig szerepeljen a legutóbbi human komment és annak csatolmánylistája;
- szerepeljen a legutóbbi agent-válasz;
- szerepeljen az utolsó N releváns komment időrendben (pl. 10), amíg a `maxChars` engedi;
- régi vagy túl hosszú elemek összefoglalva / levágva kerüljenek be, ne nyersen;
- csatolmányoknál a prompt tartalmazza a filename-et, mime type-ot, és ha van extracted textet / képleíró markert. Képi model input külön későbbi optimalizálás, de a screenshot legalább dokumentumként legyen hivatkozva.

### 6.2 `GeneralTaskRuntime` — a szál beépítése
`general-task-runtime.ts:73` körül: a `question` építésénél, ha a ticketnek van `TicketComment` szála (>1 elem, azaz volt már válasz + pontosítás), a promptba **be kell fűzni** a `buildThreadContextPrompt` kimenetét. Ez javítja a ma meglévő hibát, hogy a general agent nem látja a pontosítást.
- KB-search query desztillálásához (`distillKbSearchQuery`) a **legutóbbi pontosítást** is figyelembe kell venni (ma csak a `question`-t).
- A komment-csatolmány `Document`-eket a már létező attachment loader logikával kell betölteni, és `formatAttachmentBlock`-szerűen kell a promptba illeszteni.
- Folyamat-ticketen a runtime továbbra is ír `agent_answer` szál-elemet, de a v1 handback tiltott, ezért process re-dispatch kontextusépítés nincs első körben.

### 6.3 A válasz mint szál-elem, törlés kivezetése
- A `board_write` completion után (mind general, mind wiki, mind folyamat) a runtime beszúr egy `TicketComment { kind: 'agent_answer', authorType: 'agent', authorAgentId, authorDisplayName, agentVersion, body: answer, structured: {sources, rationale, confidence, model, toolCallCount} }`-et.
- A `payload.answer` írása **maradhat** (kompat., 1. kör), de a UI igazsága a szál.
- **`clearWikiAnswerFields` kivezetése** a `ticket-service.ts` `rejected→ready` ágból (141-147): mostantól nem törlünk választ, mert a szál megőrzi a történetet, és a `needs_info→ready` úton a szál a kontextus. A `followUpNotes` append-only lista **átmenetileg** maradhat kompat. miatt, de a UI már a szálból renderel.

### 6.4 Folyamat/step ticketek
- A `buildStepCompletionPayload` outputja mellé is beszúrjuk az `agent_answer` szál-elemet (a `body` a lépés emberi olvasható összefoglalója / a fő output mező), így a detail szál-nézet a folyamat-lépéseknél is mutat választ.
- V1-ben nincs `needs_info→ready` re-dispatch folyamat-ticketen. Ha egy későbbi körben step rework kell, azt külön állapottal / Playbook state machine integrációval kell specifikálni, nem ezzel a generic handbackkel.

---

## 7. UI

### 7.1 Új komponens: `TicketThread`
`app/src/components/tickets/ticket-thread.tsx` — a „Feladat" kártya alá kerül, a „Wiki-válasz" / „Pontosító kérések" külön kártyák **helyére** (azok kivezetve).
- Fejléc: az eredeti feladat (mint az első, rögzített szál-elem).
- Időrendi elemek, mindegyik: szerző-avatar/badge (Ember / AI agent / Rendszer), név, időbélyeg, `kind`-függő stílus (agent_answer = kiemelt kártya forrás-badge-ekkel; human_comment = buborék; system_note = halvány sor).
- `agent_answer` elemnél a `structured`-ból: konfidencia-badge, forrás-badge-ek, model (mint ma a „Wiki-válasz" kártyán).
- `human_comment` elemnél csatolmánylista: képeknél inline thumbnail/preview, nem-képnél fájl-chip filename + mime type + letöltés/open action.

### 7.2 Új komponens: `TicketCommentComposer`
A szál alján egy textarea + attachment sor + két gomb:
- **„Komment hozzáadása"** → `addTicketComment({ handBackToAgent: false })`.
- **„Pontosítás + visszaadás az agentnek"** (csak ha `ticket.agentId`, állapot ∈ {done, awaiting_human}, és `!ticket.processInstanceId`) → `addTicketComment({ handBackToAgent: true })`. Ez váltja ki a mai „Visszadobás→Újra feldolgozás" kézi táncot nem-folyamat ticketeken.
- Üres body akkor engedett, ha van legalább egy csatolmány; body és csatolmány nélküli submit → hiba.
- Attachment UX:
  - paperclip / file input több fájlhoz;
  - drag&drop opcionális, ha könnyen illeszkedik a meglévő ticket file dropzone-hoz;
  - textarea `onPaste`: ha a clipboard image itemet tartalmaz, `File`-t készít `screenshot-<timestamp>.png` névvel, feltölti `kind: 'screenshot'` értékkel, majd preview chipet mutat;
  - feltöltés közben pending állapot és eltávolítás gomb a még be nem küldött draft csatolmányokra;
  - max. 8 csatolmány és 25 MB/fájl kliensoldali elővalidáció.

### 7.3 `TicketActions` egyszerűsítése
- A `rejected`/`ready`/`approve` gombok maradnak a **valódi** governance-hez (jóváhagyás, elvetés). A „pontosítás" ága átkerül a Composerbe. A „Visszadobás" note-ja továbbra is a szálba kerül (§5.3).
- Új `needs_info` állapot label/tone hozzáadása (`ticket-labels.ts`): pl. „Pontosításra vár" / warning tone.
- Process/step ticketen a composerben csak komment/attachment submit látszik, handback gomb nem.

### 7.4 `TicketMeta` tisztítása
- A „Wiki-válasz" és „Pontosító kérések" kártyák eltávolítása (a szál veszi át). A „Feladat", „Metaadatok", „Hozzárendelve", „Agent anatómia", „Payload (debug)" marad.

---

## 8. Migráció / backfill

1. **Prisma migráció:** `needs_info` enum-érték, `TicketCommentKind`, `TicketCommentAttachmentKind`, `ticket_comments`, `ticket_comment_attachments`, relációk. `db push` dev + test.
2. **Backfill script** (`app/scripts/backfill-ticket-comments.ts`): a meglévő ticketek payloadjából szál-elemeket generál időrendi közelítéssel:
   - eredeti `question`/`task` → nem kell külön elem (a feladat a Ticket-en van).
   - `payload.answer` (+ sources/rationale/confidence) → 1 `agent_answer` elem (`createdAt ≈ ticket.updatedAt`, `agentVersion` a payloadból).
   - `payload.followUpNotes[]` → `human_comment` elemek (időbélyeg-közelítés a `TicketTransition`-ökből, ha van).
   - Idempotens (ha már van komment a ticketen, kihagyja).
3. A `followUpNotes`/`answer` payload-mezők **nem törlődnek** a backfillnél (kompat.).
4. **Ticket-type config migráció:** a meglévő perzisztált configokba be kell merge-ölni a hiányzó `needs_info` default átmeneteket, vagy a normalizálóban kell garantálni a merge-et. A kettő közül egyet válasszunk, de a behavior ne függjön attól, hogy a tenantnak korábban volt-e mentett configja.
5. Backfill csatolmányokra nincs: meglévő payloadban nincs megbízható komment-csatolmány struktúra. A korábbi ticket workspace fájlok maradnak a ticket file panelben, nem kötjük őket visszamenőleg konkrét kommenthez.

---

## 9. Governance / audit / biztonság

- Minden komment és handback **audit-eseményt** ír (`ticket.comment.add`, `ticket.handback`), a meglévő hash-láncba.
- A handback re-dispatch a meglévő `runAgentTicketDispatch` governance-ét örökli (per-dispatch efemer agent-kulcs, loop-guard — lásd a retry-loop javítást).
- **Loop-guard:** handback csak emberi akció lehet; agent/system nem indíthatja. Automatizált handback nincs v1-ben. Dupla submit/idempotencia guard kell, hogy egy user action ne indítson két dispatch-et.
- Content-guard a `body`-n (redakció + méretlimit), attachmenteknél MIME/size allowlist.
- Jogosultság: olvasás viewer+; komment írása operator+, illetve a ticket-létrehozó viewer; handback operator+ vagy ticket-létrehozó, csak nem-folyamat ticketen.
- Attachment audit: `ticket.comment.attachment.uploaded` opcionális audit-esemény, vagy a `ticket.comment.add` metadata része. Mindkét esetben legyen visszakereshető `documentId`, `filename`, `mimeType`, `byteSize`, `kind`.

---

## 10. Tesztek (elvárt lefedettség)

1. `TicketComment` repository: `seq` monotonitás verseny alatt, `@@unique` ütközés/retry vagy advisory lock kezelése.
2. `TicketCommentAttachment` repository: max 8, sorrend, csak jogosult / saját draft dokumentum köthető, ugyanaz a document nem köthető két kommenthez.
3. Állapotgép: `done→needs_info` / `awaiting_human→needs_info` engedélyezett `creator_or_operator` aktornak nem-folyamat ticketen; `needs_info→ready` engedélyezett system/operator aktornak; `viewer` csak creator-handback esetben; `needs_info→rejected` engedélyezett; process ticket handback tiltott.
4. Ticket-type config merge: meglévő perzisztált config mellett is elérhetők az új `needs_info` átmenetek.
5. `addTicketComment` sima komment: creator viewer és operator+ jogosultság, body-only, attachment-only és body+attachment eset.
6. `addTicketComment` handback: beszúr komment + attachment linkek + system_note + átmenetek + audit, majd dispatch hívás (mock); dispatch hiba warningként tér vissza, komment nem vész el.
7. Clipboard screenshot UI: paste eventből `image/png` draft attachment lesz, preview megjelenik, submit után a kommenthez kapcsolódik.
8. `GeneralTaskRuntime`: ha van szál, a prompt tartalmazza a legutóbbi pontosítást és a csatolmányok filename/extracted text részét (a mai hiány regresszió-tesztje).
9. Válasz-megőrzés: két egymást követő futás után **két** `agent_answer` elem van (nincs törlés).
10. Backfill: payload→komment leképezés, idempotencia.
11. Folyamat-step: `agent_answer` elem beszúrása step-completionkor; handback API és UI tiltott process ticketen.

---

## 11. Munkacsomagok (javasolt sorrend)

| WP | Tartalom | Függ |
|---|---|---|
| **WP-1** | Prisma: `needs_info` enum, `TicketCommentKind`, `TicketCommentAttachmentKind`, `ticket_comments`, `ticket_comment_attachments`, relációk; `db push` dev/test | — |
| **WP-2** | `ticket-type-config.ts` átmenetek + `TICKET_STATES` + labels/tone + persisted config merge/migráció | WP-1 |
| **WP-3** | `TicketComment` + `TicketCommentAttachment` repository (seq-safe create, list, attachment link validation) + interfészek | WP-1 |
| **WP-4** | Akciók: `uploadTicketCommentAttachment`, `addTicketComment`, `listTicketComments`, `transitionTicket` note→komment; atomitás/idempotencia | WP-3 |
| **WP-5** | `ticket-thread-prompt.ts` + `GeneralTaskRuntime`/`WikiRuntime` szál-kontextus + attachment context + `agent_answer` beszúrás + `clearWikiAnswerFields` kivezetés | WP-3 |
| **WP-6** | Folyamat-step: `agent_answer` beszúrás; process handback tiltás UI/API teszttel | WP-5 |
| **WP-7** | UI: `TicketThread`, `TicketCommentComposer`, paste screenshot/file attachment UX, `TicketMeta`/`TicketActions` átszervezés | WP-4 |
| **WP-8** | Backfill script + futtatás; legacy fallback ellenőrzés | WP-3 |
| **WP-9** | Tesztek (§10) + tsc/eslint zöld | mind |

---

## 12. Lezárt döntések v1-re

- **Fészkelés:** lineáris szál; `parentId` csak séma-szinten.
- **Backfill:** igen, idempotensen, payloadból; csatolmány-backfill nincs.
- **Folyamat-step:** komment és agent-answer szál igen; handback tiltott v1-ben.
- **Kommentjog:** operator+ írhat; creator viewer is írhat a saját ticketjére; handback operator+ vagy creator, nem-folyamat ticketen.
- **Formázás:** sanitizált markdown, 16 KB body limit.
- **Csatolmány:** max 8 / komment, 25 MB / fájl; file upload + vágólap-screenshot támogatott.
- **Auto-handback:** nincs; csak emberi action.
- **`payload.answer`:** v1-ben duplán írjuk, kivezetés későbbi kör.
- **Persisted transition config:** kötelező merge/migráció, mert a mentett configok nem kapják meg maguktól az új default rule-okat.
- **Prompt hossz:** token-budgetelt thread context, nem teljes végtelen szál.
