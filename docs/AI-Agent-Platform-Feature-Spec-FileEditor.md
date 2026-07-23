# Feature-spec — Agent File Editor (fájlkezelés és szerkesztés)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-18
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11), `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md` (v1.0)
**Olvasó:** fejlesztő(k). Feltételezi a platform-mcp-bridge, Tool Broker és goose-config architektúra ismeretét.
**Státusz:** **Fázis 3 — teljes MVP** (2026-06-18). Az alábbi „Implementációs állapot” szekció naprakész.

---

## Implementációs állapot (2026-06-18)

**Összefoglaló:** Az agent file editor MVP funkcionalitása kész: Tool Broker + MCP bridge + stub/GCS storage + Control Plane UI + acceptance `scenarioFileEditor` (szöveges, bináris, kvóta, pre-signed URL stub, W7 upload→read) + Playwright E2E UI teszt.

### Fázisok

| Fázis | Leírás | Állapot |
|---|---|---|
| **F3-A** | Connector + workspace infrastruktúra | ✅ Kész (`findWorkspaceConnector`, pre-signed URL, retention purge) |
| **F3-B** | 7 szöveges file tool | ✅ Kész + `scenarioFileEditor` acceptance (`file_delete` ✅) |
| **F3-C** | Bináris adapterek (xlsx, docx, pdf) | ✅ Kész; acceptance: xlsx ✅, docx ✅, pdf ✅, `xlsx_append_rows` ✅ |
| **F3-D** | Control Plane „Fájlok” panel | ✅ Kész (drag & drop, pre-signed letöltés, audit meta oszlop) |

### Elfogadási kritériumok (§7)

| ID | Kritérium | Állapot |
|---|---|---|
| W1 | `file_write` → `file_read` → `file_edit` egy ticketen | ✅ acceptance |
| W2 | `../` path traversal → `PATH_TRAVERSAL` | ✅ acceptance |
| W3 | Ticket A nem éri el Ticket B workspace-ét | ✅ acceptance (ticket prefix izoláció) |
| W4 | Audit: path + meta, tartalom nélkül | ✅ acceptance |
| W5 | `file_edit` egyedi csere / hiba kétértelmű esetben | ✅ acceptance |
| W6 | `file_glob` / `file_search` csak saját workspace | ✅ acceptance |
| W7 | UI feltöltés → agent `file_read` | ✅ acceptance + Playwright E2E |
| W8 | Lezárt ticketen letöltés UI-ból | ✅ pre-signed URL (`?signed=1`) |
| W9 | xlsx read → write_cells → helyes fájl | ✅ acceptance (stub storage) |
| W10 | 50 MB feletti írás → `FILE_TOO_LARGE` | ✅ acceptance |

### Még hiányzik / eltér a spec-től

_Az MVP file editor scope teljes — nincs nyitott gap a spec szerint._

### Érintett fájlok (implementálva)

- `app/prisma/schema.prisma` — `ConnectorType.workspace`, `ConnectorAuthMode.agent_owned`
- `app/prisma/seed.ts` — workspace connector + 12 file tool capability
- `app/src/domain/file-editor/` — `workspace-storage.ts`, `file-editor-service.ts`, adapterek
- `app/src/domain/tool-broker/tool-broker-service.ts` — file tool ág, audit meta
- `app/src/harness/platform-mcp-bridge.ts`, `goose-config.ts`
- `app/src/app/api/v1/tickets/[id]/workspace/files/route.ts`
- `app/src/components/tickets/ticket-files-panel.tsx` + ticket detail page bekötés
- `app/src/repositories/postgres/connector-repository.ts` — `findWorkspaceConnector(tenantId)`
- `app/src/domain/file-editor/workspace-lifecycle-service.ts` — retention purge + tenant GDPR purge
- `app/src/components/iam/workspace-offboarding-panel.tsx` — GDPR tenant workspace purge UI (IAM)
- `app/infra/gcp/WORKSPACE-GCS-SETUP.md` — bucket + lifecycle rule dokumentáció
- `app/e2e/file-editor-ui.spec.ts` — Playwright W7 UI teszt

---

## 0. Mit ad ez a dokumentum

Meghatározza, hogyan kap az agent **általános célú fájlkezelési képességet** — fájlok olvasása, szerkesztése, létrehozása és listázása — ugyanazon a Tool Broker + platform-mcp-bridge architektúrán belül, amelyen a Gmail connector is alapul. A cél: az agent ugyanolyan precízen tudjon fájlokkal dolgozni, mint a Claude Code (Read / Edit / Write / Glob / Grep), anélkül hogy a Goose `developer` extensionje be lenne kapcsolva.

