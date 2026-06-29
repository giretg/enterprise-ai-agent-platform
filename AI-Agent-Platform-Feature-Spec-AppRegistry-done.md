# Feature-spec - Sandbox App Container / App Registry

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-27
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, 5.4-5.9, 6., 8.4), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (5.10.1)
**Olvasó:** fejlesztő(k), architect, product owner. Feltételezi a Control Plane, Sandbox Plane, Tool Broker, audit és RBAC alapmodell ismeretét.
**Státusz:** tervezet - önálló feature-spec. Az MVP-ben stretch/demo-bónusz, de a séma és a biztonsági határok legyenek production-kompatibilisek.

---

## 0. Mit ad ez a dokumentum

Ez a specifikáció meghatározza, hogyan lesz az AI által létrehozott sandbox-artefaktból **nyilvántartott, verziózott, izoláltan megnyitható és exportálható mini-alkalmazás**.

A koncepció szerint az Execution / Sandbox Plane nem csak fájlok és riportok tárolója, hanem agent által fejleszthető alkalmazásfelület. Ehhez kell egy App Registry: nem chatben eldobott HTML-kód, nem kézzel linkelt fájl, hanem tenanthez, sandboxhoz, tickethez, agenthez és auditnyomhoz köthető app-erőforrás.

Az első implementációs cél az **A0 - single-file app**:

- egy darab HTML/CSS/JS artefakt;
- külön, cookieless preview origin;
- sandboxolt iframe;
- szigorú CSP, hálózat és secret nélkül;
- verziózás, rollback, export;
- auditált create / version / preview / export / access-denied események.

Ez a feature nem váltja ki az Agent File Editort. A File Editor az agent munkaterületi fájlműveleteit adja. Az App Registry azokat az artefaktokat emeli termék-szintű app-erőforrássá, amelyeket felhasználók megnyitnak, kipróbálnak, verzióznak és exportálnak.

---

## 1. Scope

### 1.1 In scope - MVP / A0 szelet

- App Registry lista tenantonként és sandboxonként.
- Egyetlen app-típus: `single_html`.
- Egyetlen app-szint: `A0`.
- App létrehozása névvel, leírással, kritikussági szinttel és opcionális eredet-hivatkozással.
- App-verzió létrehozása HTML tartalommal, change summary-val és SHA-256 content hash-sel.
- Aktív verzió kijelölése.
- Régi verzió megtekintése és visszaállítása.
- Preview URL generálása külön preview domainen / originon.
- Iframe preview a Control Plane vagy Sandbox UI-ban.
- HTML export letöltésként, hash megjelenítéssel.
- Audit minden érdemi műveletre.
- Tool Broker toolok az agent felé opcionálisan már az MVP-ben, de a szolgáltatás API-ja ezek nélkül is készüljön el.

### 1.2 Out of scope - MVP-ben nem

- Többfájlos static app bundle (`A1`).
- NPM / build pipeline / dependency install.
- Backend, API route vagy server-side execution az apphoz.
- Sandbox-natív adatmodell olvasása/írása az appból (`A2`).
- Külső connector vagy Tool Broker hívás közvetlenül az appból (`A3`).
- Internet-elérés a preview futás közben.
- App publikálása éles ügyfélkörnyezetbe.
- Docker, Git repository vagy IaC export.
- Többfelhasználós real-time app-szerkesztés.
- App store / marketplace funkciók.

### 1.3 Feature-szint döntés

Az App Registryt **Execution / Sandbox Plane szolgáltatásként** kell kezelni, de a kontrollpontjai a Control Plane-en keresztül érvényesülnek:

- az app metaadata és auditja platform-szintű;
- az artefakt sandbox-szintű üzleti output;
- a preview izolált futtatási felület;
- az export a scratchpad felelősséghatár átlépése, ezért auditált felhasználói aktus.

---

## 2. Architektúra

### 2.1 Komponensek

```text
User / Agent
  |
  | create / update / preview / export
  v
Control Plane API
  |
  +-- RBAC + tenant check
  +-- AppRegistryService
  +-- AuditService
  |
  v
Sandbox App Store
  |
  +-- metadata: Postgres
  +-- artifact: object storage vagy blob store
  |
  v
Preview Service - külön origin
  |
  +-- HTML betöltés content hash alapján
  +-- CSP header
  +-- no cookies, no platform session
  |
  v
Sandboxed iframe a UI-ban
```

