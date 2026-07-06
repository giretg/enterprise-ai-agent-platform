# Playbook hibakezelési policy + hiba-él láthatóság

Fejlesztői specifikáció — konfigurálható default hibaág, hibatípus-tudatos routing és canvas hiba-él megjelenítés

**Enterprise AI Agent Platform — Playbook V2 / Process Runtime / Governed Flow Builder**

| | |
|---|---|
| Dokumentum típusa | Fejlesztői specifikáció |
| Célközönség | Platform fejlesztők, architect, QA, product owner |
| Státusz | Javasolt implementációs specifikáció |
| Dátum | 2026-07-06 |
| Kapcsolódó kódterület | `app/src/lib/playbook-v2`, `app/src/domain/playbook`, `app/src/components/playbooks` |
| Kapcsolódó spec | `playbook_decision_branching_fejlesztoi_specifikacio.docx` (szemantikai A/B elágazás), `docs/specs/governed-flow-builder-spec.md` (WP-7 §10.2 hiba-él) |
| Megvalósítás állapota | **P1 (Playbook- ÉS tenant-default, WP-1/2/4) + P2 (WP-1/2/3, részben) + WP-5 (validátor, részben) + WP-6 (audit) KÉSZ, + KRITIKUS WIRING-JAVÍTÁS KÉSZ** (§2.1) — lásd §8, §9 és §11 jelölés. P3 (canvas) + `UNREACHABLE_ERROR_ROUTE` + `timeout` watchdog még nincs implementálva, nincs commitolva. |

> **⚠️ Wiring-gap talált + javítva (2026-07-06, §2.1).** A P1 fejlesztés idején kiderült, hogy a lentebb leírt "a platform már ma implementálja" állítás a valós agent-végrehajtási úton **nem volt igaz**: a `general-task-runtime.ts` a `blocked`/`failed` hard-signal outcome-ot közvetlenül `awaiting_human`-ra írta, MEGKERÜLVE a `TicketStateMachine`/`ProcessService.advance`/`evaluateAdvance` réteget — vagyis a `step.onError`/`onBlocked`/`defaultErrorPolicy` routing élesben SOHA nem futott le, csak unit-tesztek szintjén. Ezt javítottuk (§2.1); a lenti "Lényeg" bekezdés az EREDETI (téves) feltevést írja le, a §2.1 az ÉRVÉNYES állapotot.

> **Lényeg.** A platform már ma implementálja a BPMN error-boundary mintát: a `failed`/`blocked` step-outcome-ot a runtime kaszkád-védelemmel egy hiba-élre, végső soron a beégetett `await_human` terminálra irányítja. Ez a spec **nem** új orchestration motor. Három, egymásra épülő, visszafelé kompatibilis bővítést ír le a meglévő `outcome.status` / `onError` / `evaluateAdvance` / canvas-projekció rétegre:
> 1. **Konfigurálható default hibaág** — a beégetett `await_human` helyett Playbook- (és opcionálisan tenant-) szintű alapértelmezett hibacél.
> 2. **Hibatípus-tudatos routing** — a `failed` vödör felbontása az `outcome.reason` alapján (pl. `tool_denied` ≠ `tool_loop_exhausted`).
> 3. **Hiba-él láthatóság a Canvas-on** — az `onError`/`onBlocked` és a default hibaág vizuális megjelenítése.

---

## Tartalom

1. Összefoglaló
2. Jelenlegi kódtámogatás
3. Célmodell és tervezési elvek
4. P1 — Konfigurálható default hibaág
5. P2 — Hibatípus-tudatos routing
6. P3 — Canvas hiba-él láthatóság
7. Runtime viselkedés (egyesített)
8. Validációs szabályok
9. Audit és observability
10. Tesztelési terv
11. Implementációs bontás
12. Elfogadási kritériumok
13. Nyitott kérdések
14. Forráshivatkozások

---

## 1. Összefoglaló

A Playbook V2 runtime `evaluateAdvance` magja a befejezett lépés `outcome.status` mezője alapján dönt (`app/src/lib/playbook-v2/runtime.ts`). Ha a státusz `blocked`/`failed`, **kaszkád-védelem** lép életbe: a happy-path ágakat kizárja, először a lépés hiba-éleit (`edgeType: 'error' | 'blocked'`) próbálja, és ha nincs kezelt él, **implicit BPMN error boundary**-ként a beégetett `await_human` terminálra megy.

Ez a viselkedés helyes és biztonságos, de három ponton merev:

- **P1.** Az implicit hibaág célja fixen `await_human` (generikus emberi felülvizsgálat ticket). Nincs mód arra, hogy egy Folyamat vagy tenant kimondja: „nálam a kezeletlen `failed` az `incident_review` blocking gate-re menjen".
- **P2.** A `failed` egyetlen vödör. A `computeStepOutcome` már ma megkülönbözteti a `reason`-t (`tool_denied`, `tool_loop_exhausted`, `output_contract_unmet` — `app/src/lib/playbook-v2/process-step-payload.ts`), de a routing csak `outcome.status`-ra ágazik, a `reason` elvész a döntésből.
- **P3.** A Canvas (`specToCanvasModel`) csak az `onComplete`/`requiredGate`/`transition` éleket vetíti ki; az `onError`/`onBlocked` hiba-él és a default hibaút a szerző számára láthatatlan → könnyű néma, kezeletlen ágat hagyni.

Mindhárom bővítés a meglévő mechanizmusra ül rá; **egyik sem vezet be új runtime-semantics-et** a `evaluateAdvance` szintjén (a P2 kifejezetten a meglévő `condition`-kiértékelést használja újra), és a **pin-elt `compiled_spec` determinizmusa** (§4.3 content-hash, process-pinning tesztek) sértetlen marad.

---

## 2. Jelenlegi kódtámogatás

