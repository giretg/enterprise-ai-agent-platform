# Fejlesztési specifikáció - Tartós agent-memória projektfolytonossághoz

Státusz: **Fejlesztési specifikáció - v2.1 (grill-elt, konszolidált, kód-horgonyzott, végrehajtható)** · Készült: **2026-07-08** · Utolsó szerkesztés: **2026-07-09 (v2.1 kód-verifikáció)**

> **v2.1 kód-verifikációs változásnapló (2026-07-09):** a spec minden kód-hivatkozását a tényleges kódbázissal vetettük össze; 5 érdemi pontosítás: **(1)** `workspaceId` → **`tenantId`** (nincs `Workspace` entitás a sémában; a kódban a „workspace" a ticket/conversation-kulcsú fájl-munkaterület, nem szervezeti egység — §2.1); **(2)** a `WriteGateToken.trainingTicketId` ma **kötelező** FK → az inline jóváhagyáshoz séma-bővítés kell (§9.4, ÚJ); **(3)** `MemoryVersion.content` ma kötelező `String` → nullable-migráció (§9.3); **(4)** a Prisma-váz **FTS GIN-indexe** csak raw SQL migrációval hozható létre, a KB `0002_kb_chunk_fts_index` mintájára (§9.1); **(5)** NF4 degradált mód pontosítva (retrieval-hiba esetén `project_state` sincs). Új §23: WP-nkénti kód-horgony táblázat a fejlesztőnek.

> **v2 grillezés-változásnapló (2026-07-09):** a `project_state` determinisztikus on-read vetületté vált (nincs jóváhagyás, nincs `stale`), a narratíva külön `focus` chunk-típus; a teljes legacy/shadow/fallback réteg **kihúzva** (csak demo-agentek, üres újraseed); `projectKey` (Q2) és minden nyitott döntés (Q1/Q4/Q5/Q6/Q8) lezárva, Q3/Q7 halasztva; a minimális élő szelet a retrieval-ágat is tartalmazza (WP-1..6). Részletek az érintett §-eknél.
Kapcsolódó koncepció: `AI-Agent-Platform-Koncepcio.md` §4.6 (tanítás és memória), §4.6.2 (retrieval + salience), §4.6.3 (reflexió mint tanítási-ticket feeder), §4.6.4 (önfejlesztési profil), §4.13 (MemoryStore cserepont), §4.14 (beszélgetés-/session-kezelés)
Kapcsolódó memória/spec: `[[wp6-observability-build]]`, `kb-v3-okf-spec`, `chat-turn-resilience-spec`
Érintett kód: [`training-service.ts`](../../app/src/domain/training/training-service.ts), [`agent-chat-runtime.ts`](../../app/src/domain/agent/agent-chat-runtime.ts), [`general-task-runtime.ts`](../../app/src/domain/agent/general-task-runtime.ts), [`context-assembly.ts`](../../app/src/domain/conversation/context-assembly.ts), [`knowledge-repository.ts`](../../app/src/repositories/postgres/knowledge-repository.ts), [`schema.prisma`](../../app/prisma/schema.prisma)

---

## 0. Egy mondatos termékcél

Az agent memoriája **jóváhagyott, auditálható projektfolytonossági állapot**: tudja, hogy egy adott projekten hol tartunk, milyen döntések születtek, mi nyitott, mit próbáltunk már, mi nem működött, és mi a következő lépés - cross-conversation módon, teljes memória-injektálás nélkül.

Ez **nem** tenant-/cégmemória, nem szabályzattár, nem személyes preferencia-tár és nem viselkedési profil. Ezek külön rendszerek:

- cég/tenant tudás: KB / policy store;
- agent szerep, munkaköri leírás, viselkedés: behavior profile / job description;
- user-preferencia: behavior/profile beállítás, nem projektmemória;
- projektfolytonosság: ez a specifikáció.

---

## 1. Kiindulás: mai állapot és iparági kontextus

### 1.1 Mai állapot (ez a platform)

Ma a memória **jóváhagyott, verziózott szöveg**, amit a runtime **minden futáskor teljes egészében beinjektál** a promptba, és **kizárólag kézzel indított tanítási ticketen** át változhat.

Konkrét jelek a kódban:

- `MemoryVersion.content` a teljes memória-szöveg hordozója ([`schema.prisma`](../../app/prisma/schema.prisma)).
- A runtime a memóriát teljes blokkban teszi a promptba: `Memória (aktív verzió): ...` ([`agent-chat-runtime.ts`](../../app/src/domain/agent/agent-chat-runtime.ts), [`general-task-runtime.ts`](../../app/src/domain/agent/general-task-runtime.ts), [`bookkeeper-runtime.ts`](../../app/src/domain/agent/bookkeeper-runtime.ts)).
- A tanítási útvonal a `TrainingService` write-gate mechanizmusán megy át ([`training-service.ts`](../../app/src/domain/training/training-service.ts)).
- Ticket nélküli, nyers memóriaírás ma tiltott: `attemptUngatedMemoryWrite`.

Ez auditálható és robusztus, de nem skálázódik: a memória mérete közvetlenül eszi a kontextusablakot, nincs keresés, nincs atomi állapotkezelés, nincs projektfolytonossági "hol tartunk most" modell.

### 1.2 Hogyan oldják meg máshol (Claude Code, Codex, kutatási vonal)

Ma három, egymás mellett élő minta van; ez a spec tudatosan a 2. és 3. ötvözetére épít, governance-réteggel a tetején.

1. **Mindig-beinjektált instrukciós fájl.** Claude Code `CLAUDE.md` (projekt-gyökér + beágyazott + user-szintű `~/.claude/CLAUDE.md`), Codex/társai `AGENTS.md`. Session-indításkor a promptba fűzött, ember-karbantartott, **statikus** fájlok. Ez **nem tanulás és nem retrieval** — a ti *viselkedésprofil + munkaköri leírás* rétegetek analógja. **A mai teljes-inject memóriátok (§1.1) is pontosan ez a minta**, ezt váltja le a spec a projektmemóriára.

2. **Index-vezérelt fájl-memória progresszív betöltéssel.** A Claude Code újabb fájl-memóriája: egy `memory/` könyvtár, **fájlonként egy tény** frontmatterrel (`name` / `description` / `type`), plusz egy `MEMORY.md` **index**, amiből **mindig csak az index** van a kontextusban; a teljes elem a `description` alapján, **igény szerint** töltődik be. Van konszolidációs kör is (dedup/nyesés). Ez a spec **`project_state` (mindig bent) + top-K atomi chunk (lusta betöltés)** felállásának közvetlen analógja (§4, §5). Fő különbség: ott **nincs jóváhagyási kapu** — a modell magától ír.

3. **RAG-over-memory + tiered memory + reflexió (kutatási vonal).** Diszkrét memória-elemek, vektor/kulcsszó-index, **top-K visszatöltés futásonként**; rétegzés working → episodic → semantic → procedural (MemGPT/Letta „önkezelt kontextus", a modell tool-hívással lapoz be/ki); salience = *recency × importance × relevance* + reflexió-szintézis (Stanford „Generative Agents"). A §5.2 score-képlet és a §8 konszolidáció közvetlenül ebből a vonalból származik.

### 1.3 Hová pozicionál ez a spec

Ez a spec = a 2. (index + progresszív betöltés) és 3. (retrieval + rétegzés + salience + konszolidáció) minta ötvözete, **plusz** a platform megkülönböztető governance-rétege: write-gate, verziózás, rollback, kemény padló (§16), és **agent-kezdeményezett, jogosultság-vezérelt jóváhagyás** (§6). A nagy CLI-k épp ezt a kaput nem adják — ez a **„governed memory"**: az agent tanul a projektből, de kontrollálatlanul soha nem módosítja önmagát.

---

## 2. Alapelvek

### 2.1 Memória-tulajdon és scope

A memória tulajdonosa az **agent**, de minden emléknek kötelező scope-ja van.

Kötelező scope:

- `agentId`
- `memoryId`
- `tenantId` **és** `projectKey` (a kettő együtt; a `projectKey` a `tenantId`-n belül szűkít, default értéke a per-tenant+agent `__general__` szentinel — így sosincs null-kulcs, az NF2 fail-closed nem lő be véletlenül)

> **Kód-horgony (v2.1):** a sémában **nincs `Workspace` entitás** — a kódban a „workspace" a ticket/conversation-kulcsú **fájl-munkaterület** (GCS, ld. `file.handler.ts`: `workspaceId = ticketId ?? conversationId`), nem szervezeti egység. A szervezeti határ a `Tenant` (`Agent.tenantId`, `Conversation.tenantId`). A spec korábbi `workspaceId` scope-kulcsa ezért mindenhol **`tenantId`**-ként implementálandó; a tenant-reachability őr ([`tenant-reachability.ts`](../../app/src/lib/tenant-reachability.ts)) így közvetlenül alkalmazható (§16 S6).

Opcionális scope:

- `workstreamKey` - nagy projekten belüli munkafolyam;
- `threadId` / `ticketId` / `runId` - forrás és audit, nem elsődleges scope;
- `repoPath` / `artifactRef` - ha a memória konkrét fájlhoz, branchhez, PR-hez, dokumentumhoz kötődik.

**Döntés (Q2 lezárva):** ugyanannak az agentnek külön projektmemóriája lehet külön tenant/project scope-okban. A runtime csak az aktuális projekt scope-jából tölthet vissza memóriát, kivéve explicit cross-project handoff esetén (v2 feature).

**`projectKey` származtatása:**

- **task/process-run:** a **`ProcessDefinition.id`** a kanonikus `projectKey` (útvonal a kódban: `Ticket.processInstanceId` → `ProcessInstance.processDefinitionId`). A *definíció*, nem az *instance* — a folytonosság a folyamat szintjén értelmes, nem futásonként. Process nélküli ad-hoc ticketnél `__general__`.
- **chat:** soft-default a per-tenant+agent `__general__` projektre, de a chat-fejlécben látható **projekt-választó** van; a user egy kattintással szűkíthet. A memória-írás mindig a **kiválasztott** kulcsra megy, és a `memory_propose` kártya megjeleníti a cél-projektet. **Kód-horgony:** a `Conversation` modellnek ma nincs projekt-mezője → WP-1 ad hozzá `project_key String @default("__general__")` oszlopot; a választó ezt írja, a runtime ezt olvassa.
- Hiányzó egyértelmű kulcs **sosem** vezet néma fail-closedhez: mindig van legalább a `__general__` kulcs.

### 2.2 Forrásréteg és derivált állapot

A v1 hibrid modellt használ, de nem két párhuzamos igazságforrással.

- **Atomi memóriachunkok**: a kanonikus, auditálható forrásréteg.
- **`project_state` összefoglaló**: az aktív atomi chunkokból képzett, visszavezethető állapotnézet.

Szabály:

> A `project_state` nem önálló memóriaforrás, hanem az aktív atomi memóriaelemekből képzett derivált nézet. Konfliktus vagy eltérés esetén az atomi chunk a kanonikus rekord; a `project_state` frissítendő vagy review-ra kerül.

### 2.3 Explicit capture only v1-ben

V1-ben nincs háttérben automatikusan író reflexió. Az agent csak explicit `memory_propose` művelettel kezdeményezhet memória-változást:

- chatben memória-javaslat kártyaként;
- ticketes feladatvégrehajtásnál ticketbe csatolt memória-javaslatként;
- user explicit "jegyezd meg..." kérésére is ugyanazon az úton.

A javaslat T1 candidate-be kerül, **soha nem közvetlenül T2-be**.

**Capture-policy (mikor javasoljon):** a `memory_propose` a *mechanizmus*; a *policy* — hogy mit érdemes megjegyezni — a **rendszerprompt** dedikált „Memory capture policy" blokkjában él (nem konfig, hanem viselkedési instrukció). Ez kimondja: futás/session végén javasolj `focus`-t, ha az állapot érdemben változott; javasolj `decision`/`open_task`/`failed_attempt`/`artifact`-ot, amikor ilyen esemény ténylegesen történik; ne javasolj transzkriptet, preferenciát, general tudást (§3.2). A prompt-policy megírása külön WP-deliverable (§13, WP-3).

**Batch:** a fatigue ellen a futásvégi javaslat **batch**-elt — több chunk egyetlen kártyán, egyetlen jóváhagyással (§11.1), nem chunkonként külön kártya.

### 2.4 Write-gate és audit változatlan

Minden tartós memória-változás write-gate alatt áll:

- létrehozás;
- módosítás;
- supersede;
- archive;
- delete/törlési javaslat jóváhagyása.

*(A `project_state` derivált nézet **nem** kerül write-gate alá: on-read vetület, nincs publikálás — §4.1.)*

Az "azonnali jóváhagyás" csak UX-rövidítés: jogosult user esetén a szerver ugyanúgy kiállítja és consume-olja az egyszer használatos write-gate tokent.

---

## 3. Memory Acceptance Policy

### 3.1 Mit szabad memóriává alakítani?

V1-ben csak projektfolytonossági memória kerülhet be:

| Típus | Mikor használjuk? | Példa |
|---|---|---|
| `focus` | Interpretatív „hol tartunk + következő lépés" narratíva; scope-onként **1 aktív**, az új supersede-eli a régit | "A memory-spec pontosítása folyamatban, következő lépés a Prisma modell." |
| `decision` | Jóváhagyott projekt-döntés és indok | "Dedikált `MemoryChunk` tábla lesz, nem közös KB artifact." |
| `open_task` | Nyitott vagy következő munka | "WP-1: schema + migráció elkészítése." |
| `assumption` | Ideiglenes feltételezés, review-val | "FTS elég v1-ben, embedding később." |
| `finding` | Fontos feltárás, tanulság, bug | "A full-inject most a `agent-chat-runtime.ts` körül történik." |
| `constraint` | Projekt-specifikus megkötés | "A memory write nem kerülheti meg a write-gate-et." |
| `artifact` | Fontos fájl, branch, PR, endpoint, dokumentum | "`docs/specs/agent-memory...md` a fejlesztési spec." |
| `failed_attempt` | Amit már próbáltunk, de nem működött | "A nyers memóriaírás `attemptUngatedMemoryWrite` úton tiltott." |
| `handoff_summary` | Beszélgetések/futások közti átadás | "A következő agent-turn a retrieval-adapterrel folytassa." |

### 3.2 Mit nem szabad memóriába írni?

Nem memória:

- személyes preferencia, ha nem projektfolytonossági tény;
- agent viselkedési szabály vagy munkaköri leírás;
- céges/tenant szabályzat;
- általános tudásbázis-tartalom;
- nyers beszélgetés-transzkript;
- egyszeri, lejárt task-részlet;
- érzékeny adat, ha nincs explicit indok, redakció és jóváhagyás.

### 3.3 Kötelező metadata minden memóriaelemhez

Minden T2 chunk kötelező mezői:

- `id`
- `memoryId`
- `agentId`
- `tenantId` + `projectKey`
- `workstreamKey?`
- `type`
- `path`
- `title`
- `summary`
- `text`
- `tags`
- `status`: `active | superseded | archived | deleted`
- `salience`
- `confidence`: `low | normal | high`
- `sourceRefs`: thread/ticket/run/file/PR/doc hivatkozások
- `evidence`: rövid, emberileg olvasható indok vagy forráskivonat
- `approvedBy`
- `approvedAt`
- `createdAt`
- `updatedAt`
- `reviewAfter?`
- `expiresAt?`
- `supersedes?`
- `supersededBy?`
- `contentHash`

---

## 4. Rétegzett memória-modell

```
T0 WORKING
  Futás/turn közbeni ideiglenes kontextus.
  Nem tartós memória.

T1 CANDIDATE
  Agent vagy maintenance által javasolt memória-változás.
  Látható, szerkeszthető, elvethető, ticketesíthető.
  Nem kerül automatikusan retrievalbe.

T2 CURATED ATOMIC MEMORY
  Jóváhagyott, OKF-alakú atomi chunkok.
  Ez a kanonikus forrásréteg.

T3 DERIVED PROJECT STATE
  Az aktív T2 chunkokból ON-READ képzett, determinisztikus vetület.
  Nincs jóváhagyás, nincs tárolt "publikált" példány, mindig friss.
  Gyors orientációra szolgál, nem önálló igazságforrás.
```

### 4.1 T3 `project_state` szabályai (determinisztikus vetület)

A `project_state` **nem tárolt, nem jóváhagyott** rekord, hanem az aktív T2 chunkokból **on-read** összeállított, determinisztikus vetület. Mindig friss; nincs `stale` státusz, nincs publikálás, nincs write-gate.

Összetétele:

- **narratíva** — a scope legfrissebb **aktív `focus` chunkjának** szövege („jelenlegi fókusz + következő javasolt lépés");
- **kivetített listák** (mechanikusan, az aktív chunkokból): legutóbbi `decision`-ök, nyitott `open_task`-ok, `constraint`/blokkolók, kulcs `artifact`-ok;
- a hivatkozott atomi chunkok id-listája (reprodukcióhoz).

A vetület a `projectState` token-budgetből (§12.2) épül, a top-K-n **kívül**; ha a kivetített listák túllépnék a budgetet, salience+recency szerint csonkolódnak, de a `focus` narratíva mindig bent marad.

**Következmény (G3+G4):** a régi `project_state`-approval, `derivedBy: maintenance_job`, `sourceManifestVersion`, `stale`-státusz és a `project_state_refresh` maintenance-proposal **megszűnik** — a vetület mindig a pillanatnyi aktív chunkokat tükrözi. Az interpretatív narratíva a jóváhagyás-köteles `focus` chunk-típusban él (§3.1), így a governance sértetlen marad, de a vetület összerakása jóváhagyás-mentes.

---

## 5. Retrieval és prompt-összeállítás

### 5.1 Cél

A runtime ne a teljes memóriát injektálja, hanem:

1. az aktuális scope releváns `project_state` nézetét;
2. top-K releváns atomi chunkot;
3. konfliktus esetén a konfliktus-set jelölését;
4. fix token-budgeten belül.

### 5.1.1 Retrieval query és a service-szerződés (G2)

A query-építés a **`context-assembly.ts`**-ben történik, a `MemoryRetrievalService` **pure** marad (a runtime-formát nem ismeri):

- **chat:** utolsó user-üzenet (elsődleges) + max 5 előző üzenet (user+assistant, tool-payload nélkül), recency-sorrendben, ~400 token cap;
- **task/process-run:** ticket-cím + aktuális step-instrukció + step-input rövid összefoglaló, ~400 token cap.

```ts
interface MemoryRetrievalRequest {
  agentId: string; memoryId: string;
  projectKey: string; workstreamKey?: string;
  query: string;                 // már normalizált FTS-input
  queryKind: 'chat' | 'task';    // csak a no-query fallbackhez
  tokenBudget: { projectState: number; chunks: number };
  runRef: { runId?: string; threadId?: string; ticketId?: string };
}

interface MemoryRetrievalResult {
  projectState?: ProjectStateView;   // focus-narratíva + kivetített listák
  activeFocusChunkId?: string;        // supersede-hez KÖTELEZŐ
  chunks: RetrievedChunk[];           // top-K
  supersedeCandidates: string[];      // capture-hoz visszaadott chunk-id-k
  conflictSets: ConflictSet[];
  scores: Record<string, number>;
  memoryVersionId: string;
  queryMode: 'normal' | 'no_query';
}

retrieveForRun(req: MemoryRetrievalRequest): Promise<MemoryRetrievalResult>
```

**No-query mód (determinisztikus):** a normalizálás (trim/lowercase/stopword- és nyugtázó-token-szűrés: „oké", „folytassuk", „köszi", „menjünk tovább" stb.) után ha az értelmes token **< 3**, vagy az FTS 0 lexémát ad, a score elhagyja a `w_fts` tagot (a maradék súlyok újranormalizálva), a rangsor `salience + recency + scope + project_state_boost − penalties`. A `project_state` vetület query-től függetlenül **mindig pinned** (a `projectState` budgetből). A `queryKind: task` gyakorlatilag sosem esik ide (a ticket/step szöveg dús). A `queryMode` auditált (§5.3).

### 5.2 Rangszámítás

V1-ben FTS-alapú retrieval elég, a KB-motor mintájára. Később a `KnowledgeIndexStore` cserepont mögé jöhet embedding.

Javasolt score:

```text
score =
  w_fts * text_relevance
+ w_sal * salience
+ w_rec * recency_decay
+ w_scope * scope_match
+ w_state * project_state_boost
- w_conflict * unresolved_conflict_penalty
- w_stale * stale_penalty
```

Fontos: a `salience` nem azonos a hasznossággal. Külön mérendő:

- `retrievedCount`
- `usedInAnswerCount`
- `userConfirmedHelpfulCount`
- `userCorrectedCount`
- `lastRetrievedAt`
- `lastUsedAt`
- `lastValidatedAt`

**Salience-frissítés v1 (Q5 lezárva):** kezdőérték a `salienceHint`-ből (`normal≈0.5`, `high≈0.8`); a **recency-decay a score-ban** számolódik (nem tárolt mezőn), minden retrievalkor csak a `lastRetrievedAt` frissül a visszaadott chunkokon; **explicit feedback-lökés** (user-confirm +, user-correct −, ez utóbbi `lastValidatedAt`-et is mozgat). A `usedInAnswerCount` v1-ben **opcionális** modell-citation, **nem KPI** (megbízhatatlan attribúció, G10); a `memory_hit_rate` emiatt kikerül a v1 headline-metrikákból (§14). A folytonos salience-tuning **nem** a maintenance dolga — az csak durva demote/archive-ot javasol.

### 5.3 Audit

Minden retrieval esemény auditált:

- `memory.retrieve`
- `agentId`
- `projectKey/tenantId`
- `query`
- `tokenBudget`
- `returnedProjectStateId`
- `returnedChunkIds`
- `scores`
- `conflictSetIds`
- `memoryVersionId`
- `runId/threadId/ticketId`

Ez reprodukálhatóvá teszi, hogy egy agent-válasz milyen memóriából dolgozott.

---

## 6. Agent-kezdeményezett capture

### 6.1 `memory_propose` tool

Az agent tool-hívással javasol memóriaváltozást. A tool csak T1 candidate-et hoz létre. A `project_state_refresh` operation **megszűnt** (a `project_state` on-read vetület, nincs mit frissíteni). A `focus`-típusnál a supersede-hez a `MemoryRetrievalResult.activeFocusChunkId`-t kell megadni `supersedes`-ben — ezt a retrieval a futás elején visszaadta (§5.1.1). Futásvégi több javaslat **egy batch-kártyán** megy (§6.2).

```jsonc
{
  "name": "memory_propose",
  "input": {
    "operation": "create | update | supersede | archive | delete_request",
    "type": "decision | open_task | assumption | finding | constraint | artifact | failed_attempt | handoff_summary | focus",
    "projectKey": "enterprise-ai-agent-platform",
    "workstreamKey": "agent-memory",
    "path": "agent-memory/decisions",
    "title": "Dedikált MemoryChunk tábla",
    "summary": "A v1 külön MemoryChunk táblát használ OKF-alakban.",
    "text": "A memória agent/project scoped, ezért nem keverjük a tenant KB artifact-életciklusával.",
    "tags": ["memory", "schema", "governance"],
    "salienceHint": "normal | high",
    "confidence": "low | normal | high",
    "supersedes": null,
    "reviewAfter": "2026-10-08",
    "expiresAt": null,
    "sourceRefs": [
      { "type": "thread", "id": "..." },
      { "type": "file", "path": "docs/specs/agent-memory-persistent-cross-conversation-spec.md" }
    ],
    "evidence": "A fejlesztési specifikáció Q1 döntése alapján.",
    "reason": "Ez projektfolytonossági döntés, későbbi implementációknál releváns."
  }
}
```

### 6.2 Chat UX

A chat-streambe strukturált memória-javaslat esemény kerül. A kliens kártyát renderel:

```text
Memória-javaslat
"A v1 külön MemoryChunk táblát használ OKF-alakban."

típus: decision
scope: enterprise-ai-agent-platform / agent-memory
hatás: új aktív memóriaelem

[Jóváhagyom] [Módosítom] [Ticketbe küldöm] [Elvetem]
```

Ticketes futásnál ugyanez a ticket mellékleteként jelenik meg, és a ticket jóváhagyási folyamat része lesz.

Futásvégi **batch:** ha az agent egy futásban több chunkot javasol, azok **egyetlen kártyán** jelennek meg, chunk-soronként típus/scope/hatás jelöléssel, egyetlen `[Jóváhagyom mind]` (plusz soronkénti finomítás) lehetőséggel — nem N külön kártya.

### 6.3 Jogosultsági elágazás

| User jogosultság | Agent profil | Eredmény |
|---|---|---|
| `memory.inline_approve` vagy agent owner | `human` / `higher_role` | Azonnali write-gate consume, T2 publikálás |
| nincs inline jog | `human` / `higher_role` | Training/memory ticket keletkezik |
| eval-köteles agent | `eval_only` / `auto_after_eval` | Eval + write-gate, bukás esetén ticket/blokk |
| scope tiltja | bármely | Elutasítás, audit |

Az audit eseményekben mindig szerepel:

- ki javasolta;
- ki hagyta jóvá;
- mikor;
- milyen forrás alapján;
- milyen memória-verzió-manifeszt jött létre.

---

## 7. Konfliktuskezelés

Nem cél, hogy minden konfliktust kizárólag algoritmus döntsön el. Cél, hogy a modell ne vakon döntsön.

### 7.1 Determinisztikus előszűrés

Publikálás és retrieval során conflict candidate, ha:

- azonos vagy közeli `path`;
- azonos `type` + átfedő `tags`;
- új chunk `supersedes` nélkül ellentmond aktív chunknak;
- hasonló artifact/workstream scope-ban eltérő állítást tesz;
- aktív `project_state` eltér az atomi chunkoktól.

### 7.2 Konfliktus-rangsor

Determinista jelzések:

- `status`: active > archived > superseded;
- `approvedAt`: frissebb előny, de nem dönt egyedül;
- `confidence`;
- `sourceQuality`: ticket/PR/doc > chat-only;
- `lastValidatedAt`;
- `salience`;
- `reviewAfter` lejárt-e.

### 7.3 Modell szerepe

Ha konfliktus marad, a runtime `conflict_set` formában adja át az érintett chunkokat a modellnek:

- alacsony kockázat: a modell kontextus szerint választhat, de jelölnie kell az indokot;
- közepes kockázat: a modell kérdezhet vagy memory review-t javasol;
- magas kockázat: a modell nem dönthet, ticket/review szükséges.

Konfliktus esetén a rendszer `memory.conflict_detected` audit eseményt ír.

---

## 8. Memory maintenance / consolidation ("dreaming")

### 8.1 Cél

Időnként szükség van memória-karbantartásra: elavult állítások hátrébb sorolása, duplikátumok összevonása, lejárt feltételezések review-ja, `project_state` frissítése.

A belső működés neve lehet "dreaming", de fejlesztési és audit szinten ez:

> **memory maintenance / consolidation job**

### 8.2 Kemény szabály

A maintenance job **nem írhat közvetlenül T2-be**. Csak T1 maintenance proposalokat gyárt.

Proposal típusok:

- `merge`
- `supersede`
- `demote`
- `archive`
- `delete_request`
- `refresh_needed`
- `conflict_review`

*(A `project_state_refresh` **megszűnt** — a vetület on-read, mindig friss, §4.1.)*

Minden proposal jóváhagyás-köteles. Jóváhagyás után új memória-verzió-manifeszt jön létre.

### 8.3 Trigger

V1-ben javasolt triggerek:

- manuális "Memória karbantartás indítása" gomb agent/projekt szinten;
- ticket lezárás után opcionális consolidation proposal;
- N darab jóváhagyott memória-változás után;
- `reviewAfter` lejáratkor.

Nem cél v1-ben a folyamatos háttérben futó, autonóm maintenance. A futtatás **`memory.maintenance.run` capability-gate** alatt áll, és egy consolidation-kör **token-budgetje cappelt** (`maintenanceTokenBudget`, `self_evolution_profile`, §12.2) — így a költség emberi triggerre és fix keretre korlátozott (Q8 lezárva).

### 8.4 Audit

Audit események:

- `memory.maintenance.started`
- `memory.maintenance.proposed`
- `memory.maintenance.approved`
- `memory.maintenance.rejected`
- `memory.chunk.archived`
- `memory.chunk.deleted`
- `memory.chunk.demoted`

Törlésnél a fizikai törlés külön policy kérdés. V1 ajánlás: soft-delete + audit trail, kivéve jogi/adatvédelmi kötelező hard delete esetén.

---

## 9. Adatmodell - javasolt Prisma irány

### 9.1 `MemoryChunk`

Dedikált OKF-alakú tábla, nem közös KB artifact.

Indok:

- agent/project scoped;
- más lifecycle, mint a tenant KB;
- salience/decay/review mezők memóriaspecifikusak;
- a `WriteGateToken.targetMemoryId` már természetes kapcsolódási pont (de a token-séma bővítendő az inline úthoz, §9.4).

Fő mezők:

```prisma
model MemoryChunk {
  id          String @id @default(uuid()) @db.Uuid
  memoryId    String @map("memory_id") @db.Uuid
  agentId     String @map("agent_id") @db.Uuid

  tenantId      String? @map("tenant_id") @db.Uuid
  projectKey    String  @map("project_key")
  workstreamKey String? @map("workstream_key")

  type      String
  path      String
  title     String
  section   String?
  text      String
  summary   String?
  tags      String[] @default([])
  metadata  Json?

  status     String @default("active")
  salience   Float  @default(0.5)
  confidence String @default("normal")

  sourceRefs Json? @map("source_refs")
  evidence   String?

  approvedBy String?   @map("approved_by") @db.Uuid
  approvedAt DateTime? @map("approved_at")

  reviewAfter DateTime? @map("review_after")
  expiresAt    DateTime? @map("expires_at")

  supersedes   String? @map("supersedes") @db.Uuid
  supersededBy String? @map("superseded_by") @db.Uuid

  retrievedCount            Int       @default(0) @map("retrieved_count")
  usedInAnswerCount          Int       @default(0) @map("used_in_answer_count")
  userConfirmedHelpfulCount  Int       @default(0) @map("user_confirmed_helpful_count")
  userCorrectedCount         Int       @default(0) @map("user_corrected_count")
  lastRetrievedAt            DateTime? @map("last_retrieved_at")
  lastUsedAt                 DateTime? @map("last_used_at")
  lastValidatedAt            DateTime? @map("last_validated_at")

  contentHash String @map("content_hash")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@index([memoryId, projectKey, workstreamKey, status])
  @@index([memoryId, path, status])
  @@index([tenantId, agentId, status])
  @@map("memory_chunks")
}
```

**FTS-index (v2.1, kötelező kiegészítés):** a Prisma nem tud kifejezés-alapú GIN-indexet — a retrieval indexét **raw SQL migráció** hozza létre, pontosan a KB `0002_kb_chunk_fts_index` mintájára:

```sql
CREATE INDEX memory_chunks_fts_idx ON memory_chunks
  USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || text));
```

A lekérdező oldal a [`knowledge-repository.ts`](../../app/src/repositories/postgres/knowledge-repository.ts) `ts_rank` + `to_tsvector('simple', ...)` mintáját másolja (150–186. sor környéke), memória-scope-ra külön repositoryban. Fontos: a query-oldali `to_tsvector` kifejezésnek **karakterre egyeznie** kell az indexbelivel, különben az index nem használódik.

Megjegyzés: enumok később tisztíthatók, de v1-ben string mezők gyorsabb migrációt adnak. A `contentHash` nem csak integritás-pecsét, hanem **dedup-horgony**: rollback→re-capture ciklusban a hash-egyezésű chunk **reaktiválódik** (`archived → active`), nem keletkezik duplikátum (§9.3 rollback, G11).

### 9.2 `MemoryCandidate`

T1 javaslatok tára.

Fő mezők:

- `id`
- `memoryId`
- `agentId`
- `tenantId/projectKey/workstreamKey`
- `operation`
- `payload`
- `status`: `proposed | modified | approved | ticketed | rejected | expired`
- `proposedBy`: `agent | user | maintenance_job`
- `proposedByRunId?`
- `proposedInThreadId?`
- `ticketId?`
- `approvedBy?`
- `approvedAt?`
- `rejectedBy?`
- `rejectedAt?`
- `writeGateTokenId?`

### 9.3 `MemoryVersion` új szerepe (manifest + rollback-horgony)

A `MemoryVersion.content` **azonnal legacy-null** — nincs full-inject fallback (nincs védendő éles agent, §18). **Migráció-pontosítás (v2.1):** a `content` ma **kötelező** `String` a sémában → a WP-1 migráció `String?`-ra lazítja (a meglévő demo-sorok értéke maradhat, új manifest-sorok `NULL`-t írnak). A meglévő FK-k (`AgentVersion`, `EvalRun`, `Memory.currentVersionId`) változatlanok. A `@@unique([memoryId, version])` verziósor **marad globális per-memory** (nem per-projectKey) — egyszerűbb, és a manifest úgyis rögzíti a saját `projectKey`-ét; a rollback csak az adott `projectKey` scope chunkjait billenti. A `MemoryVersion` egyetlen szerepe a T2-pillanatkép:

> Egy `MemoryVersion` a T2 memória adott pillanatának **manifesztje**: mely chunkok aktívak (`activeChunkIds`), és milyen változás hozta létre (`changeSet`).

Mezők:

- `activeChunkIds Json` — **teljes** aktív-halmaz pillanatkép (autoritatív a rollbackhez és az NF3-reprodukcióhoz);
- `changeSet Json` — ember-olvasható delta a timeline-hoz;
- `projectKey`, `workstreamKey?`;
- `sourceCandidateIds`.

**Rollback (§20 DoD, G11):** append-only, sosem destruktív. A „rollback N-re" **új** manifestet (N+1) gyárt, amelynek aktív halmaza = N `activeChunkIds`-e; ehhez átbillenti a chunk-státuszokat (N óta született chunk → `archived`; N és most között archivált/superseded → `active`). Semmi nem törlődik fizikailag; a `focus` automatikusan helyreáll (scope-onként 1 aktív invariáns). Hash-egyezésű re-capture **reaktivál**, nem duplikál (§9.1). A rollback write-gate-elt, `memory.rollback` capability + audit alatt.

**Legacy migráció (elhanyagolható, §18):** ma csak demo-agentek vannak, ezért a régi `MemoryVersion.content` **nem** migrál projekt-chunká. Ha egyáltalán megőrzendő, az adott agent **`behaviorProfileOverlay`**-jébe kerül (per-agent, **nem** a shared `BehaviorProfile` törzsbe) a `composeBehaviorProfile`-verziózás úton — de a gyakorlatban a demo-agenteket **üres projektmemóriával újraseedeljük**.

### 9.4 `WriteGateToken` bővítés az inline úthoz (v2.1, ÚJ — séma-blokkoló)

A mai séma szerint a `WriteGateToken.trainingTicketId` **kötelező** FK a `Ticket`-re — vagyis ma **nem lehet** ticket nélküli (inline) write-gate tokent kiállítani, pedig a §2.4/§6.3 inline útja pont ezt kívánja. WP-1 migráció:

- `trainingTicketId` → **nullable**;
- új `memoryCandidateId String? @db.Uuid` FK a `MemoryCandidate`-re;
- alkalmazás-szintű invariáns (a `MemoryApprovalService` őrzi): **pontosan az egyik** kitöltött — ticketes útnál a ticket, inline útnál a candidate;
- `expectedDiffHash` szemantikája memória-útnál: a **candidate payload kanonikus hash-e** (= a leendő chunk `contentHash`-e create/update-nél, illetve az operation+cél-chunk-id hash-e archive/supersede-nél) — így a token továbbra is pontosan egy, előre rögzített változást engedélyez;
- a kiállítás/consume/lejárat/aláírás mechanizmus **változatlan** (a `resolveSigningSecret` fail-closed titok-feloldással, `[[code-review-crypto-secret-fail-closed]]`).

Így az „inline = UX-rövidítés" elv a sémán is igaz marad: ugyanaz a token-életciklus, csak a horgony a candidate, nem a ticket.

---

## 10. Backend komponensek

### 10.1 Repository-k

Új interfészek:

- `MemoryChunkRepository`
- `MemoryCandidateRepository`
- `MemoryRetrievalRepository`
- `MemoryMaintenanceRepository`

A `PostgresKnowledgeChunkRepository` FTS megközelítése újrahasznosítható, de memória-scope-ra külön repository legyen.

### 10.2 Domain service-ek

Új vagy bővített service-ek:

- `MemoryProposalService`
  - `proposeMemoryChange`
  - `modifyCandidate`
  - `rejectCandidate`
  - `ticketCandidate`
- `MemoryApprovalService`
  - jogosultság ellenőrzés;
  - write-gate token;
  - candidate -> chunk/changeSet;
  - manifest publikálás.
- `MemoryRetrievalService` (**pure**, a runtime-formát nem ismeri — a query-t a `context-assembly.ts` építi, §5.1.1)
  - `retrieveForRun(MemoryRetrievalRequest): MemoryRetrievalResult`;
  - token-budget (`projectState` + `chunks` külön);
  - `project_state` vetület + top-K;
  - `activeFocusChunkId` + `supersedeCandidates` visszaadása a capture-höz;
  - `no_query` fallback;
  - conflict detection.
- `MemoryMaintenanceService`
  - maintenance proposal generálás (proposal-only, §8);
  - merge/supersede/demote/archive/delete_request/refresh_needed/conflict_review javaslat;
  - `memory.maintenance.run` capability + `maintenanceTokenBudget` keret.

### 10.3 Runtime integráció

Érintett runtime-ok:

- `agent-chat-runtime.ts`
- `general-task-runtime.ts`
- `wiki-runtime.ts`
- `bookkeeper-runtime.ts`
- `context-assembly.ts`

Váltás:

- régi: `agentDetails.memoryContent` teljes inject;
- új: `MemoryRetrievalService.retrieveForRun(...)`;
- prompt blokk: `Project memory context`, benne `project_state`, atomi chunkok, konfliktus jelölések;
- token-budget kötelező.

**Token-budget összjáték (v2.1):** a [`context-assembly.ts`](../../app/src/domain/conversation/context-assembly.ts) teljes kontextus-budgetje ma `DEFAULT_CONTEXT_BUDGET_TOKENS = 6000`, és a memóriát ma a `memoryContent` token-becslése terheli rá. A §12.2 default (1200 `projectState` + 2500 chunk = 3700) ebbe **nem fér bele kényelmesen** az üzenetek mellé. WP-3 döntése: az `assembleContext` a `memoryContent` helyett a **retrieval-eredmény tényleges token-becslését** kapja meg, és a teljes budget **10 000-re emelkedik** (a memória-rész továbbra is a saját §12.2 keretén belül marad — két külön, egymásba ágyazott korlát).

Betöltési mód:

- a retrieval az **egyetlen** út — nincs legacy full-inject fallback (§18);
- degradált mód (NF4): ha a retrieval hibázik/timeoutol, a futás nem áll le — üres memória + `memoryMode: degraded` audit;
- normál futásnál `memoryMode: retrieval`.

---

## 11. Frontend / UX

### 11.1 Chat memória-javaslat kártya

A chat stream új eseménytípust kap:

- `memory_candidate`

Kliens akciók:

- approve;
- edit;
- send to ticket;
- reject.

Kötelezően látható mezők:

- összefoglaló;
- type;
- scope;
- source;
- expected operation;
- conflict warning, ha van;
- review/expiry, ha van.

### 11.2 Agent memória oldal

Az agent detail oldalon a sima `ProseBlock` memória-nézetet fokozatosan váltja:

- aktuális `project_state`;
- aktív chunkok listája szűrőkkel;
- candidate queue;
- maintenance proposals;
- version manifest timeline;
- rollback.

### 11.3 Ticket integráció

Training/memory ticketben megjelenik:

- candidate payload diff;
- konfliktusok;
- sourceRefs;
- jóváhagyási döntés;
- létrejövő manifest preview.

---

## 12. Jogosultság és self-evolution profile

### 12.1 Új jogosultságok

Javasolt RBAC capability-k:

- `memory.propose`
- `memory.inline_approve`
- `memory.ticket_approve`
- `memory.maintenance.run`
- `memory.rollback`
- `memory.delete_approve`

### 12.2 `self_evolution_profile` bővítés

Javasolt mezők:

```jsonc
{
  "scope": ["memory"],
  "approval_mode": "human | higher_role | eval_only | auto_after_eval",
  "memory": {
    "allowedTypes": ["decision", "open_task", "assumption", "finding", "constraint", "artifact", "failed_attempt", "handoff_summary", "focus"],
    "inlineApprovalRoles": ["agent_owner", "memory_approver"],
    "captureMode": "explicit_only",
    "maintenanceMode": "manual_or_review_due",
    "maxProjectStateTokens": 1200,
    "maxRetrievedChunkTokens": 2500,
    "maintenanceTokenBudget": 4000
  }
}
```

V1 döntés: `captureMode = explicit_only`.

---

## 13. Munkacsomagok (fázisozás)

| WP | Tartalom | Fő deliverable | Függ |
|---|---|---|---|
| **WP-1** | `MemoryChunk` + `MemoryCandidate` séma + migráció (**+ FTS GIN-index raw SQL-ben**, §9.1); `MemoryVersion` manifest-mezők (`activeChunkIds`/`changeSet`/`projectKey`), `content` nullable (§9.3); **`WriteGateToken` bővítés** (§9.4); **`Conversation.projectKey`** oszlop (§2.1); **demo-agentek újraseedelése üres projektmemóriával** (nincs legacy backfill) + `Capability('memory_propose')` és `RolePermission` memória-kulcsok seedelése | Prisma modellek, migráció, seed | — |
| **WP-2** | Retrieval-adapter: memória-scope FTS a KB-motor mintájára + rangszámítás (§5.2) + `no_query` fallback + token-budget; `project_state` **on-read vetület** (§4.1) | `MemoryRetrievalService.retrieveForRun` (pure) | WP-1 |
| **WP-3** | Query-építés a `context-assembly.ts`-ben (§5.1.1); runtime-váltás **retrieval-only** (nincs fallback); prompt-blokk `Project memory context`; **capture-policy prompt-blokk** megírása (§2.3, §6); `memory.retrieve`/`queryMode`/`memoryMode` audit | Prompt-blokkok + `memory.retrieve` audit | WP-2 |
| **WP-4** | `memory_propose` broker-tool + `MemoryProposalService` (T1 candidate) + acceptance policy validáció (§3); **batch-javaslat** összeállítás | Tool + candidate-tár | WP-1 |
| **WP-5** | Chat-stream `memory_candidate` esemény + kliens-**batch-kártya** (approve/edit/ticket/reject) | SSE-esemény + UI-kártya | WP-4 |
| **WP-6** | Jogosultsági elágazás (`MemoryApprovalService`): inline write-gate consume vs. ticket; `self_evolution_profile` bővítés + RBAC capability-k (§12) | Azonnali vs. ticketes jóváhagyás | WP-5 |
| **WP-7** | Konfliktus-előszűrés + `conflict_set` átadás a modellnek + `memory.conflict_detected` (§7) | Konfliktus-detektor | WP-2, WP-4 |
| **WP-8** | Maintenance/consolidation job (proposal-only, §8) + `MemoryVersion` **rollback** (§9.3) + timeline/rollback UI + agent memória-oldal (§11.2) | `MemoryMaintenanceService` + memória-oldal | WP-6 |

**Minimális élő vertikális szelet (G1):** **WP-1 + WP-2 + WP-3 + WP-4 + WP-5 + WP-6** — a capture-nek a retrieval a **kötelező** párja; e nélkül nincs „cross-conversation elérés", a retrieval nem opcionális ráépülés. A kritikus út két párhuzamos ág: `WP-1 → WP-2 → WP-3` (visszaolvasás) és `WP-1 → WP-4 → WP-5 → WP-6` (capture+jóváhagyás); a szelet akkor „élő", ha **mindkét** ág kész. A konfliktus (WP-7) és a maintenance/rollback (WP-8) ráépül.

---

## 14. Observability és metrikák

Az események (§5.3, §6.3, §7, §8.4) a meglévő append-only audit-láncba mennek. A `[[wp6-observability-build]]` metrika-regiszterbe új mérőszámok:

- `memory_candidates_total{status}` — javaslatok állapotonként (proposed/approved/ticketed/rejected).
- `memory_inline_approvals_total` vs. `memory_ticketed_total` — az elágazás aránya (§6.3).
- `memory_retrieve_tokens` (histogram) — a memóriára ténylegesen elköltött prompt-token; a token-budget betartásának bizonyítéka.
- `memory_retrieval_latency_ms` (histogram).
- `memory_chunks_active` (gauge, projektenként) — a memória mérete; ha nő, ez indokolja az embedding bevezetését (§5.2, Q7).
- `memory_conflicts_total{resolution}` — konfliktusok és feloldásuk módja.

*(A `memory_hit_rate` (`usedInAnswerCount/retrievedCount`) v1-ben **nem** headline-metrika: a `usedInAnswerCount` megbízhatatlanul mérhető (G10). Helyette a retrieval-gyakoriság + explicit user-feedback (`userConfirmedHelpfulCount`/`userCorrectedCount`) a minőség-jel.)*

Dashboard-nézet: candidate-átfutás (propose→döntés idő), inline/ticket arány, memória-méret trend projektenként, retrieval token/latencia és user-feedback arány.

### 14.1 Audit-esemény katalógus

A meglévő append-only audit-láncba (`[[wp6-observability-build]]`, `[[code-review-audit-hash-full-coverage]]`) írt új `action`-ök — **mindegyik regisztrálandó** a [`event-catalog.ts`](../../app/src/lib/audit/event-catalog.ts)-ben (a `memory.write_denied` már ott van, a minta adott):

- `memory.propose`
- `memory.candidate.modified`
- `memory.candidate.approved`
- `memory.candidate.ticketed`
- `memory.candidate.rejected`
- `memory.retrieve`
- `memory.conflict_detected`
- `memory.chunk.created`
- `memory.chunk.updated`
- `memory.chunk.superseded`
- `memory.chunk.archived`
- `memory.chunk.delete_requested`
- `memory.chunk.deleted`
- `memory.chunk.demoted`
- `memory.maintenance.started`
- `memory.maintenance.proposed`
- `memory.maintenance.approved`
- `memory.maintenance.rejected`
- `memory.rollback`

Minden esemény kötelező attribúciója:

- `agentId`
- `memoryId`
- `projectKey` / `tenantId`
- `runId` / `threadId` / `ticketId`, ha van;
- `actorUserId`, ha emberi döntés;
- az érintett candidate / chunk / version id-k.

---

## 15. Nem-funkcionális követelmények

- **NF1 — Token-budget kötelező.** A retrieval sosem lépheti túl a `maxProjectStateTokens + maxRetrievedChunkTokens` keretet (§12.2); túlcsordulásnál a legalacsonyabb score-ú chunkok esnek ki, a `core`/`project_state` marad.
- **NF2 — Scope-izoláció fail-closed.** A runtime csak az aktuális `tenantId`+`projectKey` scope-jából tölt vissza (§2.1); cross-project betöltés kizárólag explicit handoff-on át (v2). A `projectKey` mindig kitöltött (default `__general__`), így nincs néma „mindent" — a legrosszabb eset a `__general__` scope, nem a teljes memória.
- **NF3 — Reprodukálhatóság.** A `memory.retrieve` audit (§5.3) alapján egy régi agent-válasz memória-kontextusa determinisztikusan visszaállítható (memoryVersionId + returnedChunkIds).
- **NF4 — Degradált mód.** Ha a retrieval hibázik/timeoutol, a futás nem áll le: **üres memória-blokk** + audit-jelölés (`memoryMode: degraded`), nem a régi teljes-inject. *(v2.1 pontosítás: a `project_state` on-read vetület ugyanabból a service-ből/DB-ből épül — retrieval-hiba esetén az sincs; „fallback a project_state-re" nem értelmezhető.)*
- **NF5 — Latencia.** A retrieval a futás előtt egyszer fut; célérték p95 < 150 ms FTS-en (embedding nélkül).

---

## 16. Biztonság és adatvédelem

- **S1 — Write-gate megkerülhetetlen.** Minden T2-változás (create/update/supersede/archive/delete/`project_state` publikálás, maintenance-proposal elfogadás) aláírt, egyszer használatos tokennel megy (§2.4, §4.6.1). Az inline jóváhagyás csak a jóváhagyási lépést rövidíti.
- **S2 — Kemény padló.** A memória-önfejlesztés soha nem bővít capability-t/RBAC-ot ([`self-evolution-guard.ts`](../../app/src/domain/training/self-evolution-guard.ts)); a `memory_propose` sosem érinthet jogosultságot.
- **S3 — PII/érzékeny adat (Q6 lezárva, rétegzett).** A candidate propose-időben átmegy a content-guardon: **hard-block** csak nagy-biztonságú kategóriára (detektált secret/kulcs); **figyelmeztetés** (kártyán jelölés, a jóváhagyó dönt) a lágy PII-re — egy tisztán blokkoló kapu false-positive-jai megölnék a capture-UX-et. Érzékeny adat csak explicit indokkal, redakcióval és jóváhagyással kerülhet be (§3.2).
- **S4 — Prompt-injection ellenállás.** A visszatöltött memória a promptban **adat, nem utasítás**: elhatárolt blokkban (`Project memory context`), és a rendszerprompt kimondja, hogy a memória-tartalom nem felülírhatja a governance-szabályokat. Így egy mérgezett emlék nem tud jogosultságot vagy viselkedést átírni.
- **S5 — Memória-mérgezés.** A capture javaslat, nem írás; a jóváhagyó látja a diffet, a `sourceRefs`-et, az `evidence`-t és a konfliktusjelzést; magas kockázatú agentnél eval-kapu (§6.3).
- **S6 — Tenant-határ.** A `MemoryChunk` agent/projekt-scoped; a scope-kulcsok (memoryId/agentId/projectKey) tenant-reachability-őr mögött, a KB-nál már bevált fail-closed mintával (`[[code-review-kb-tenant-boundary]]`).

---

## 17. Tesztstratégia

- **Unit:** acceptance policy (§3.1/3.2 elfogad/elutasít), rangszámítás (§5.2 súlyok, decay), konfliktus-előszűrés (§7.1), scope-illesztés.
- **Integráció (roundtrip):** `memory_propose` → inline approve → write-gate consume → `MemoryChunk` → **másik** run/thread retrieve visszakapja (a cross-conversation mag bizonyítéka). Külön ág: nincs inline-jog → ticket keletkezik → jóváhagyás → chunk.
- **Rollback:** T2-változás → rollback N-re → az aktív-halmaz = manifest N `activeChunkIds`-e, a chunk-státuszok helyesen billennek, a `focus` helyreáll, semmi nem törlődik fizikailag (§9.3, G11); hash-egyezésű re-capture reaktivál, nem duplikál.
- **Degradált mód:** retrieval-hiba/timeout → `memoryMode: degraded`, üres memória, a futás nem áll le (NF4).
- **Retrieval-minőség eval:** a `kb-eval` mintájára memória-recall mérés (releváns chunk bekerült-e a top-K-ba) egy fixture projekt-memórián.
- **Konfliktus:** ellentmondó chunk publikálása → `conflict_set` átadás + `memory.conflict_detected`; magas kockázatnál a modell nem dönt.

---

## 18. Bevezetési és migrációs terv

Mivel ma csak demo-agentek vannak (nincs védendő éles baseline), a bevezetés **két lépés** — a shadow-mód, a per-agent fokozatos kapcsolás és a legacy fallback **elmarad** (G9):

1. **Séma + seed (WP-1):** `MemoryChunk`/`MemoryCandidate` migráció + `MemoryVersion` manifest-mezők; a demo-agentek **újraseedelése üres projektmemóriával**. Nincs legacy chunk, nincs `content` fallback.
2. **Capture + retrieval bekapcsolás (WP-2..6):** a retrieval az **egyetlen** betöltési út; a `memory_propose` + batch-kártya + jóváhagyás élesedik. Valódi agenteket már ebben a világban építünk.

A degradált-mód (NF4) marad a resilience-hez; ez nem legacy, hanem előrenéző hibatűrés.

---

## 19. Nyitott döntések

> A grillezés (2026-07-09) lezárta Q1/Q2/Q4/Q5/Q6/Q8-at; Q3/Q7 tudatosan halasztva.

- **Q1 — `project_state` előállítása — LEZÁRVA:** determinisztikus **on-read vetület**, nincs jóváhagyás, mindig friss (§4.1); a narratíva külön `focus` chunk (§3.1).
- **Q2 — `projectKey` származtatása — LEZÁRVA:** `tenantId`+`projectKey` együtt kötelező, default `__general__`; task-run: `ProcessDefinition.id`; chat: soft-default + látható projekt-választó (`Conversation.projectKey` oszlop, §2.1).
- **Q3 — Cross-project handoff — v2:** explicit `memory_handoff` tool, külön jóváhagyással; v1-ben szigorú scope-izoláció (NF2).
- **Q4 — Hard-delete — LEZÁRVA:** default soft-delete + audit; a fizikai törlés külön, explicit-gate-elt GDPR/jogi admin-út (`memory.delete_approve`), nem az agent-memória-folyamon belül (§8.4).
- **Q5 — Salience-decay — LEZÁRVA:** `salienceHint` kezdő + score-beli recency-decay + explicit feedback-lökés; nem maintenance-feladat (§5.2).
- **Q6 — PII-guard — LEZÁRVA:** rétegzett — secret=block, lágy PII=warn (§16 S3).
- **Q7 — Embedding-küszöb — halasztva, metrika-vezérelt:** nincs beégetett szám; a `KnowledgeIndexStore` cserepont mögött váltunk, ha a retrieval-minőség romlik vagy a `memory_chunks_active`/projekt néhány száz fölé nő (§5.2).
- **Q8 — Maintenance jog + költség — LEZÁRVA:** `memory.maintenance.run` capability + manuális trigger + per-kör `maintenanceTokenBudget` (§8.3, §12.2).

---

## 20. V1 elfogadási kritériumok (Definition of Done)

- [ ] Egy jóváhagyott emlék egy **másik beszélgetésben/futásban** visszakereshető (cross-conversation mag).
- [ ] A memória **retrieval-alapú**: a prompt-token a memóriára mérhetően a budget alatt, a teljes memória mérete a kontextusablakot már nem korlátozza.
- [ ] Az agent chatben **felajánl** emléket (`memory_propose` → kártya), és a jóváhagyás a user jogosultsága szerint **azonnal** vagy **ticketen** át hat.
- [ ] Minden T2-változás write-gate-elt, verziózott, rollback-elhető, auditált; a kemény padló és a scope-izoláció bizonyítottan tartja.
- [ ] A rollback append-only és determinisztikus: egy T2-változás visszagörgethető a manifest `activeChunkIds` alapján, fizikai törlés nélkül (§9.3); a degradált mód (NF4) nem állítja le a futást.
- [ ] A retrieval és a jóváhagyás reprodukálható (§5.3, §6.3) és dashboardon látható (§14).

---

## 21. Egymondatos összefoglaló

A memória **projektfolytonossági állapot** (hol tartunk, mi dőlt el, mi nyitott, mi nem működött): rétegzett (working → candidate → curated OKF → derivált `project_state`), **keresés-alapú** a teljes beinjektálás helyett, és **agent-kezdeményezett** — az agent felajánlja, mit jegyezzen meg, a jóváhagyó jogköre pedig eldönti, hogy azonnal életbe lép vagy tanítási ticketet szül; a write-gate, verziózás, rollback és a kemény padló végig érvényes.

---

## 22. Függelék — fogalmi megfelelés a mai állapottal

| Spec-fogalom | Mai kód / állapot | Viszony |
|---|---|---|
| T2 `MemoryChunk` (OKF-alak) | `MemoryVersion.content` (egyetlen szövegblokk) | Felváltja; nincs legacy-migráció (csak demo-agentek, üres újraseed), `content` null-olva (§9.3, §18) |
| Retrieval (`project_state` vetület + top-K) | Teljes memória-inject (`agent-chat-runtime.ts` stb.) | Felváltja; **nincs** full-inject fallback (retrieval-only), csak NF4 `degraded` (§10.3, §18) |
| `memory_propose` + kártya | `attemptUngatedMemoryWrite` (ma tiltás) | A tiltott „nyers írás" helyére kontrollált javaslat-út lép |
| Inline jóváhagyás / ticket elágazás (§6.3) | `TrainingService.createTrainingTicket` + write-gate | A ticket-út megmarad; az inline csak a jóváhagyási lépést rövidíti, a write-gate ugyanaz |
| Kemény padló | `SelfEvolutionGuard.denyCapabilityEscalation` | Változatlanul érvényes a memória-útra is (§16 S2) |
| Salience / retrieval-score (§5.2) | KB `ts_rank` FTS (`knowledge-repository.ts`) | A mechanizmus újrahasznosított, memória-scope-ra külön repositoryval (§9.1, §10.1) |

---

## 23. Kód-horgonyok WP-nként (v2.1 — implementációs vezérfonal)

A kódbázissal 2026-07-09-én verifikált belépési pontok. Cél: a fejlesztő WP-nként pontosan tudja, hová nyúl, és milyen meglévő mintát másol.

| WP | Hová nyúlsz | Melyik meglévő mintát másolod |
|---|---|---|
| **WP-1** | [`schema.prisma`](../../app/prisma/schema.prisma): `Memory`/`MemoryVersion` (~1240–1271. sor), `WriteGateToken` (~2235. sor, §9.4), `Conversation` (+`project_key`); migráció a `prisma/migrations/` sorozatba (`0004_agent_memory`), FTS-index külön raw SQL-lel; seed: [`seed.ts`](../../app/prisma/seed.ts) — üres projektmemória + `Capability(agentId, toolName='memory_propose')` sorok + `RolePermission` memória-kulcsok | `0002_kb_chunk_fts_index` (GIN raw SQL), `0003_skill_catalog` (új-tábla migráció szerkezete) |
| **WP-2** | Új `src/domain/memory/` modul: `MemoryRetrievalService` (pure, §5.1.1) + új `src/repositories/postgres/memory-chunk-repository.ts` | [`knowledge-repository.ts`](../../app/src/repositories/postgres/knowledge-repository.ts) `ts_rank`/`to_tsvector('simple', ...)` FTS-lekérdezése (~150–186. sor) |
| **WP-3** | A mai full-inject pontok cseréje: [`agent-chat-runtime.ts:1191`](../../app/src/domain/agent/agent-chat-runtime.ts), [`general-task-runtime.ts:717`](../../app/src/domain/agent/general-task-runtime.ts), [`bookkeeper-runtime.ts:74`](../../app/src/domain/agent/bookkeeper-runtime.ts), `wiki-runtime.ts`; query-építés + budget-integráció: [`context-assembly.ts`](../../app/src/domain/conversation/context-assembly.ts) (`assembleContext` bővítés, §10.3); `projectKey`: chat → `Conversation.projectKey`, task → `Ticket.processInstanceId` → `ProcessInstance.processDefinitionId` | a mai `Memória (aktív verzió):` blokk helyére `Project memory context` blokk; audit-append a meglévő `AuditRepository` úton |
| **WP-4** | Új `src/domain/tool-broker/handlers/memory.handler.ts` + felvétel a [`registry.ts`](../../app/src/domain/tool-broker/handlers/registry.ts) `TOOL_HANDLERS` listájába (a broker-mag nem módosul); `MemoryProposalService` a `src/domain/memory/`-ba | bármelyik friss handler (pl. `web-search.handler.ts`) a WP-8 free-function mintában; a capability-őr fail-closed — a `Capability` seed nélkül a tool nem hívható |
| **WP-5** | SSE: [`stream/route.ts`](../../app/src/app/api/v1/agent-chat/stream/route.ts) generikus `event.type`-ot streamel → új `memory_candidate` típus a chat-tool-loop eseményfolyamába ([`chat-tool-loop.ts`](../../app/src/domain/agent/chat-tool-loop.ts) `kind: 'tool'` progress-minta); kliens: [`agent-chat-panel.tsx`](../../app/src/components/agents/agent-chat-panel.tsx) | a kártya-state a `MemoryCandidate` DB-sorból **rehidratálható** — reconnectnél nem veszik el (illeszkedik a `chat-turn-resilience-spec` irányához) |
| **WP-6** | `MemoryApprovalService` a `src/domain/memory/`-ba; jogosultság: `RolePermission` (`permissionKey` + `minRole`, [`iam-service.ts`](../../app/src/domain/iam/iam-service.ts) upsert-minta ~316. sor); write-gate token kiállítás/consume: [`training-service.ts`](../../app/src/domain/training/training-service.ts) `approveTraining` memória-ága; tenant-őr: [`tenant-reachability.ts`](../../app/src/lib/tenant-reachability.ts) | az inline út a §9.4 szerint bővített tokent használja; a ticketes út a meglévő training-ticket folyamot |
| **WP-7** | Konfliktus-detektor a `MemoryRetrievalService`/`MemoryApprovalService` közös segédmoduljaként (`src/domain/memory/conflict-detection.ts`) | determinisztikus előszűrés (§7.1) unit-tesztelve a `skill-catalog` validátor-teszt stílusában |
| **WP-8** | `MemoryMaintenanceService` + rollback; UI: agent-detail memória-szekció ([`control-plane/agents/[agentId]/page.tsx`](../../app/src/app/control-plane/agents/%5BagentId%5D/page.tsx)) | metrikák a `lib/observability` regiszterbe (`[[wp6-observability-build]]`); audit-akciók a §14.1 katalógusból az event-catalogba felvéve |

**Két dolog, amit ne találj ki újra:** (1) az FTS-lekérdezés és az index kifejezése karakterre egyezzen (§9.1); (2) minden új audit-`action` kerüljön be a meglévő event-catalogba, különben a content-guard/katalógus-teszt elhasal.
