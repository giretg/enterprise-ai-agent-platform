# Fejlesztői specifikáció — Governed Flow Builder (Langflow-ihletésű Playbook-szerkesztés)

Státusz: **véglegesített tervezet — döntés-komplett (D1–D13), kód nincs** · Utolsó folytatás: **2026-07-05** · Forrásjavaslat: [`langflow_playbook_fejlesztesi_javaslatcsomag.docx`](../../langflow_playbook_fejlesztesi_javaslatcsomag.docx), [`playbook_decision_branching_fejlesztoi_specifikacio.docx`](../../playbook_decision_branching_fejlesztoi_specifikacio.docx) · Kapcsolódó memória: `playbook-process-lifecycle-build`, `playbook-phase2-build` · Follow-up task: `costEstimate=0` gateway-fix (§16.1)

## 0. Vezetői állítás

Nem Langflow-runtime-ot építünk, hanem **Langflow-szerű szerkesztési élményt** adunk a meglévő, governance-first Playbook V2 / Process runtime **fölé**. A cél gyors, vizuális folyamatépítés — de a kötelező kapuk, az audit, a verziózás és a determinista léptetés végig a jelenlegi szerveroldali entitásokban maradnak.

Kulcsdöntés (a javaslattevő dokumentumtól eltérően): **ez nem zöldmezős build.** A dokumentum roadmapjének 0., 2., 3. fázisa és az 5.7 Playbook Assistant **már kész és tesztelt** a repóban. Ez a spec kizárólag a **valódi deltát** írja le, a meglévő kódra ráépítve, azt nem lecserélve.

### 0.1 Ami MÁR KÉSZ (nem tárgya ennek a specnek)

| Meglévő képesség | Kód |
|---|---|
| Playbook spec + canonical hash + életciklus (draft→pending→published→retired) | `PlaybookVersionV2.{spec, compiledSpec, validationResult, contentHash}`, `computePlaybookContentHash` (`app/src/lib/playbook-v2/spec.ts`) |
| Compiler (állapotgép, gate-map, routing, input-slotok) | `PlaybookCompiler` → `CompiledSpec` (`app/src/domain/playbook/playbook-compiler.ts`) |
| Validator (uniqueId, referenciák, reachability/orphan, ciklusok, gate-criticality, role-kompat, tenant capability) | `PlaybookValidator` (`app/src/domain/playbook/playbook-validator.ts`) |
| ProcessDefinition (roleBindings, configValues) + ProcessTrigger (manual/chat/ticket/monitor_cron) | `ProcessDefinition`, `ProcessTrigger` + builder UI (`app/src/components/processes/process-definition-builder.tsx`) |
| Runtime entitások (step-státusz, delegáció) | `ProcessInstance`, `ProcessStepInstance`, `DelegationEdge` |
| NL→draft Playbook Assistant (propose-not-apply) | `playbook-author-agent.ts` |
| Read-only folyamatgráf (SVG, node-kattintás inspector) | `PlaybookFlowGraph` (`app/src/components/playbooks/playbook-flow-graph.tsx`) |

### 0.2 Ami ÚJ (ennek a specnek a tárgya)

1. **Runtime Trace overlay** — a tervezett folyamat gráfjára rárajzolt tényleges futás. *(WP-1)*
2. **Playbook Canvas** — React Flow alapú drag-drop szerkesztő, a spec kétirányú vetületeként. *(WP-2)*
3. **StepTemplate katalógus** — governance-safe, újrahasznosítható lépés-legók. *(WP-3)*
4. **Symbolic Simulation / dry-run** — a `compiledSpec` állapotgép-sétája hamis outputokkal, hiány- és költségbecslés. *(WP-4)*
5. **Risk-weighted verzió-diff + impact analysis**. *(WP-5)*
6. **Playbook Pack export/import** — a professional-services munka termékesítése. *(WP-6)*
7. **Step-outcome kontraktus + kaszkád-védelem** — minden step gépi kimenet-státuszt ad, és implicit hiba-éllel ágazik a hiba-útra, hogy a tartalmilag sikertelen lépés ne propagálódjon sikerként. *(WP-7)*
8. **Decision Step / Branch Node** — explicit, olvasható A/B (multi-outcome) elágazás-absztrakció a meglévő `onComplete` + `evaluateAdvance` mechanizmus fölé: az agent strukturált döntést ad (`decision`/`confidence`/`evidence`), a runtime determinisztikusan a Playbookban deklarált ágat választja. *(WP-8)*

## 1. Elvi keretek (megkötő döntések)

Ezek a döntések a grill-me egyeztetésen lettek rögzítve (2026-07-05):