| Réteg | Meglévő képesség | Forrás |
|---|---|---|
| Outcome-kontraktus | `outcome.status ∈ {ok, blocked, failed}` + opcionális `reason`, `missing` | `spec.ts` `stepOutcomeSchema` (96–101) |
| Hard-signal | `computeStepOutcome` determinisztikusan állítja a státuszt+reason-t (`tool_loop_exhausted`, `tool_denied`, `output_contract_unmet`) | `process-step-payload.ts` |
| Hiba-él séma | `step.onError` / `step.onBlocked`: `routingTargetSchema` (step VAGY gate) | `spec.ts` (109–118, 202–203) |
| Compiler | `onError`→`error` él (`outcome.status == failed`), `onBlocked`→`blocked` él, hiba-élek ELŐSZÖR | `playbook-compiler.ts` (210–232) |
| Runtime mag | `evaluateAdvance` kaszkád-védelem: hiba-él → `await_gate`/`next_step`, egyébként `await_human` | `runtime.ts` (233–255) |
| Runtime feltétel | `evaluateCondition` + `readPath` — **pontozott útvonalat** kezel (`outcome.status`, tehát `outcome.reason` is működne) | `runtime.ts` (351–397) |
| Service | `advanceProcess` — `await_human` ágon `interaction` review-ticket + `process.blocked` audit + alert | `process-service.ts` (519–572) |
| Canvas projekció | `specToCanvasModel` — `entry/flow/decision/gate/requires/end` élfajták; hiba-él **nincs** kivetítve | `canvas-mapping.ts` (41, 293–337) |
| Canvas stílus | `EDGE_STYLE` map élfajtánként (stroke/dash) | `playbook-canvas.tsx` (86–92) |
| Validátor | `UNKNOWN_BRANCH_TARGET` már ellenőrzi az `onError`/`onBlocked` célt | `playbook-validator.ts` (155–205) |

**Következtetés.** A hiba-út teljes gépezete megvan (séma → compiler → runtime → service → audit → validátor). Ami hiányzik: (P1) alapértelmezett cél a beégetett terminál helyett, (P2) a `reason` becsatornázása a döntésbe, (P3) a hiba-él láthatósága a vizuális szerkesztőben.

### 2.1 ✅ Wiring-gap javítva — a hiba-út most már ténylegesen lefut az agent-végrehajtásnál

**A talált probléma.** A §2 táblázat helyesen írja le, hogy a `evaluateAdvance`/`evaluateTicketTransition` réteg kezeli a `blocked`/`failed` outcome-ot — de ez a réteg csak akkor fut le, ha egy Playbook-folyamat ticketje a `TicketStateMachine.transitionTicket`-en át `done`/`approved`-ra vált (`ticket-state-machine.ts` 216: `STEP_COMPLETION_STATES`). A `GeneralTaskRuntime.processTicket` (`general-task-runtime.ts`) viszont — mind a tool-loop-kimerülés, mind az egyéb hard-signal `blocked`/`failed` esetén — **közvetlenül** `this.tickets.update(ticket.id, { state: 'awaiting_human' })`-öt hívott, és kézzel írta a process/step státuszokat, teljesen **megkerülve** a `TicketStateMachine`/`ProcessService.advance`/`evaluateAdvance` láncot. Következmény: a P1-ben megépített `step.onError`/`onBlocked`/`defaultErrorPolicy` routing élesben SOSEM érvényesült egyetlen agent-hibánál sem — csak a `evaluateAdvance`-t közvetlenül hívó unit-tesztek látták működni.

**A javítás.**
- `runtime.ts` `evaluateTicketTransition` — az output-contract kikényszerítés (`OUTPUT_CONTRACT_VIOLATION`) most kihagyásra kerül, ha a payload `outcome.status` `blocked`/`failed` (`isErrorOutcomePayload` helper). Enélkül a `done`-ra írt hiba-outcome azonnal DENY-t kapott volna a hiányzó kimeneti mezők miatt, mielőtt egyáltalán elérte volna a routingot.
- `general-task-runtime.ts` — új privát `routeNonOkStepOutcome` helper: ha a ticket Playbook-folyamathoz kötött (`processStep` létezik), a `board_write`-ot hívja `state: 'done'`-nal (az `outcome` mezővel a payloadban) a korábbi közvetlen ticket-írás helyett — így a `TicketStateMachine` → `ProcessService.advance` → `evaluateAdvance` ténylegesen kiértékeli a hiba-útvonalat (lépés-szintű `onError`/`onBlocked` → Playbook-default → beégetett `await_human`). Nem Playbook-folyamat ticketnél (nincs compiled routing) a viselkedés változatlan: közvetlen `awaiting_human` írás.
- Új design-elv (**TE-6**): *az output-contract SOHA nem blokkolhatja a hiba-utat* — a kötelező kimeneti mezők csak a happy-path teljesítettségét garantálják, nem szabad, hogy egy tartalmi kudarc emiatt DENY-be fusson ahelyett, hogy elérné a hiba-routingot.

**Tesztelve:** `playbook-v2-runtime.test.ts` két új eset (failed/blocked outcome a `done`-átmenetnél NEM `OUTPUT_CONTRACT_VIOLATION`); a teljes meglévő runtime/process/lifecycle/flow-builder tesztkészlet (5 fájl) továbbra is zöld, `tsc --noEmit` tiszta (útközben két, e session korábbi részéből származó, a fixtől független `structured: Prisma.JsonObject` cast-hiányt is javítottunk `general-task-runtime.ts`/`tool-broker-service.ts`-ben). **Nincs commitolva.**

---

## 3. Célmodell és tervezési elvek

**TE-1 — Nincs új runtime-semantics.** A `evaluateAdvance` szerződése (`AdvanceDecision` uniója) változatlan. A P1/P2 a **compiler** feladata: több/finomabb `error`/`blocked` élt bocsát ki, amelyeket a runtime a meglévő prioritási sorral kiértékel.

**TE-2 — A pin-elt spec determinisztikus marad.** A runtime SOHA nem olvas élő tenant-konfigot futásidőben. Minden default (Playbook- és tenant-szintű) a **publish/compile** pillanatában feloldódik és beépül a `compiled_spec`-be, amelynek content-hash-e pin-elt (§4.3). Egy futó Folyamat viselkedése nem változhat attól, hogy közben átírják a tenant-policyt.

**TE-3 — A beégetett `await_human` végső biztonsági háló marad.** A default hibaág feloldási sorrendje:
```
step.onError / step.onBlocked         (lépés-szintű, legmagasabb — meglévő)
   ↓ ha nincs
playbook.defaultErrorPolicy           (Folyamat-szintű — ÚJ, P1)
   ↓ ha nincs (publishkor a tenant-default ide oldódik fel)
beégetett await_human terminál        (végső háló — változatlan)
```
Így a NO_SILENT_COMPLETE invariáns erősödik: kezeletlen `failed`/`blocked` sosem lesz néma `complete`, és soha nem „vész el" — vagy explicit ágra, vagy a konfigurált defaultra, vagy emberi felülvizsgálatra megy.

**TE-4 — Gate-bypass védelem sérthetetlen.** A default hibaág célja lehet blocking gate; a meglévő `NO_AGENT_GATE_APPROVAL` invariáns (agent/system nem hagyhat jóvá blocking gate-et) érintetlen.