### 2.2 Felelősségi határok

| Elem | Felelősség |
|---|---|
| Control Plane API | RBAC, tenant izoláció, audit, app metaadat-műveletek |
| AppRegistryService | app és verzió életciklus, hash, státusz, policy validáció |
| Artifact Store | HTML artefakt tárolása immutable verzióként |
| Preview Service | izolált kiszolgálás külön originről, CSP, cache és content hash ellenőrzés |
| UI | app lista, verziók, preview iframe, export gomb, biztonsági állapot megjelenítése |
| Tool Broker | agent általi app létrehozás / verziófrissítés kontrollált toolként |

### 2.3 Kritikus invariánsok

1. Preview app nem kap platform cookie-t, sessiont, tokent vagy secretet.
2. Preview app nem hívhat platform API-t.
3. Preview app nem érhet el külső hálózatot.
4. Egy app és verzió mindig pontosan egy tenanthez tartozik.
5. A HTML tartalom verzió után immutable; módosítás csak új verzióval történhet.
6. Export csak létező, hash-elt, immutable verzióból készülhet.
7. Cross-tenant app vagy verzió elérés `APP_NOT_FOUND_OR_FORBIDDEN` választ ad, és `sandbox_app.access_denied` audit eseményt ír.

---

## 3. Adatmodell

### 3.1 Enumok

```sql
app_level: A0 | A1 | A2 | A3
app_type: single_html | static_bundle | sandbox_data_app | integrated_app
app_status: draft | active | archived | blocked
app_version_status: draft | active | superseded | blocked
criticality: L0 | L1 | L2 | L3
created_by_type: user | agent | system
```

Az MVP-ben csak ezek engedélyezettek:

```text
app_level = A0
app_type = single_html
criticality = L0 vagy L1
```

### 3.2 `sandbox_apps`

```sql
sandbox_apps (
  id uuid primary key,
  tenant_id uuid not null,
  sandbox_id uuid null,

  name text not null,
  description text null,
  level app_level not null default 'A0',
  type app_type not null default 'single_html',
  status app_status not null default 'draft',
  criticality criticality not null default 'L1',

  active_version_id uuid null,

  created_by_type created_by_type not null,
  created_by_user_id uuid null,
  created_by_agent_id uuid null,
  created_from_ticket_id uuid null,
  created_from_conversation_id uuid null,

  policy jsonb not null default '{}',
  tags jsonb not null default '[]',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
)
```

**Indexek:**

```sql
index sandbox_apps_tenant_status_idx on sandbox_apps (tenant_id, status);
index sandbox_apps_tenant_sandbox_idx on sandbox_apps (tenant_id, sandbox_id);
index sandbox_apps_created_from_ticket_idx on sandbox_apps (tenant_id, created_from_ticket_id);
```

### 3.3 `sandbox_app_versions`

```sql
sandbox_app_versions (
  id uuid primary key,
  tenant_id uuid not null,
  app_id uuid not null references sandbox_apps(id),

  version int not null,
  status app_version_status not null default 'draft',
  change_summary text not null,

  artifact_ref text not null,
  artifact_size_bytes int not null,
  content_hash text not null,
  mime_type text not null default 'text/html; charset=utf-8',

  created_by_type created_by_type not null,
  created_by_user_id uuid null,
  created_by_agent_id uuid null,
  created_from_run_id uuid null,

  validation_result jsonb not null default '{}',

  created_at timestamptz not null default now(),

  unique(app_id, version),
  unique(tenant_id, app_id, content_hash)
)
```

**Artifact path javaslat:**

```text
sandbox-apps/{tenantId}/{appId}/versions/{version}/index.html
```

### 3.4 `policy` mező A0-ban

Az MVP-ben a policy deklaratív, de erősen korlátozott:

```json
{
  "level": "A0",
  "network": "none",
  "connectors": [],
  "secrets": "none",
  "dataAccess": "embedded_only",
  "requiresApprovalToActivate": false,
  "maxArtifactSizeBytes": 1048576
}
```

MVP validáció:

- `network` csak `none` lehet.
- `connectors` csak üres tömb lehet.
- `secrets` csak `none` lehet.
- `dataAccess` csak `embedded_only` lehet.
- `maxArtifactSizeBytes` alapérték 1 MB, tenantonként konfigurálható felső plafonnal.

---

## 4. API specifikáció

### 4.1 `createSandboxApp`

```ts
createSandboxApp(input: {
  name: string;
  description?: string;
  sandboxId?: string;
  criticality?: "L0" | "L1";
  createdFromTicketId?: string;
  createdFromConversationId?: string;
  tags?: string[];
}): {
  appId: string;
  status: "draft";
}
```

**Jogosultság:** `operator+` vagy agent Tool Broker capability.

**Validáció:**

- `name`: 3-80 karakter.
- `description`: max. 1000 karakter.
- `criticality`: MVP-ben csak `L0` vagy `L1`.
- `createdFromTicketId` esetén a ticket tenantja egyezzen.
- `createdFromConversationId` esetén a conversation tenantja egyezzen.

**Audit:** `sandbox_app.create`.

### 4.2 `upsertSandboxAppVersion`

```ts
upsertSandboxAppVersion(input: {
  appId: string;
  html: string;
  changeSummary: string;
  activate?: boolean;
  createdFromRunId?: string;
}): {
  versionId: string;
  version: number;
  contentHash: string;
  validationResult: ValidationResult;
  status: "draft" | "active";
}
```

**Jogosultság:** `operator+` vagy agent Tool Broker capability.

**Szerveroldali lépések:**

1. Tenant és app hozzáférés ellenőrzése.
2. Méretlimit ellenőrzése UTF-8 byte alapján.
3. HTML validáció és biztonsági lint futtatása.
4. SHA-256 hash számítása a normalizálás utáni tartalomra.
5. Új immutable artefakt mentése.
6. Új verziószám kiosztása tranzakcióban.
7. Ha `activate=true`, aktív verzió átállítása.
8. Audit esemény írása.

**Audit:** `sandbox_app.version.create`, opcionálisan `sandbox_app.version.activate`.

### 4.3 `listSandboxApps`

```ts
listSandboxApps(input: {
  sandboxId?: string;
  status?: "draft" | "active" | "archived" | "blocked";
  search?: string;
  limit?: number;
  cursor?: string;
}): {
  apps: Array<{
    appId: string;
    name: string;
    description?: string;
    status: string;
    level: "A0";
    type: "single_html";
    activeVersion?: number;
    contentHash?: string;
    createdByLabel: string;
    updatedAt: string;
  }>;
  nextCursor?: string;
}
```

**Jogosultság:** `viewer+`.

### 4.4 `getSandboxApp`

```ts
getSandboxApp(input: {
  appId: string;
}): {
  app: SandboxApp;
  versions: SandboxAppVersionSummary[];
}
```

**Jogosultság:** `viewer+`.

### 4.5 `getSandboxAppPreviewUrl`

```ts
getSandboxAppPreviewUrl(input: {
  appId: string;
  version?: number;
}): {
  previewUrl: string;
  contentHash: string;
  expiresAt: string;
}
```

**Jogosultság:** `viewer+`.

**Elv:** a preview URL rövid életű, aláírt tokennel működik, de nem hordoz platform sessiont. A token csak `tenantId + appId + version + contentHash` kombinációra érvényes.

**Audit:** `sandbox_app.preview`.

### 4.6 `activateSandboxAppVersion`

```ts
activateSandboxAppVersion(input: {
  appId: string;
  version: number;
  reason?: string;
}): {
  appId: string;
  activeVersion: number;
}
```

**Jogosultság:** `operator+`.

**MVP szabály:** `L0-L1` app aktiválható egyszerű operator aktussal. `L2-L3` a későbbi A2-A3 szintekhez tartozik, ott approval gate kell.

**Audit:** `sandbox_app.version.activate`.

### 4.7 `exportSandboxApp`

```ts
exportSandboxApp(input: {
  appId: string;
  version?: number;
}): {
  filename: string;
  contentRef: string;
  contentHash: string;
  sizeBytes: number;
}
```

**Jogosultság:** `operator+`.

**MVP export:** `.html` letöltés. A letöltéskor a UI mutassa a `contentHash` értéket.

**Audit:** `sandbox_app.export`.

---

## 5. Tool Broker toolok az agent felé