- **D1 — A canvas vetület, nem új adatmodell.** A dokumentum node-típusai (Agent Step, Human Task, Approval Gate, Decision, Delegation, Tool Policy) egyike sem hoz új *végrehajtási* képességet — mind kifejezhető a mai `steps[] / gates[] / roles[] + onComplete routing` szerkezettel. Ezért a spec-alakot **nem** migráljuk egyesített node-gráffá. A canvas a meglévő szerkezetből *derivált* nézet.
- **D2 — A layout a hash-en KÍVÜL él.** A `canonicalize()` a teljes specet hash-eli, ezért a node-koordináták NEM kerülhetnek a `spec` JSON-be. Új, nem hash-elt tároló: `PlaybookVersionV2.layout` oszlop (§3.1). Egy node arrébb húzása SOHA nem szülhet új `contentHash`-t vagy verzió-diffet.
- **D3 — StepTemplate ≠ Agent Registry.** A StepTemplate legó-segédlet: előkitöltött spec-fragment. SOHA nem ad tool-jogot; a capability-t a Tool Broker kényszeríti ki runtime-ban. A meglévő `Recipe` entitáshoz nem nyúlunk (az az agent tanítási/interakciós folyamatához tartozik).
- **D4 — A Simulation szimbolikus, nem valódi futtatás.** Az MVP dry-run a `compiledSpec` állapotgépén sétál végig hamis step-outputokkal; NEM hív LLM-et, NEM ír éles rendszerbe. A költség heurisztikus becslés (token-modell), nem valós mérés.
- **D5 — Trace-first sorrend.** A WP-1 (Trace overlay) megy előbb: az adat már megvan, olcsó, és ez a legerősebb governance-demo. A drága Canvas (WP-2) utána.
- **D6 — React Flow.** A szerkesztő-canvas `@xyflow/react` alapú. A meglévő kézzel írt `PlaybookFlowGraph` SVG megmarad a read-only trace-nézethez (WP-1), a szerkesztés React Flow-ra épül.
- **D7 — Risk-weighted diff az MVP-ben.** A verzió-diff a gate / capability / role / criticality változásokat kiemeli; nem sima strukturális zaj.
- **D8 — StepTemplate eval: v1 opcionális, "certified" tier-hez kötött.** A published-höz NEM kell eval; egy külön `certified` jelöléshez viszont igen. Alak: `evalSamples: [{ sampleInput, expectations[] }]` a fragment mellett (nem a hash-elt fragmentben). A repóban ma **nincs** eval-koncepció — ez az első; ezért v1-ben szándékosan minimál és opcionális, hogy ne blokkolja a katalógust.
- **D9 — Pack: saját `PlaybookPack` envelope, NEM a connector-export kiterjesztése.** A pack szuperhalmaz (playbook + StepTemplate + connector-template + eval + demo + doc), ezért saját, contentHash-elt szekciókból álló boríték. A connector-szekció a MEGLÉVŐ `connector-template descriptor` alakot (`app/src/domain/connector-template/template-descriptor.ts`) újrahasználja — nem definiálunk másikat. A containment iránya: a Pack tartalmazza a connector-template-et, nem fordítva.
- **D10 — Trace overlay: poll, nem push.** Az MVP fix intervallumú poll (3–5s), amíg a `ProcessInstance` nem terminális; terminális állapotban a poll leáll. Push (SSE/websocket) későbbi optimalizáció, nem MVP.
- **D11 — Költség-tarifa: egyetlen `model.pricing` platform-setting, két fogyasztóval.** Per-modell input/output ár (EUR / 1M token, a `measurement-report` EUR-konvenciójához igazítva) platform-settingként. Ebből táplálkozik (a) a **valódi** gateway `costEstimate` — ami ma `model-gateway.ts:827`-en **fixen `0`** (lappangó hiba, lásd §16.1), és (b) a szimuláció heurisztikus becslése. Egy tarifa-forrás, nem kettő.
- **D12 — Step-outcome kontraktus + implicit hiba-él (kaszkád-védelem).** Minden step a próza mellé kötelező gépi `outcome` státuszt (`ok | blocked | failed`) ad; a hard signalokat (`kb_search` 0 találat, tool-denied, tool-loop exception) a **runtime kényszeríti rá determinisztikusan**, nem az agent optimista önbevallására bízva. Az elágazás **implicit hiba-éllel** történik (BPMN *error boundary event* modell), NEM kötelező döntés-node-dal minden step után. `blocked`/`failed` step sosem lesz happy-path `done`, és a kimenetét nem propagálja a következő step inputjába. Részletek: §10.
- **D13 — Decision Step: az agent szakmailag dönt, de a folyamatot nem vezérli.** Az agent-output alapú A/B (multi-outcome) elágazás **nem új orchestration-motor**: a meglévő `PlaybookStep.onComplete` + `CompiledRoutingRule` + `evaluateAdvance` (`runtime.ts:214`) réteg fölé húzott **explicit Decision Step absztrakció**. Az agent CSAK strukturált döntési outputot ad (`decision` + opcionális `confidence`/`evidence`); a tényleges ágat a **pin-elt `compiledSpec` és a szerveroldali runtime** választja ki, determinisztikusan, a Playbookban előre deklarált outcome-ok közül. Az agent nem ugorhat tetszőleges `stepId`-re, és nem kerülhet meg blocking approval gate-et (a meglévő gate-bypass védelem invariáns marad). A `decision` sugar-blokk — a `layout`-tal (D2) ellentétben — **a hash-elt `spec` része** (authoring-cukor, compile-time desugar `onComplete`-re, visszafelé kompatibilis). Részletek: §11.

## 2. Célarchitektúra (rétegek)

Változatlan a meglévő modell; a canvas és a nézetek ráépülnek:

| Réteg | Feladat | Fő entitások (meglévő) | Új elem |
|---|---|---|---|
| Design-time | Playbook tervezés, validálás, review | `PlaybookV2`, `PlaybookVersionV2`, `PlaybookAssignment` | Canvas (WP-2), StepTemplate (WP-3), Diff (WP-5) |
| Configuration-time | Ügyfélfolyamat összeállítása | `ProcessDefinition`, `ProcessTrigger` | — (kész) |
| Run-time | Determinista léptetés | `ProcessInstance`, `ProcessStepInstance`, `DelegationEdge`, `Ticket` | — (kész) |
| Governance-time | Audit, diff, approval, policy | `AuditLog`, `ToolCall`, `ModelCall`, `Capability` | Impact analysis (WP-5), Pack (WP-6) |
| Operator UX | Szimuláció, monitor, trace | — | Trace overlay (WP-1), Simulation (WP-4) |

