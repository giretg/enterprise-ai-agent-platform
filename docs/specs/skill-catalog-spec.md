# Fejlesztői specifikáció — Skill-katalógus (importálható, governance alá vont agent-skillek)

Státusz: **Fázis 1 KÉSZ** · Utolsó folytatás: **2026-07-08 (2)** · Kapcsolódó koncepció: `AI-Agent-Platform-Koncepcio.md` §4.6.3–4.6.4 (reflexió + önfejlesztési profil), §4.8.6 (recipe-katalógus + progresszív betöltés), §4.9 (erőforrás-modell) · Kapcsolódó memória: `connector-template-catalog-build`, `provisioning-assistant-build`, `iam-rbac-build`, `code-review-tool-broker-tenant-isolation` · Forrás: grill-me egyeztetés (2026-07-07)

> ## Megvalósítási állapot (2026-07-08)
>
> | WP | Állapot | Megjegyzés |
> |---|---|---|
> | **WP-1** Katalógus-entitások + repository + scope | ✅ **KÉSZ** | `Skill`/`SkillVersion`/`AgentSkill` séma+migráció, `skill-repository.ts`, fail-closed `skill-scope.ts`, seed |
> | **WP-2** `SKILL.md` import-adapter | ✅ **KÉSZ** | `skill-md-adapter.ts` (frontmatter + instrukció-bontás + provenience/hash/licenc) |
> | **WP-3** Import provisioning-pipeline | ✅ **KÉSZ** | `skill-validator.ts` (séma/méret/injection-lint/kód-detektálás → T2/T3 elutasítás), tier-levezetés, `SkillService.importSkillMd` + `approveVersion` (aláírt); **tanácsadó LLM-review él:** `skill-review-agent.ts` + `advisoryReviewVersion` + `reviewSkillVersionAction` + katalógus „LLM tanács" gomb (nem kapu, §D5) |
> | **WP-4** Hozzárendelés + readiness-check | ✅ **KÉSZ** | `assign/unassign` auditált, `computeSkillReadiness` (zöld/sárga/piros); **agent-detail skill-panel él** (`agent-skills-panel.tsx` + `actions/skills.ts`: readiness-jelzés, enable-kapcsoló, leszerelés, katalógusból hozzárendelés) |
> | **WP-5** Context-assembler + progresszív betöltés | ✅ **KÉSZ (live + snapshot)** | Level-0 index a promptba + `load_skill` valódi tool a `runAgentToolLoop`-ban (chat stream+non-stream **és** task-ág), fail-closed betöltés, `skill.loaded`/`skill.access_denied` audit. **Futásidejű snapshot perzisztálva:** `recordRunSkillSnapshot` → `skill.run_snapshot` audit a futáshoz (ticket/conversation) kötve, mindkét runtime-ban bekötve (reprodukálhatóság, D9/D12) |
> | **WP-6** App-on belüli szerzés/szerkesztés (3 forrás) | ✅ **KÉSZ** | write-gate `proposeVersion`/`approveVersion`/`rollbackToVersion` domain kész; **`/control-plane/skills` katalógus-oldal él** (`skill-catalog-manager.tsx`): SKILL.md import-form + kézi editor + **in-place verzió-szerkesztő** (`getSkillVersionAction` → `proposeSkillVersionAction`), **`triggerKeywords`/`parameters` mezők** a kézi és in-place formokban. **D14 desztilláció él:** chat-panel „Skill desztillálása" gomb **új skill / meglévő új verzió** választóval (admin, agent-detail). |
> | **WP-7** Governance & audit | ✅ **KÉSZ** | aláírás (`signSkillVersion`), rollback, minden audit-esemény bekötve (`skill.run_snapshot`, **`skill.version.reviewed`** felvéve); **verziólista + jóváhagyás + rollback gombok élnek** a katalógus-oldalon; **verzió-diff vizualizáció él** (`skill-diff.ts` + `diffSkillVersionsAction`). |
>
> **Tesztek:** `npm run test:skill-catalog` zöld (adapter, validátor, fail-closed scope, readiness, content-hash, progresszív betöltés, live `load_skill` loop-bekötés, futásidejű snapshot-perzisztálás, D14 desztilláló parse/transcript/requires, **verzió-diff**, **tanácsadó LLM-review parse/build**). `tsc`/`eslint` tiszta. UI: a control-plane route-ok auth-gate mögött (paritásban a többi oldallal).