**Első célterület:** szöveges fájlok (txt, csv, json, yaml, md, kód). Második lépés: strukturált bináris formátumok (xlsx, docx, pdf) — ugyanarra a connector infrastruktúrára épülve.

---

## 1. Scope

### 1.1 In scope

- `workspace` connector bevezetése (`auth_mode: agent_owned`, storage: GCS per-ticket prefix).
- 7 alap file tool a Tool Brokerben + platform-mcp-bridge-ben:
  `file_read`, `file_write`, `file_edit`, `file_list`, `file_glob`, `file_search`, `file_delete`.
- Workspace lifecycle: ticket indításkor létrejön, ticket záráskor archiválható / letölthetővé válik.
- Fájlfeltöltés / letöltés a Control Plane UI-ból (fel: ticket előtt vagy közben; le: ticket után).
- Path sandboxing: az agent nem léphet ki a saját workspace-éből.
- Audit: minden file_* művelet rögzítve a hash-chained audit logban.
- Bináris formátumok (xlsx, docx, pdf) — strukturált JSON adapter rétegen keresztül (F3-C).

### 1.2 Out of scope (most nem)

- Valós idejű kollaboráció (több agent egy ticketen belül párhuzamosan ír ugyanabba a fájlba).
- Verziókövetés (git integration) a workspace-en belül — külön feature.
- Fájlmegosztás ticketek között (minden ticket izolált workspace).
- 50 MB-nál nagyobb fájlok streaming olvasása.

---

## 2. Architektúra

### 2.1 Illeszkedés a meglévő rendszerbe

```
GOOSE
  └─ MCP tool call (stdio): file_read, file_edit, xlsx_read_sheet, …
       ↓
platform-mcp-bridge  [src/harness/platform-mcp-bridge.ts]
  └─ invokePlatformToolViaHttp()
       ↓
Control Plane API: POST /api/v1/agent/tools
  └─ Tool Broker  [src/domain/tool-broker/tool-broker-service.ts]
       ├─ capability check (agent allowlist)
       ├─ workspace connector resolve: auth_mode = agent_owned
       │    → GCS service account (platform-managed, nem user OAuth)
       ├─ path sandbox validate
       ├─ FileEditorService  [src/domain/file-editor/file-editor-service.ts]  ← ÚJ
       │    ├─ szöveges toolok: GCS GET/PUT via @google-cloud/storage
       │    └─ bináris toolok: exceljs / mammoth / pdf-parse
       └─ audit log: tool.call + { tool, path, acting_agent_id, ticket_id }
```

A Goose **csak az MCP tool nevét és argumentumait** látja. A workspace GCS path-ját, a service account credentialt, a tenant_id-t — mindegyiket a Tool Broker injektálja szerver oldalon.

### 2.2 Workspace storage

| Réteg | Megvalósítás |
|---|---|
| Tárolás | Google Cloud Storage bucket: `platform-workspace-{env}` |
| Prefix séma | `{tenantId}/{ticketId}/` |
| Hozzáférés | Platform service account (nem user OAuth) — Tool Broker injektálja |
| Lifetime | Ticket nyitva: R/W; ticket closed: read-only + configurable retention |
| Max méret | 50 MB per fájl, 500 MB per workspace (enforced Tool Broker szinten) |

### 2.3 Connector record (DB)

```sql
-- Egy tenant-szintű "workspace" connector; auth_mode = agent_owned
INSERT INTO connectors (id, tenant_id, type, auth_mode, name, config, secret_alias)
VALUES (
  uuid,
  '{tenantId}',
  'workspace',
  'agent_owned',
  'Agent Workspace',
  '{ "bucket": "platform-workspace-prod", "retentionDays": 30 }',
  'platform/gcs-service-account'   -- Secret Manager; Tool Broker olvassa
);
```

`agent_owned` = nincs user-szintű grant; a credential a platform service accounté; az agent az aktuális `ticketId`-hez tartozó prefixet kapja.

---

## 3. Tool definíciók

### 3.1 platform-mcp-bridge.ts bővítése

Az alábbi toolok kerülnek a `PLATFORM_BROKER_TOOLS` tömbbe (a `GMAIL_TOOLS` mintájára `FILE_TOOLS` konstansként):

```typescript
const FILE_TOOLS = [
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_glob',
  'file_search',
  'file_delete',
] as const
```

### 3.2 Tool kontraktusok

