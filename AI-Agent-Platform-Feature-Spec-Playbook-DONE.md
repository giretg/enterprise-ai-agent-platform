# Feature-spec - Playbook-elsodleges vegrehajtas

**Keszitette:** Excellence Pay KFT (Enterprise AI tanacsadas)  
**Verzio:** 1.0  
**Datum:** 2026-06-27  
**Forrasdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, 4.5.1, 4.10-4.10.6, 4.11, 8.5), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (CR-MVP-002, 4.9, 5.12.3, 9.2 N6)  
**Olvaso:** fejleszto(k), architect, product owner. Feltetelezi a TicketService, Agent Registry, IAM/RBAC, audit log es dispatcher alapmodell ismeretet.  
**Statusz:** tervezet - onallo feature-spec. Az MVP-ben csak sema-horgok es egy trivialis wiki-Playbook vannak; ez a dokumentum a Fazis 2 teljes, tobb szereplos Playbook-vezerles fejlesztoi specifikacioja.

---

## 0. Mit ad ez a dokumentum

Ez a specifikacio meghatarozza, hogyan legyen a tobb lepeses, tobb szereplos agent-folyamatok **forras-igazsaga** egy verziozott, gepiesen olvashato Playbook, es hogyan forduljon ez szerveroldali, determinisztikus ticket-allapotgeppe.

A koncepcio lenyege:

- a Playbook irja le a szandekolt folyamatot;
- a ticket- es delegacios mechanika hajtja vegre az atadast;
- a kotelezo kapukat nem az LLM donti el, hanem a Control Plane allapotgepe kenyszeriti ki;
- egy folyamat inditasakor a Playbook-verzio pin-elve van, es vegig fix marad;
- az audit log a tenyleges lefutast rogziti, amit kesobb ossze lehet vetni a Playbook szerinti tervvel.

Ez a feature kulonbozik a Goose recipe-tol:

| Elem | Cel | Forras-igazsag |
|---|---|---|
| **Playbook** | Vegponttol vegpontig tarto uzleti flow: szerepek, atadasok, kapuk | Control Plane, verziozott `playbook_versions.spec` |
| **Recipe** | Egy konkret agent-futas technikai instrukcioja | Harness / Goose recipe-katalogus |
| **Ticket state machine** | Kemeny szerveroldali vegrehajtas es kapu-kikenyszerites | Playbookbol forditott runtime konfiguracio |
| **Audit log** | Ami tenylegesen tortent | Append-only, hash-lancolt audit |

---

## 1. Scope

### 1.1 In scope - Fazis 2

- Playbook CRUD es verziozas tenant-scope-pal.
- Gepiesen olvashato Playbook-spec JSON schema validacioval.
- Playbook publikacio / approve flow.
- Playbook hozzarendeles folyamattipushoz vagy tickettipushoz.
- Folyamatinditas Playbook-verzio pin-elesevel.
- `process_instances` entitas a teljes folyamat lefutas kovetesere.
- `tickets.playbook_ref`, `tickets.process_instance_id`, `tickets.playbook_step_id` mezok hasznalata.
- Playbook -> ticket-allapotgep compiler.
- Kotelezo kapuk szerveroldali kikenyszeritese.
- Agent-orchestrator csak Playbook-hivatkozassal delegalhat, nem irhat at flow-t.
- Delegacios statusz reteg: pending / delivered / done / failed.
- Szandekolt vs. tenyleges folyamat osszevetes audit logbol.
- Admin UI: Playbook lista, verzio, validacio, publish, hozzarendeles.
- Operator UI: folyamatinditas, aktualis lepes, vart szereplo, blokkolt kapu.
- Audit es negativ tesztek.

### 1.2 Out of scope - most nem

- Teljes BPMN 2.0 kompatibilitas.
- Parhuzamos agakkal, join-nal es kompenzacios tranzakciokkal rendelkezo komplex workflow-motor.
- Grafikus drag-and-drop Playbook szerkeszto.
- Automatikus Playbook-generalo LLM production modban.
- Cross-tenant Playbook megosztas.
- Playbook marketplace.
- Kozvetlen kulso rendszerbe iras approval nelkul.
- Agent onmodositason keresztuli Playbook- vagy capability-modositas.

### 1.3 Feature-szint dontes

A Playbook **Control Plane eroforras**, nem Sandbox artefakt. Ennek oka:

- governance es audit szempontbol a folyamatleiras bizalmi elem;
- a kotelezo kapuk forrasa;
- tenant-, agent-, szerep- es tickettipus-jogosultsagokhoz kotodik;
- verziozasa es publikalasa admin / approver hataskor.

---

## 2. Fo invariansok

Ezeket kodszinten kell vedeni, nem UI-szinten.

1. Egy folyamatinditas mindig pontosan egy `playbook_version_id`-t pin-el.
2. A pin-elt Playbook-verzio a folyamat vegeig nem cserelheto.
3. Published Playbook-verzio immutable; modositas csak uj verzio.
4. Kotelezo approval gate csak szerveroldali allapotgepen at lepheto.
5. Agent nem lephet at olyan transitiont, amelyet a compiled state machine nem enged.
6. Agent nem hozhat letre vagy modosithat Playbookot onfejlesztesi uton.
7. Agent nem bovitheti sajat Playbook-, ticket-, connector- vagy tool-jogait.
8. Orchestrator szerep alapbol tool-less: folyamatot indithat es ticketet/delegaciot nyithat, de nem hivhat uzleti toolt.
9. Cross-tenant Playbook, process, ticket vagy audit olvasas tiltott.
10. A Playbook nem audit-forras; az audit log a tenyleges tortenet forrasa.

---

## 3. Architektura

### 3.1 Komponensek

```text
Admin / Operator / Orchestrator Agent
  |
  | create version / publish / start process / transition ticket
  v
Control Plane API
  |
  +-- RBAC + tenant check
  +-- PlaybookService
  +-- PlaybookValidator
  +-- PlaybookCompiler
  +-- ProcessService
  +-- TicketStateMachine
  +-- AuditService
  |
  v
Postgres
  |
  +-- playbooks
  +-- playbook_versions
  +-- playbook_assignments
  +-- process_instances
  +-- process_step_instances
  +-- delegation_edges
  +-- ticket_state_machine_rules
```

### 3.2 Felelossegi hatarok

| Elem | Felelosseg |
|---|---|
| `PlaybookService` | CRUD, draft version, publish, archive, hozzarendeles |
| `PlaybookValidator` | JSON schema, szemantikai validacio, RBAC-hivatkozasok ellenorzese |
| `PlaybookCompiler` | Playbook-spec -> ticket transition / gate / assignment szabalyok |
| `ProcessService` | folyamatinditas, Playbook-verzio pin, step instance letrehozas |
| `TicketStateMachine` | szerveroldali transition ellenorzes es kapu-kikenyszerites |
| `DelegationService` | agent -> agent / agent -> human atadas statusza |
| `AuditService` | append-only audit es szandekolt/tenyleges flow osszevetes alapadata |
| Dispatcher | ready ticketek inditasa, LLM nelkuli routing elv szerint |

---

## 4. Adatmodell

### 4.1 Enumok

```sql
playbook_status: draft | published | archived | blocked
playbook_version_status: draft | pending_approval | published | rejected | retired
process_status: created | running | awaiting_human | blocked | completed | failed | cancelled
step_status: pending | ready | in_progress | awaiting_gate | completed | skipped | failed
gate_type: human_approval | eval_check | policy_check | tool_authorization | manual_review
delegation_status: pending | delivered | accepted | done | failed | cancelled
actor_type: user | agent | system
```

### 4.2 `playbooks`

```sql
playbooks (
  id uuid primary key,
  tenant_id uuid not null,

  key text not null,                    -- pl. "invoice-processing"
  name text not null,
  description text null,
  process_type text not null,            -- pl. "invoice_processing"
  status playbook_status not null default 'draft',

  current_published_version_id uuid null,
  owner_user_id uuid null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null,

  unique(tenant_id, key)
)
```

### 4.3 `playbook_versions`

```sql
playbook_versions (
  id uuid primary key,
  tenant_id uuid not null,
  playbook_id uuid not null references playbooks(id),

  version int not null,
  status playbook_version_status not null default 'draft',
  spec jsonb not null,
  compiled_spec jsonb null,
  validation_result jsonb not null default '{}',

  change_summary text not null,
  content_hash text not null,

  created_by_user_id uuid not null,
  approved_by_user_id uuid null,
  approved_at timestamptz null,
  published_at timestamptz null,
  retired_at timestamptz null,
  created_at timestamptz not null default now(),

  unique(playbook_id, version),
  unique(tenant_id, playbook_id, content_hash)
)
```