**TE-5 — Visszafelé kompatibilis.** `defaultErrorPolicy` nélküli Playbook a mai `await_human` viselkedést kapja bit-azonosan. `reason` nélküli hiba-él (mai `onError`) változatlanul `outcome.status == failed`-re illeszkedik.

**TE-6 — Az output-contract nem blokkolhatja a hiba-utat (§2.1, KÉSZ).** A kötelező kimeneti mezők (`OUTPUT_CONTRACT_VIOLATION`) csak a happy-path teljesítettségét garantálják. Egy `blocked`/`failed` outcome-mal `done`-ra író átmenetnél az output-contract check kihagyásra kerül, különben a hiba-outcome sosem érné el az `evaluateAdvance`-ot.

---

## 4. P1 — Konfigurálható default hibaág

> **✅ KÉSZ (Playbook-szint ÉS tenant-szint, §4.1/§4.2/§4.3), nincs commitolva.** `errorPolicySchema` + `playbookSpecV2Schema.defaultErrorPolicy` (`spec.ts`), a compiler per-lépés default `error`/`blocked` élt bocsát ki (csak lépés-szintű `onError`/`onBlocked` HIÁNYÁBAN, Playbook-default ELSŐBBSÉGGEL a tenant-default felett) + a default gate-célt `addCompiledGate`-be regisztrálja (`playbook-compiler.ts`); validátor `UNKNOWN_DEFAULT_ERROR_TARGET` + `TENANT_DEFAULT_ERROR_TARGET_MISSING` (warning) + az `IMPLICIT_ERROR_EDGE`/`CRITICAL_STEP_NO_ERROR_PATH` figyelembe veszi a (feloldható) tenant-default lefedettséget is (`playbook-validator.ts`); audit `error_route_source` (`step`/`playbook_default`/`tenant_default`/`await_human_fallback`) mindhárom advance-ágon (`process-service.ts`). §4.2 tenant-szintű feloldás (WP-4) is KÉSZ: `PlatformSettingsService.getTenantDefaultErrorPolicy`/`setTenantDefaultErrorPolicy` (tenant-kulcsos `PlatformSetting`, ugyanaz a minta, mint az egress-allowlistnél), `PlaybookV2Service.publishPlaybookVersion` publish-időben olvassa fel és adja át a validátornak+compilernek (`tenantDefaultErrorPolicy` — NEM a hash-elt spec része, a `version.contentHash` érintetlen, csak a `compiled_spec` tükrözi), admin server action (`getTenantDefaultErrorPolicyAction`/`setTenantDefaultErrorPolicyAction`, `app/actions/playbook.ts`). 15 új teszt zöld (`flow-builder-governed.test.ts`, ebből 8 WP-4-specifikus: prioritási sorrend, csendes kihagyás ha a cél nem létezik a Playbookban, validátor-warning, pinning-invariáns), a runtime (`evaluateAdvance`) **nem** módosult (TE-1).

### 4.1 Séma — Playbook-szint

Új opcionális blokk a `playbookSpecV2Schema` gyökerén (`spec.ts` 254):

```ts
export const errorPolicySchema = z.object({
  /** Kezeletlen `failed` step-outcome default célja (step VAGY gate). */
  onError: routingTargetSchema.optional(),
  /** Kezeletlen `blocked` step-outcome default célja. */
  onBlocked: routingTargetSchema.optional(),
})
export type ErrorPolicy = z.infer<typeof errorPolicySchema>

// playbookSpecV2Schema-ba:
  defaultErrorPolicy: errorPolicySchema.optional(),
```

- A `defaultErrorPolicy` a **hash-elt spec** része (a `computePlaybookContentHash` `canonicalize`-ja automatikusan felveszi — nincs külön teendő).
- Ha egy `onError`/`onBlocked` gate-célt ad meg, az a compiler `addCompiledGate` során ugyanúgy `CompiledGate`-té válik, mint a lépés-szintű hiba-gate (a `playbook-compiler.ts` 203–206 mintáját ki kell terjeszteni a Playbook-szintre).

### 4.2 Séma — Tenant-szint (opcionális, TE-2 szerint publishkor feloldva)

> **✅ KÉSZ, nincs commitolva.** A tervezettől ELTÉRŐEN a tenant-default NEM önálló DB-táblát/oszlopot kapott, hanem a meglévő kulcs-érték `PlatformSetting` réteget használja (ugyanaz a minta, mint a `provisioning.egress_allowlist`-nél, `platform-settings-service.ts`): egyetlen `playbook.tenant_default_error_policy` kulcs alatt egy `tenantId → ErrorPolicy` JSON-map. Nem volt szükség Prisma-migrációra.

```ts
// PlatformSettingsService (platform-settings-service.ts):
export const PLAYBOOK_TENANT_DEFAULT_ERROR_POLICY_KEY = 'playbook.tenant_default_error_policy'
async getTenantDefaultErrorPolicy(tenantId: string | null): Promise<ErrorPolicy | null>
async setTenantDefaultErrorPolicy(tenantId: string, policy: ErrorPolicy, actorId: string): Promise<ErrorPolicy>
```

**Feloldás publishkor** (`playbook-v2-service.ts` `publishPlaybookVersion`): a `getTenantDefaultErrorPolicy` egy opcionális, konstruktorban injektált függvény-függőség (`(tenantId) => Promise<ErrorPolicy | null>` — ugyanaz a lazy function-injection minta, mint a `TicketService`-nél a ticket-type-config lekérdezőnél, `domain/index.ts`, hogy elkerülje a `PlatformSettingsService` ↔ `PlaybookV2Service` kör-függőséget). A feloldott `tenantDefaultErrorPolicy` bekerül a validáció kontextusába (`TenantValidationContext.tenantDefaultErrorPolicy`) ÉS a `compiler.compile(spec, { tenantDefaultErrorPolicy })` opciói közé — de **NEM** a `version.spec`/`contentHash`-be (TE-2 sértetlen: a raw author-spec és a hash-e változatlan, csak a `compiled_spec` tükrözi az effektív eredményt).

A compiler (`playbook-compiler.ts`, `effectiveDefault` helper) a prioritási sorrendet lépésenként, ágakra (`onError`/`onBlocked`) külön-külön oldja fel: **lépés-szintű → Playbook-default → tenant-default → (semmi, runtime `await_human`)**. A tenant-default célja (step/gate) csak akkor kerül fel élként, ha `isRoutingTargetResolvable` szerint ténylegesen létezik EBBEN a Playbookban (`playbook-compiler.ts`, exportált helper) — ha nem, a compiler **csendben kihagyja** (nincs dobott hiba), és a beégetett `await_human` marad érvényben (TE-3 végső háló). Az `error_route_source` audit-mező (§9) ennek megfelelően `'tenant_default'` értéket is felvehet.