#### `file_read`
```json
{
  "name": "file_read",
  "description": "Read a file from the ticket workspace. Returns content with line numbers (cat -n format). Use offset + limit for large files.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":   { "type": "string", "description": "Relative path within workspace, e.g. 'data/report.csv'" },
      "offset": { "type": "number", "description": "Start from this line number (1-based, default 1)" },
      "limit":  { "type": "number", "description": "Max lines to return (default 2000)" }
    },
    "required": ["path"]
  }
}
```

**Visszatérési érték:**
```json
{
  "path": "data/report.csv",
  "totalLines": 142,
  "content": "     1\tNév,Összeg,Dátum\n     2\tKovács Bt.,15000,2026-06-01\n…"
}
```

---

#### `file_write`
```json
{
  "name": "file_write",
  "description": "Write (overwrite or create) a file in the ticket workspace. For edits to existing files prefer file_edit — it is safer and uses less tokens.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":    { "type": "string", "description": "Relative path within workspace" },
      "content": { "type": "string", "description": "Full file content to write" }
    },
    "required": ["path", "content"]
  }
}
```

---

#### `file_edit`
```json
{
  "name": "file_edit",
  "description": "Replace an exact string in a file. old_string must be unique in the file — provide enough surrounding context if needed. Fails if old_string is not found or appears more than once (use replace_all: true for intentional bulk replace).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":        { "type": "string" },
      "old_string":  { "type": "string", "description": "Exact text to find and replace" },
      "new_string":  { "type": "string", "description": "Replacement text" },
      "replace_all": { "type": "boolean", "description": "Replace every occurrence (default false)" }
    },
    "required": ["path", "old_string", "new_string"]
  }
}
```

**Hibák:**
- `FILE_NOT_FOUND` — a fájl nem létezik a workspace-ben
- `STRING_NOT_FOUND` — `old_string` nem található
- `AMBIGUOUS_MATCH` — `old_string` több helyen szerepel és `replace_all` nem true

---

#### `file_list`
```json
{
  "name": "file_list",
  "description": "List files and directories in a workspace path.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":      { "type": "string", "description": "Directory path (default: workspace root)" },
      "recursive": { "type": "boolean", "description": "List recursively (default false)" }
    }
  }
}
```

---

#### `file_glob`
```json
{
  "name": "file_glob",
  "description": "Find files matching a glob pattern in the workspace. Returns matching paths sorted by last modified.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "Glob pattern, e.g. '**/*.csv' or 'reports/*.xlsx'" }
    },
    "required": ["pattern"]
  }
}
```

---

#### `file_search`
```json
{
  "name": "file_search",
  "description": "Search file contents using a regex pattern (ripgrep-style). Returns matching lines with file path and line number.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern":     { "type": "string", "description": "Regex pattern to search for" },
      "path":        { "type": "string", "description": "Directory or file to search in (default: workspace root)" },
      "glob":        { "type": "string", "description": "Limit to files matching this glob, e.g. '*.csv'" },
      "ignore_case": { "type": "boolean", "description": "Case-insensitive search (default false)" },
      "max_results": { "type": "number", "description": "Max matching lines to return (default 100)" }
    },
    "required": ["pattern"]
  }
}
```

---

#### `file_delete`
```json
{
  "name": "file_delete",
  "description": "Delete a file from the workspace. Irreversible — use with care.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" }
    },
    "required": ["path"]
  }
}
```

---

### 3.3 Bináris formátum toolok (F3-C — második lépés)

```json
[
  {
    "name": "xlsx_read_sheet",
    "description": "Read an Excel worksheet as a JSON array of row objects. Headers from the first row become object keys.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path":       { "type": "string" },
        "sheet":      { "type": "string", "description": "Sheet name (default: first sheet)" },
        "max_rows":   { "type": "number", "description": "Max rows to return (default 500)" }
      },
      "required": ["path"]
    }
  },
  {
    "name": "xlsx_write_cells",
    "description": "Update individual cells in an Excel file. Cell addresses use A1 notation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path":   { "type": "string" },
        "sheet":  { "type": "string" },
        "changes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "cell":  { "type": "string", "description": "e.g. 'B3'" },
              "value": { "description": "string | number | boolean | null" }
            },
            "required": ["cell", "value"]
          }
        }
      },
      "required": ["path", "changes"]
    }
  },
  {
    "name": "xlsx_append_rows",
    "description": "Append rows to an Excel worksheet.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path":  { "type": "string" },
        "sheet": { "type": "string" },
        "rows":  { "type": "array", "items": { "type": "object" }, "description": "Array of row objects matching the header columns" }
      },
      "required": ["path", "rows"]
    }
  },
  {
    "name": "docx_read",
    "description": "Extract text content from a Word document (.docx).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": { "type": "string" }
      },
      "required": ["path"]
    }
  },
  {
    "name": "pdf_read",
    "description": "Extract text content from a PDF file.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path":       { "type": "string" },
        "page_range": { "type": "string", "description": "e.g. '1-5' or '3' (default: all)" }
      },
      "required": ["path"]
    }
  }
]
```