Az MVP-ben az App Registry működhet csak UI/API alapon is. Ha az agent általi létrehozás belefér, a toolok a Tool Brokeren keresztül érhetők el.

### 5.1 Capability névkonvenció

```text
sandbox_app.create
sandbox_app.update_artifact
sandbox_app.preview
sandbox_app.export
```

Minden capability agent-verzióhoz kötött, deny-by-default módon.

### 5.2 `sandbox_app.create`

```json
{
  "name": "Wiki riport",
  "description": "Önálló HTML riport a belső tudásbázis pilot eredményeiről",
  "criticality": "L1",
  "createdFromTicketId": "..."
}
```

Válasz:

```json
{
  "appId": "...",
  "status": "draft"
}
```

### 5.3 `sandbox_app.update_artifact`

```json
{
  "appId": "...",
  "html": "<!doctype html>...",
  "changeSummary": "Első önálló riportnézet létrehozása",
  "activate": true
}
```

Válasz:

```json
{
  "versionId": "...",
  "version": 1,
  "contentHash": "sha256:...",
  "validationResult": {
    "status": "passed",
    "warnings": []
  }
}
```

### 5.4 `sandbox_app.preview`

```json
{
  "appId": "...",
  "version": 1
}
```

Válasz:

```json
{
  "previewUrl": "https://preview.example/sandbox-apps/...",
  "contentHash": "sha256:...",
  "expiresAt": "2026-06-27T12:00:00Z"
}
```

### 5.5 `sandbox_app.export`

```json
{
  "appId": "...",
  "version": 1
}
```

Válasz:

```json
{
  "filename": "wiki-riport-v1.html",
  "contentRef": "...",
  "contentHash": "sha256:...",
  "sizeBytes": 123456
}
```

### 5.6 Agent-specifikus tiltások

Az agent toolon keresztül:

- nem kérhet `A1-A3` app szintet;
- nem kapcsolhat be hálózatot;
- nem adhat meg connector listát;
- nem állíthat magasabb criticality-t `L1` fölé;
- nem írhat felül meglévő verziót;
- nem törölhet auditot vagy artefaktot;
- nem exportálhat automatikusan felhasználói megerősítés nélkül, ha tenant policy ezt tiltja.

---

## 6. Preview és biztonsági modell

### 6.1 Kiszolgálási modell

A preview ne a Control Plane domainről fusson.

Javaslat:

```text
Control Plane: https://app.platform.example
Preview:       https://sandbox-preview.platform.example
```

A preview domain:

- ne kapjon platform auth cookie-t;
- ne használjon wildcard cookie scope-ot;
- ne férjen hozzá localStorage-ban tárolt platform tokenhez;
- csak aláírt, rövid életű preview token alapján szolgáljon ki artefaktot.

### 6.2 Iframe beállítás

```html
<iframe
  src="https://sandbox-preview.platform.example/p/{token}"
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
></iframe>
```

Tilos:

- `allow-same-origin`;
- `allow-forms`;
- `allow-popups`;
- `allow-top-navigation`;
- `allow-downloads` preview módban.

### 6.3 CSP

A0 preview minimum CSP:

```http
Content-Security-Policy:
  default-src 'none';
  script-src 'unsafe-inline';
  style-src 'unsafe-inline';
  img-src data: blob:;
  font-src data:;
  connect-src 'none';
  object-src 'none';
  frame-ancestors https://app.platform.example;
  base-uri 'none';
  form-action 'none';
```

Megjegyzés: A0 single-file HTML miatt inline script és style engedélyezett, de hálózat, objektum, form és platform API hívás nincs. Későbbi A1-A3 szinteknél nonce/hash alapú CSP és build pipeline javasolt.

### 6.4 HTML validáció

Szerveroldali validáció minimum:

- max. méret ellenőrzés;
- `<!doctype html>` ajánlott, de nem kötelező;
- `<script src=...>` warning vagy hard fail tenant policy szerint;
- `<iframe>`, `<object>`, `<embed>` hard fail;
- `<form>` hard fail MVP-ben;
- `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource` warning; CSP úgyis blokkolja, de review-hoz jelezni kell;
- `document.cookie` warning;
- `localStorage` / `sessionStorage` warning;
- `window.top` / `parent.postMessage` warning vagy hard fail policy szerint.