A validátor ellenőrzi a tenant-default cél létezését is (§8, `TENANT_DEFAULT_ERROR_TARGET_MISSING`, warning — NEM error, mert a tenant-policy sok Playbookra egyszerre vonatkozik, egy adott Playbookra való nem-illeszkedése nem publish-blokkoló); a `CRITICAL_STEP_NO_ERROR_PATH`/`IMPLICIT_ERROR_EDGE`/`DEFAULT_ERROR_TARGET_NOT_BLOCKING_GATE` szabályok a (feloldható) tenant-defaultot is lefedettségnek tekintik (`hasResolvedDefaultCoverage` helper, `playbook-validator.ts`).

Admin server action (`app/actions/playbook.ts`): `getTenantDefaultErrorPolicyAction` (viewer) / `setTenantDefaultErrorPolicyAction` (admin, auditált `playbook.tenant_default_error_policy.set` esemény). **Nincs hozzá admin UI** (csak a server action réteg kész) — külön follow-up, ha kell felület a beállításhoz.

> A tenant-default egy konvencionális gate-re mutasson, amit minden ilyen Folyamat tartalmaz (pl. `incident_review`). Ha a Playbook nem definiál ilyen gate-et, publish-warning: „a tenant hibapolicy `X` gate-et vár, de a Playbook nem tartalmazza — a beégetett `await_human` marad" — ez pontosan a `TENANT_DEFAULT_ERROR_TARGET_MISSING` warning.

### 4.3 Compiler kiterjesztés

A `playbook-compiler.ts` routing-generáló hurkában (210–232) minden lépéshez, amelynek **nincs saját** `onError` (ill. `onBlocked`), az effektív `compiled_spec.defaultErrorPolicy`-ből származó **default hiba-élt** bocsátunk ki, catch-all feltétellel:

```ts
// pszeudokód, a meglévő onError-blokk MELLÉ:
const effErr = step.onError ?? spec.defaultErrorPolicy?.onError
if (effErr) {
  routingRules.push({
    fromStepId: step.id,
    toStepId: effErr.nextStepId,
    gateId: effErr.gateId,
    trigger: 'step.completed',
    condition: { field: STEP_OUTCOME_STATUS_PATH, op: '==', value: 'failed' },
    edgeType: 'error',
    outcome: 'failed',
  })
}
// onBlocked analóg, edgeType: 'blocked', value: 'blocked'
```

Ezzel a **runtime-ban semmi nem változik**: a `evaluateAdvance` most is talál `error`/`blocked` élt, ezért a `await_human` ág csak akkor fut, ha se lépés-, se Folyamat-, se tenant-szintű default nincs (TE-3 végső háló).

> **Fontos sorrend.** A default hiba-él a lépés-szintű reason-specifikus élek (P2) UTÁN, de minden happy-path él ELŐTT kerül a `routingRules`-ba. A `evaluateAdvance` a hiba-éleket beszúrási sorrendben értékeli (`runtime.ts` 243–248), ezért a reason-specifikus élnek előbb kell lennie a catch-all defaultnál.

---

## 5. P2 — Hibatípus-tudatos routing

> **✅ KÉSZ (WP-1/2/3, §5.1/5.2/5.3), nincs commitolva.** `stepOutcomeReasonSchema` (5 nevesített reason) + `errorRouteSchema`/`errorRoutesSchema`/`stepErrorTargetSchema` (`spec.ts`); a `playbookStepSchema.onError`/`onBlocked` mostantól `RoutingTarget | ErrorRoutes` union. Compiler (`playbook-compiler.ts`): `normalizeErrorTarget`/`errorTargetGateIds`/`pushStepErrorRoutingRules` helperek — minden reason-kulcsos route ELŐSZÖR (magas prioritás), utána a catch-all (status-alapú) él; a Playbook-default (P1) csak akkor lép életbe, ha a lépésnek EGYÁLTALÁN nincs `onError`/`onBlocked`-je (sem reason-route, sem catch-all). A validátor (`playbook-validator.ts`) `UNKNOWN_BRANCH_TARGET`-je és a reachability-gráf (`buildAdjacency`) is kiterjesztve a reason-route célokra. Runtime (`evaluateAdvance`/`readPath`) VÁLTOZATLAN (TE-1) — a `outcome.reason` pontozott útvonal már eddig is működött. **WP-3 részleges**: `output_contract_unmet` valódi, elérhető hard-signal (`general-task-runtime.ts` a parse-olt structured outputot ellenőrzi `computeStepOutcome`-ba adás előtt); a **`timeout` reason egyelőre CSAK séma-szinten létezik** — nincs watchdog/cron, ami a `step.timeoutMinutes` túllépését ténylegesen észlelné, ezért ez a reason ma nem termelődik (lásd §13/7 nyitott kérdés, külön follow-up). 6 új teszt (`flow-builder-governed.test.ts`), tsc/eslint tiszta.

### 5.1 Reason-szótár

A ma szabad-szöveges `reason` (`process-step-payload.ts`) kap egy nevesített, bővíthető enumot a routing-illeszkedéshez (az egyedi reason-ök továbbra is megengedettek, csak nem célozhatók névvel):

```ts
export const stepOutcomeReasonSchema = z.enum([
  'tool_loop_exhausted',   // failed — kimerült tool-loop
  'tool_denied',           // failed — broker megtagadta a tool-hívást
  'missing_kb_source',     // explicit domain-ok — forráskötelezett lépés/agent jelzése, nem globális KB 0-hit hard-signal
  'timeout',               // failed — step timeoutMinutes túllépve (ÚJ hard-signal)
  'output_contract_unmet', // failed/blocked — kötelező output-mező hiányzik
])
```

A `computeStepOutcome` visszatérési `reason`-je ezekre az értékekre normalizálódik; a `timeout` és `output_contract_unmet` új hard-signalként bekötendő (a `StepOutcomeSignals`-ba).

### 5.2 Séma — reason-kulcsos hiba-él

Az `onError`/`onBlocked` a mai egyszerű `routingTargetSchema` MELLETT elfogad egy **reason→cél** listát is (diszkriminált union, back-compat):