**Immutable szabaly:** `published` statuszu `playbook_versions.spec` es `compiled_spec` nem modosithato. Uj tartalom = uj version.

### 4.4 `playbook_assignments`

```sql
playbook_assignments (
  id uuid primary key,
  tenant_id uuid not null,
  playbook_id uuid not null references playbooks(id),
  playbook_version_id uuid not null references playbook_versions(id),

  assignment_type text not null,          -- process_type | ticket_type | agent_role
  assignment_key text not null,           -- pl. "invoice_processing"
  is_default boolean not null default false,

  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,

  unique(tenant_id, assignment_type, assignment_key, is_default)
)
```

**Szabaly:** `is_default = true` assignmentbol egy adott `(tenant, assignment_type, assignment_key)` parra csak egy aktiv lehet.

### 4.5 `process_instances`

```sql
process_instances (
  id uuid primary key,
  tenant_id uuid not null,

  process_type text not null,
  status process_status not null default 'created',

  playbook_id uuid not null references playbooks(id),
  playbook_version_id uuid not null references playbook_versions(id),
  playbook_ref text not null,             -- "playbook:invoice-processing@v3"
  playbook_content_hash text not null,

  started_by_type actor_type not null,
  started_by_user_id uuid null,
  started_by_agent_id uuid null,
  conversation_id uuid null,
  root_ticket_id uuid null,

  input_payload jsonb not null default '{}',
  output_payload jsonb not null default '{}',

  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  failed_at timestamptz null
)
```

### 4.6 `process_step_instances`

```sql
process_step_instances (
  id uuid primary key,
  tenant_id uuid not null,
  process_instance_id uuid not null references process_instances(id),

  step_id text not null,                  -- Playbook spec step id
  step_name text not null,
  status step_status not null default 'pending',

  assigned_role text not null,
  assigned_agent_id uuid null,
  assigned_user_id uuid null,
  ticket_id uuid null,

  started_at timestamptz null,
  completed_at timestamptz null,
  failed_at timestamptz null,
  result_payload jsonb not null default '{}',

  unique(process_instance_id, step_id)
)
```

### 4.7 `delegation_edges`

```sql
delegation_edges (
  id uuid primary key,
  tenant_id uuid not null,
  process_instance_id uuid not null references process_instances(id),

  from_step_id text not null,
  to_step_id text not null,
  from_ticket_id uuid null,
  to_ticket_id uuid null,

  from_actor_type actor_type not null,
  from_agent_id uuid null,
  from_user_id uuid null,
  to_actor_type actor_type not null,
  to_agent_id uuid null,
  to_user_id uuid null,

  status delegation_status not null default 'pending',
  created_at timestamptz not null default now(),
  delivered_at timestamptz null,
  accepted_at timestamptz null,
  done_at timestamptz null,
  failed_at timestamptz null,

  metadata jsonb not null default '{}'
)
```

### 4.8 `tickets` kiegeszites

```sql
alter table tickets add column process_instance_id uuid null references process_instances(id);
alter table tickets add column playbook_ref text null;
alter table tickets add column playbook_version_id uuid null references playbook_versions(id);
alter table tickets add column playbook_step_id text null;
alter table tickets add column required_gate_id text null;
```

**Szabaly:** ha `process_instance_id` nem null, akkor `playbook_ref`, `playbook_version_id` es `playbook_step_id` is kotelezo.

---

## 5. Playbook spec JSON

### 5.1 Minimalis pelda