## 0. Vezetői állítás

> **Közérthetően:** Az iparágban tömegesen tesznek közzé letölthető „skilleket" (pl. Anthropic Agent Skills — `SKILL.md` mappák). Ezek hasznos, kész munkaköri-leírás-darabok. A cél, hogy ezeket **be lehessen tölteni a platformba**, a governance-modellünknek megfelelően átvizsgálva és jóváhagyva, majd — a toolokhoz hasonlóan — **agentekhez rendelni**. Emellett skillt **az appon belül is lehessen készíteni és szerkeszteni**. A skill „ereje" mindig annyi, amennyi capability-t az adminisztrátor melléad — a skill szövege önmagában tehetetlen.

Nem új orchestration-motort építünk. A skill-katalógus a meglévő **Tool Broker + capability**, **write-gate/jóváhagyás**, **Provisioning Assistant** és **audit** rétegek **fölé** épül, azokat újrahasználva.

**Kulcsdöntés (fázisolás): ez a spec kizárólag a Fázis 1-et (instrukció-only skillek) írja le.** A kód-hordozó skillek (sandbox-futtatás, regeneráló agent) Fázis 2, külön spec — itt csak a határt jelöljük ki (§13), hogy a Fázis 1 ne épüljön rá téves feltevésre.

### 0.1 Ami MÁR KÉSZ (nem tárgya ennek a specnek)

| Meglévő képesség | Kód |
|---|---|
| Capability / Tool Broker (deny-by-default, tenant-izolált, hívás-időben kikényszerített) | `Capability`, `tool-broker-repository.ts` |
| Provisioning Assistant minta (draft → hardcoded validátor → LLM-assist → humán jóváhagyás → aktiválás) | Connector Onboarding (`provisioning.ts`, `provisioning-panel.tsx`) |
| Write-gate + verziózott promóció aláírt tokennel + rollback | `WriteGateService`, `WriteGateToken`, `signWriteGateToken` (`hash-chain.ts`) |
| Eval-kapu (Fázis 2 regenerációhoz) | `Eval`, `EvalRun` |
| Agent-harness Docker-izoláció egress-enforce-szal (Fázis 2 sandbox-alap) | `docker-local-harness-launcher.ts` (`egressEnforce`) |
| Tenant-határ minták (fail-closed, `actorTenantId`, reachability) | `code-review-tool-broker-tenant-isolation`, KB-boundary |
| Audit hash-lánc | `AuditLog`, `hash-chain.ts` |

### 0.2 Ami ÚJ (ennek a specnek a tárgya)

1. **Skill / SkillVersion / AgentSkill** entitások — importálható, verziózott, agenthez many-to-many köthető skill. *(WP-1)*
2. **`SKILL.md` import-adapter** — külső skill beolvasása a kanonikus belső sémára, provenience + licenc + hash rögzítéssel. *(WP-2)*
3. **Import provisioning-pipeline** — hardcoded validátor + kockázati-tier levezetés + tanácsadó LLM-review + humán jóváhagyás. *(WP-3)*
4. **Hozzárendelés + readiness-check** — hiányzó capability-k jelzése assign-időben (zöld/sárga/piros). *(WP-4)*
5. **Context-assembler integráció** — Level-0 index (csak hozzárendelt) + `load_skill` tool (Level-1, brokerelt, auditált). *(WP-5)*
6. **App-on belüli skill-szerzés/szerkesztés** — a write-gate pipeline fölé húzott UI, három forrással (import / kézi / **desztilláció beszélgetésből**). *(WP-6, D14)*
7. **Governance** — verziózás, aláírás, rollback, megosztott-skill jóváhagyás, audit-események. *(WP-7)*