```ts
export const errorRouteSchema = z.object({
  /** Melyik reason-re illeszkedjen; hiányában catch-all (a mai viselkedés). */
  reason: stepOutcomeReasonSchema.optional(),
  nextStepId: z.string().min(1).optional(),
  gateId: z.string().min(1).optional(),
}).refine((r) => r.nextStepId != null || r.gateId != null, {
  message: 'hiba-útnak nextStepId vagy gateId kell.',
})

// step.onError típusa:
//   RoutingTarget                (mai, catch-all)  VAGY
//   RoutingTarget & { routes: ErrorRoute[] }       (reason-kulcsos + fallback)
onError: z.union([routingTargetSchema, errorRoutesSchema]).optional(),
```

### 5.3 Compiler — reason-feltételes élek

Minden reason-kulcsos `ErrorRoute`-ból egy `error`/`blocked` él keletkezik, amelynek feltétele **compound** a `reason`-re:

```ts
// reason-specifikus él (ELŐSZÖR, magas prioritás):
condition: { field: 'outcome.reason', op: '==', value: 'tool_denied' }
edgeType: 'error', outcome: 'failed'
// majd a catch-all (reason nélküli) él: outcome.status == failed
```

Mivel a `readPath` már kezeli a pontozott `outcome.reason` útvonalat és a `evaluateAdvance` a hiba-éleket sorban értékeli, a **runtime-mag változatlan** — csak a compiler bocsát ki finomabb éleket, helyes sorrendben (reason-specifikus → status catch-all → Playbook default → `await_human`).

> **Megjegyzés a `field/op/value` nyelvről.** A jelenlegi `conditionExpressionSchema` egyetlen mező-összehasonlítást enged. A reason-alapú illeszkedéshez ez elég (`outcome.reason == X`). Ha egy ágat több reason-re akarunk illeszteni (`in` operátor), az a `conditionOpSchema` bővítése — külön, opcionális follow-up (lásd §13). MVP-ben egy reason = egy él.

---

## 6. P3 — Canvas hiba-él láthatóság

### 6.1 Új élfajta a projekcióban

`canvas-mapping.ts`:

```ts
export type CanvasEdgeKind =
  'entry' | 'flow' | 'decision' | 'gate' | 'requires' | 'end'
  | 'error' | 'blocked'   // ÚJ
```

A `specToCanvasModel` lépés-hurkába (293–313), az `onComplete` élek MELLÉ, a hiba-élek kivetítése:

```ts
for (const route of errorRoutesOf(s)) {   // s.onError + s.onBlocked normalizálva
  const target = route.nextStepId ?? route.gateId
  if (!target || !(stepIds.has(target) || gateIds.has(target))) continue
  push({
    id: `e_err_${s.id}_${route.kind}_${route.reason ?? 'any'}_${target}`,
    source: s.id, target,
    kind: route.kind,                       // 'error' | 'blocked'
    label: route.reason ?? (route.kind === 'error' ? 'failed' : 'blocked'),
  })
}
```

A Playbook-szintű `defaultErrorPolicy` **nem** rajzol N élt minden lépéstől (vizuális zaj); helyette a Canvas egy **globális jelölést** mutat (lásd 6.3).

> **Terminál-számítás.** A jelenlegi „terminál step → End" logika (`canvas-mapping.ts` 333–336) a `hasStepTarget` halmaz alapján dönt. A hiba-él céljait is fel kell venni `hasStepTarget`-be, különben egy csak-hiba-éllel rendelkező lépés tévesen End-re is kötődne.

### 6.2 Stílus

`playbook-canvas.tsx` `EDGE_STYLE` (86–92) + `EDGE_KIND_LABEL` (312) bővítés:

```ts
error:   { stroke: 'var(--color-coral)', dash: '4 3' },   // szaggatott piros
blocked: { stroke: 'var(--color-honey)', dash: '4 3' },   // szaggatott sárga
```

Az `EdgeInspector` (321) mutassa: élfajta (hiba/blokk), reason-címke, cél (step/gate), és hogy explicit vagy örökölt-e.

### 6.3 Default-policy jelölés és inline validáció

- A Canvas fejlécén/legendáján egy sor: „Default hibaág: `→ incident_review` gate (Folyamat-szintű)" vagy „nincs (kezeletlen hiba → emberi felülvizsgálat)".
- Inline figyelmeztetés a lépésen, ha se saját, se default hibaág nincs és a lépés kritikus (L2/L3) — a `nodeErrorIds`/`validation` már meglévő csatornán (`playbook-canvas.tsx` 439, 101).
- A `governed-flow-builder-spec.md` WP-5 (risk-diff) publish-előnézete emelje ki a hiba-él/policy változásokat.

---

## 7. Runtime viselkedés (egyesített)

Egy step `done` átmenetekor (változatlan váz, `advanceProcess` → `evaluateAdvance`):

1. `readOutcomeStatus(payload)` → `ok` | `blocked` | `failed` | `undefined`.
2. Ha `blocked`/`failed` → **hiba-út** (kaszkád-védelem, happy path kizárva). A `fromStepId` hiba-élei beszúrási sorrendben:
   1. **reason-specifikus** él (`outcome.reason == …`) — P2;
   2. **status catch-all** lépés-szintű `onError`/`onBlocked` — meglévő;
   3. **Playbook default** hiba-él (P1, compilerből, effektív policy);
   4. egyik sem → **`await_human`** (P1 TE-3 végső háló, változatlan `advanceProcess` ág).
3. Ha `ok`/hiányzik → **happy path**: feltételes `onComplete` ágak, majd `default` fallback (változatlan).

A `evaluateAdvance` / `AdvanceDecision` / `BranchPreview` szerződés **nem változik** → a `evaluatePlaybookAdvance` Simulation-endpoint (Canvas előnézet) automatikusan a reason-tudatos és default-ág döntést mutatja, továbbra is bit-azonosan a runtime-mal (elfogadási kritérium).

---

## 8. Validációs szabályok