```json
{
  "schemaVersion": "1.0",
  "key": "invoice-processing",
  "name": "Bejovo szamla feldolgozas",
  "processType": "invoice_processing",
  "entryStepId": "extract_invoice",
  "roles": [
    {
      "key": "invoice_extractor",
      "type": "agent_role",
      "requiredCapabilities": ["tool:file_read", "tool:invoice_extract"]
    },
    {
      "key": "accounting_approver",
      "type": "human_role",
      "requiredPermissions": ["ticket:approve"]
    }
  ],
  "steps": [
    {
      "id": "extract_invoice",
      "name": "Szamlaadatok kinyerese",
      "ticketType": "invoice_extract",
      "assignedRole": "invoice_extractor",
      "allowedStates": ["ready", "in_progress", "awaiting_human", "done", "failed"],
      "onComplete": [
        {
          "condition": { "field": "confidence", "op": ">=", "value": 0.85 },
          "nextStepId": "approval"
        },
        {
          "condition": "default",
          "gateId": "low_confidence_review"
        }
      ]
    },
    {
      "id": "approval",
      "name": "Konyvelesi jovahagyas",
      "ticketType": "human_approval",
      "assignedRole": "accounting_approver",
      "requiredGateIds": ["approve_accounting_posting"],
      "allowedStates": ["ready", "awaiting_human", "approved", "rejected", "done"]
    }
  ],
  "gates": [
    {
      "id": "low_confidence_review",
      "type": "manual_review",
      "requiredActorRole": "accounting_approver",
      "blocking": true
    },
    {
      "id": "approve_accounting_posting",
      "type": "human_approval",
      "requiredActorRole": "accounting_approver",
      "blocking": true,
      "criticality": "L2"
    }
  ],
  "transitions": [
    {
      "fromStepId": "extract_invoice",
      "toStepId": "approval",
      "trigger": "step.completed"
    }
  ],
  "outputContract": {
    "requiredFields": ["invoiceNumber", "supplierName", "amount", "currency", "decision"]
  }
}
```

### 5.2 Kotelezo top-level mezok

| Mezo | Tipus | Jelentes |
|---|---|---|
| `schemaVersion` | string | Playbook spec verzio; kezdetben `1.0` |
| `key` | string | stabil, tenanton belul egyedi azonosito |
| `name` | string | emberi nev |
| `processType` | string | indithato folyamattipus |
| `entryStepId` | string | kezdo step |
| `roles` | array | emberi es agent szerepek |
| `steps` | array | vegrehajtasi lepesek |
| `gates` | array | kotelezo / opcionalis kapuk |
| `transitions` | array | step-ek kozti engedelyezett atmenetek |

### 5.3 Step szerzodes

```typescript
type PlaybookStep = {
  id: string;
  name: string;
  ticketType: string;
  assignedRole: string;
  description?: string;
  requiredGateIds?: string[];
  allowedStates?: string[];
  inputContract?: JsonSchemaLike;
  outputContract?: JsonSchemaLike;
  onComplete?: StepCompletionRule[];
  timeoutMinutes?: number;
  retryPolicy?: {
    maxAttempts: number;
    onExhausted: "fail_process" | "manual_review";
  };
};
```

### 5.4 Gate szerzodes

```typescript
type PlaybookGate = {
  id: string;
  type: "human_approval" | "eval_check" | "policy_check" | "tool_authorization" | "manual_review";
  requiredActorRole?: string;
  criticality?: "L0" | "L1" | "L2" | "L3";
  blocking: boolean;
  condition?: ConditionExpression;
  approvalMode?: "single" | "four_eyes" | "multi_level";
  evidenceRequired?: boolean;
};
```

**Kritikus szabaly:** `criticality = L2 | L3` gate csak blocking lehet.

---

## 6. Validacio

### 6.1 Schema validacio

`PlaybookValidator.validateSpec(spec)` a kovetkezoket ellenorzi:

- minden kotelezo top-level mezo megvan;
- minden `step.id`, `gate.id`, `role.key` egyedi;
- `entryStepId` letezo stepre mutat;
- minden `assignedRole` letezo role;
- minden `requiredGateIds` letezo gate;
- minden transition letezo `fromStepId` es `toStepId` parra mutat;
- nincs elerhetetlen step;
- nincs olyan ciklus, amelybol nincs gate, timeout vagy manual exit;
- `criticality L2/L3` csak blocking gate lehet;
- `human_approval` gate-hez letezik emberi role;
- agent role-hoz rendelt step csak agent assignee-t kaphat;
- human role-hoz rendelt step csak human assignee-t kaphat;
- output contract ervenyes JSON schema-kompatibilis struktura.

### 6.2 Szemantikai validacio

A validator a tenant aktualis konfiguraciojaval is osszevet:

- a `ticketType` letezik vagy draft Playbooknal explicit `allowMissingTicketTypes` flaggel jelolt;
- a megadott agent role-hoz van legalabb egy aktiv agent;
- a required capability-k osszefernek az adott role/agent capability-ivel;
- a required human permission-ok leteznek az IAM/RBAC modellben;
- a Playbook nem hivatkozik mas tenant eroforrasara;
- nincs olyan gate, amelyet senki nem tud jovahagyni.

### 6.3 Validacio eredmeny