## 1. Elvi keretek (megkötő döntések)

Ezek a döntések a grill-me egyeztetésen lettek rögzítve (2026-07-07):

- **D1 — A skill összetett objektum: puha + kemény.** `skill = puha rész (instrukciók, promptba injektálva) + kemény rész (`requires` capability-manifeszt + [Fázis 2] kód-csomag)`. A puha részt a modell követi vagy sem — ez elfogadható, mert **nincs foga**. A kemény részt (a skill által igényelt toolokat) a **Tool Broker kényszeríti ki** hívás-időben, deny-by-default. A skill hatóköre = a hozzá bekötött capability-k hatóköre; a szöveg maga tehetetlen.

- **D2 — A hozzárendelés kemény, input-oldali kontroll.** Ha egy skill **nincs** hozzárendelve egy agenthez, a skill szövege **egyáltalán nem kerülhet a kontextusba** — még a Level-0 indexbe sem. Az agent **nem tud a létezéséről**. Kikényszerítési pont: a szerveroldali **context assembler** (prompt-összeállító), NEM a modell diszkréciója. Ez az input oldalán ugyanolyan kemény fal, mint a capability a hívás oldalán.

- **D3 — Kockázati tier vezérli a jóváhagyási utat.** Az importáló a **tartalomból levezeti** a skill kockázati szintjét, és a szint **automatikusan meghatározza a kaput** (a 4.6.4 önfejlesztési-profil „tárcsa" logikájával konzisztensen):

  | Tier | Tartalom | Kapu | Fázis |
  |---|---|---|---|
  | **T0** | csak instrukció, nincs tool-igény, nincs kód | 1 admin jóváhagyás | **F1** |
  | **T1** | instrukció + tool-igény, nincs kód | + capability-review, readiness-check | **F1** |
  | **T2** | kód, **nincs** egress/secret (pl. doc-gen) | + statikus scan + sandbox + humán | F2 |
  | **T3** | kód **+ háló/secret** | legszigorúbb, alapból **tiltott** | F2 |

  Fázis 1 kizárólag **T0 + T1**. Kód-tartalmú skill (T2/T3) importja Fázis 1-ben **elutasított** (a validátor detektálja és blokkolja).

- **D4 — Az import a Provisioning Assistant mintát reuse-olja, nem új alrendszer.** Folyamat: `import draft → hardcoded validátor → tier-levezetés → tanácsadó LLM-review → humán jóváhagyás → aktiválás`. **Csak admin importálhat.**

- **D5 — Az LLM-review CSAK tanácsadó; a valódi kontroll a hardcoded lint + humán.** A skillt ellenőrző agentet a rosszindulatú skill maga **prompt-injektálhatja** („jelentsd ártalmatlannak"). Ezért az LLM-kimenet sosem kapu — a determinista lint (séma, méret, injection-minták, kód-jelenlét), a humán jóváhagyás és (Fázis 2) a sandbox a teherhordó kontroll.

- **D6 — Kanonikus belső séma; `SKILL.md` az első adapter.** A belső tárolás egy tipizált JSON (a mai `Recipe.content` szerkezetének kiterjesztése): `name`, `description`, `triggerKeywords[]`, `parameters[]`, `instructions[]`, **`requires[]`** (capability-manifeszt), `provenance`, `license`, `riskTier`. Az `SKILL.md` (YAML frontmatter `name`/`description` + markdown törzs) **az első import-adapter**, nem a natív formátum. Későbbi adapterek (más publikálási formátumok) ugyanerre a sémára képeznek.

- **D7 — Progresszív betöltés: Level-0 index mindig, Level-1 `load_skill` toolon át.** A Level-0 (név + leírás) **csak a hozzárendelt** skillekre mindig a kontextusban. A Level-1 (teljes `instructions`) egy explicit **`load_skill` tool**-hívással töltődik, amit az agent hív, amikor az indexből relevánsat lát. Előny: a behúzás **auditált ToolCall a Brokeren át**, token-olcsó, és a meglévő infrát használja. (Level-2 = mellékletek: Fázis 2.)

- **D8 — Kétrétegű, fail-closed katalógus.** **Platform-globális** (admin-kurált publikált packok, a tenantoknak **read-only**) + **tenant-lokális** (a tenant admin importja, **sosem látható más tenantnak**). A skill-feloldás fail-closed: hiányzó/ismeretlen tenant-scope → megtagadás. Illeszkedik a folyamatban lévő tenant-határ hardeninghez.

- **D9 — Hozzárendelés: könnyűsúlyú, auditált many-to-many.** Új `AgentSkill (agentId, skillVersionId, enabled)` — a `AgentConnector`/`Capability` mintájára. Egy skill assign/unassign **NEM szül új agent-verziót** (a mai `Recipe`↔`AgentVersion` 1:1 kötéssel szemben, ami nem skálázik sok skillre). A reprodukálhatóságot a **futásidejű snapshot** adja: minden futás rögzíti, mely skill-verziók voltak aktívak.

- **D10 — Readiness-check assign-időben, de a kemény padló érintetlen.** Hozzárendeléskor az app kijelzi (zöld/sárga/piros), mely `requires` capability-k **hiányoznak** az agentről — beleértve azokat is, amelyekhez **egyáltalán nincs connector** (piros: a skill nem működőképes, amíg nincs orvosolva). A readiness-check **csak jelez**, jogot **nem ad**: a capability-grant külön, magasabb jogú admin-aktus (kemény padló, 4.6.4). Skill sosem bővítheti a saját hatáskörét.

- **D11 — App-on belüli skill-szerzés = a write-gate pipeline UI-ja.** A skill-készítés/-szerkesztés **nem új governance-alrendszer**: a meglévő `proposed → approved → active` + verziózás + rollback + audit fölé húzott szerkesztő (strukturált mezők: `name`/`description`/`instructions`/`triggerKeywords`/`requires`). Egy **megosztott** (global vagy több agenthez kötött) skill módosítása sok agent viselkedését érinti → **jóváhagyás-köteles + auditesemény** (4.9.3).

- **D12 — Verziózás, aláírás, rollback.** Minden `SkillVersion` **aláírt** (a `WriteGateToken` mechanizmus reuse-ával), **rollback-elhető**, és a skill-katalógus változása a **write-gate alá esik**, mint a memória (4.6) és a megosztott erőforrások (4.9.3). Bármely futásra megmondható, mely skill-verzió volt aktív (reprodukálhatóság).

- **D13 — Kód-hordozó skill (Fázis 2) az izolációra épül, NEM forrás-átírásra.** Rögzítve, hogy a Fázis 1 ne feltételezzen mást: a Fázis 2 útja **regeneráló agent** (a külső skill mint *spec*, natív újragenerálás a célból) + **eval-kapu** (referencia-viselkedéshez mérés) + **OS-szintű sandbox** (konténer, nincs network namespace, read-only efemer FS, resource-limit, brokerelt egress). Az idegen kód automatikus „biztonságossá átírása" **elvetve** (adverzáriálisan törékeny, elveszíthető fegyverkezési verseny). A regeneráció a supply-chain kockázatot csökkenti, a runtime-kockázatot nem — a sandbox akkor is kell. **Kemény elv: az agent-írta skill-kód NEM megbízhatóbb attól, hogy a mi agentünk gyártotta** — pontosan ugyanazon a T2/T3 kapun (statikus scan + OS-sandbox + humán review + eval) megy át, mint egy külső, **azonos szigorral, provenience-kedvezmény nélkül** (4.6.4 kemény padló: az agent-kimenet sosem kap könnyített utat). A regeneráció csak azt nyeri, hogy nincs idegen bájt; a bug/erőforrás-abúzus/logikai-hiba kockázat változatlan.

- **D14 — Harmadik szerzési belépő: „skill desztillálása beszélgetésből".** A Claude-nál bevett minta (beszélgetés végén: „készíts ebből skillt") beépül a WP-6 authoring-pipeline **harmadik forrásaként** (import / kézi szerzés / **desztilláció**). Az agent egy **javasolt** `SkillVersion`-t (`proposed`) állít elő a beszélgetésből, ami a **változatlan write-gate kapun** megy át — sosem élő. Ez a koncepció **§4.6.3 reflexió-feeder** governance-konform megvalósítása (a marveen auto-skill-generálás „javasol, nem ír" változata), egyelőre **user-triggerelt** formában.
  - **Instrukció-only → T0/T1 → Fázis 1.** A desztilláló CSAK instrukciót + `requires`-manifesztet emel ki, kódot nem → a kimenet definíció szerint T0/T1, tehát Fázis 1-be fér (nem kell sandbox).
  - **A beszélgetés is nem-megbízható input.** A desztillált skill NEM megbízhatóbb attól, hogy a saját chatünkből jött (prompt-injection a beszélgetésben, manipulált agent) — azonos hardcoded validátor + humán jóváhagyás, **provenience-kedvezmény nélkül** (a D13 elv általánosítása).
  - **`requires` = a beszélgetésben ténylegesen használt toolokból levezetve, de javasolt-nem-adott** (kemény padló): ha a chat `gmail_send`-et hívott, a skill `requires: [gmail_send]`-et *javasol*, de a capability-grant külön humán aktus.
  - **Provenience = a forrás-conversation/ticket id** (auditálhatóság, reprodukálhatóság); alap-scope: tenant-lokális draft, sosem auto-global.
  - **Opcionális későbbi bővítés (NEM F1):** a §4.6.3 *automatikus* (determinista trigger a futás végén — sok eszközhívás / hiba utáni recovery / user-korrekció) változat ugyanezt a pipeline-t táplálja; egyelőre csak a user-triggerelt út van scope-ban.

## 2. Célarchitektúra (rétegek)

| Réteg | Feladat | Meglévő entitás | Új elem |
|---|---|---|---|
| Katalógus | Skill tárolás, verziózás, scope | — | `Skill`, `SkillVersion` (WP-1) |
| Import | Külső skill beolvasás + átvizsgálás | Provisioning Assistant minta | `SKILL.md` adapter (WP-2), import-pipeline (WP-3) |
| Design-time | Skill-szerzés/szerkesztés, jóváhagyás | `WriteGateService`, write-gate UI | Skill-editor (WP-6) |
| Kötés | Skill → agent hozzárendelés | `AgentConnector`/`Capability` minta | `AgentSkill` + readiness-check (WP-4) |
| Run-time | Progresszív betöltés, behúzás | context assembler, Tool Broker | Level-0 index + `load_skill` tool (WP-5) |
| Kikényszerítés | Capability (kemény), audit | `Capability`, `AuditLog` | — (reuse) |

## 3. Adatmodell (Prisma-vázlat)

> Új entitások; a meglévő `Recipe`-hez **nem nyúlunk** (az az agent tanítási/interakciós útjához tartozik — konzisztens a governed-flow spec D3-mal). Későbbi konvergencia/migráció külön döntés.

```prisma
model Skill {
  id           String        @id @default(uuid()) @db.Uuid
  name         String
  description  String                              // Level-0 index szöveg
  catalogScope SkillCatalogScope @default(tenant)  // global | tenant
  tenantId     String?       @map("tenant_id") @db.Uuid   // null ⇔ global
  sourceType   SkillSourceType   @default(authored)       // authored | imported
  provenance   Json?                               // forrás-URL, eredeti hash, importált-formátum
  license      String?                             // SPDX vagy 'proprietary' / null
  riskTier     SkillRiskTier                       // t0 | t1 | t2 | t3 (F1: csak t0/t1)
  createdAt    DateTime      @default(now()) @map("created_at") @db.Timestamptz

  versions     SkillVersion[]
  @@index([tenantId])
  @@map("skills")
}

model SkillVersion {
  id           String              @id @default(uuid()) @db.Uuid
  skillId      String              @map("skill_id") @db.Uuid
  version      Int
  content      Json                // { instructions[], triggerKeywords[], parameters[] }
  requires     Json                // capability-manifeszt: [{ toolName, reason }]
  status       SkillVersionStatus  @default(proposed) // proposed | approved | active | retired | rolled_back
  contentHash  String              @map("content_hash")
  signature    String?             // WriteGateToken-aláírás
  approvedById String?             @map("approved_by") @db.Uuid
  createdAt    DateTime            @default(now()) @map("created_at") @db.Timestamptz

  skill        Skill               @relation(fields: [skillId], references: [id], onDelete: Cascade)
  approvedBy   User?               @relation("SkillApprovedBy", fields: [approvedById], references: [id])
  agentSkills  AgentSkill[]

  @@unique([skillId, version])
  @@map("skill_versions")
}

model AgentSkill {
  agentId        String   @map("agent_id") @db.Uuid
  skillVersionId String   @map("skill_version_id") @db.Uuid
  enabled        Boolean  @default(true)
  assignedById   String?  @map("assigned_by") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz

  agent          Agent        @relation(fields: [agentId], references: [id], onDelete: Cascade)
  skillVersion   SkillVersion @relation(fields: [skillVersionId], references: [id], onDelete: Cascade)

  @@id([agentId, skillVersionId])
  @@map("agent_skills")
}
```

Enumok: `SkillCatalogScope { global, tenant }`, `SkillSourceType { authored, imported }`, `SkillRiskTier { t0, t1, t2, t3 }`, `SkillVersionStatus { proposed, approved, active, retired, rolled_back }`.

## 4. Munkacsomagok

### WP-1 — Katalógus-entitások + repository + scope ✅ KÉSZ
- Séma (§3), migráció, repository (`skill-repository.ts`) az `interfaces/index.ts`-be kötve.
- **Fail-closed scope-feloldás**: `resolveSkillForActor(actorTenantId, skillId)` — global (read-only) VAGY a saját tenant; idegen tenant skillje **sosem** olvasható (a tool-broker/KB tenant-minta reuse).
- Seed: 1–2 T0 demo-skill (pl. „reconciliation-checklist").

### WP-2 — `SKILL.md` import-adapter ✅ KÉSZ
- Parser: YAML frontmatter (`name`, `description`) + markdown törzs → `instructions[]` (szekciókra bontva) + `triggerKeywords[]` (ha van).
- **Provenience-rögzítés**: forrás, eredeti bájt-hash, formátum-jelölés; **licenc-metaadat** kinyerése (frontmatter / `LICENSE` / hiány → `null`, humán döntésre).
- **Fork-on-import**: az importált skill innentől a mi verziózott másolatunk; upstream frissítés nem folyik be automatikusan.
- Admin-only belépési pont.

### WP-3 — Import provisioning-pipeline ✅ KÉSZ
- **Hardcoded validátor (kapu):** séma-megfelelés, méret-limit, injection-minta lint (pl. „ignore previous", secret-kérés, exfil-minták), **kód-jelenlét detektálás** → ha kód van, **T2/T3 → Fázis 1-ben elutasít**.
- **Tier-levezetés:** tartalomból T0/T1 (van-e `requires` tool-igény).
- **Tanácsadó LLM-review:** kockázat-összegzés, javasolt `requires` capability-lista — **nem kapu** (D5). ✅ **KÉSZ:** `SkillReviewAgent` + `SkillService.advisoryReviewVersion` + `reviewSkillVersionAction`; a katalógus-oldalon proposed/approved verzióknál **„LLM tanács"** gomb (a hardcoded validátor eredménye mindig megjelenik mellette). Audit: `skill.version.reviewed`.
- **Humán jóváhagyás → `active`**, aláírt `SkillVersion` (WriteGateToken reuse), audit-esemény.

### WP-4 — Hozzárendelés + readiness-check ✅ KÉSZ
- `AgentSkill` assign/unassign action (admin), **auditált**. *(domain: `SkillService.assign/unassign`, `listAgentSkillsWithReadiness`; action: `actions/skills.ts` `assignSkillAction`/`unassignSkillAction`/`setSkillEnabledAction`, tenant-admin kapu.)*
- **Readiness-check UI**: a skill `requires` listáját összeveti az agent `Capability`-ivel → zöld (mind megvan) / sárga (van, de nem mind) / piros (hiányzó tool connector nélkül → nem működőképes). *(él: `agent-skills-panel.tsx` — per-tool státusz-badge + összesített szín.)*
- **Kemény padló:** a check csak jelez; capability-grant külön, magasabb jogú aktus. A skill sosem ad magának jogot.
- Skill-panel az agent-detail oldalon (a `agent-capabilities-panel` mintájára). *(`AgentSkillsPanel` a Szerkesztés-szekcióban, csak admin; hozzárendelés a katalógus aktív verzióiból.)*

### WP-5 — Context-assembler integráció (progresszív betöltés) ✅ KÉSZ (live + snapshot)
- **Level-0 index**: a prompt-összeállító a `AgentSkill enabled=true` skillek `name+description`-jét injektálja — **kizárólag** ezeket (D2 kemény kontroll). *(`AgentChatRuntime.buildSkillBinding` + `runAgentToolLoop` `skillIndexPrompt` — chat stream+non-stream és task-ág.)*
- **`load_skill` tool**: deny-by-default (csak a hozzárendelt skillekre oldható fel a `SkillService.loadSkillForAgent` fail-closed feloldásán át), a hívás **ToolCall-ként auditált** (`skill.loaded` / megtagadás: `skill.access_denied`); visszaadja a Level-1 `instructions`-t. A tool a capability-allowliston KÍVÜL fut (nem connector-tool), enforcement = a hozzárendelés. Ha az agentnek van hozzárendelt skillje, a tool-loop akkor is elindul, ha nincs más capability-tool.
- **Futásidejű snapshot** ✅: `SkillService.getRunSkillSnapshot` (aktív, enabled skill-verzió-id-k) + **`recordRunSkillSnapshot`** — a futás kezdetén `skill.run_snapshot` audit-eseményt ír a futáshoz (ticketId/conversationId) kötve, a snapshot skill-verzió-id-kkel. Bekötve a `general-task-runtime`-ba (ticket) és az `agent-chat-runtime` mindkét (stream + non-stream) ágába (conversation). Üres snapshotnál nem ír. Reprodukálhatóság = a snapshot-esemény visszakeresése (D9/D12).

### WP-6 — App-on belüli skill-szerzés/szerkesztés (három forrás) ✅ KÉSZ
> A write-gate domain-primitívek megvannak (`SkillService.createSkill/proposeVersion/approveVersion/rollbackToVersion`); az **import + kézi + desztilláció + in-place verzió-editor UI/domain él**.
- Strukturált editor (`name`/`description`/`instructions`/`triggerKeywords`/`requires`) a **write-gate pipeline** fölött: `proposed → approved → active`, verziózás, **rollback**, audit. *(kézi editor + verziólista/approve/rollback él; **in-place verzió-szerkesztő** a katalógus-oldalon; **`triggerKeywords`/`parameters` mezők** a kézi és in-place formokban — vesszős/sor-alapú szerkesztés.)*
- **Három szerzési forrás, EGY pipeline** (mind `proposed`-ként landol, azonos kapu):
  1. **Import** (`SKILL.md`, WP-2/3). ✅ UI: `importSkillMdAction` + import-form (scope-választó, validátor-hibák megjelenítve).
  2. **Kézi szerzés** (üres editor). ✅ UI: `createSkillAction` + strukturált form (a hardcoded validátoron át).
  3. **Desztilláció beszélgetésből** (D14): „készíts ebből skillt" action egy conversation/ticket felett → az agent instrukció-only javaslatot ad + levezetett `requires` (javasolt-nem-adott) + provenience (forrás-id). A desztilláló **kódot nem** emelhet ki (T0/T1 kényszerítve). ✅ **KÉSZ:** `skill-distiller-agent.ts` (propose-not-apply LLM), `skill-distill-transcript.ts` (transzkript + determinisztikus `requires`), `SkillService.distillFromConversation`, `distillSkillFromConversationAction`, chat-panel **„Skill desztillálása"** gomb + **új skill / meglévő új verzió** választó (admin, agent-detail).
- **Célzás:** a javaslat lehet **új skill** vagy **meglévő új verziója** (edit vs create), a dedup/drift kezelésére. ✅ *(domain: `proposeVersion` + `targetSkillId`; UI: chat-panel dropdown.)*
- **Megosztott skill** (global vagy több agenthez kötött) módosítása → jóváhagyás-köteles (4.9.3). *(a scope-kapu él: global írás csak platform-adminnak.)*

### WP-7 — Governance & audit ✅ KÉSZ
- `SkillVersion` aláírás (WriteGateToken), rollback-action, verzió-diff (a recipe/memória mintára). ✅ *(aláírás + rollback + audit domain kész; **verziólista + jóváhagyás- + rollback-gombok élnek** a katalógus-oldalon; **verzió-diff vizualizáció él:** `skill-diff.ts` + `diffSkillVersionsAction` + katalógus UI — kockázat-súlyozott változáslista.)*
- Audit-események: `skill.imported`, `skill.created`, `skill.version.proposed`, **`skill.version.reviewed`** (tanácsadó LLM-review), `skill.version.approved`, `skill.assigned`, `skill.unassigned`, `skill.loaded` (a `load_skill` hívás), `skill.access_denied`, `skill.rolled_back`, **`skill.run_snapshot`** (futásidejű reprodukálhatóság). *(mind az event-katalógusban.)*

## 5. Fejlesztői hatás / kockázatok

- **Tenant-határ:** a katalógus új cross-tenant felület — a WP-1 fail-closed scope-feloldás **P0**, teszttel (idegen-tenant skill olvasás/assign tiltása), a KB/tool-broker minták szerint.
- **Prompt-injection:** az importált skill támadó-kontrollált szöveg — a hardcoded lint + humán jóváhagyás + `load_skill` audit együtt kell.
- **Token-ökonómia:** sok assign-olt skillnél a Level-0 index nő; a `description` méret-limit + `load_skill` lazy betöltés tartja kordában.
- **Recipe-konvergencia:** a `Recipe` és a `Skill` később összeolvadhat; most szándékosan külön (nem migrálunk).

## 6. Hatókörön kívül (Fázis 2, külön spec)

- Kód-hordozó skillek (T2/T3): sandbox-futtatási szerződés, statikus scan, regeneráló agent, eval-kapu (D13).
- Level-2 mellékletek (scriptek, dokumentumok).
- Upstream-frissítés jelzés / re-import diff.
- Forrás-átírásra épített biztonság — **véglegesen elvetve** (D13).

> **Fázis 2 spec (tervezet, nincs grillezve):** `skill-catalog-phase2-spec.md`. Fontos korrekció benne: a fenti §0.1-ben Fázis 2 alapkőnek jelölt `Eval`/`EvalRun` és `docker-local-harness-launcher.ts` élesben mást csinál, mint amit a D13 feltételez — egyik sem nyújt ma valódi OS-szintű izolációt vagy skillre kötött eval-kaput. Lásd a Fázis 2 spec §0.2-t.