### 6.5 Tartalom és PII

Az App Registry nem PII-detektor elsődleges helye. Ha a HTML-be személyes adat kerül, az ugyanúgy sandbox-munkaadatnak számít, mint egy generált riport. Ennek következménye:

- tenant és sandbox izoláció kötelező;
- export audit kötelező;
- retention és törlési policy a sandbox adattárolási policy része;
- offboarding esetén app artefaktok törlésének is része kell legyen a tenant purge folyamatnak.

---

## 7. UI követelmények

### 7.1 App Registry lista

Megjelenítendő mezők:

- app neve;
- rövid leírás;
- státusz;
- aktív verzió;
- létrehozó: user / agent;
- eredet: ticket vagy conversation link, ha van;
- utolsó módosítás ideje;
- content hash rövidített formában;
- export állapot / utolsó export ideje, ha van.

### 7.2 App részletező oldal

Szükséges részek:

- metaadatok;
- aktív verzió jelölése;
- verziólista;
- change summary;
- validation warningok;
- preview;
- export gomb;
- rollback / aktiválás régi verzióra;
- audit link az app eseményeire.

### 7.3 Preview UX

A preview körül jelenjen meg:

- app név és verzió;
- hash;
- izolációs állapot: "sandbox preview, nincs hálózat / nincs platform API";
- export gomb külön felhasználói aktusként.

Ne legyen a preview olyan, mintha éles, platformon belüli natív modul lenne. Az A0 app scratchpad-output, nem production app.

### 7.4 Export UX

Export előtt rövid megerősítés:

```text
Ez egy letölthető HTML fájl. A platformon belül izoláltan futott; letöltés után a saját gépen/környezetben ugyanúgy kezelendő, mint bármely HTML fájl.
```

A letöltés után mutatni kell:

- fájlnév;
- verzió;
- content hash;
- export időpont;
- exportáló user.

---

## 8. Audit és observability

### 8.1 Audit események

```text
sandbox_app.create
sandbox_app.version.create
sandbox_app.version.activate
sandbox_app.preview
sandbox_app.export
sandbox_app.archive
sandbox_app.block
sandbox_app.access_denied
sandbox_app.validation_failed
```

### 8.2 Audit payload minimum

```json
{
  "tenant_id": "...",
  "app_id": "...",
  "version": 1,
  "content_hash": "sha256:...",
  "actor_type": "user|agent|system",
  "actor_id": "...",
  "created_from_ticket_id": "...",
  "created_from_conversation_id": "...",
  "criticality": "L1",
  "artifact_size_bytes": 123456,
  "policy": {
    "level": "A0",
    "network": "none",
    "connectors": []
  }
}
```

HTML tartalmat audit logba írni tilos. Csak referencia, hash és metaadat kerülhet be.

### 8.3 Metrikák

- appok száma tenantonként;
- verziók száma apponként;
- preview megnyitások száma;
- exportok száma;
- validációs hibák száma;
- access denied események száma;
- átlagos artefakt méret;
- agent által létrehozott vs. ember által létrehozott appok aránya.

---

## 9. Implementációs terv

### F-AR-1 - Adatmodell és service alap

- `sandbox_apps` tábla.
- `sandbox_app_versions` tábla.
- enumok / konstansok.
- `AppRegistryService`.
- artifact store adapter.
- audit események.

**Kipróbálható, ha:** API-ból létrehozható app és verzió, a hash determinisztikus, a DB-ben nincs HTML content, csak artifact reference.

### F-AR-2 - Preview service és izoláció

- külön preview origin / route;
- aláírt preview token;
- CSP header;
- iframe integráció;
- cross-tenant tiltás.

**Kipróbálható, ha:** egy HTML app preview-ban fut, de `fetch`, külső script, form submit és platform cookie hozzáférés nem működik.

### F-AR-3 - UI registry és verziókezelés

- app lista;
- app részletező;
- preview panel;
- verziólista;
- aktiválás / rollback;
- validation warningok.

**Kipróbálható, ha:** user létrehozott appot lát, verziót vált, preview-t nyit és régi verzióra rollbackel.

### F-AR-4 - Export

- `.html` letöltés;
- hash megjelenítés;
- export audit;
- export megerősítő UX.