```json
{
  "valid": false,
  "errors": [
    {
      "code": "UNKNOWN_ROLE",
      "path": "steps[1].assignedRole",
      "message": "Az 'accounting_approver' role nincs definialva."
    }
  ],
  "warnings": [
    {
      "code": "NO_TIMEOUT",
      "path": "steps[0]",
      "message": "A stephez nincs timeout beallitva."
    }
  ]
}
```

Published statusz csak `valid = true` es approver jovahagyas utan lehet.

---

## 7. Playbook -> allapotgep compiler

### 7.1 Compiler output

`PlaybookCompiler.compile(version.spec)` kimenete `compiled_spec`, amelyet a runtime hasznal:

```json
{
  "schemaVersion": "1.0",
  "playbookVersionId": "uuid",
  "entryStepId": "extract_invoice",
  "ticketRules": [
    {
      "stepId": "extract_invoice",
      "ticketType": "invoice_extract",
      "allowedTransitions": [
        {
          "fromState": "ready",
          "toState": "in_progress",
          "allowedActorTypes": ["agent", "system"]
        },
        {
          "fromState": "in_progress",
          "toState": "done",
          "allowedActorTypes": ["agent"],
          "requiresOutputContract": true
        }
      ]
    }
  ],
  "gates": [
    {
      "gateId": "approve_accounting_posting",
      "stepId": "approval",
      "blocksTransition": {
        "fromState": "awaiting_human",
        "toState": "approved"
      },
      "requiredActorRole": "accounting_approver",
      "approvalMode": "single"
    }
  ],
  "routingRules": [
    {
      "fromStepId": "extract_invoice",
      "toStepId": "approval",
      "trigger": "step.completed"
    }
  ]
}
```

### 7.2 Allapotgep kikenyszerites

`TicketStateMachine.transitionTicket()` kotelezo sorrendje:

1. tenant scope ellenorzes;
2. ticket betoltese;
3. ha ticket Playbook-processhez tartozik, `compiled_spec` betoltese a pin-elt `playbook_version_id` alapjan;
4. `(stepId, fromState, toState, actor)` transition engedelyezett-e;
5. gate blokkolja-e az atmenetet;
6. output contract valid-e, ha a transition megkoveteli;
7. RBAC / agent capability ellenorzes;
8. allapotvaltas tranzakcioban;
9. audit: `ticket.transition` vagy tiltott esetben `ticket.transition.denied`;
10. ha step completed, `ProcessService.advance()` meghivasa.

**Tiltott atmenetnel:** nincs allapotvaltas, nincs output modositas, van audit `ticket.transition.denied`.

### 7.3 Process advance

`ProcessService.advance(processInstanceId, completedStepId)`:

- beolvassa a pin-elt compiled specet;
- kiertekeli az `onComplete` / routing rule felteteleket;
- ha gate kell, step `awaiting_gate`, process `awaiting_human`;
- ha next step van, letrehoz `process_step_instance` + kovetkezo ticket;
- letrehoz `delegation_edge` rekordot;
- audit: `process.step.completed`, `process.step.created`, `delegation.created`;
- dispatcher csak akkor kap `ready` ticketet, ha a kapuk teljesultek.

---

## 8. API / service szerzodesek

### 8.1 PlaybookService

```typescript
createPlaybook(input: {
  tenantId: string;
  key: string;
  name: string;
  description?: string;
  processType: string;
  ownerUserId?: string;
  actorUserId: string;
}): Promise<Playbook>;

createPlaybookVersion(input: {
  tenantId: string;
  playbookId: string;
  spec: unknown;
  changeSummary: string;
  actorUserId: string;
}): Promise<PlaybookVersion>;

validatePlaybookVersion(input: {
  tenantId: string;
  playbookVersionId: string;
}): Promise<ValidationResult>;

submitForApproval(input: {
  tenantId: string;
  playbookVersionId: string;
  actorUserId: string;
}): Promise<PlaybookVersion>;

publishPlaybookVersion(input: {
  tenantId: string;
  playbookVersionId: string;
  approverUserId: string;
}): Promise<PlaybookVersion>;

assignPlaybook(input: {
  tenantId: string;
  playbookVersionId: string;
  assignmentType: "process_type" | "ticket_type" | "agent_role";
  assignmentKey: string;
  isDefault: boolean;
  actorUserId: string;
}): Promise<PlaybookAssignment>;
```

### 8.2 ProcessService

