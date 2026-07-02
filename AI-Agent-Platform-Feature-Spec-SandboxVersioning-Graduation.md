# Feature-spec - Sandbox verziózás, test→live promóció és graduation/export

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-07-02
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, 5.4-5.8, 6., 8.4-8.6), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (D7), `AI-Agent-Platform-Feature-Spec-AppRegistry.md`, `AI-Agent-Platform-Feature-Spec-FileEditor.md`
**Olvasó:** fejlesztő(k), architect, product owner. Feltételezi a Control Plane, Sandbox Plane, Tool Broker, App Registry, File Editor, audit és RBAC alapmodell ismeretét.
**Státusz:** tervezet - önálló feature-spec. Az MVP-ben csak egy vékony szelet kötelező (kód-verziózás + rollback + audit); a promóció és a graduation séma legyen production-kompatibilis, de a teljes flow Fázis 2.

---

## 0. Mit ad ez a dokumentum

Ez a specifikáció azt írja le, hogyan lesz az Execution / Sandbox Plane egy **verziózott, visszaállítható, test→live promócióval kezelt és egy gombbal kiexportálható (graduálható) munkatér** — az az „Excel-szintű scratchpad" biztonsági háló, ami a koncepció 5.5-5.8 ígéretét tisztességessé teszi.

A koncepció szerint a sandbox nem csak fájlok tárolója, hanem agent-által fejleszthető alkalmazásplatform (5.4). Ha az AI szabadon épít benne, akkor **három dolgot mi biztosítunk alap-szolgáltatásként**, hogy a szabadság ne váljon kockázattá:

1. **Verziózás + rollback (5.7):** minden agent- vagy ember-változás diffelhető, visszagörgethető — a kód git-szerű projekt.
2. **Test→live promóció emberi go-live kapuval (5.7):** új funkció először egy `test` környezetben épül, és csak emberi „mehet" kattintással kerül `live`-ba; a promóció auditesemény.
3. **Graduation / export (5.8):** az érett modul kód + adat + séma együtt, lehetőleg egy gombbal kivihető a cég saját környezetébe — nincs lock-in.

**Az egész spec kulcs-invariánsa (5.7):** a **kód** és az **adat** két külön sín. A git a *kódot* verziózza és görgeti vissza; az élő adat (pl. CRM-sorok) **nem git** — azt időzített, point-in-time **snapshot** védi. Egy rossz deploy visszavonása soha nem veheti el a tegnap rögzített üzleti adatot.

**Mi NEM tartozik ide (elhatárolás):**

- Az **App Registry** (AppRegistry-spec) egy-egy *app-artefakt* (A0 single-file HTML) objektum-életciklusát adja. Ez a spec a *sandbox egészének* (kódbázis + adat) verziózását, környezet-promócióját és teljes kiszervezését adja. Az App Registry export egy app `.html`-jét adja; a graduation a teljes modult (kód + séma + adat).
- A **File Editor** (FileEditor-spec) az agent egyedi fájlműveleteit (read/write/patch) adja a workspace-en. Ez a spec az e fölötti commit/verzió/környezet/promóció réteget adja.
- A **MemoryTraining** write-gate az *agent memóriáját* verziózza. Ez a spec a *sandbox kódbázisát és adatát* verziózza. A két sín elvben azonos (verzió + rollback + audit + szerveroldali write-token), de külön store.

---

## 1. Scope

### 1.1 In scope - MVP szelet

- Sandbox mint verziózott projekt: `sandbox_projects` + `sandbox_commits` séma.
- Kód-commit létrehozása (agent vagy ember), fájllista + tartalom-hash alapján.
- Commit-history listázás, diff két commit között, rollback korábbi commitra (új commit létrehozásával, nem history-átírással).
- Két környezet: `test` és `live`, mindkettő egy commitra mutat (`test_commit_id`, `live_commit_id`).
- Test→live promóció **emberi go-live kapuval** (kötelező, nem kapcsolható ki), auditeseménnyel.
- Adat-snapshot sín: `sandbox_data_snapshots` (point-in-time), promóció előtt automatikus pre-promotion snapshot.
- Költség/observability horgok: build/run token- és compute-fogyasztás a 8.6 mérési alaplapra.
- Audit minden érdemi műveletre (`sandbox.commit`, `sandbox.rollback`, `sandbox.promote`, `sandbox.snapshot`, `sandbox.export`, `sandbox.access_denied`).

### 1.2 Out of scope - MVP-ben nem