## 3. Adatmodell-illesztés

### 3.1 `PlaybookVersionV2.layout` (új, nem hash-elt)

```prisma
// A canvas node-pozíciók és él-görbék. PREZENTÁCIÓ — a canonical hash-ből
// KIZÁRVA (D2). Alakja: { nodes: { "<stepId|gateId>": { x, y } }, viewport?: {...} }
layout  Json  @default("{}")  @map("layout")
```

- A `canonicalize()` **nem** érinti (külön oszlop, nem a `spec`-ben).
- A canvas mentéskor a `spec`-et és a `layout`-ot **külön** perzisztálja. Csak a `spec` változása vált ki új `contentHash`-t / új verziót.
- Migráció: additív oszlop, meglévő rekordokon `{}` default; a `PlaybookFlowGraph` auto-layout marad a fallback, ha `layout` üres.

### 3.2 `StepTemplate` + `StepTemplateVersion` (új, WP-3)

```prisma
model StepTemplate {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String?  @map("tenant_id") @db.Uuid   // null = globális, admin-karbantartott
  key           String
  name          String
  description    String?
  status        StepTemplateStatus @default(draft)   // draft | published | retired
  currentPublishedVersionId String? @map("current_published_version_id") @db.Uuid
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz
  archivedAt    DateTime? @map("archived_at") @db.Timestamptz
  versions      StepTemplateVersion[]
  @@unique([tenantId, key])
  @@map("step_templates")
}

model StepTemplateVersion {
  id            String   @id @default(uuid()) @db.Uuid
  templateId    String   @map("template_id") @db.Uuid
  version       Int
  // Egy playbook-spec `steps[]`-fragment + ajánlott gate(ek), role-PLACEHOLDER-rel.
  // requiredCapabilities benne van, DE ez csak JAVASLAT — jogot nem ad (D3).
  fragment      Json
  contentHash   String   @map("content_hash")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz
  template      StepTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  @@unique([templateId, version])
  @@map("step_template_versions")
}
```

A fragment alakja (a `playbookStepSchema` részhalmaza + opcionális gate):

```json
{
  "step": {
    "id": "__PLACEHOLDER__",
    "name": "Invoice exception classifier",
    "assignedRole": "__ROLE__",
    "requiredGateIds": [],
    "requiredCapabilities": ["file:read", "model:standard"],
    "outputContract": { "exception_list": "array", "summary": "string" },
    "criticality": "L1"
  },
  "suggestedGate": null
}
```

**Governance-korlát (D3):** beszúráskor a canvas a `__PLACEHOLDER__` id-t egyedivé teszi, a `__ROLE__`-t kötelező hozzákötni egy valós role-hoz, a `requiredCapabilities` pedig a szokásos validátor + Tool Broker ellenőrzésen megy át. A template önmagában semmilyen futásidejű jogot nem hordoz.

## 4. WP-1 — Runtime Trace overlay (ELŐSZÖR)

**Cél:** ugyanazon a folyamatgráfon látszódjon a *tervezett* és a *tényleges* futás — "nemcsak megtervezzük, bizonyítani is tudjuk, mi történt".

- Adatforrás: `ProcessStepInstance` (státusz, assignedAgent/User, ticketId, időbélyegek), `DelegationEdge` (átadási él státusz), és az audit-link (`AuditLog`, `ToolCall`, `ModelCall`).
- Megjelenítés: a `PlaybookFlowGraph` node-jaira státusz-overlay (pending / running / done / failed / skipped), az élekre a tényleges útvonal kiemelése.
- **Eltérésjelzés:** tervezett ág helyett más ág, retry, failed delegation, skipped step, manuális beavatkozás — vizuálisan megkülönböztetve.
- Node-kattintás → step-instance detail: ki kapta, mikor, melyik ticket, milyen tool-hívások, hol volt approval-gate.
- Read-only; nem szerkeszthető. A meglévő SVG-gráfot bővíti, React Flow nem kell hozzá.

**Deliverable:** `ProcessInstance` detail oldal "Folyamat-trace" nézet; a `PlaybookFlowGraph` `traceOverlay` prop-ja; step-instance drill-down.

## 5. WP-2 — Playbook Canvas (React Flow)

**Cél:** vizuális, könnyen kezelhető szerkesztő az adminoknak/tanácsadóknak — a JSON-kézírás kiváltása (a JSON/compiled nézet expert-módként megmarad).

- **Tech (D6):** `@xyflow/react`. Új függőség.
- **Node-típusok (derivált, D1):** Start, Agent Step, Human Task, Approval Gate, Decision, Delegation, End. Ezek **nem** új spec-entitások:
  - Start/End → entry-step / terminális step;
  - Agent Step vs Human Task → `step.assignedRole` (agent- vs. humán-role);
  - Approval Gate → `gates[]` + a step `requiredGateIds`-ja (a canvas a gate-et a step-hez ragasztva/rombuszként rajzolja);
  - Decision → `onComplete` routing-feltételek;
  - Delegation → átmenet másik role-ú step-re.
- **Inspector panel (jobb oldal):** a kiválasztott node kötelező mezői — assigned role, ticket type, input slots, output contract, required capabilities, criticality.
- **Kétirányú szinkron:** canvas ⇄ `spec` JSON. A canvas mindig a kanonikus `spec`-et állítja elő; a `layout` külön mentődik (D2).
- **Állapot-badge:** a canvas mindig mutatja: Draft / Pending approval / Published / Retired + a Playbook-verziót.
- **Két nézet (kockázat-mitigáció):** egyszerű üzleti nézet + expert JSON/compiled nézet (a meglévő `playbook-spec-editor.tsx`).
- A **publish/approval nem változik**: a canvas draftot ír, a meglévő `draft → validál → ember jóváhagy → publish` lánc érintetlen.