```typescript
startProcess(input: {
  tenantId: string;
  processType: string;
  playbookVersionId?: string;       // ha nincs, default assignment alapjan oldodik
  inputPayload: Record<string, unknown>;
  startedBy: { type: "user" | "agent"; id: string };
  conversationId?: string;
}): Promise<ProcessInstance>;

getProcess(input: {
  tenantId: string;
  processInstanceId: string;
}): Promise<ProcessDetail>;

advance(input: {
  tenantId: string;
  processInstanceId: string;
  completedStepId: string;
  actor: { type: "user" | "agent" | "system"; id?: string };
}): Promise<ProcessAdvanceResult>;

cancelProcess(input: {
  tenantId: string;
  processInstanceId: string;
  reason: string;
  actorUserId: string;
}): Promise<ProcessInstance>;
```

### 8.3 TicketStateMachine kiegeszites

```typescript
transitionTicket(input: {
  tenantId: string;
  ticketId: string;
  toState: string;
  actor: { type: "user" | "agent" | "system"; id?: string };
  note?: string;
  outputPayload?: Record<string, unknown>;
  approvalEvidence?: Record<string, unknown>;
}): Promise<Ticket>;
```

---

## 9. UI kovetelmenyek

### 9.1 Admin - Playbook Registry

- Playbook lista: nev, process type, statusz, current published version, utolso modositas.
- Playbook reszletek: verzio lista, content hash, validacio eredmeny, audit timeline.
- Draft verzio letrehozasa JSON editorral vagy feltoltesbol.
- Validacio futtatasa es hibak soronkent / JSON path szerint.
- Submit for approval.
- Publish / reject.
- Assignment kezeles: mely process type / ticket type alapertelmezett Playbookja.

### 9.2 Operator - Process view

- Folyamat lista: statusz, Playbook ref, indito, aktualis step, varakozas oka.
- Folyamat reszlet: step lista, ticket linkek, delegacios statusz.
- Blocking gate panel: ki hagyhatja jova, milyen bizonyitek kell, miert all a folyamat.
- Szandekolt vs. tenyleges flow minimalis nezet:
  - Playbook step sorrend;
  - auditbol kepzett tenyleges atadasok;
  - elteresek jelolese.

### 9.3 Agent / orchestrator felulet

Az orchestrator nem kap teljes flow-szerkesztesi UI-t. Csak:

- elerheto Playbookok listaja a jogosult process type-okhoz;
- folyamatinditas Playbook-hivatkozassal;
- futasi statusz visszakerdezes;
- ticket/delegacio letrehozas a Playbook altal engedett kovetkezo stephez.

---

## 10. Audit es observability

### 10.1 Uj audit esemenyek

```text
playbook.create
playbook.version.create
playbook.version.validate
playbook.version.submit
playbook.version.publish
playbook.version.reject
playbook.assignment.create
playbook.assignment.revoke

process.start
process.step.create
process.step.ready
process.step.start
process.step.await_gate
process.step.complete
process.step.fail
process.complete
process.cancel

delegation.create
delegation.deliver
delegation.accept
delegation.done
delegation.fail

gate.request
gate.approve
gate.reject
gate.bypass_denied

ticket.transition
ticket.transition.denied
```

### 10.2 `process.start` payload

```json
{
  "process_instance_id": "uuid",
  "process_type": "invoice_processing",
  "playbook_id": "uuid",
  "playbook_version_id": "uuid",
  "playbook_ref": "playbook:invoice-processing@v3",
  "playbook_content_hash": "sha256:...",
  "started_by_type": "user",
  "started_by_user_id": "uuid",
  "conversation_id": "uuid-or-null"
}
```

### 10.3 Metrikak

- elinditott folyamatok szama process type szerint;
- completed / failed / cancelled arany;
- atlagos es median process atfutasi ido;
- stepenkenti atlagos varakozasi ido;
- gate approval latency;
- transition denied arany;
- Playbook-verzios megoszlas aktiv folyamatoknal;
- szandekolt vs. tenyleges flow elteresek szama.

---

## 11. Security / governance baseline

### 11.1 RBAC

| Muvelet | Minimum szerep |
|---|---|
| Playbook olvasas | viewer |
| Draft verzio letrehozasa | admin |
| Publish / reject | approver vagy admin, de four-eyes policy eseten nem lehet azonos a keszitovel |
| Assignment modositas | admin |
| Process inditas | operator |
| Gate approval | a gate-ben megadott human role + approver jog |
| Process cancel | admin vagy kijelolt process owner |