| Kód | Súly | Leírás | Állapot |
|---|---|---|---|
| `UNKNOWN_DEFAULT_ERROR_TARGET` | error | `defaultErrorPolicy.onError/onBlocked` létező stepre/gate-re mutasson (Playbook-szint). | ✅ kész |
| `TENANT_DEFAULT_ERROR_TARGET_MISSING` | warning | A tenant-default (§4.2/WP-4) által hivatkozott step/gate NEM létezik ebben a Playbookban — szándékosan warning, nem error (a compiler csendben kihagyja, `await_human` marad). | ✅ kész (`checkTenantDefaultErrorTargets`, `playbook-validator.ts`) |
| `DEFAULT_ERROR_TARGET_NOT_BLOCKING_GATE` | warning | Ha a default hibaág gate-re megy, javasoltan blocking gate legyen (ne néma átfutás). | ✅ kész (`checkErrorRouteQuality`, `playbook-validator.ts`) |
| `UNKNOWN_ERROR_REASON` | warning | `errorRoute.reason` a `stepOutcomeReasonSchema`-ban legyen (egyedi reason nem célozható). | ✅ effektíven lefedve — a séma (`stepOutcomeReasonSchema` enum) már `SCHEMA_INVALID`-ként elutasítja az ismeretlen reason-t, külön szemantikai szabály nem kell |
| `DUPLICATE_ERROR_REASON_ROUTE` | error | Egy lépésen belül egy reason-höz max. egy hiba-út. | ✅ kész (`checkErrorRouteQuality`, onError/onBlocked külön névtérben) |
| `UNREACHABLE_ERROR_ROUTE` | warning | Reason-specifikus út olyan reason-re, amit a lépés hard-signaljai sosem produkálhatnak. | ⬜ nincs kész — a reason lehet explicit domain-ok is, ezért a szabály megbízható heurisztika nélkül spekulatív lenne; külön follow-up (pl. deklaratív step-kategória mező bevezetése után) |
| `CRITICAL_STEP_NO_ERROR_PATH` | warning→policy error | L2/L3 lépésnek legyen saját vagy örökölt (default) hibaága; production publish-nél policy szerint tiltható. | ✅ kész (`checkErrorRouteQuality`) — mivel a stepnek nincs saját `criticality` mezője, a step akkor minősül kritikusnak, ha `requiredGateIds`-ja L2/L3 gate-re mutat, vagy `decision.branches` valamelyike L2/L3; jelenleg mindig warning (policy-error escalation külön follow-up) |
| `NO_AGENT_GATE_APPROVAL` | (meglévő, invariáns) | A hibaág blocking gate-jét agent/system nem hagyhatja jóvá. | ✅ már korábban kész (runtime `gateDecision`), a default hibaágra is érvényes (ugyanaz a gate-mechanizmus) |

A `UNKNOWN_BRANCH_TARGET` (meglévő, `playbook-validator.ts` 155–205) hatóköre kiterjed a reason-kulcsos `errorRoute` célokra is.

---

## 9. Audit és observability

> **✅ TELJESEN KÉSZ (a `tenant_default` forrás is elérhető).** A `readStepOutcome` helper (`process-step-payload.ts`) és a mindhárom `advanceProcess` ágra (`await_gate`, `await_human`, `next_step`) felvett `outcome_status`/`outcome_reason` mező KÉSZ+tesztelt. Az `error_route_source` (`errorRouteSourceOf` helper, `process-service.ts`) is felkerült mindhárom ágra: `step` (lépés-szintű `onError`/`onBlocked`), `playbook_default` (P1 Playbook-default hiba-él), `tenant_default` (P1/§4.2/WP-4 — publish-időben feloldott tenant-default hiba-él), `await_human_fallback` (nincs sem lépés-, sem Playbook-, sem tenant-default). A `selected_edge_type` (`edge_type` néven) mindkét releváns ágon (`next_step`, `await_gate`) jelen van. **Nincs commitolva.**

A `advanceProcess` audit-metaadata bővítése (a meglévő `process.step.advance` / `process.blocked` / `await_gate` eseményeken, `process-service.ts` 545–572):

```jsonc
{
  "action": "process.step.advance",       // vagy process.blocked
  "metadata": {
    "completed_step_id": "classify_invoice",
    "outcome_status": "failed",
    "outcome_reason": "tool_denied",       // ÚJ (P2)
    "selected_edge_type": "error",         // happy|decision|error|blocked|default
    "error_route_source": "step | playbook_default | tenant_default | await_human_fallback", // ÚJ (P1)
    "target_kind": "await_gate",
    "target_id": "incident_review",
    "playbook_content_hash": "sha256:…"
  }
}
```

Cél: utólag rekonstruálható legyen, **miért** arra az ágra ment a hiba (típus + melyik policy-réteg döntött). A `BranchPreview.edgeType` már ma hordozza az élfajtát — az `error_route_source`-ot a service tölti a kiválasztott `rule` alapján.

---

## 10. Tesztelési terv

| Teszt típus | Elvárt esetek |
|---|---|
| Unit — runtime | reason-specifikus él (`outcome.reason == tool_denied` → gate A) előbb illeszkedik, mint a status catch-all (→ gate B); default hibaág akkor fut, ha nincs lépés-szintű; `await_human` csak ha semmi nincs. |
| Unit — compiler | `defaultErrorPolicy` → per-lépés default `error`/`blocked` él csak ott, ahol nincs saját; reason-route → `outcome.reason` feltételes él, helyes sorrendben (reason → status → default). |
| Unit — outcome | `computeStepOutcome` normalizált reason (`timeout`, `output_contract_unmet` új signalok). |
| Publish/service | tenant-default feloldódik a `compiled_spec`-be; futó process **nem** változik a tenant-policy utólagos átírásától (pinning-invariáns). |
| Validátor | `UNKNOWN_DEFAULT_ERROR_TARGET`, `DUPLICATE_ERROR_REASON_ROUTE`, `CRITICAL_STEP_NO_ERROR_PATH`. |
| Gate-bypass | agent nem hagyhatja jóvá a default hibaág blocking gate-jét. |
| Canvas | `onError`/`onBlocked` él megjelenik (szaggatott), reason-címke helyes, csak-hiba-éllel bíró lépés nem köt tévesen End-re; default-policy legenda. |
| Simulation-parity | `evaluatePlaybookAdvance(sample: {outcome:{status:'failed',reason:'tool_denied'}})` ugyanazt a célt adja, mint a runtime. |

---

## 11. Implementációs bontás