**Deliverable:** `PlaybookCanvas` komponens; spec↔canvas mapper (`spec-to-flow` / `flow-to-spec`); layout-perzisztencia; StepTemplate-beszúrás (WP-3-mal együtt).

## 6. WP-3 — StepTemplate katalógus

- Új entitások §3.2 szerint; admin CRUD (globális + tenant scope); draft→published→retired.
- A canvas bal oldali palettáján választható; beszúráskor id-t egyedít, role-t kötni kell.
- Minden template-hez: leírás, input/output szerződés, `requiredCapabilities`, criticality, ajánlott role, opcionális gate, (v2:) eval-minta.
- Kezdő katalógus (seed): `invoice-exception-classifier`, `payment-reconciliation-reviewer`, `policy-checker`.
- **Nem** duplikálja az Agent Registry-t; nem hivatkozik konkrét agentre.

## 7. WP-4 — Symbolic Simulation / dry-run

**Cél:** futás előtti bizonyosság éles hívás nélkül (D4).

- Bemenet: egy `ProcessDefinition` (vagy publikált Playbook-verzió) + példa input-payload.
- Motor: végigsétál a `compiledSpec` állapotgépén, minden step-hez **hamis** outputot injektál (a `outputContract` alapján generált placeholder), a routing-feltételeket kiértékeli.
- **Kimenet (report):**
  - hiányzó role binding (a `ProcessDefinition.roleBindings`-hoz képest),
  - hiányzó connector grant / tool capability mismatch (a role tényleges capability-ihez képest),
  - approval-gate-ek helye és escalation-út,
  - **heurisztikus** token/költség-becslés (per-step modell-konfig × becsült token, NEM valós hívás),
  - várható út (expected path) + becsült SLA.
- **Nem** ír éles rendszerbe; a report menthető a Playbook-verzió approval-csomagjához.
- Legalább **három** hibakategóriát mutasson: hiányzó role, hiányzó connector/capability, approval-gate/escalation (elfogadási kritérium).

**Deliverable:** `PlaybookSimulator` domain-szolgáltatás (a `PlaybookCompiler` outputját fogyasztja); simulation-report UI a canvas mellett; report-perzisztencia.

## 8. WP-5 — Risk-weighted verzió-diff + impact analysis

- **Diff (D7):** két Playbook-verzió `spec`-je között — új/törölt/módosított node, edge, gate. A gate / capability / role / criticality változás **kiemelve**; a puszta layout/kozmetikai eltérés nem számít (a `layout` nincs is a hash-ben).
- **Impact analysis:** mely `ProcessDefinition`-ök, `PlaybookAssignment`-ek, tenantok és aktív `ProcessTrigger`-ek pinelnek erre a Playbookra/verzióra → kit érint a publish.
- Approval előtt kötelező, hogy a `validationResult` blocking-error mentes legyen (már meglévő szabály).

**Deliverable:** `PlaybookDiffService` (canonical spec-alapú, layout-független); diff UI a verzió-history-ban; impact-lista a publish-dialógusban.

## 9. WP-6 — Playbook Pack export/import

- **Csomag tartalma:** Playbook(ok) + StepTemplate + Connector template + eval-készlet + demo input + dokumentáció, hordozható formátumban (contentHash-ekkel deduplikálva).
- **Import:** SOHA nem élesít automatikusan — előbb validation, mapping, approval. A tenant-specifikus értékek (secret, connector grant, role binding) import után **kitöltendő** konfigurációként jelennek meg (nem a pack tartalma).
- **Kockázat-mitigáció:** a pack CSAK template-et tartalmazhat; secret/connector-grant sosem utazik a packben.

**Deliverable:** pack-export/import szolgáltatás; import-wizard (validate → map → approve); a meglévő Connector Template katalógusra épít.

## 10. WP-7 — Step-outcome kontraktus + kaszkád-védelem

**Cél:** megakadályozni, hogy egy tartalmilag sikertelen lépés *sikerként* propagálódjon a következő lépésbe. Kiváltó eset: egy step a `kb_search` 0 találata után „Sajnálom, nem tudom elérni…" prózát írt, majd `board_write`-tal `state: 'done'`-ra állt (`general-task-runtime.ts` `buildStepCompletionPayload` → board_write done), és a downstream step ezt a bocsánatkérést **forrásként** („drafted proposal") nyelte le → a hiba végiggörgött a folyamaton.

**Kulcsfelismerés:** ez **soft failure** — mechanikailag siker, tartalmilag kudarc. Egy állapot-szintű (`done` vs `errored`) gate ezt **átengedi**, mert a ticket `done` lett. A védelem csak annyit ér, amennyit a **kimenet-jelzés**, amire elágazik.

### 10.1 D12 — Gépi step-outcome, nem próza

Minden step a domain-kimenete MELLETT egy kötelező, gépi státuszt ad vissza:

```json
{
  "outcome": {
    "status": "ok | blocked | failed",
    "reason": "missing_kb_source",
    "missing": ["doc:General Data Management and Protection Policy v1.1"]
  },
  "output": { /* a step outputContract szerinti hasznos adat */ }
}
```

- `ok` — a step teljesítette a szerződését (`outputContract` kitöltve) → happy path.
- `blocked` — hiányzó előfeltétel/input, emberrel vagy másik lépéssel feloldható (NEM hard hiba).
- `failed` — hard hiba (tool exception, tool-denied, kimerített retry).