- Teljes graduation-export csomag automatikus deploy-jal az ügyfél saját környezetébe (a séma és a manifest készüljön el, de a tényleges IaC/deploy Fázis 2).
- Elágazás / branch / merge (git-feature branch modell) — MVP-ben lineáris commit-lánc + rollback elég.
- Több párhuzamos live környezet (staging/canary) — MVP-ben egy `test` + egy `live`.
- Automatikus, ember nélküli test→live promóció (tiltott; a go-live kapu kemény padló).
- Real-time többfelhasználós szerkesztés-konfliktus feloldás.
- Adat-migráció / séma-verzió automatikus fordítása régi snapshotból újba.
- Blob/objektum-diff (binárisokra hash-alapú „változott / nem változott" elég, sor-szintű diff csak szövegre).

### 1.3 Feature-szint döntés

A verziózás/promóció/graduation **Execution / Sandbox Plane szolgáltatás**, de a kontrollpontjai a Control Plane-en keresztül érvényesülnek (illeszkedve az AppRegistry 1.3 döntéséhez):

- a projekt-, commit- és promóció-metaadat, valamint az audit **platform-szintű** (Control Plane);
- a kód- és adat-artefakt **sandbox-szintű** üzleti output;
- a **go-live promóció** és a **graduation-export** a scratchpad felelősséghatár átlépése, ezért **kötelezően auditált emberi aktus**.

---

## 2. Architektúra

### 2.1 Komponensek

```text
User / Agent
  |
  | commit / rollback / promote / snapshot / export
  v
Control Plane API
  |
  +-- RBAC + tenant check
  +-- SandboxVersionService   (kód-sín: commit, diff, rollback)
  +-- SandboxPromotionService (test->live go-live kapu)
  +-- SandboxDataSnapshotService (adat-sín: point-in-time snapshot)
  +-- GraduationService       (export csomag: kód + séma + adat)
  +-- AuditService
  |
  v
Sandbox Store
  |
  +-- metadata:      Postgres (projects, commits, promotions, snapshots)
  +-- code artifact: object storage (per-commit immutable fa)
  +-- data snapshot: object storage / DB point-in-time dump
  |
  v
Execution runtime (test / live)
  |
  +-- test env  -> test_commit_id
  +-- live env  -> live_commit_id
```

### 2.2 Felelősségi határok

| Elem | Felelősség |
|---|---|
| Control Plane API | RBAC, tenant izoláció, audit, minden verzió-/promóció-/export-metaművelet |
| SandboxVersionService | commit létrehozás, fa-hash, diff, lineáris history, rollback (előre-commit) |
| SandboxPromotionService | test→live léptetés, kötelező emberi go-live kapu, pre-promotion snapshot kikényszerítése |
| SandboxDataSnapshotService | point-in-time adat snapshot, restore, retenció |
| GraduationService | teljes hordozható export-csomag (kód + séma + adat + manifest), checksum, felelősség-átadás jelölése |
| Code / Data Store | commit-fa és adat-snapshot immutable tárolása |
| File Editor | a fájlok tényleges tartalmi műveletei (e spec commit fölötte ül) |
| Tool Broker | agent általi commit/rollback/snapshot mint kontrollált tool (promóció és export NEM agent-jog) |

### 2.3 Kritikus invariánsok

1. **Kód és adat két külön sín.** Kód-rollback soha nem módosít üzleti adatot; adat-restore soha nem módosít kódot.
2. A commit-fa **immutable**: rollback nem törli/írja át a history-t, hanem új commitot hoz létre, ami egy korábbi fára mutat.
3. **A test→live promóciónak mindig van emberi jóváhagyója.** Nincs olyan konfiguráció (agent, scheduled, proaktív), amely ezt megkerüli — kemény padló (illeszkedik a MemoryTraining 5.8 „nem kapcsolható ki" elvéhez).
4. **Promóció előtt kötelező pre-promotion adat-snapshot** a `live` környezetről (visszagörgethetőség).
5. Egy projekt, commit, snapshot és export mindig pontosan egy tenanthoz tartozik.
6. **Agent nem promótálhat és nem exportálhat.** Az agent legfeljebb commitolhat és javasolhatja a promóciót; a go-live és a graduation ember-only.
7. **Agent önmódosítással nem bővítheti a saját jogosultságait** — a sandbox kód-commit nem érinti a capability/RBAC réteget (illeszkedik a koncepció 4.6.4 kemény padlójához).
8. Cross-tenant projekt/commit/snapshot/export elérés `SANDBOX_NOT_FOUND_OR_FORBIDDEN` választ ad és `sandbox.access_denied` auditot ír.
9. Export csak létező, hash-elt commitból és nevesített adat-snapshotból készülhet; a csomagnak reprodukálható checksumja van.

---

## 3. Adatmodell

### 3.1 Enumok

```sql
sandbox_env:            test | live
commit_source:          user | agent | system | import
promotion_status:       pending_approval | approved | promoted | rejected | rolled_back
snapshot_kind:          manual | pre_promotion | scheduled | pre_rollback
snapshot_status:        creating | available | restoring | expired | failed
export_status:          requested | building | ready | delivered | failed
export_scope:           code_only | code_and_schema | full   -- full = kód + séma + adat
actor_type:             user | agent | system
```

### 3.2 `sandbox_projects`

```sql
sandbox_projects (
  id uuid primary key,
  tenant_id uuid not null,
  sandbox_id uuid not null,

  name text not null,
  description text null,

  test_commit_id uuid null,   -- aktuális test fa
  live_commit_id uuid null,   -- aktuális live fa
  head_commit_id uuid null,   -- utolsó commit (a lineáris lánc feje)

  data_binding jsonb not null default '{}',  -- mely adat-store-ok tartoznak a modulhoz (snapshothoz/exporthoz)
  portability jsonb not null default '{}',   -- graduation-readiness jelölők (5.6 hordozhatóság)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null,

  unique(tenant_id, sandbox_id, name)
)
```

### 3.3 `sandbox_commits`

```sql
sandbox_commits (
  id uuid primary key,
  tenant_id uuid not null,
  project_id uuid not null references sandbox_projects(id),

  seq int not null,                 -- lineáris sorszám a projekten belül
  parent_commit_id uuid null,       -- előző commit (rollback esetén a cél-fa őse marad látszó)
  based_on_commit_id uuid null,     -- rollback esetén: melyik korábbi fát állította vissza

  source commit_source not null,
  change_summary text not null,

  tree_ref text not null,           -- immutable fa-artefakt referencia (object storage)
  tree_hash text not null,          -- a teljes fa determinisztikus SHA-256 hash-e
  file_count int not null,
  total_size_bytes bigint not null,

  created_by_type actor_type not null,
  created_by_user_id uuid null,
  created_by_agent_id uuid null,
  created_from_ticket_id uuid null,
  created_from_run_id uuid null,

  build_cost jsonb not null default '{}',  -- token/compute a 8.6 mérési alaplapra

  created_at timestamptz not null default now(),

  unique(project_id, seq),
  unique(tenant_id, project_id, tree_hash)
)
```

**Fa-artefakt path javaslat:**

```text
sandbox-code/{tenantId}/{projectId}/commits/{seq}/tree.tar.zst
```

### 3.4 `sandbox_promotions`

```sql
sandbox_promotions (
  id uuid primary key,
  tenant_id uuid not null,
  project_id uuid not null references sandbox_projects(id),

  from_commit_id uuid not null,   -- amit live-ba léptetnénk (a test feje)
  prev_live_commit_id uuid null,  -- a korábbi live (rollback célja)
  pre_promotion_snapshot_id uuid null references sandbox_data_snapshots(id),

  status promotion_status not null default 'pending_approval',

  requested_by_type actor_type not null,
  requested_by_user_id uuid null,
  requested_by_agent_id uuid null,
  approved_by_user_id uuid null,   -- KÖTELEZŐ, ha status in (approved, promoted)
  reason text null,

  requested_at timestamptz not null default now(),
  decided_at timestamptz null,
  promoted_at timestamptz null
)
```

### 3.5 `sandbox_data_snapshots`

```sql
sandbox_data_snapshots (
  id uuid primary key,
  tenant_id uuid not null,
  project_id uuid not null references sandbox_projects(id),
  env sandbox_env not null,        -- melyik környezet adatáról készült

  kind snapshot_kind not null,
  status snapshot_status not null default 'creating',

  snapshot_ref text not null,      -- point-in-time dump referencia
  schema_hash text not null,       -- a séma állapotának hash-e (kód-fától független)
  row_count bigint null,
  size_bytes bigint null,

  created_by_type actor_type not null,
  created_by_user_id uuid null,
  linked_promotion_id uuid null,

  created_at timestamptz not null default now(),
  expires_at timestamptz null
)
```

### 3.6 `sandbox_exports` (graduation)

```sql
sandbox_exports (
  id uuid primary key,
  tenant_id uuid not null,
  project_id uuid not null references sandbox_projects(id),

  scope export_scope not null,
  source_commit_id uuid not null,
  source_snapshot_id uuid null,     -- full scope esetén kötelező

  status export_status not null default 'requested',
  package_ref text null,            -- a kész export-csomag referencia
  package_hash text null,           -- reprodukálható checksum
  manifest jsonb not null default '{}',
  responsibility_transferred boolean not null default false,  -- 5.3.2 BOT-transfer jelölő

  requested_by_user_id uuid not null,   -- ember-only
  requested_at timestamptz not null default now(),
  completed_at timestamptz null
)
```

---

## 4. API specifikáció

### 4.1 `createSandboxCommit`

```ts
createSandboxCommit(input: {
  projectId: string;
  files: Array<{ path: string; contentRef: string }>;  // File Editor által előkészített
  changeSummary: string;
  createdFromTicketId?: string;
  createdFromRunId?: string;
}): {
  commitId: string;
  seq: number;
  treeHash: string;
}
```

**Jogosultság:** `operator+` vagy agent Tool Broker capability (`sandbox.commit`).

**Szerveroldali lépések:** tenant/projekt check → fa összeállítása és determinisztikus hash → immutable fa mentése → `seq` kiosztása tranzakcióban → `head_commit_id` és `test_commit_id` frissítése (a commit a `test` fejére kerül) → build-költség naplózása → audit.

**Fontos:** a commit **csak a `test` fát mozdítja**; `live` sosem változik commitra, csak promócióra.

**Audit:** `sandbox.commit`.

### 4.2 `getSandboxHistory` / `diffSandboxCommits`

```ts
getSandboxHistory(input: { projectId: string; limit?: number; cursor?: string }): {
  commits: Array<{ commitId: string; seq: number; source: string; changeSummary: string;
                   treeHash: string; createdByLabel: string; createdAt: string;
                   isTest: boolean; isLive: boolean }>;
  nextCursor?: string;
}

diffSandboxCommits(input: { projectId: string; fromCommitId: string; toCommitId: string }): {
  changedFiles: Array<{ path: string; changeType: "added"|"modified"|"deleted"|"binary_changed";
                        textDiff?: string }>;
}
```

**Jogosultság:** `viewer+`.

### 4.3 `rollbackSandboxCode`

```ts
rollbackSandboxCode(input: {
  projectId: string;
  toCommitId: string;   // egy korábbi commit fája
  reason: string;
}): {
  commitId: string;     // ÚJ commit, ami a régi fát állítja vissza
  seq: number;
}
```

**Jogosultság:** `operator+`.

**Elv (invariáns 2):** a rollback **nem törli** a history-t; új commitot hoz létre `based_on_commit_id = toCommitId` értékkel, és a `test` fejet erre állítja. A `live` ettől nem változik (ahhoz promóció kell). Csak a kód-sín; adatot nem érint.

**Audit:** `sandbox.rollback`.

### 4.4 `requestPromotion` → `approvePromotion` (test→live go-live kapu)

```ts
requestPromotion(input: {
  projectId: string;
  reason?: string;
}): { promotionId: string; status: "pending_approval"; fromCommitId: string }

approvePromotion(input: {
  promotionId: string;
  decision: "approve" | "reject";
  reason?: string;
}): { promotionId: string; status: "promoted" | "rejected"; liveCommitId?: string }
```

**Jogosultság:** `requestPromotion` — `operator+` **vagy** agent (`sandbox.request_promotion` capability). `approvePromotion` — **kizárólag ember**, `operator+` (agent SOHA). Az `approved_by_user_id` kitöltése kötelező jóváhagyáskor (invariáns 3).

**Szerveroldali lépések approve esetén:**

1. Ellenőrzés: van-e jóváhagyó ember; a `from_commit_id` a `test` aktuális feje-e.
2. **Kötelező pre-promotion adat-snapshot** a `live` környezetről (invariáns 4) — ha ez nem áll elő, a promóció `failed`, nem `promoted`.
3. `live_commit_id := from_commit_id` atomikusan.
4. `status := promoted`, `promoted_at` beállítása.
5. Audit.

**Audit:** `sandbox.promote.request`, `sandbox.promote.approve` / `sandbox.promote.reject`.

### 4.5 `createDataSnapshot` / `restoreDataSnapshot`

```ts
createDataSnapshot(input: { projectId: string; env: "test"|"live"; label?: string }): {
  snapshotId: string; status: "creating"|"available"; schemaHash: string;
}

restoreDataSnapshot(input: { projectId: string; snapshotId: string; targetEnv: "test"|"live"; reason: string }): {
  snapshotId: string; restoredTo: "test"|"live";
}
```

**Jogosultság:** `createDataSnapshot` — `operator+` vagy agent capability (`sandbox.snapshot`). `restoreDataSnapshot` — **ember-only** `operator+`, `live` célra kötelező jóváhagyással; a restore **pre_rollback** snapshotot készít a felülírás előtt.

**Elv:** az adat-sín teljesen független a kód-committól; egy restore soha nem változtat kódot.

**Audit:** `sandbox.snapshot.create`, `sandbox.snapshot.restore`.

### 4.6 `requestExport` (graduation)

```ts
requestExport(input: {
  projectId: string;
  scope: "code_only" | "code_and_schema" | "full";
  sourceCommitId?: string;   // default: live_commit_id
  sourceSnapshotId?: string; // full scope esetén kötelező
  markResponsibilityTransfer?: boolean;
}): {
  exportId: string; status: "requested"|"building";
}

getExport(input: { exportId: string }): {
  status: "requested"|"building"|"ready"|"delivered"|"failed";
  packageRef?: string; packageHash?: string; manifest?: object;
}
```

**Jogosultság:** **kizárólag ember**, `operator+` (agent SOHA — invariáns 6). `markResponsibilityTransfer=true` (BOT-transfer, 5.3.2) csak `admin`.

**Export-csomag tartalma (`full` scope):**

- teljes kód-fa a `source_commit_id`-ról (a `tree_hash`-sel);
- adatbázis-séma (DDL) a `schema_hash`-sel;
- adat point-in-time dump a `source_snapshot_id`-ból;
- `manifest.json`: projekt-metaadat, commit-hash, snapshot-hash, séma-hash, csomag-checksum, export időpont, exportáló, hordozhatósági jelölők;
- README a saját környezetbe telepítéshez (Fázis 2: IaC/Docker).

**Audit:** `sandbox.export.request`, `sandbox.export.ready`, `sandbox.export.delivered`.

---

## 5. Tool Broker toolok az agent felé

Az agent commitolhat, javasolhat promóciót és készíthet snapshotot — de **nem promótálhat és nem exportálhat**.

### 5.1 Capability névkonvenció

```text
sandbox.commit
sandbox.request_promotion
sandbox.snapshot          (csak env='test' az agentnek; live snapshot ember-only)
```

Minden capability agent-verzióhoz kötött, deny-by-default. **Nincs** `sandbox.approve_promotion`, `sandbox.rollback` (live), `sandbox.restore` (live) és `sandbox.export` agent-capability — ezek kódszinten sem adhatók agentnek.

### 5.2 `sandbox.commit`

```json
{ "projectId": "...", "files": [ { "path": "app/crm.jsx", "contentRef": "..." } ],
  "changeSummary": "Ügyfél-lista szűrő hozzáadva", "createdFromTicketId": "..." }
```

Válasz: `{ "commitId": "...", "seq": 7, "treeHash": "sha256:..." }`

### 5.3 `sandbox.request_promotion`

```json
{ "projectId": "...", "reason": "A szűrő kész, kérem élesítésre." }
```

Válasz: `{ "promotionId": "...", "status": "pending_approval" }` — a jóváhagyás ezután **emberi** aktus a Control Plane UI-ban.

### 5.4 Agent-specifikus tiltások

Az agent toolon keresztül:

- **nem hagyhat jóvá** promóciót és **nem léptethet** `live`-ba;
- **nem exportálhat** (graduation) semmilyen scope-ban;
- `live` környezet adatát **nem snapshotolhatja** és **nem állíthatja vissza**;
- **nem törölhet** commitot, snapshotot, exportot vagy auditot;
- **nem írhatja át** a history-t (rollback csak ember, és az is előre-commit);
- **nem módosíthat** capability/RBAC/policy réteget sandbox-committal (invariáns 7).

---

## 6. Promóció, go-live kapu és a kód/adat kettős sín

### 6.1 A test→live modell

```text
   commit (agent/ember)  ─────►  TEST fa (test_commit_id)   [szabad kéz]
                                       │
                                       │ requestPromotion  (agent v. ember)
                                       ▼
                              🔒 EMBERI GO-LIVE KAPU (approvePromotion, ember-only)
                                       │  1) pre-promotion snapshot a LIVE adatról (kötelező)
                                       ▼
                                  LIVE fa (live_commit_id)   [erre támaszkodnak emberek]
```

A `test` a kísérletezés helye — itt commitol az AI szabadon. A `live` az a felület, amire emberek támaszkodnak; oda csak emberi „mehet" kattintással kerül kód. A promóció **auditesemény**, jóváhagyóval, indokkal, forrás-commit-hash-sel.

### 6.2 A kód vs. adat kettős sín (a spec legfontosabb szabálya)

| Sín | Mit véd | Mechanizmus | Visszaállítás |
|---|---|---|---|
| **Kód** | app-logika, fájlok | git-szerű commit-fa, `tree_hash` | `rollbackSandboxCode` → új commit egy régi fára |
| **Adat** | felhalmozott üzleti sorok (pl. CRM) | point-in-time `sandbox_data_snapshots` | `restoreDataSnapshot` (pre_rollback snapshottal) |

**Miért kritikus:** egy rossz deploy visszavonása (kód-rollback) **nem veheti el a tegnap rögzített üzleti adatot**. A két művelet külön API, külön store, külön audit. Egy kód-rollback után a `live` adat érintetlen; egy adat-restore után a kód érintetlen. A séma állapotát a `schema_hash` külön követi, mert a séma az adat-sínhez tartozik, nem a kód-fához.

### 6.3 Go-live kapu mint kemény padló

A promóció-jóváhagyás emberkényszere **nem konfigurálható ki** — sem agent önfejlesztési profillal (4.6.4), sem scheduled/proaktív futással (4.11), sem tenant-beállítással. Ez a `self_evolution_profile` „soha nem bővíthet jogosultságot" elvének sandbox-megfelelője: az AI a `test`-ben mindent megtehet, de az élesítés emberi döntés marad.

---

## 7. Graduation / export (kiszervezés)

### 7.1 Elv

A graduation a termék **bizalmi differenciátora**, nem mellékfunkció (5.8): „soha nem vagy bezárva". Az érett, bevált modul kód + adat + séma együtt, lehetőleg egy gombbal kivihető a cég saját környezetébe, és onnantól az a cég hivatalos rendszerének része. A felelősség és a garancia is átszáll (illeszkedik a BOT-transfer-hez, 5.3.2).

### 7.2 A „triviális export" követelmény

Az export akkor tölti be a szerepét, ha **valóban egyszerű** (5.8): egy gomb, teljes adat + kód + séma. Ez csak akkor olcsó, ha a modul **hordozhatóan épült a kezdetektől** (5.6) — ezért a `sandbox_projects.portability` jelölők (pl. „nincs platform-specifikus API-függés", „séma önálló DDL-ként kiírható") a projekt élete során karbantartottak, és a graduation-readiness a UI-ban látszik. Ha a hordozhatóság sérül, a UI figyelmeztet, mert különben a „bármikor kiveheted" ígéret üres, súrlódás-alapú lock-inná válik.

### 7.3 Export scope-ok

| Scope | Tartalom | Tipikus használat |
|---|---|---|
| `code_only` | kód-fa + manifest | kód-review, külső verziókezelőbe |
| `code_and_schema` | kód-fa + DDL séma + manifest | üres célkörnyezet felállítása |
| `full` | kód-fa + séma + adat point-in-time dump + manifest | teljes kiszervezés (graduation) |

Az export ember-only, auditált, reprodukálható `package_hash`-sel. `admin` a `responsibility_transferred` jelölőt is beállíthatja (a garancia átszállásának formális jelzése).

---

## 8. Audit és observability

### 8.1 Audit események

```text
sandbox.commit
sandbox.rollback
sandbox.promote.request
sandbox.promote.approve
sandbox.promote.reject
sandbox.snapshot.create
sandbox.snapshot.restore
sandbox.export.request
sandbox.export.ready
sandbox.export.delivered
sandbox.access_denied
```

### 8.2 Audit payload minimum

```json
{
  "tenant_id": "...",
  "project_id": "...",
  "env": "test|live",
  "commit_id": "...",
  "tree_hash": "sha256:...",
  "snapshot_id": "...",
  "schema_hash": "sha256:...",
  "actor_type": "user|agent|system",
  "actor_id": "...",
  "approved_by_user_id": "...",
  "reason": "...",
  "created_from_ticket_id": "..."
}
```

Kód- vagy adat-tartalmat audit logba írni tilos — csak referencia, hash és metaadat.

### 8.3 Metrikák (a 8.6 mérési alaplapra)

- commitok száma projektenként; test→live promóciók száma és átfutási ideje;
- promóció-elutasítások aránya; rollbackek száma (kód) és restore-ok száma (adat);
- pre-promotion snapshotok sikeraránya (kötelező kapu ellenőrzése);
- build/run token- és compute-költség commitonként és környezetenként;
- graduation-exportok száma és scope-eloszlása; hordozhatóság-figyelmeztetések száma;
- agent által vs. ember által létrehozott commitok aránya.

---

## 9. UI követelmények

### 9.1 Projekt-nézet

- projekt neve, leírás; aktuális `test` és `live` commit (seq + rövid hash);
- commit-history idővonal, forrás (user/agent) jelöléssel;
- „Test" és „Live" badge a megfelelő commiton;
- graduation-readiness / hordozhatóság állapot-jelző.

### 9.2 Commit / diff nézet

- change summary, létrehozó, eredet-ticket link;
- két commit közti diff (szöveg sor-szintű; bináris: „változott");
- rollback gomb (indok kötelező) — jelzi, hogy csak a kódot állítja vissza, az adatot nem.

### 9.3 Promóció (go-live) nézet

- promóció-kérések listája `pending_approval` állapotban;
- jóváhagyás/elutasítás gomb (ember-only), indokmezővel;
- explicit vizuális megerősítés: „Ez a `test` commitot élesíti. A `live` adatról előbb automatikus mentés készül."
- promóció-előzmény jóváhagyóval, időbélyeggel, forrás-hash-sel.

### 9.4 Adat-snapshot nézet

- snapshot-lista (kind, env, időpont, méret, séma-hash);
- restore gomb (`live` célra kötelező jóváhagyás + indok);
- egyértelmű elkülönítés a kód-history-tól (külön panel), hogy a kettős sín látható legyen.

### 9.5 Graduation / export UX

Export előtt megerősítés:

```text
Ez a modult a saját környezetedbe kiszervezhető csomagba (kód + séma + adat) csomagolja.
A letöltés után a modul a te rendszered része; a platformon belüli scratchpad-felelősség itt átszáll.
```

Letöltés után mutatni kell: csomag-checksum, forrás-commit-hash, snapshot-hash, séma-hash, exportáló, időpont, felelősség-átadás jelölő.

---

## 10. Implementációs terv

### F-SV-1 - Kód-sín: projekt, commit, history

- `sandbox_projects`, `sandbox_commits` tábla + enumok;
- `SandboxVersionService` (commit, determinisztikus fa-hash, lineáris seq);
- File Editor integráció (a commit a File Editor által előkészített fájlokból áll össze);
- audit `sandbox.commit`.

**Kipróbálható, ha:** API-ból létrehozható commit, a `tree_hash` determinisztikus, a `test_commit_id` mozog, a `live` nem, és a DB nem tárol nyers tartalmat, csak referencia + hash.

### F-SV-2 - Diff és rollback

- `diffSandboxCommits` (szöveg sor-szint, bináris hash);
- `rollbackSandboxCode` (előre-commit, history-megőrzés);
- audit `sandbox.rollback`.

**Kipróbálható, ha:** két commit diffelhető, a rollback új commitot hoz létre egy régi fára, a history nem sérül, és az adat érintetlen marad.

### F-SV-3 - Adat-sín: snapshot és restore

- `sandbox_data_snapshots` tábla + service;
- `createDataSnapshot` (test/live), `restoreDataSnapshot` (pre_rollback snapshottal);
- retenció; audit `sandbox.snapshot.*`.

**Kipróbálható, ha:** adat-snapshot készül és visszaállítható anélkül, hogy a kód-commit változna; a `schema_hash` külön követett.

### F-SV-4 - Test→live promóció + go-live kapu

- `sandbox_promotions` tábla + `SandboxPromotionService`;
- `requestPromotion` (agent/ember), `approvePromotion` (ember-only);
- **kötelező pre-promotion live-snapshot** a promóció előfeltételeként;
- audit `sandbox.promote.*`.

**Kipróbálható, ha:** agent kérheti a promóciót, de csak ember hagyja jóvá; a jóváhagyás előbb live-snapshotot készít, majd atomikusan léptet; ember nélkül nincs élesítés.

### F-SV-5 - Graduation / export

- `sandbox_exports` tábla + `GraduationService`;
- `requestExport` / `getExport` (ember-only), `code_only`/`code_and_schema`/`full` scope;
- manifest + reprodukálható `package_hash`; hordozhatóság-jelzők;
- audit `sandbox.export.*`.

**Kipróbálható, ha:** `full` export a live commitból + nevesített snapshotból reprodukálható csomagot ad, checksummal; agent nem indíthat exportot.

### F-SV-6 - UI

- projekt/commit/diff/promóció/snapshot/export nézetek;
- kettős sín vizuális elkülönítése; go-live megerősítő; export megerősítő + checksum.

**Kipróbálható, ha:** operator commitot néz, diffet lát, rollbackel, promóciót hagy jóvá és exportot indít; a UI mutatja a kód/adat elkülönítést.

---

## 11. Elfogadási kritériumok

### 11.1 Funkcionális

| ID | Kritérium |
|---|---|
| SV1 | Agent vagy operator commitot hoz létre; a rendszer `seq`-et és determinisztikus `tree_hash`-t ad; csak a `test` fa mozdul. |
| SV2 | Két commit diffelhető; a bináris fájl „változott" jelölést kap, a szöveg sor-szintű diffet. |
| SV3 | Rollback új commitot hoz létre egy korábbi fára; a history immutable marad; az adat érintetlen. |
| SV4 | Adat-snapshot készül és visszaállítható a kód-commit módosítása nélkül. |
| SV5 | Promóció csak ember jóváhagyásával léptet `live`-ba; a jóváhagyó rögzül. |
| SV6 | Promóció előtt automatikusan pre-promotion live-adat-snapshot készül; ha ez meghiúsul, nincs promóció. |
| SV7 | `full` export reprodukálható csomagot ad (kód + séma + adat) checksummal; a manifest tartalmazza a hash-eket. |
| SV8 | Minden commit/rollback/promote/snapshot/export esemény auditban van, tartalom nélkül. |
| SV9 | Agent commitolhat és kérhet promóciót, de nem hagyhat jóvá, nem exportálhat és nem nyúlhat live adathoz. |
| SV10 | Kód- és adat-tartalom nem kerül audit logba, csak referencia + hash. |

### 11.2 Kötelező negatív tesztek

| ID | Teszt | Elvárt eredmény |
|---|---|---|
| N1 | Más tenant projektjének commit/history elérése | `SANDBOX_NOT_FOUND_OR_FORBIDDEN` + `sandbox.access_denied` |
| N2 | Agent `approvePromotion` hívása | `TOOL_NOT_AUTHORIZED` (nincs ilyen capability) |
| N3 | Agent `requestExport` hívása | `TOOL_NOT_AUTHORIZED` |
| N4 | `approvePromotion` `approved_by_user_id` nélkül | elutasítás; a promóció nem lehet `promoted` |
| N5 | Promóció, de a pre-promotion snapshot meghiúsul | `PROMOTION_FAILED_NO_SNAPSHOT`, `live_commit_id` változatlan |
| N6 | Kód-rollback után az élő adat ellenőrzése | az adat változatlan (kettős sín) |
| N7 | Agent live-env snapshot/restore hívása | `TOOL_NOT_AUTHORIZED` |
| N8 | `full` export `sourceSnapshotId` nélkül | `EXPORT_SNAPSHOT_REQUIRED` |
| N9 | History átírás / commit törlés kísérlete | tiltott; a commit-fa immutable |
| N10 | Audit payload kód-/adattartalmat tartalmazna | teszt bukjon; sanitization kötelező |
| N11 | Sandbox-committal capability/RBAC bővítés kísérlete | tiltott; a commit nem érinti a jogosultsági réteget (invariáns 7) |

---

## 12. Roadmap (Fázis 2 irányba)

- **Branch / merge:** feature-branch modell a lineáris lánc helyett, konfliktus-feloldással.
- **Több élő környezet:** staging + canary + live, fokozatos rollout.
- **Automatikus deploy graduationkor:** IaC/Docker-csomag, egygombos telepítés az ügyfél saját felhőjébe/on-prembe.
- **Séma-migráció:** régi adat-snapshot automatikus migrálása új séma-verzióba restore-kor.
- **Policy-alapú promóció-kapu:** kritikussági szint (L0-L3, 5.6) szerint differenciált jóváhagyási lánc (egy vs. két jóváhagyó), de az emberkényszer marad kemény padló.
- **Diff-alapú eval a promóció előtt:** automatikus teszt/eval a `test` commiton, mint a go-live kapu döntéstámogatása (nem helyettesítője).

---

## 13. Nyitott döntések

1. **Kód-store formátum:** per-commit teljes fa-snapshot (egyszerű, de redundáns) vagy tartalom-címzett objektum-store git-szerű megosztott blobokkal? Javaslat: MVP-ben teljes fa-snapshot object storage-ban, később content-addressed dedup.
2. **Adat-snapshot mélysége:** logikai dump (hordozható, lassabb) vagy storage-szintű point-in-time (gyors, kevésbé hordozható)? Javaslat: logikai dump, mert a graduation hordozhatóságot igényel.
3. **Pre-promotion snapshot retenció:** meddig őrizzük a promóció-előtti mentéseket? Javaslat: konfigurálható, alapból a sandbox retention-t követi, minimum N utolsó promóció.
4. **Export méret / adatmennyiség:** nagy `full` export aszinkron build + letöltési link, vagy közvetlen stream? Javaslat: aszinkron build + rövid életű aláírt letöltés.
5. **Graduation után:** a kiexportált modul marad-e a sandboxban (párhuzamos üzem), vagy archiváljuk? Javaslat: alapból marad, de a UI jelzi a „graduált" státuszt és a felelősség-átadást.
6. **Hordozhatóság mérése:** statikus lint (platform-API-függés keresése) elég-e a `portability` jelzőkhöz, vagy futásidejű ellenőrzés is kell? Javaslat: MVP-ben statikus lint + figyelmeztetés.