---

## 4. Biztonsági modell

### 4.1 Path sandboxing (kötelező)

Az agent **soha nem léphet ki a saját ticket workspace-éből.** Minden tool-híváskor a Tool Broker elvégzi:

```typescript
function resolveSafePath(workspaceRoot: string, userPath: string): string {
  const resolved = path.resolve(workspaceRoot, userPath)
  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    throw new ToolBrokerError('PATH_TRAVERSAL', `Path escapes workspace: ${userPath}`)
  }
  return resolved
}
```

**Blokolt minták:** `../`, `./../../`, abszolút útvonalak (`/etc/passwd`), symlink traversal.

### 4.2 Méretkorlátok

| Korlát | Érték | Hol enforced |
|---|---|---|
| Max fájl olvasás | 50 MB | FileEditorService |
| Max fájl írás | 50 MB | FileEditorService |
| Max workspace méret | 500 MB | GCS lifecycle rule |
| Max `file_search` találat | 1000 sor | FileEditorService |
| Max `xlsx_read_sheet` sorok | 5000 | xlsx adapter |

### 4.3 Tenant izoláció

A workspace GCS prefix: `{tenantId}/{ticketId}/`. A Tool Broker a `ticketId`-t a harness env-ből veszi (`TICKET_ID`), a `tenantId`-t a ticket DB rekordjából — az agent **nem adhatja meg ezeket paraméterként**. Két tenant workspace-e soha nem fedi át egymást.

### 4.4 Audit

Minden `file_*` és `xlsx_*` tool hívás rögzítve az audit logban:

```json
{
  "event": "tool.call",
  "tool": "file_edit",
  "ticket_id": "...",
  "agent_id": "...",
  "args_meta": { "path": "data/report.csv", "old_string_length": 42 },
  "result_meta": { "success": true, "bytes_written": 187 }
}
```

A fájl tartalma **nem kerül az audit logba** — csak metaadatok.

---

## 5. Workspace lifecycle és UI

### 5.1 Fájlfeltöltés (ticket előtt / közben)

A Control Plane UI-ban a ticket részletes nézetén megjelenik egy **"Fájlok"** panel:
- Drag & drop vagy fájlböngésző feltöltés → `PUT /api/v1/tickets/{id}/workspace/files`
- Az API feltölti a fájlt a GCS workspace prefixbe
- Az agent azonnal elérheti `file_read`-del

### 5.2 Fájl letöltés (ticket után)

- Ticket `closed` állapotba kerülése után a Fájlok panel megmutatja az agent által létrehozott / módosított fájlokat
- `GET /api/v1/tickets/{id}/workspace/files/{path}` → pre-signed GCS URL (15 perc)
- UI: letöltés gomb minden fájlhoz

### 5.3 Workspace törlés

- Alapértelmezett retention: 30 nap ticket lezárása után (konfigurálható connector `config.retentionDays`)
- GDPR törlés: offboarding esetén az összes workspace az érintett tenanthoz azonnal törlődik

---

## 6. Megvalósítási terv

### F3-A — Connector + workspace infrastruktúra ✅ (részleges)

**Érintett fájlok:**
- `prisma/schema.prisma` — `connectors` táblában `type` enum bővítése: `workspace` ✅
- `src/repositories/postgres/connector-repository.ts` — `findWorkspaceConnector(tenantId)` ⬜ (helyette `tool-broker-repository.findConnectorForAgent`)
- `src/domain/file-editor/workspace-storage.ts` ← **ÚJ** — GCS adapter (read, write, list, delete) ✅; pre-signed URL ⬜
- `app/api/v1/tickets/[id]/workspace/files/route.ts` ← **ÚJ** — feltöltés (POST multipart) / listázás / stream letöltés ✅
- `prisma/seed.ts` — workspace connector + agent link + capabilities ✅

**Elfogadási kritérium:** `workspace` connector record létrehozható, a GCS adapter egységtesztelve (stub GCS-szel). ✅