### 11.2 Four-eyes policy

Ha a Playbook `criticality` vagy barmely gate `criticality` = `L2 | L3`, akkor:

- Playbook publish csak keszito != jovahagyo mellett;
- gate approvalhoz legalabb egy emberi jovahagyo kell;
- L3-nal ket kulon approver is eloirthato;
- minden approval evidence hash-elve auditba kerul.

### 11.3 Prompt injection vedelem

- A Playbookot az agent promptban csak hivatkozaskent / olvashato iranymutataskent kapja.
- A kotelezo transition es gate szabalyok nem promptban, hanem szerveroldalon elnek.
- Ha az agent kimenete azt allitja, hogy "kapu nem szukseges", a state machine ezt figyelmen kivul hagyja.
- Tool Broker capability es gate enforcement egymastol fuggetlen vedelmi retegek.

### 11.4 Tenant izolacio

Minden Playbook, version, assignment, process, step, delegation es ticket tenant-scope-olt. A repository retegekben kotelezo a `(tenant_id, id)` alapu lookup. Tiltott cross-tenant eleres:

- nem kulonbozteti meg, hogy nem letezik vagy nincs jog;
- `NOT_FOUND_OR_FORBIDDEN` valaszt ad;
- `access.denied` vagy specifikus `playbook.access_denied` auditot ir, payloadban csak metaadattal.

---

## 12. Implementacios fazisok

### F2-A - Playbook Registry es verziozas

**Feladatok:**

- `playbooks`, `playbook_versions`, `playbook_assignments` migracio.
- Repository + service reteg.
- JSON schema + szemantikai validator.
- Audit esemenyek: create/version/validate/submit/publish/assignment.
- Admin UI minimalis lista + reszlet + JSON editor.

**Elfogadas:**

- draft Playbook verzio letrehozhato;
- hibas spec nem publikalhato;
- published spec immutable;
- valid Playbook publish utan default assignmenthez kotheto.

### F2-B - Compiler es state machine enforcement

**Feladatok:**

- `compiled_spec` eloallitasa publish-kor.
- `TicketStateMachine` compiled szabalyokra kotese.
- `tickets.playbook_*` mezok hasznalata.
- Tiltott transition denial audit.

**Elfogadas:**

- Playbook stephez kotott ticket csak engedelyezett allapotba lephet;
- kotelezo gate nelkul blocked transition DENY;
- agent prompt/kimenet nem tud gate-et atlepni.

### F2-C - Process runtime es delegacio

**Feladatok:**

- `process_instances`, `process_step_instances`, `delegation_edges` migracio.
- `startProcess`, `advance`, `cancelProcess`.
- Kovetkezo ticket automatikus letrehozasa routing rule alapjan.
- Dispatcher csak ready + gate-free ticketet indit.

**Elfogadas:**

- egy 2 lepeses agent -> human folyamat vegigfut;
- Playbook ref minden ticketen es auditon latszik;
- delegation statusz pending -> delivered -> done.

### F2-D - Operator UI es flow osszevetes

**Feladatok:**

- process lista es reszlet;
- step timeline;
- gate panel;
- minimalis intended vs actual flow.

**Elfogadas:**

- operator latja, hol all a folyamat es ki var kire;
- auditbol visszarajzolhato a tenyleges flow;
- elteres jelolheto, ha a tenyleges atadas nem egyezik a Playbook routinggal.

### F2-E - Negativ tesztek es governance bizonyitek

**Feladatok:**

- acceptance tesztek P1-P10;
- governance dashboard metrikak;
- verifyChain lefuttatasa Playbook esemenyekkel.

**Elfogadas:**

- minden kotelezo negativ teszt zold;
- audit-lanc ep;
- meresi riportban megjelenik legalabb process count, gate latency, denied transition count.

---

## 13. Acceptance tesztek