**Determinista felülírás (a lényeg):** a státuszt nem az agent önbevallására bízzuk. A hard signalokat a runtime kényszeríti ki: ha a pre-fetch `kb_search` 0 találatot ad, a tool-broker `denied`-et ad, vagy a tool-loop exception-nel zárul, a runtime az `outcome`-ot `blocked`/`failed`-re állítja, függetlenül attól, mit írt az agent. A meglévő `buildStepCompletionPayload` / `outputRequiredFields` ezzel az `outcome` mezővel bővül, és a completion-payload validátora kötelezővé teszi.

### 10.2 Implicit hiba-él (nem döntés-node minden step után)

Ergonómiai megkötés: nem rajzoltatunk kötelező döntés-rombuszt minden step után (a Playbook-szerkesztő és a WP-10 Playbook-szerző agent belefulladna). Helyette a BPMN *error boundary event* modell:

- Minden nem-terminális stepnek van egy **implicit hiba-éle**. A szerző csak a happy path-t húzza meg; a hiba-ág default célja `awaiting_human`.
- A `spec.steps[]` opcionális `onError` (és opcionálisan külön `onBlocked`) routing-célt kap; ha nincs megadva, a compiler az implicit default-terminálhoz köti.
- A canvas ezt derivált hiba-portként rajzolja (D1 — vetület, nem új spec-entitás); a „Decision → onComplete routing" node-típus (§5) kiterjed az `outcome.status`-ra ágazásra.

### 10.3 Blocked/failed nem lehet `done`, és nem propagál

- Egy `blocked`/`failed` step nem állhat happy-path `board_write state:'done'`-ra, és a prózáját NEM adja át sikeres inputként a downstream stepnek. A runtime a hiba-élen viszi tovább (default `awaiting_human`).
- Precedens a rendszerben már van: a loop-guard→`awaiting_human` és a config-slot feloldhatatlanság→`blocked` minta. A WP-7 ezt egységesíti, és a soft failure felismerésével (tartalmi kudarc ≠ `done`) egészíti ki.

### 10.4 Ahol tényleges judge/validátor kell (opt-in)

Nem minden step után LLM-bíró (költség + latencia + saját hibamód). Csak magas kritikalitású (`L2+`) stepekhez, playbookonként **opt-in** validátor-gate, ami rubrika ellen nézi: valódi válasz-e, vagy bocsánatkérés/blokkoló. Alapból az olcsó, strukturált `outcome` az egyetlen kapu.

### 10.5 Illeszkedés a többi WP-hez

- **WP-1 Trace:** az `outcome.status` + a bejárt él (happy vs hiba) pontosan a §4 „eltérésjelzés" — most explicit, nem heurisztika.
- **WP-4 Simulation:** a dry-run injektálhat `blocked`/`failed` outcome-ot és megmutatja a hiba-utat → erősíti a §14 „legalább három hibakategória" kritériumot.
- **Validátor (meglévő):** új szabály — minden nem-terminális step hiba-kimenete legyen kezelt (elérhető hiba-él vagy default), különben blocking-error.

**Deliverable:** `outcome` mező a step-completion payloadban + validátor; a runtime hard-signal→outcome kényszerítése (`general-task-runtime` / tool-loop); `onError`/`onBlocked` a spec-sémában + compiler implicit hiba-él; canvas hiba-port (derivált); simulation outcome-injektálás.

## 11. WP-8 — Decision Step / Branch Node

**Cél:** a meglévő, már működő feltételes továbblépést (agent `resultPayload` → másik step / gate / terminál) **explicit, olvasható termék- és fejlesztői fogalommá** emelni. A feladat NEM új orchestration-motor, hanem egy Decision Step / Branch Node absztrakció + validáció + UI + tesztkészlet a meglévő `onComplete` + `evaluateAdvance` mechanizmusra (D13).