---

### F3-B — Szöveges file toolok a Tool Brokerben ✅

**Érintett fájlok:**
- `src/domain/file-editor/file-editor-service.ts` ← **ÚJ** — tool implementációk ✅
- `src/domain/tool-broker/tool-broker-service.ts` — file tool ág; path sandbox + size limit ✅
- `src/harness/platform-mcp-bridge.ts` — `FILE_TOOLS` + tool definíciók ✅
- `src/harness/goose-config.ts` — `available_tools` bővítés ✅
- `src/lib/validators/actions.ts` — zod schema ✅

**Elfogadási kritérium:** acceptance teszt — `scenarioFileEditor` ✅ (a spec „más ticket → PATH_TRAVERSAL” helyett ténylegesen `FILE_NOT_FOUND` / üres workspace — ticket prefix izoláció).

---

### F3-C — Bináris formátum adapterek ✅ (acceptance részleges)

**Érintett fájlok:**
- `src/domain/file-editor/adapters/xlsx-adapter.ts` ✅
- `src/domain/file-editor/adapters/docx-adapter.ts` ✅
- `src/domain/file-editor/adapters/pdf-adapter.ts` ✅
- `src/domain/file-editor/file-editor-service.ts` — bekötés ✅
- `src/harness/platform-mcp-bridge.ts` — bináris tool definíciók ✅
- `package.json` — `exceljs`, `mammoth`, `pdf-parse` ✅

**Elfogadási kritérium:**
- xlsx read → write_cells → verify ✅ (`scenarioFileEditor`)
- `docx_read` / `pdf_read` mintafájl ⬜
- `xlsx_append_rows` ⬜ acceptance

---

### F3-D — Control Plane UI: Fájlok panel ✅ (részleges)

**Érintett fájlok:**
- `src/components/tickets/ticket-files-panel.tsx` ✅ — feltöltés (file input), fájllista, letöltés
- `src/app/control-plane/tickets/[ticketId]/page.tsx` — panel bekötés ✅
- `src/app/api/v1/tickets/[id]/workspace/files/route.ts` — multipart + list + stream ✅; pre-signed URL ⬜

**Hiányzik:** drag & drop (§5.1), pre-signed letöltés (§5.2).

---

## 7. Elfogadási kritériumok (összesített)

| ID | Kritérium | Állapot |
|---|---|---|
| W1 | Agent fájlt ír (`file_write`), visszaolvassa (`file_read`), szerkeszti (`file_edit`) — egyetlen ticketen belül | ✅ |
| W2 | `../` path traversal kísérlet minden file toolnál `PATH_TRAVERSAL` hibával elutasítva | ✅ |
| W3 | Ticket A agentje nem érheti el Ticket B workspace-ét | ✅ |
| W4 | Minden file tool esemény megjelenik az audit logban (path + metaadat, tartalom nélkül) | ✅ |
| W5 | `file_edit` pontosan egyszer cseréli az `old_string`-et; ha nincs meg vagy kétértelmű → hibát dob | ✅ |
| W6 | `file_glob` és `file_search` csak a ticket workspace-én belüli fájlokat adja vissza | ✅ |
| W7 | Felhasználó fájlt tölt fel a UI-on → agent azonnal eléri `file_read`-del | ✅ acceptance + Playwright E2E |
| W8 | Ticket lezárása után felhasználó letölti az agent által módosított fájlt a UI-ból | ✅ pre-signed URL (`?signed=1`) |
| W9 | xlsx fájl: agent `xlsx_read_sheet`-tel beolvassa, `xlsx_write_cells`-szel módosítja → a letöltött fájl helyes | ✅ |
| W10 | 50 MB-nál nagyobb fájl írási kísérlete `FILE_TOO_LARGE` hibával elutasítva | ✅ |

---

## 8. Nyitott kérdések

| ID | Kérdés | Ajánlás |
|---|---|---|
| D-FE-1 | GCS helyett Supabase Storage vagy S3? | GCS — illeszkedik a meglévő Cloud Run infra-hoz |
| D-FE-2 | `file_delete` kerüljön-e human-in-the-loop kapú mögé? | Nem kötelező MVP-ben; agent capability szinten korlátozható |
| D-FE-3 | Workspace fájlok láthatóak legyenek-e a Control Plane audit UI-ban? | Igen — F3-D részeként |
| D-FE-4 | xlsx íráskor az eredeti formázás (cell color, font) megmaradjon-e? | `exceljs` megtartja; tesztelendő edge case |