**Kipróbálható, ha:** letöltött HTML hash-e egyezik a registryben tárolt hash-sel.

### F-AR-5 - Tool Broker integráció

- `sandbox_app.create`;
- `sandbox_app.update_artifact`;
- `sandbox_app.preview`;
- `sandbox_app.export`;
- capability seed;
- acceptance scenario agent által generált A0 riporttal.

**Kipróbálható, ha:** agent létrehoz egy HTML riport appot, preview URL-t kap, és minden tool-hívás auditban megjelenik.

---

## 10. Elfogadási kritériumok

### 10.1 Funkcionális

| ID | Kritérium |
|---|---|
| AR1 | Operator létrehoz egy A0 `single_html` appot névvel és leírással. |
| AR2 | Operator vagy agent új HTML verziót ment, a rendszer verziószámot és SHA-256 hash-t ad. |
| AR3 | Régi verzió immutable marad; módosítás csak új verzióval történhet. |
| AR4 | Aktív verzió átállítható korábbi verzióra. |
| AR5 | Preview iframe-ben megnyílik a külön preview originről. |
| AR6 | Export `.html` fájlt ad, és a letöltött tartalom hash-e egyezik a registry hash-sel. |
| AR7 | App lista és részletező mutatja az aktív verziót, létrehozót, eredet-ticketet/conversationt és hash-t. |
| AR8 | Minden create / version / activate / preview / export esemény auditban van. |
| AR9 | Agent csak capability birtokában hívhat `sandbox_app.*` toolt. |
| AR10 | HTML tartalom nem kerül audit logba. |

### 10.2 Kötelező negatív tesztek

| ID | Teszt | Elvárt eredmény |
|---|---|---|
| N1 | Más tenant app preview URL-je | `APP_NOT_FOUND_OR_FORBIDDEN` + `sandbox_app.access_denied` audit |
| N2 | HTML méretlimit felett | `APP_ARTIFACT_TOO_LARGE` + nincs verzió |
| N3 | `<object>` vagy `<embed>` a HTML-ben | `APP_VALIDATION_FAILED` |
| N4 | Preview HTML `fetch("https://example.com")` | CSP blokkolja |
| N5 | Preview HTML platform API-t hív | CSP / origin izoláció blokkolja |
| N6 | Preview iframe `document.cookie` olvasás | nincs platform cookie |
| N7 | Agent capability nélkül appot hozna létre | `TOOL_NOT_AUTHORIZED` |
| N8 | Agent `A2` vagy connector policyt kér | `POLICY_NOT_ALLOWED_FOR_A0` |
| N9 | Export nem létező verzióra | `APP_VERSION_NOT_FOUND` |
| N10 | Audit payload HTML tartalmat tartalmazna | teszt bukjon, payload sanitization kötelező |

---

## 11. Roadmap A1-A3 irányba

### A1 - Static app bundle

- többfájlos build artefakt;
- statikus asset storage;
- manifest;
- zip export;
- szigorúbb CSP hash/nonce alapon;
- dependency allowlist.

### A2 - Sandbox data app

- app-saját schema;
- sandbox adat snapshot;
- read/write sandbox data API;
- adatváltozás audit;
- schema + data export.

### A3 - Integrated app

- Tool Broker connector használat;
- App Policy jóváhagyás;
- operation criticality L2-L3;
- human approval gate;
- graduation package;
- ügyfélkörnyezetbe telepítési csomag.

---

## 12. Nyitott döntések

1. **Artifact store:** az MVP-ben object storage legyen-e, vagy DB blob kis méretre? Javaslat: object storage, mert a későbbi A1 bundle-höz ez skálázódik természetesen.
2. **Preview origin:** külön aldomain elegendő-e, vagy külön service / project kell banki pilotnál? MVP-ben külön aldomain, banki környezetben külön service javasolt.
3. **HTML validator szigor:** `fetch` / `localStorage` warning vagy hard fail legyen? Javaslat: MVP-ben warning + CSP hard block; banki presetben hard fail.
4. **Export approval:** L0-L1 esetén operator export elég-e? Javaslat: igen. L2-L3 szinteknél később approval gate.
5. **Retention:** app artefaktok retentionje a ticket retentiont vagy sandbox retentiont kövesse? Javaslat: sandbox retention, mert az app önálló sandbox-erőforrás.