| Munkacsomag | Tartalom | Becslés | Állapot |
|---|---|---|---|
| WP-1 Séma | `errorPolicySchema`, `stepOutcomeReasonSchema`, `errorRouteSchema`, `onError` union; `playbookSpecV2Schema.defaultErrorPolicy` | 0.5–1 nap | ✅ kész (`spec.ts`): `errorPolicySchema` (P1) + `stepOutcomeReasonSchema`/`errorRouteSchema`/`errorRoutesSchema`/`stepErrorTargetSchema` (P2) |
| WP-2 Compiler | Playbook-default per-lépés hiba-él + reason-feltételes élek helyes prioritási sorrendben; Playbook-szintű hiba-gate `addCompiledGate` | 1–2 nap | ✅ kész (`playbook-compiler.ts`): `normalizeErrorTarget`/`pushStepErrorRoutingRules` — reason-specifikus → catch-all → Playbook-default sorrend |
| WP-3 Outcome-signalok | `timeout` + `output_contract_unmet` hard-signal a `computeStepOutcome`-ba; reason-normalizálás | 1 nap | 🟡 részben kész: `output_contract_unmet` valódi hard-signal (`process-step-payload.ts` + `general-task-runtime.ts`); `timeout` CSAK séma-szinten létezik, watchdog/cron nélkül nem termelődik (§13/7) |
| WP-4 Tenant-default feloldás | publish-időben tenant-policy → effektív `defaultErrorPolicy` a `compiled_spec`-be; pinning-teszt | 1 nap | ✅ kész (nincs commitolva): `PlatformSettingsService.getTenantDefaultErrorPolicy`/`setTenantDefaultErrorPolicy` (tenant-kulcsos `PlatformSetting`, `platform-settings-service.ts`), `PlaybookV2Service.publishPlaybookVersion` publish-időben olvassa fel + validál + compilál vele (`playbook-v2-service.ts`), compiler `effectiveDefault`/`isRoutingTargetResolvable` (`playbook-compiler.ts`) — Playbook-default ELSŐBBSÉGGEL, a nem-feloldható tenant-cél csendben kimarad. Admin server action (`app/actions/playbook.ts`). 8 új teszt zöld (`flow-builder-governed.test.ts`), köztük pinning-invariáns teszt. |
| WP-5 Validátor | §8 új szabályok + `UNKNOWN_BRANCH_TARGET` hatókör-bővítés | 1 nap | ✅ kész (nincs commitolva): `UNKNOWN_BRANCH_TARGET` + reachability kiterjesztve a reason-route célokra (korábban); ÚJ `checkErrorRouteQuality` (`playbook-validator.ts`) — `DUPLICATE_ERROR_REASON_ROUTE`, `CRITICAL_STEP_NO_ERROR_PATH`, `DEFAULT_ERROR_TARGET_NOT_BLOCKING_GATE`; `UNKNOWN_ERROR_REASON` a séma-enum miatt szükségtelen; ÚJ `checkTenantDefaultErrorTargets` → `TENANT_DEFAULT_ERROR_TARGET_MISSING` (WP-4). Egyedül `UNREACHABLE_ERROR_ROUTE` nincs kész (spekulatív heurisztika nélkül nem megbízható, lásd §8 tábla). 13 új teszt zöld (`flow-builder-governed.test.ts`). |
| WP-6 Audit | `outcome_reason` + `error_route_source` + `selected_edge_type` a metaadatba | 0.5 nap | ✅ kész: `outcome_status`/`outcome_reason`/`edge_type`/`error_route_source` (`step`/`playbook_default`/`tenant_default`/`await_human_fallback`) mindhárom advance-ágon (`errorRouteSourceOf`, `process-service.ts`) implementálva+tesztelve, nincs commitolva. |
| WP-7 Canvas | `error`/`blocked` élfajta projekció + stílus + inspector + default-legenda + terminál-fix | 2–3 nap | ⬜ nincs kész |
| WP-8 E2E teszt | agent → `failed(reason)` → reason-ág / default / `await_human` teljes folyamat + Simulation-parity | 1–2 nap | 🟡 részben kész: unit-szintű reason-routing + Simulation-parity teszt megvan (`flow-builder-governed.test.ts`); teljes DB-s E2E (agent-futáson át) még nincs |

Javasolt sorrend: **WP-1 → WP-2 → (WP-3 ∥ WP-5 ∥ WP-6) → WP-4 → WP-7 → WP-8.** A P2 (WP-1/2/3) és P1 (WP-1/2/4) közös compiler-alapon áll; a P3 (WP-7) tisztán UI, párhuzamosítható. **Egyedül a WP-7 (Canvas) maradt hátra ebből a listából.**

---

## 12. Elfogadási kritériumok

1. ✅ Egy Playbook gyökerén deklarálható `defaultErrorPolicy`, amely a kezeletlen `failed`/`blocked` lépéseket a beégetett `await_human` HELYETT a megadott step/gate-re irányítja.
2. ✅ Egy lépés hiba-ága a `outcome.reason` szerint különböző célra ágazhat (pl. `tool_denied` → `incident_review`, `tool_loop_exhausted` → retry-alternatíva).
3. ✅ A feloldási sorrend igazolt: lépés-szintű → Playbook-default → (publishkor feloldott) tenant-default → `await_human`; néma `complete` production módban nem történik.
4. ✅ A pin-elt `compiled_spec` viselkedése nem változik a tenant-policy utólagos módosításától (pinning-invariáns teszt zöld, `flow-builder-governed.test.ts`).
5. ⬜ A Canvas megjeleníti a hiba-éleket (szaggatott, reason-címkével) és a default-policyt; L2/L3 lépés hibaág nélkül figyelmeztet. — WP-7 (canvas) még nincs kész.
6. ✅ Az audit rekonstruálható: `outcome_reason`, `selected_edge_type`, `error_route_source` (tenant_default is), cél és Playbook content-hash.
7. ✅ A `evaluatePlaybookAdvance` (Simulation) reason-tartalmú sample payloadra ugyanazt a célt adja, mint a runtime `evaluateAdvance`.
8. ✅ `defaultErrorPolicy`/reason-route nélküli meglévő Playbookok bit-azonos viselkedést kapnak (back-compat).

---

## 13. Nyitott kérdések