**Kód-állapot (verifikált):** a branch-mag már létezik — `PlaybookStep.onComplete` (`spec.ts:98`), `CompiledRoutingRule` (`playbook-compiler.ts:65`), `evaluateAdvance` (`runtime.ts:214`, „konkrét feltételek előbb, `default` utoljára"), `ProcessService.advanceProcess`, és a magas/alacsony confidence branching-teszt (`playbook-v2-runtime.test.ts`). Ami hiányzik: az explicit absztrakció, a döntési-output erősebb validációja, az audit és a UI.

### 11.1 Célmodell

A Decision Step egy Playbook-lépés, amely agentet (v. opcionálisan determinisztikus klasszifikátort) futtat, és **strukturált** `resultPayload`-ot ad. A Playbook **előre deklarálja az összes engedélyezett outcome-ot és célágát**; a runtime csak ezek valamelyikét hajthatja végre.

| Kell | Tilos |
|---|---|
| Agent strukturált outputot ad: `decision`, `confidence`, `evidence` | Agent tetszőleges `stepId`-re ugrik |
| Playbook deklarálja az ÖSSZES engedélyezett outcome-ot | Agent kihagy kötelező approval gate-et |
| Runtime determinisztikusan választ ágat a `resultPayload` alapján | Prompt-szöveg / LLM-döntés közvetlenül átírja a folyamatot |
| Default/fallback ág kötelező vagy validáltan terminál | Ismeretlen outcome néma process-lezárást okoz |
| Auditban látszik: agent output, selected branch, matched rule | Branch-választás auditálatlan mellékhatásként |

### 11.2 Két kompatibilis implementációs út

**(a) MVP — a meglévő `onComplete` minta formalizálása (séma-törés nélkül).** A Decision Step ma is kifejezhető:

```json
{
  "id": "classify_invoice", "ticketType": "invoice_classification", "assignedRole": "invoice_checker",
  "outputContract": { "requiredFields": ["decision", "confidence", "evidence"] },
  "onComplete": [
    { "condition": { "field": "decision", "op": "==", "value": "clean_match" },     "nextStepId": "prepare_report" },
    { "condition": { "field": "decision", "op": "==", "value": "minor_exception" }, "nextStepId": "finance_review" },
    { "condition": { "field": "decision", "op": "==", "value": "major_exception" }, "gateId": "major_exception_approval" },
    { "condition": "default", "gateId": "decision_fallback_review" }
  ]
}
```

**(b) V1.1 — explicit `decision` sugar-blokk (`type: "decision_step"`).** Kényelmesebb authoring; **nem** új runtime-semantics — a compiler `onComplete`/`routingRules`-ra desugarolja. Mezői: `field`, `confidenceField`, `evidenceField`, `allowedOutcomes[]`, `branches{}`, `fallback`, `minConfidenceForAutoBranch`, `requiresEvidence`. A `decision`-blokk a hash-elt `spec` része (D13).

> **Séma-tény (verifikált):** a jelenlegi `conditionExpressionSchema` csak `default` vagy egyetlen `{field, op, value}` (op ∈ `== != >= <= > <`) — **nincs compound AND/OR**. Ezért a `minConfidenceForAutoBranch` küszöböt MVP-ben vagy (i) külön validation/runtime-helper kényszeríti (fallback-gate enforcement), vagy (ii) csak audit/warning; a compound-condition nyelvbővítés külön nyitott kérdés (§16).

### 11.3 Runtime viselkedés

A meglévő láncon fut, változatlan invariánsokkal: agent-ticket `ready` → dispatch → strukturált `resultPayload` → `TicketStateMachine` output-contract-ellenőrzés → `advanceProcess` → `evaluateAdvance(pinned compiledSpec, resultPayload)` → **első illeszkedő** feltételes rule, különben `default`/fallback → `next_step` (új `ProcessStepInstance` + `Ticket` + `DelegationEdge`) | `await_gate` (`awaiting_human`) | `complete`. **Branch-ordering invariáns:** konkrét feltételek előbb, `default` mindig utolsó; a validator figyelmeztet, ha `default` nem utolsó vagy több `default` van.

### 11.4 Validációs szabályok (a meglévő `PlaybookValidator` bővítése)

| Szabály | Leírás |
|---|---|
| `DECISION_FIELD_REQUIRED` | Decision Stepnél kötelező `decision.field`, vagy `onComplete`-ben ≥1 output-field alapú feltétel. |
| `OUTCOME_BRANCH_REQUIRED` | Minden `allowedOutcome`-hoz legyen branch vagy fallback. |
| `UNKNOWN_BRANCH_TARGET` | Minden `nextStepId`/`gateId` létező stepre/gate-re mutasson. |
| `DEFAULT_BRANCH_RECOMMENDED` | Legyen default/fallback ág, lehetőleg `manual_review` gate. |
| `CRITICAL_BRANCH_GATE_REQUIRED` | L2/L3 vagy rendszerbe író ág csak **blocking gate**-en át. |
| `EVIDENCE_REQUIRED_FOR_HIGH_RISK` | L2/L3 branch → `evidenceField`/`approvalEvidence` kötelező. |
| `NO_AGENT_GATE_APPROVAL` | Agent/system nem hagyhat jóvá blocking gate-et (meglévő bypass-védelem invariáns). |
| `OUTPUT_CONTRACT_HAS_DECISION` | Decision Step `outputContract.requiredFields` tartalmazza a `decision` mezőt. |
| `NO_SILENT_COMPLETE` | Feltételes ág + hiányzó fallback → legalább warning; production publish-nél policy szerint tiltott/indoklásköteles. |

### 11.5 Illeszkedés a többi WP-hez

- **WP-2 Canvas (§5):** a §5 „Decision → onComplete routing" node itt teljesedik ki — külön **rombusz/branch node**, outcome-táblával (outcome value, label, target step/gate, criticality, requires evidence), kötelezően látható fallback-ággal, outcome-névvel címkézett élekkel. A user **outcome-táblát** szerkeszt, nem JSON-t.
- **WP-4 Simulation (§7):** a doc `evaluatePlaybookAdvance(playbookVersionId, stepId, samplePayload)` **pure** endpointja a WP-4 szimulátor konkrét branch-motorja — a Canvas/Simulation ugyanazt az ágat mutatja, mint a runtime `evaluateAdvance` (elfogadási kritérium). Nem külön motor.
- **WP-5 Diff (§8):** a verzió-diff kiemeli az outcome/branch változásokat (risk-weighted) — publish-approval előtt.
- **WP-7 Step-outcome (§10) — a réteg-viszony tisztázása:** a `decision` (üzleti ág) és az `outcome.status` (`ok|blocked|failed`, health-jel) **két ortogonális réteg** ugyanazon a stepen. A health-réteg dönti el, *lefutott-e értelmesen* a step (különben implicit hiba-él → `awaiting_human`); a decision-réteg a *sikeres* futás üzleti ágát választja. Az „ismeretlen/nem-illeszkedő outcome → fallback gate, soha nem néma complete" (`NO_SILENT_COMPLETE`) pontosan a WP-7 hiba-élének üzleti-rétegbeli megfelelője — a kettő együtt zárja ki, hogy bármi (health- vagy üzleti okból) csendben `done` legyen.

### 11.6 Audit és observability

Minden branch-döntés auditált: **miért** azt az ágat választotta a runtime. Új audit-action `process.branch.select` (vagy `process.step.advance`), metadata: `process_instance_id`, `completed_step_id`, `selected_outcome`, `matched_condition`, `target_kind`, `target_id`, `confidence`, `evidence_ref`, `playbook_ref`, `playbook_version_id`, `playbook_content_hash`. Branch-mismatch/unknown outcome → `process.blocked` vagy fallback gate; **soha néma complete**. A WP-1 trace az élre `selected_outcome`-ot ír (edge-metadata).

### 11.7 API/service-contract kiegészítés

- `advanceProcess` input: agent decision-step `done`-nál `resultPayload` **kötelező**.
- `advanceProcess` output: `next_step`/`await_gate` mellett opcionális auditbarát `matchedRule`/`selectedOutcome`.
- Ticket completion-callback: **strukturált** `resultPayload`, nem szabad szöveg.
- Publish API: Decision Step validáció publish előtt fut; `compiledSpec` tartalmazza a generált `routingRules`-t.
- Új pure endpoint: `evaluatePlaybookAdvance(playbookVersionId, stepId, samplePayload)` (WP-4-gyel közös).

**Deliverable:** validator-bővítés (§11.4); branch-audit metadata `advanceProcess`-ben; `evaluatePlaybookAdvance` pure helper; Canvas Decision-node + outcome-tábla (WP-2-vel); (V1.1) `decision` sugar-séma + compiler-desugaring; E2E teszt (agent → decision → branch → gate/next-step). Munkacsomag-bontás és becslés: a forrás-doc §11.

## 12. Javasolt Playbook spec — igazítva a valós sémához

A javaslattevő dokumentum 6.1 vázlata lapos `steps[]`-et használt gate-step-pel; a **valós** séma szétválasztja a `roles[] / steps[] / gates[]`-et. A canvas ezt a valós alakot állítja elő (kivonat):

```json
{
  "schemaVersion": "1.0",
  "roles": [
    { "key": "reconciliation_worker", "requiredCapabilities": ["file:read", "model:standard"] },
    { "key": "finance_approver", "requiredCapabilities": [] }
  ],
  "steps": [
    { "id": "analyze", "name": "Analyze", "assignedRole": "reconciliation_worker",
      "requiredGateIds": ["approval"], "outputContract": { "exception_list": "array" } }
  ],
  "gates": [
    { "id": "approval", "type": "human_approval", "criticality": "L2",
      "requiredActorRole": "finance_approver", "blocking": true }
  ]
}
```

## 13. MVP roadmap (trace-first, D5)

| Fázis | WP | Cél | Miért itt |
|---|---|---|---|
| 1 | WP-1 | Runtime Trace overlay | Adat kész, olcsó, legerősebb governance-demo |
| 2 | WP-2 | Playbook Canvas (React Flow) | A könnyen kezelhető szerkesztő a fő user-igény |
| 3 | WP-3 | StepTemplate katalógus | A canvas legó-élményét adja; a WP-2-vel párhuzamosítható |
| 4 | WP-4 | Symbolic Simulation | Sales/delivery/compliance érték, futás előtti bizonyosság |
| 5 | WP-5 | Risk-weighted diff + impact | Governance-review érték |
| 6 | WP-6 | Playbook Pack | Tanácsadói IP termékesítése |
| 7 | WP-7 | Step-outcome + kaszkád-védelem | Megbízhatóság: soft failure nem propagál; a governance-ígéret alapja. WP-1 után, WP-2/4-gyel párhuzamos |
| 8 | WP-8 | Decision Step / Branch Node | A branch-mag már megvan; olcsó formalizálás (validator+audit+node). WP-2/4-gyel párhuzamos, a WP-7 health-rétegére ül rá |

## 14. Elfogadási kritériumok

- [ ] Egy admin a canvason vizuálisan létrehoz egy ≥4 lépéses Playbookot (Start → Agent Step → Approval Gate → End).
- [ ] A canvas mentése a meglévő determinista `spec`-et és `contentHash`-t eredményezi; a node arrébb húzása (csak `layout`) **nem** vált ki új verziót/hash-t.
- [ ] A validator (meglévő) továbbra is blokkolja: hiányzó role binding, orphan node, szerveroldalon nem fordítható gate, ismeretlen capability.
- [ ] A publish külön approval-lépéshez kötött; draft nem indít éles ProcessInstance-t (meglévő szabály megőrizve).
- [ ] A Runtime Trace visszarajzolja a tényleges step-státuszokat és delegation-edge-eket, jelzi az eltéréseket (retry, skip, más ág, manuális beavatkozás).
- [ ] Tool-hozzáférés csak Tool Broker `authorize()` után; a canvas-él önmagában nem jogosultság.
- [ ] A verzió-diff ember számára érthetően, risk-weighted módon mutatja a node/edge/gate/capability/role/criticality változásokat.
- [ ] A Simulation legalább három hibakategóriát mutat: hiányzó role, hiányzó connector/capability, approval-gate/escalation; nem ír éles rendszerbe.
- [ ] StepTemplate beszúrása nem ad futásidejű tool-jogot; a capability a Tool Brokeren dől el.
- [ ] Minden step gépi `outcome.status`-t ad (`ok|blocked|failed`); a completion-payload validátor kötelezővé teszi.
- [ ] Hard signal (`kb_search` 0 találat, tool-denied, tool exception) determinisztikusan `blocked`/`failed` outcome-ot ad, az agent optimista `done`-ját felülírva.
- [ ] `blocked`/`failed` step nem lesz happy-path `done`, és a prózája nem kerül a downstream step inputjába; a folyamat a (default `awaiting_human`) hiba-élen megy tovább.
- [ ] Minden nem-terminális step hiba-kimenete kezelt (validátor blokkol, ha nincs hiba-él/default).
- [ ] Egy Playbookban deklarálható ≥3 outcome-os agent Decision Step; a runtime a `resultPayload` alapján determinisztikusan a helyes ágat választja.
- [ ] Ismeretlen/hiányzó `decision` mező → fallback gate vagy validációs/policy error; production módban **nincs** néma process-complete (`NO_SILENT_COMPLETE`).
- [ ] L2/L3 ágra lépés csak blocking human gate-en át; agent nem ugorhat át approval gate-et.
- [ ] A kiválasztott branch auditálható: `matched_condition`, target step/gate, `selected_outcome`, Playbook-verzió.
- [ ] A Canvas/Simulation ugyanazt az ágat adja sample payloadra, mint a runtime `evaluateAdvance`.
- [ ] A meglévő `onComplete`-alapú Playbookok visszafelé kompatibilisek maradnak.

## 15. Kockázatok és mitigációk

| Kockázat | Hatás | Mitigáció |
|---|---|---|
| Túl gyorsan általános workflow-engine | Scope creep, lassú szállítás | MVP-ben 6-7 derivált node-típus; BPMN-szerű bővítés később |
| Canvas és runtime semantics szétesik | A felület mást ígér, mint amit a rendszer kikényszerít | Közös `spec → compiledSpec → state machine` pipeline; **nincs** UI-only logika (D1) |
| Layout beszennyezi a hash-t | Hamis verzió-diffek, review-fatigue | `layout` külön oszlopban, hash-ből kizárva (D2) |
| StepTemplate duplikálja az Agent Registry-t | Karbantartási teher, konceptuális zavar | StepTemplate = spec-fragment, agentre nem hivatkozik (D3) |
| Importált pack titkot szivárogtat | Adatszivárgás | Pack csak template; secret/grant mindig helyben (WP-6) |
| A canvas túl technikai az üzleti adminnak | Alacsony használhatóság | Két nézet: üzleti + expert JSON/compiled |
| Simulation valódi futtatássá dagad | Negyedéves scope | Szimbolikus dry-run, heurisztikus költség (D4) |
| Step-outcome az agent önbevallására bízva | Soft failure továbbra is átcsúszik | Hard signalok (tool-denied, 0-hit, exception) determinisztikusan felülírják az outcome-ot (D12 / §10.1) |
| Decision Step szabad folyamatvezérlésnek tűnhet | Agent megkerüli a governance-t | Az agent csak strukturált outputot ad; a branch-et a pin-elt `compiledSpec` + runtime választja; gate-bypass invariáns (D13 / §11.1) |
| `decision` sugar-blokk elszakad a runtime-tól | UI mást ígér, mint amit a rendszer kikényszerít | Compile-time desugar `onComplete`/`routingRules`-ra; nincs új runtime-semantics (§11.2) |

## 16. Lezárt kérdések

Az előző kör négy nyitott pontja eldöntve (D8–D11, §1):

- **Eval-formátum** → D8: v1 opcionális, `certified` tier-hez kötött, minimál `evalSamples` alak.
- **Pack-formátum** → D9: saját `PlaybookPack` envelope, a connector-descriptor újrahasznosításával.
- **Trace-frissítés** → D10: poll (3–5s), terminális állapotban leáll.
- **Költség-tarifa** → D11: egyetlen `model.pricing` platform-setting, két fogyasztóval.

### 16.1 Feltárt lappangó hiba (spec-en kívüli, follow-up)

A `ModelCall.costEstimate` **jelenleg fixen `0`** (`app/src/domain/gateway/model-gateway.ts:827`: `const costEstimate = 0`), pedig a token-számok (`promptTokens`/`completionTokens`) rögzülnek. Következmény: a `measurement-report` "átlag költség/ticket" mindig 0/`—`. A D11-beli `model.pricing` tábla bevezetése ezt is javítja (a gateway innen számol valódi becslést). Ez önálló, kicsi follow-up is lehet, de a tarifa-forrás ide, a specbe tartozik, ezért itt jelezzük.

### 16.2 Decision Step — nyitott részletkérdések (WP-8, implementáció előtt eldöntendő)

A branch-koncepció eldöntött (D13); az alábbi részletek implementáció-szintűek, nem blokkolják a WP-8 indítását:

- **Kötelező fallback?** Minden Decision Stepnél kötelező legyen a fallback, vagy elég publish előtti warning? (Jelen javaslat: production publish-nél kötelező/indoklásköteles — `NO_SILENT_COMPLETE`.)
- **Compound condition?** Kell-e AND/OR a feltétel-nyelvbe (ma nincs — csak `field/op/value`), vagy elég az egyszerű MVP? Ez dönti el, hogy a `minConfidenceForAutoBranch` a condition-nyelvben vagy külön helperben él.
- **Confidence-küszöb helye:** a condition-nyelv kezelje, vagy a `decision`-spec külön mezője (+ runtime-helper enforcement)?
- **`evidence_ref` modell:** inline payload, artifact-link, ticket-attachment, vagy audit-reference?
- **Human Decision Step?** A Decision Step lehet-e humán role-hoz kötött manuális döntés is, vagy kizárólag agent-outputra?
- **Editor-perzisztencia:** a Decision-node editor közvetlenül `decision`-blokkot mentsen, vagy már kliensoldalon `onComplete`-re fordítson?
