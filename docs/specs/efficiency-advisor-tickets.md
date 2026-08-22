# Hatékonysági tanácsadó — jegybontás

Forrás: **issue [#237](https://github.com/giretg/enterprise-ai-agent-platform/issues/237)** (ötlet) ·
**spec-issue [#304](https://github.com/giretg/enterprise-ai-agent-platform/issues/304)** ·
spec: [`AI-Agent-Platform-Feature-Spec-Efficiency-Advisor.md`](./AI-Agent-Platform-Feature-Spec-Efficiency-Advisor.md)

A bontás **vertikális szeleteket** követ: az M1 pótolja azt a két mérési hiányt, ami nélkül
az elemzés nem lehetséges, az M2 a tiszta detektor-magot hozza (DB nélkül tesztelhetően), az
M3 köti be az adat-utat és a felületet, az M4 adja az egy kattintásos alkalmazást. Minden
mérföldkő önmagában is szállítható; a kártya az M3 végén demózható.

A jegyek a spec **Implementation Decisions** és **Testing Decisions** fejezeteire hivatkoznak,
nem nyitják újra őket.

**Sorszám-előtag:** `[Efficiency Advisor] EFF-NN — …` · **mérföldkő:** `Efficiency Advisor`

---

## Előfeltétel

## EFF-00 — Spec a main-re + címkék, mérföldkő

**Mérföldkő:** M0 · **Prioritás:** Magas · **Függés:** —

**Probléma:** a feature spec a #302-vel felkerült a mainre, de a jegybontás
(`efficiency-advisor-tickets.md`) és az issue-létrehozó szkript még csak a
`claude/issue-237-spec-jnie55` ágon élt — a #305–#318 jegyek így nem tudtak a
mainen lévő docra hivatkozni.

**Feladat:**
- Ez a jegybontás + `create-efficiency-advisor-issues.sh` merge-e a mainre
  (a feature spec már a mainen van: #302).
- A `Efficiency Advisor` mérföldkő és az `area:efficiency` címke létrehozása /
  frissítése (ld. a szkript; az `area:efficiency` címke már létezik).
- A #237 ötlet-issue összekötése a spec-issue-val (kereszthivatkozás, `idea` címke marad).

**DoD:** a spec **és** a jegybontás elérhető a mainen; a jegyek hivatkozásai működnek.

---

# M1 — a hiányzó mérés pótlása

Cél: a **per-futás** elemzés adatalapja meglegyen. E nélkül a detektorok időbélyeg-illesztésre
és eszközönként eltérő JSON-alakra épülnének — pontosan az a törékenység, amit a #180 WP-2
a `ModelCall`-nál már megszüntetett.

## EFF-01 — `ToolCall.agentTurnId`: séma, migráció, bekötés

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** EFF-00

**Probléma:** a `ToolCall` ma csak `ticketId`/`conversationId`-hoz köt. Egy chat-futás
eszközhívásait csak az `AgentTurn.startedAt`/`finishedAt` ablakkal lehetne a fordulóhoz
rendelni — párhuzamos fordulóknál ez nem megbízható.

**Feladat:**
- Prisma: `ToolCall.agentTurnId` (`agent_turn_id`, `@db.Uuid`, **nullable**), reláció az
  `AgentTurn`-re `onDelete: SetNull`, index `@@index([agentTurnId])`. Az `AgentTurn` oldalon
  `toolCalls ToolCall[]` — a `modelCalls` mintájára.
- Migráció a soron következő sorszámmal, és **le is kell futtatni** a dev DB-n
  (`prisma migrate deploy`) — több korábbi feature azon bukott, hogy a migráció készen állt,
  de sosem futott le.
- Írás-oldal:
  - `chat-tool-loop.ts` `recordInternalToolCall` — `params.context.agentTurnId` átadása;
  - broker-út: az `agentTurnId` átvezetése a `ToolBrokerInvokeInput`-on a
    `tool-broker-audit.ts` `createToolCall` hívásáig.
- **Nincs backfill:** a bevezetés előtti sorokon `null` marad.

**DoD:** `prisma migrate status` tiszta; egy chat-forduló minden eszközhívása (broker-alapú és
belső egyaránt) a saját `agentTurnId`-jével kerül a táblába; a task/ticket-ág sorai
változatlanul `ticketId`-vel köthetők.

---

## EFF-02 — Egységes `result_chars` a tool-eredmény metaadatban

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** EFF-00

**Probléma:** a `ToolCall.resultMeta` eszközönként más alakú (`tool-broker-support.ts`
`resultMeta()`), és **egyik ág sem tárolja egységesen az eredmény hosszát**. A túlméretezett
kimenet detektorának pont ez kell.

**Feladat:**
- A `resultMeta()` minden ága kiegészül egy egységes `result_chars` mezővel: a modell
  csatornájára kerülő **nyers** hasznos teher karakter-hossza (nem a becsomagolt `modelText`).
- A `tool_result_read` ág változatlan — ott a szám már ma megvan
  (`argsMeta.returned_chars` / `total_chars`).
- **Metaadat, nem tartalom:** a mező szám, nem szövegrészlet. JSON-mező, ezért nincs migráció.

**DoD:** minden `ToolCall` soron (ok/denied/error ágon is) ott a `result_chars`; a mező
soha nem tartalmaz eredmény-szöveget; a broker meglévő tesztjei zöldek.

---

# M2 — detektor-mag (tiszta, DB nélkül tesztelhető)

Cél: a teljes felismerő logika **egy tiszta modulban**, a `turn-cost-signals.ts` mintájára —
küszöbök + `resolve…Thresholds` + `describe…` szövegkulcsok, minden I/O a hívóban.

## EFF-03 — `efficiency-advisor.ts` váz: típusok, küszöbök, minta-méret kapu

**Mérföldkő:** M2 · **Prioritás:** Magas · **Függés:** EFF-00

**Feladat:**
- Új modul `app/src/domain/agent/efficiency-advisor.ts`:
  - a normalizált bemenet típusai (futásonként a modellhívások token-sora és az eszközhívások
    metaadatai) és a kimeneti **hatékonysági kártya** típusa;
  - `EFFICIENCY_ADVISOR_THRESHOLDS` + `resolveEfficiencyAdvisorThresholds(env)` — érvénytelen
    érték az alapértékre esik vissza, a küszöb **hangolható, elnémítani nem**;
  - a három kártya-állapot: *rendben* / *van megállapítás* / *nincs elég adat*;
  - minta-méret kapu: legalább 3 elemezhető futás, és a minta legalább kettőben megjelenik.
- `scripts/efficiency-advisor.test.ts` + `npm run test:efficiency-advisor`
  (`node:assert/strict`, a `scripts/turn-cost-signals.test.ts` stílusában).

**DoD:** 1–2 futásból „nincs elég adat" állapot jön, nem minta; a küszöb-feloldás tesztelt;
a modul nem importál Prismát, nem olvas órát.

---

## EFF-04 — Detektor 1: ismétlődő visszaolvasás

**Mérföldkő:** M2 · **Prioritás:** Magas · **Függés:** EFF-03

**Feladat:** újraolvasásnak számít (a) a `tool_result_read` hívás `resultMeta.redundant === true`
vagy `resultMeta.blocked === true` értékkel, és (b) minden olyan olvasó hívás, amelynél ugyanaz a
forrás-kulcs a futáson belül többször szerepel — a forrás-kulcs szabálya a `loop-stop-decision.ts`
`toolCallSourceKey`-e (`path` / `documentId` / `url` / `pageId` / `id`), **nem** új heurisztika.
Mérőszám: az újraolvasó hívások aránya + a hozzájuk tartozó karakter-mennyiség, token-becslés
~4 karakter/token (ugyanaz, amit a `turn-cost-signals.ts` használ).

**DoD:** a mért incidens alakja (149 eszközhívás / 132 újraolvasás) kiváltja a mintát; egy
normál 3–5 hívásos futás nem; a **fékbe futott** (blocked) sorok is beleszámítanak az arányba.

---

## EFF-05 — Detektor 2: kontextus-hízás

**Mérföldkő:** M2 · **Prioritás:** Magas · **Függés:** EFF-03

**Feladat:** a futás `ModelCall` sorai `createdAt` szerint rendezve; **ismételt kontextus** =
`sum(promptTokens) − n × promptTokens(első hívás)`, plusz a `promptTokens` növekedésének
monotonitása. A minta akkor áll fenn, ha az ismételt kontextus a prompt-tokenek küszöb fölötti
hányadát viszi el, **és** a futás elért annyi kört, ahol a tömörítésnek már dolgoznia kellett volna.

**DoD:** a mért eset (21k → 154k prompt-növekedés alakja) kiváltja a mintát; egy 2 modellhívásos
futás nem; a mérőszám nem függ a hívások abszolút számától, csak az arányoktól.

---

## EFF-06 — Detektor 3: túlméretezett eszköz-kimenet

**Mérföldkő:** M2 · **Prioritás:** Közepes · **Függés:** EFF-03, EFF-02

**Feladat:** a futás `ToolCall` sorai `result_chars` alapján; a minta akkor áll fenn, ha
ugyanaz az eszköz (opcionálisan ugyanaz a forrás-kulcs) a futásban többször ad a
`TOOL_RESULT_INLINE_LIMIT` (12 000 karakter) fölötti eredményt. A kimenet **eszköznevet**
tartalmaz, hogy a javaslat konkrét legyen.

**DoD:** ismétlődő nagy kimenet mintát ad, egyszeri nagy kimenet nem; a detektor nem javasol
kapcsolót (ehhez a mintához nincs), csak a hívás szűkítését nevezi meg.

---

## EFF-07 — Detektor 4: cache-prefix törés (`null` ≠ 0)

**Mérföldkő:** M2 · **Prioritás:** Közepes · **Függés:** EFF-03

**Feladat:** cache-találati arány = `sum(cachedPromptTokens) / sum(promptTokens)` **csak a
nem-`null` sorokra**. Minta: elég sok, azonos modell felé menő hívás mellett a küszöb alatti
arány. Ha minden sor `null` → „a provider nem ad cache-adatot" állapot, ami **nem megállapítás**,
és nem számít bele a megtakarítás-becslésbe.

**DoD:** csupa `null` bemenetre nincs minta és nincs sáv; 0-ás értékek mellett viszont van;
a két eset a kimenetben megkülönböztethető.

---

## EFF-08 — Token-bontás és megtakarítás-sáv

**Mérföldkő:** M2 · **Prioritás:** Magas · **Függés:** EFF-04, EFF-05, EFF-06, EFF-07

**Feladat:**
- „Hova megy a token" bontás **kizárólag a `ModelCall`-ból**: belépő kontextus (futásonként az
  első hívás `promptTokens`-e), ismételt kontextus (a többi hívás prompt-tömege), válasz
  (`completionTokens`), és ebből leválasztva a cache-ből kiszolgált rész.
- Az újraolvasás-becslés **nem külön szelet**, hanem az „ismételt kontextus" alatti „ebből"
  megjegyzés — különben ugyanaz a token kétszer szerepelne.
- Megtakarítás-sáv mintánként: felső = a mérten pazarolt token teljes megszűnése, alsó = ennek
  a fele; a sáv **soha nem nagyobb** az ablakbeli tényleges költségnél. Pénzérték a meglévő
  `costEstimate` összegéből, nem újraszámolt tarifából.
- A minták rendezése a becsült megtakarítás szerint, determinisztikusan.

**DoD:** a szeletek összege pontosan a `ModelCall` token-összeg; a sáv-korlát tesztelt; azonos
bemenetből azonos kártya (sorrenddel együtt).

---

# M3 — adat-út és felület

Cél: a kártya **megjelenik** az agent adatlapján, valós adatból, korlátos lekérdezéssel.

## EFF-09 — Futás-összegyűjtő lekérdezés (korlátos, tenant-szűrt)

**Mérföldkő:** M3 · **Prioritás:** Magas · **Függés:** EFF-01, EFF-03

**Feladat:**
- Repository/service réteg, amely a detektor normalizált bemenetét állítja elő: futás-grain
  chat-ágon `AgentTurn`, task-ágon `Ticket`.
- Ablak: **30 nap vagy a legutóbbi 20 futás, amelyik szűkebb**; a futás-lista DB-oldali
  `groupBy`/aggregáció; részletes sorok csak a kiválasztott futásokra, indexelt szűréssel
  (`ModelCall(agentId, createdAt)`, `ToolCall(agentId, createdAt)`, `ModelCall(agentTurnId)`,
  `ToolCall(agentTurnId)`) és **felső sor-korláttal**
  (`docs/perf/github-issues/003-paginate-unbounded-lists.md`).
- Tenant-szűrés a meglévő minta szerint; a régebbi, `agentTurnId` nélküli sorok beszélgetés-
  szintű ágon elemzendők, és a kimenet jelzi, ha egy időszakra csak durvább bontás van.

**DoD:** üres adatbázison és nagy forgalmú agenten is korlátos számú lekérdezés és korlátos
sorszám; nincs unbounded `findMany`; a kimenet a detektor bemeneti típusa.

---

## EFF-10 — „Hatékonyság" szekció az agent adatlapon

**Mérföldkő:** M3 · **Prioritás:** Magas · **Függés:** EFF-08, EFF-09

**Feladat:**
- Új szekció a `/control-plane/agents/[agentId]` `SettingsSectionShell` szekciói közé:
  token-bontás, a felismert minták kártyái közérthető magyarázattal és megtakarítás-sávval.
- Server action a kártya betöltésére; a megtekintés az adatlap meglévő láthatósági szabályát
  követi.
- A három állapot mindegyike megjelenik — a *rendben* és a *nincs elég adat* **kimondva**, nem
  üres felületként.
- Időablak-váltó a governance-oldal `Range` mintájára.

**DoD:** a kártya kizárólag számokat, eszközneveket és darabszámokat mutat — prompt-szöveget,
eszköz-eredményt, fájltartalmat soha; a szövegek magyarul, szakzsargon nélkül szólnak.

---

# M4 — egy kattintásos alkalmazás

Cél: ahol **van meglévő kapcsoló**, a javaslat alkalmazható legyen — auditáltan, visszavonhatóan.

## EFF-11 — `modelConfig`-overlay a tömörítés és a forrás-keret küszöbeire

**Mérföldkő:** M4 · **Prioritás:** Közepes · **Függés:** EFF-00

**Probléma:** a `resolveLoopGuardLimits` már ma `modelConfig` → env → default precedenciával
dolgozik, a `resolveContextCompactionLimits` és a `resolveSourceIngestLimits` viszont **csak
env-et** olvas — így ezekre nincs per-agent kapcsoló, amit egy javaslat alkalmazni tudna.

**Feladat:**
- A két feloldó kiegészül a `resolveLoopGuardLimits`-szel **azonos** `modelConfig`-overlay-jel
  (`maxToolResultChars`, `keepRecentToolResults`, `sourceIngestFactor`, `sourceIngestMinChars`),
  clamp-pel az épeszű tartományra.
- A hívó (`chat-tool-loop.ts`) átadja az agent `modelConfig`-ját.
- **Nincs új viselkedés:** a küszöbök ugyanazok, csak agent-szinten hangolhatók.

**DoD:** a precedencia (`modelConfig` → env → default) tesztelt; a felülbírálás **szigorítani
tud, kikapcsolni nem**; overlay nélkül a mai viselkedés bájtra ugyanaz.

---

## EFF-12 — „Alkalmazom" gomb: per-agent felülbírálás, audit, visszavonás

**Mérföldkő:** M4 · **Prioritás:** Közepes · **Függés:** EFF-10, EFF-11

**Feladat:**
- A három alkalmazható javaslat gombja (szigorúbb tömörítés / szűkebb forrás-keret / szűkebb
  eszköz-büdzsé) az agent `modelConfig`-jába ír per-agent felülbírálást.
- Jogosultság: **tenant admin**, a `taskOnly` / `hiddenFromOperators` váltás mintájára.
- Minden alkalmazás `AuditLog` bejegyzést ír (`agent.efficiency_hint_applied`) a **régi és az új
  értékkel**; a felületen egy kattintással visszaállítható.
- Ahol nincs kapcsoló (cache-prefix törés, túlméretezett eszköz-kimenet), **nincs gomb** —
  magyarázat és link a megfelelő felületre.

**DoD:** nem-admin nem tudja alkalmazni; az audit-sor a két értéket tartalmazza; a visszavonás
ugyanazon a felületen elérhető és szintén auditált.

---

# M5 — lezárás

## EFF-13 — Ellenőrzés a mért eseten + dokumentáció

**Mérföldkő:** M5 · **Prioritás:** Közepes · **Függés:** EFF-10, EFF-12

**Feladat:**
- A teljes lánc ellenőrzése a 2026-07-29-i incidens adatain: a kártya kimutatja az ismétlődő
  visszaolvasást és a kontextus-hízást, a megtakarítás-sáv nem nagyobb a futás tényleges
  költségénél.
- Kétirányú visszaellenőrzés éles adaton: egy egészséges agenten a kártya *rendben* állapotot ad.
- `DOCS.md` és a spec „állapot" sorának frissítése; a #237 és a #304 lezárása
  kereszthivatkozással.

**DoD:** az ellenőrzés eredménye a jegyben dokumentálva (mit mutatott a kártya, mire); a spec és
a jegybontás a mainen naprakész.

---

## Létrehozott jegyek

A jegyek 2026-08-21-én létrejöttek; a szkript idempotens újrafuttatása duplikátumot hozna, ezért csak új jegyhez használd.

| Jegy | Issue | Mérföldkő |
| --- | --- | --- |
| EFF-00 — Spec a main-re + címkék, mérföldkő | #305 | M0 |
| EFF-01 — `ToolCall.agentTurnId`: séma, migráció, bekötés | #306 | M1 |
| EFF-02 — Egységes `result_chars` a tool-eredmény metaadatban | #307 | M1 |
| EFF-03 — `efficiency-advisor.ts` váz: típusok, küszöbök, minta-méret kapu | #308 | M2 |
| EFF-04 — Detektor 1: ismétlődő visszaolvasás | #309 | M2 |
| EFF-05 — Detektor 2: kontextus-hízás | #310 | M2 |
| EFF-06 — Detektor 3: túlméretezett eszköz-kimenet | #311 | M2 |
| EFF-07 — Detektor 4: cache-prefix törés (`null` ≠ 0) | #312 | M2 |
| EFF-08 — Token-bontás és megtakarítás-sáv | #313 | M2 |
| EFF-09 — Futás-összegyűjtő lekérdezés (korlátos, tenant-szűrt) | #314 | M3 |
| EFF-10 — „Hatékonyság" szekció az agent adatlapon | #315 | M3 |
| EFF-11 — `modelConfig`-overlay a tömörítés és a forrás-keret küszöbeire | #316 | M4 |
| EFF-12 — „Alkalmazom" gomb: per-agent felülbírálás, audit, visszavonás | #317 | M4 |
| EFF-13 — Ellenőrzés a mért eseten + dokumentáció | #318 | M5 |

---

## Függési sorrend (rövid)

```
EFF-00
 ├─ EFF-01 ──────────────┐
 ├─ EFF-02 ──────┐       │
 ├─ EFF-03 ──┬───┴─ EFF-06 ─┐
 │           ├─ EFF-04 ─────┤
 │           ├─ EFF-05 ─────┼─ EFF-08 ─┐
 │           └─ EFF-07 ─────┘          │
 │                          EFF-09 ────┴─ EFF-10 ─┐
 └─ EFF-11 ───────────────────────────────────────┴─ EFF-12 ─ EFF-13
```

A kritikus út: **EFF-01 → EFF-09 → EFF-10**. A detektorok (EFF-04…EFF-07) egymástól függetlenül,
párhuzamosan fejleszthetők, mert mind ugyanazt a tiszta bemeneti típust kapják.