1. **Tenant-default hatóköre.** Csak Playbook-hiányban töltsön (ág-szintű merge), vagy legyen egy tenant-szintű „kötelező minimum" (pl. minden L2/L3 lépésnek muszáj hibaág)? Az utóbbi policy-enforcement, nem csak default.
2. **`in` operátor.** Kell-e egy hiba-út több reason-re (`reason in [tool_denied, timeout]`)? Ez a `conditionOpSchema` bővítése — MVP-ben egy reason = egy él.
3. **Kompenzáció / rollback.** A hiba-ág célja lehet-e „kompenzáló lépés" (side-effect visszavonás), vagy az külön feature (saga-minta)? Jelen spec csak routingot ad, kompenzációs szemantikát nem.
4. **Retry vs. hibaág határa.** A `retryPolicy.onExhausted` (`fail_process | manual_review`) és a reason `tool_loop_exhausted` átfed. Tisztázandó: a retry kimerülése a `retryPolicy`-n vagy a reason-ágon keresztül döntsön? (Javaslat: `retryPolicy` a lépésen belüli ismétlés, a reason-ág a kimerülés UTÁNI routing — a kettő sorosan.)
5. **`output_contract_unmet` státusza.** ✅ Eldöntve MVP-ben: `blocked` (a `computeStepOutcome`-ban implementálva) — emberrel/gate-tel feloldható, nem hard hiba. Lépésenkénti konfigurálhatóság (`failed` opció) follow-up.
6. **Default-él vizualizáció.** A Playbook-default N élként (minden lépéstől) vagy egyetlen globális jelölésként jelenjen meg? (Javaslat: globális jelölés + opcionális „expand" a zaj elkerülésére.)
7. **`timeout` reason watchdog.** A séma/enum kész, de nincs olyan mechanizmus (cron/dispatcher-sweep), ami egy `in_progress` process-stepet a `timeoutMinutes` túllépése után ténylegesen `failed`/`timeout`-ra váltana — ez nem "outcome-signal" szintű módosítás, hanem külön háttérfolyamat (új DB-lekérdezés + ütemezés). Amíg ez nincs megépítve, a `timeout` reason routing célja nem érhető el élesben (csak manuálisan konstruált outcome-mal tesztelhető). Külön spec/WP javasolt.

---

## 14. Forráshivatkozások (jelenlegi kód)

- `app/src/lib/playbook-v2/spec.ts` — `stepOutcomeSchema` (96–101), `routingTargetSchema` (109–118), `stepOutcomeReasonSchema`/`errorRouteSchema`/`errorRoutesSchema`/`stepErrorTargetSchema` (§5.1/5.2, ÚJ), `playbookStepSchema.onError/onBlocked` (union-ra bővítve), `playbookSpecV2Schema` (254–268), `computePlaybookContentHash`/`canonicalize` (288–306).
- `app/src/lib/playbook-v2/process-step-payload.ts` — `computeStepOutcome` hard-signal → status+reason (157–168, `missingOutputFields`/`output_contract_unmet` ÚJ ág), `withStepOutcome` (171–176).
- `app/src/domain/playbook/playbook-compiler.ts` — hiba-él generálás, `normalizeErrorTarget`/`errorTargetGateIds`/`pushStepErrorRoutingRules` (§5.3, exportált a validátornak is), `addCompiledGate` a hiba-gate-hez, `CompiledRoutingRule`/`RoutingEdgeType`; `isRoutingTargetResolvable` + `compile(spec, { tenantDefaultErrorPolicy })` + `effectiveDefault` helper (§4.2/WP-4, ÚJ) — a lépés/Playbook/tenant-default prioritási sorrend egyetlen helyen dől el, `ErrorRouteSource` most `'tenant_default'`-ot is felvehet.
- `app/src/domain/platform-settings/platform-settings-service.ts` — `PLAYBOOK_TENANT_DEFAULT_ERROR_POLICY_KEY` + `getTenantDefaultErrorPolicy`/`setTenantDefaultErrorPolicy` (§4.2/WP-4, ÚJ) — tenant-kulcsos `PlatformSetting`, ugyanaz a minta, mint a `PROVISIONING_EGRESS_ALLOWLIST_KEY`-nál.
- `app/src/domain/playbook/playbook-v2-service.ts` — `PlaybookV2Service` konstruktora opcionális `getTenantDefaultErrorPolicy` function-függőséget kap (§4.2/WP-4, ÚJ); `publishPlaybookVersion` publish-időben olvassa fel + adja át a validátornak (`TenantValidationContext.tenantDefaultErrorPolicy`) és a compilernek.
- `app/src/domain/index.ts` — `playbookV2Service` bekötése a `platformSettingsService.getTenantDefaultErrorPolicy`-vel (lazy closure, mint a `ticketService` ticket-type-config lekérdezőjénél).
- `app/src/app/actions/playbook.ts` — `getTenantDefaultErrorPolicyAction`/`setTenantDefaultErrorPolicyAction` (§4.2/WP-4, ÚJ, admin server action, nincs hozzá UI).
- `app/src/lib/playbook-v2/runtime.ts` — `evaluateAdvance` kaszkád-védelem (233–255), `isErrorEdge` (211–213), `readOutcomeStatus` (216–221), `isErrorOutcomePayload` (§2.1/TE-6, ÚJ), `evaluateCondition`/`readPath` (351–397), `evaluatePlaybookAdvance` (302–346).
- `app/src/domain/playbook/process-service.ts` — `advanceProcess` `await_human` ág + `process.blocked` audit + alert (519–572).
- `app/src/domain/agent/general-task-runtime.ts` — `routeNonOkStepOutcome` (§2.1, ÚJ) — a `blocked`/`failed` outcome-ot Playbook-folyamat ticketnél `board_write('done')`-ként routolja a `TicketStateMachine`/`ProcessService.advance` felé, nem Playbook-ticketnél változatlanul közvetlen `awaiting_human`.
- `app/src/domain/playbook/ticket-state-machine.ts` — `STEP_COMPLETION_STATES` (64), a `done`/`approved` átmenet triggereli a `processService.advance`-ot (216–238).
- `app/src/lib/playbook-v2/canvas-mapping.ts` — `CanvasEdgeKind` (41), `specToCanvasModel` élkivetítés (293–337), terminál-számítás (333–336).
- `app/src/components/playbooks/playbook-canvas.tsx` — `EDGE_STYLE` (86–92), `toRfEdge` (122–142), `EdgeInspector`/`EDGE_KIND_LABEL` (312–334), `nodeErrorIds`/validáció-csatorna (101, 439).
- `app/src/domain/playbook/playbook-validator.ts` — `UNKNOWN_BRANCH_TARGET` hiba-él ellenőrzés (§5.2-re bővítve: reason-route célok is), `buildAdjacency` reachability (reason-route célok is elérhetővé teszik a step-et), `checkErrorRouteQuality` (§8/WP-5) — `DUPLICATE_ERROR_REASON_ROUTE`/`CRITICAL_STEP_NO_ERROR_PATH`/`DEFAULT_ERROR_TARGET_NOT_BLOCKING_GATE`; `TenantValidationContext.tenantDefaultErrorPolicy` + `hasResolvedDefaultCoverage` + `checkTenantDefaultErrorTargets` → `TENANT_DEFAULT_ERROR_TARGET_MISSING` (§4.2/WP-4, ÚJ).
- `app/scripts/playbook-v2-runtime.test.ts`, `app/scripts/playbook-v2-process.test.ts`, `app/scripts/flow-builder-*.test.ts` — meglévő runtime/pinning/canvas tesztek kiindulási mintái.