| ID | Szenario | Elvart eredmeny |
|---|---|---|
| P1 | Admin valid Playbookot hoz letre es publishol | `playbook.version.publish`, compiled spec letrejon |
| P2 | Hibas spec: nem letezo role-ra hivatkozik | publish DENY, validacio `UNKNOWN_ROLE` |
| P3 | Published specet modositananak | DENY, uj verzio szukseges |
| P4 | Operator folyamatot indit default Playbookkal | `process.start`, Playbook ref pinelve |
| P5 | Agent engedelyezett stepet befejez | kovetkezo step/ticket letrejon |
| P6 | Agent kotelezo human gate-et probal atlepni | DENY + `gate.bypass_denied`; allapot nem valtozik |
| P7 | Jogosult approver jovahagyja a gate-et | transition sikeres, audit `gate.approve` |
| P8 | Nem jogosult viewer probal jovahagyni | DENY + audit |
| P9 | Playbook v3 fut, kozben v4 publisholodik | a futas tovabbra is v3-mal megy vegig |
| P10 | Mas tenant Playbook/process elerese | `NOT_FOUND_OR_FORBIDDEN` + access denied audit |
| P11 | Process vegigfut agent -> human -> done uton | `process.complete`, step statuszok completed |
| P12 | Auditbol tenyleges flow generalas | a delegation edge-ek es ticket transitionok alapjan reprodukalhato |

### 13.1 Kiemelt negativ teszt - gate bypass

**Given:** egy Playbookban `approve_accounting_posting` blocking human gate van.  
**When:** az agent outputja `{"approval_not_needed": true}` es `transitionTicket(toState: "approved")` hivas tortenik agent actorkent.  
**Then:** a state machine elutasitja az atmenetet, a ticket marad `awaiting_human`, auditba kerul `gate.bypass_denied` es `ticket.transition.denied`.

### 13.2 Kiemelt reprodukalhatosagi teszt - pinned version

**Given:** `playbook:invoice-processing@v3` alatt elindul egy process.  
**When:** admin publikalja a `v4` verziot es default assignmentet atallitja v4-re.  
**Then:** a mar futo process minden uj ticketje tovabbra is `playbook_version_id = v3`; csak az ujonnan inditott process kap v4-et.

---

## 14. Nyitott dontesek

| ID | Kerdes | Javasolt dontes |
|---|---|---|
| D-PB-1 | Kell-e grafikus Playbook editor? | Nem Fazis 2-ben; JSON editor + validacio eleg. Grafikus editor csak ugyfel-demo vagy gyakori uzleti szerkesztes eseten. |
| D-PB-2 | BPMN import/export kell-e? | Nem MVP/Fazis 2. Banki enterprise upgrade-pathkent tarthato fenn. |
| D-PB-3 | Ki irhat Playbookot? | Csak admin; approver publishol. Agent legfeljebb draft-javaslatot keszithet, de az nem kerul be automatikusan. |
| D-PB-4 | LLM segithet-e Playbook validacioban? | Csak nem-kotelezo magyarazat/suggestion celra. A validacio es compiler determinisztikus. |
| D-PB-5 | Parhuzamos agakat tamogatunk-e? | Elso Fazis 2-ben nem. `transitions` mar bovitheto, de `join`/`parallel` csak kesobbi schema version. |

---

## 15. Fejlesztoi megjegyzesek

- A Playbook spec legyen Zod schemaval validalva a TypeScript oldalon; DB-be csak valid JSON kerulhet draftkent is, de szemantikai hibakkal rendelkezo draft tarolhato.
- A publish tranzakcio egy lepesben validaljon, compile-oljon, content hash-t ellenorizzen, statuszt valtson es auditot irjon.
- A state machine ne olvassa minden transitionnel ujra a draft Playbookot; mindig a pin-elt `playbook_versions.compiled_spec`-et hasznalja.
- A `compiled_spec` legyen cache-elheto, de a DB legyen a forras.
- Audit payloadba ne keruljon teljes Playbook spec, csak `playbook_version_id`, `content_hash`, `playbook_ref` es metaadat.
- Playbook export/import kesobb konnyen hozzaadhato, ha a spec JSON stabil.

---

## 16. Definition of Done

A feature akkor tekintheto kesznek, ha:

1. Published Playbook-verzio letrehozhato, validalhato, compile-olhato es assignolhato.
2. Egy tobb lepeses, legalabb egy agent es egy human approval szereplos demo-folyamat vegigfut.
3. A Playbook-verzio pin-elese bizonyitott; menet kozbeni uj verzio nem hat a futo processre.
4. A blocking gate-et agent nem tudja megkerulni.
5. Minden Playbook-, process-, step-, delegation-, gate- es ticket-transition esemeny auditban van.
6. A tenyleges flow auditbol visszaallithato es osszevetheto a Playbookkal.
7. A P1-P12 acceptance tesztek zoldek.
8. Cross-tenant es jogosulatlan muveletek DENY + audit mintaval mukodnek.

