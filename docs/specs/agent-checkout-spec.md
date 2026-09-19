# Feature-spec — Agent checkout (MCP → helyi harness-vetület)

**Verzió:** 1.0
**Dátum:** 2026-09-19
**Státusz:** grill-lezárt — fejlesztésre kész
**GitHub issue:** [#564](https://github.com/giretg/enterprise-ai-agent-platform/issues/564) — kanonikus hely
**Forrás:** grill-me (Q1–Q7)
**Célközönség:** product, platform-admin, security, fejlesztők

## 0. Vezetői döntés

A platform nem futtat modellt. A Codex / Claude Code / Goose a runtime; az MCP a kormányzás (definíció, tool, credential, audit). Ma a `platform.agent.get_definition` JSON-t ad — a harness ettől még nem veszi fel a munkakört.

**Checkout:** egy published agent definition **vetülete** a harness natív instruction-felületére (`AGENTS.md`). Nem lokális példány, nem másolat, nem installer.

A lemezen lévő fájlok cache. Eszköz, tudástár, projektmemória, jóváhagyás, sandbox, titok: MCP. Ha a pin elavult, a generált fájlokat felülírjuk.

Az MCP nem ír a user gépére. A tool visszaad egy fájlfát + írásreceptet; a kliens (Codex/Claude/Goose) írja ki.

## 1. Lezárt döntések

| # | Döntés |
|---|---|
| D1 | Dedikált workspace. Nem a céges kódrepó overlay-e. |
| D2 | Egy mappa = egy published agent. Több agent = több workspace. |
| D3 | v1 kliensek: Claude Code, Codex, Goose. Grok és későbbi kliensek adapterrel. |
| D4 | Instrukció-skill mehet lokális `SKILL.md` cache. **Futtatható kód soha nem kerül a workspace-be.** Sandbox (ha lesz) `skillVersionId`-t vár, soha nem helyi feltöltést. |
| D5 | v1 egy kanonikus `AGENTS.md` + `.enterprise-agent/manifest.json`. Nincs Claude/Codex/Goose/Grok klón. |
| D6 | v1 nem ír natív MCP-konfigot. Az `AGENTS.md` tartalmazza a tenant MCP URL-t. |
| D7 | A manifest felsorolja a generált path-okat. Újra-checkout csak azokat írja felül / takarítja. Emberi fájl békén marad. Az `AGENTS.md` generált: helyi munkakör-átírás a következő sync-kor elveszik. A munkakör a Control Plane-en változik. |

## 2. Scope

### 2.1 In — v1

- Új MCP tool: `platform.agent.checkout`.
- Tiszta renderer: published snapshot → fájllista. Nincs I/O a user gépére.
- Generált fa: `AGENTS.md`, manifest, instrukció-only `SKILL.md`.
- Pin: `agentId`, `definitionId`, `version`, `contentHash`.
- Stale szabály az `AGENTS.md`-ben: munka előtt `get_definition`; hash eltér → checkout újra, csak a generált path-ok.
- Authz = `get_definition` (`canReadPublishedAgent`). Csak MCP-n elérhető agent (`isAvailableOnMcp`).
- Skill-verzió = a snapshotba pinelt `skillVersionId`, nem a live assign.

### 2.2 Out — v1

- Fájlíró MCP, installer plugin, háttér-sync, push a nyitott sessionbe.
- Natív kliens-konfig (`.mcp.json`, Goose extension, Codex `config.toml`).
- Harness-adapter fájlok (`CLAUDE.md` klón, Goose recipe). A `harness` input v1-ben reserved, ignorált, a manifestbe beírható.
- Skill-melléklet, kód-bundle, sandbox-futtatás, memória-vetület.
- Overlay egy product gitre.
- Több agent egy workspace-ben.

## 3. Ami már megvan

| Elem | Hol | Checkout szerepe |
|---|---|---|
| Published snapshot | `domain/agent-definition` | SoT: `roleInstruction`, skill pinek, connectorok, capability-k, `contentHash` |
| `get_definition` / lista / authz | `auth/mcp-server.ts`, `canReadPublishedAgent`, `isAvailableOnMcp` | Ugyanaz a kapu; checkout nem új ACL |
| `SKILL.md` export | `lib/skill/skill-md-export.ts` `serializeSkillMd` | Instrukció-cache |
| Kód-kiterjesztés tiltás | `lib/skill/skill-package-adapter.ts` `CODE_EXTENSIONS` | A renderer kimenete **nem** lehet ezeken |
| Skill-tartalom | `SkillRepository.listEnabledForAgent` + verzió a snapshot `skillVersionId`-jén | Snapshot pin, nem live enabled-lista |
| Tool-audit | `mcp.tools.call` | Új action típus nem kell |

A snapshot skilljei csak `{ skillId, skillVersionId, name }`. A renderer a pinelt verzió `content`/`requires`/`description` mezőiből serializál. Hiányzó verzió: kihagyás + `warnings[]`, nem „latest” fallback.

## 4. Interfész

Név: `platform.agent.checkout`. Felkerül `MCP_ALLOWED_TOOLS`-ra és a `tools/call` allow-listre. `tools/list` továbbra sem security boundary.

### 4.1 Input

```ts
{
  agentId: string // uuid, kötelező
  version?: number // pozitív int; hiányában a current published
  harness?: 'claude' | 'codex' | 'goose' | 'grok' // v1: stored, ignored
}
```

Nincs `definitionId` külön: a version + agentId elég, mint `get_definition`-nál. Extra JSON mezők ignoráltak (tenant a URL-ből jön).

### 4.2 Output

Egyetlen JSON, `text` contentként (a többi platform tool mintája):

```ts
{
  suggestedRoot: string // pl. "Agents/drive-asszisztens" — relatív, home-alapú javaslat
  mcpUrl: string        // {origin}/api/mcp/{tenantSlug}
  pin: {
    agentId: string
    definitionId: string
    version: number
    contentHash: string
    tenantSlug: string
    harness: string | null
  }
  files: Array<{ path: string; content: string }>
  generatedPaths: string[] // files[].path plusz a takarítandó .enterprise-agent/** maradék
  deleteUnder: ['.enterprise-agent'] // csak ezen belül törölhető az, ami nincs generatedPaths-ban
  warnings: string[]
  writeRecipe: string // a tool description rövid, checkolható lépései
}
```

`files[].path` mindig relatív, `/`-es, `..` nélkül, nem abszolút. Engedélyezett kiterjesztés: `.md`, `.json`. A renderer fail-closed, ha bármely path `CODE_EXTENSIONS`-be esne vagy `..`-t tartalmazna.

### 4.3 Tool description = írásrecept

Ez az interfész része, nem komment. A kliens ezt követi. Teljesítési feltétel minden lépés végén:

1. Hozd létre a `suggestedRoot` mappát a user home (vagy a user által megadott) alatt, ha nincs.
2. Írd ki `files[]` minden elemét `root/path` alá, UTF-8, felülírva.
3. A `.enterprise-agent/` alatt töröld a fájlt, ami nincs a `generatedPaths`-ban. `AGENTS.md`-t csak akkor bántsd, ha a `files[]` tartalmazza (mindig tartalmazza).
4. Ne törölj, ne írjj semmit a `generatedPaths` + `deleteUnder` kontraktuson kívül. `NOTES.md` és minden emberi fájl marad.
5. Kész, ha minden `files[]` path a lemezen byte-egyező, és `.enterprise-agent/`-ben nincs extra generált fájl.

Ne futtass kódot a checkoutból. Ne commitolj. Ne másold a mappát egy kódrepóba.

### 4.4 Hibák

Ugyanaz a takarás, mint `get_definition`: nem található / nincs jog → `definitionNotFound` alak (nincs existence leak). Nem MCP-elérhető agent (nincs current version, nem `active`) → ugyanaz. Érvénytelen uuid/version → validációs hiba, nem 500.

## 5. Generált fa

```
{suggestedRoot}/
  AGENTS.md
  .enterprise-agent/
    manifest.json
    skills/{skillSlug}/SKILL.md
```

`suggestedRoot` slug: agent `name` → lowercase, `[a-z0-9]+` szegmensek kötőjellel, max 60 karakter, üres esetén `agent`. Ütköző skill-nevek: `{slug}--{skillId 8 hex}`.

`skillSlug` a skill `name`-ből, ugyanazzal a szabállyal. A mappa csak `SKILL.md`-t tartalmaz v1-ben.

### 5.1 `manifest.json`

```json
{
  "kind": "enterprise-agent-checkout",
  "schemaVersion": 1,
  "pin": { "agentId": "…", "definitionId": "…", "version": 3, "contentHash": "…", "tenantSlug": "acme" },
  "mcpUrl": "https://…/api/mcp/acme",
  "generatedPaths": ["AGENTS.md", ".enterprise-agent/manifest.json", ".enterprise-agent/skills/drive-search/SKILL.md"],
  "skills": [{ "skillId": "…", "skillVersionId": "…", "name": "drive-search", "path": ".enterprise-agent/skills/drive-search/SKILL.md" }]
}
```

A `contentHash` a **definition snapshot** hash-e (`hashSnapshot`), nem a kirenderelt fájloké. Stale = a live `get_definition.snapshot` hash ≠ pin.

## 6. `AGENTS.md` szerződés

Rövid, mindig-töltött. A skilltörzs nem ide kerül — pointer a helyi `SKILL.md`-re, triggerrel.

Kötött sorrend:

1. **Pin** (egy blokk, gépnek és embernek): agent név, `agentId`, version, `contentHash`, `mcpUrl`.
2. **Szerep:** a published `roleInstruction` változatlanul. Itt nincs parafrázis.
3. **MCP-routing** (pozitív standing rule, nem tiltólista-regény):
   - Erőforrás, connector, enterprise tool: hívd az MCP toolt. Credential a szerveren marad.
   - Írás (pl. Drive mappa) enqueue + Control Plane jóváhagyás; ne kerüld meg.
   - Projektmemória / tudástár, ha van: MCP. Ne hozz létre lokális memóriafájlt.
   - Skill-kód / sandbox: ha a munka futtatható kódot igényel, MCP sandbox a `skillVersionId`-vel. Ne futtass skill-kódot a workspace-ből, és ne tölts helyi fájlt sandboxba. (v1-ben a sandbox tool még nincs — a mondat akkor is bent van, hogy a későbbi T2 ne a lemezre tanítsa a klienst.)
4. **Stale:** munka elején `platform.agent.get_definition` ugyanarra az `agentId`-re. Ha `contentHash` ≠ pin → `platform.agent.checkout`, írd felül a generált path-okat, kész ha a pin egyezik.
5. **Skillek:** soronként egy pointer. Leading word = skill név. Branch = a `description` / trigger. Cél = `.enterprise-agent/skills/{slug}/SKILL.md`.

A renderer nem told bele extra stílust, disclaimer-regényt, vagy a snapshotban nem szereplő toolnevet. A capability-lista nem másolja a teljes allow-listet az `AGENTS.md`-be: a kemény kapu a szerver `authorizeToolCall`. Az `AGENTS.md` csak annyit mond: a munkakör tooljai az MCP-n vannak, a Drive-ot (ha a snapshotban van) név szerint említheti.

## 7. Renderer

Egy tiszta függvény, MCP-től függetlenül tesztelhető:

```ts
renderAgentCheckout(input: {
  definition: AgentDefinition
  skills: Array<{ skillId: string; skillVersionId: string; name: string; displayName?: string | null; description: string; license?: string | null; content: SkillContent; requires: SkillRequirement[] }>
  mcpUrl: string
  harness?: string | null
}): CheckoutBundle
```

- `roleInstruction` → `AGENTS.md` szerep-szekció.
- Minden skill → `serializeSkillMd(...)`. Attachments kihagyva.
- Path-őr: relatív, nincs `..`, kiterjesztés ∈ `{md,json}`.
- `warnings`: hiányzó skill-verzió, üres `roleInstruction`, skill névütközés.

Nem hív modellt. Nem nyúl connector-titokhoz. A snapshotban lévő connector/capability csak a routing-mondatokhoz kell, ha egyáltalán — v1 elég az általános MCP-routing + a snapshot `capabilities[].toolName` felsorolása egy rövid „elérhető MCP toolok” listában, **engedélyt nem ad**.

## 8. Authz, audit, titok

- Olvasás: `canReadPublishedAgent` + tenant-egyezés + `isAvailableOnMcp`. `view` elég (a checkout cache, a tool-hívás külön `canOperateAgent`).
- Audit: meglévő `mcp.tools.call` (`agentId` a metadata-ban, ha a többi tool mintája engedi). Új `CORE_MVP_AUDIT_ACTIONS` elem nem kell.
- Credential, token, `tokenRef`, Clerk id nem kerülhet a `files[]`-be. A snapshot már tilos ilyet hordozni; a renderer nem bővíti.

## 9. Szinkron

Nincs külön tool. A checkout idempotens: ugyanaz a pin → ugyanaz a `files[]` (kanonikus path-ok, determinista skill-sorrend: `skillId` localeCompare).

Élő session push nincs. A nyitott Codex-ablak a következő stale-checkig a régi `AGENTS.md`-t viszi — elfogadott v1 reziduum.

## 10. Munkacsomagok

| WP | Mi | Hol |
|---|---|---|
| WP-1 | `renderAgentCheckout` + path/slug/kiterjesztés-őr + `serializeSkillMd` reuse | `app/src/lib/agent-checkout.ts` (vagy `domain/agent-definition` mellé, ha a hash/snapshot importja tisztább) |
| WP-2 | Teszt: pin, skill pin vs live, hiányzó verzió warning, `..` / `.py` elutasítás, determinista files[], AGENTS.md tartalmazza a `roleInstruction`t és az MCP URL-t | `app/scripts/agent-checkout.test.ts` |
| WP-3 | MCP bekötés: konstans, allow-list, `registerTool`, `tools/call` ág, skill-verziók betöltése a snapshot pinjein | `mcp-principal.ts`, `mcp-server.ts` |
| WP-4 | `docs/architecture.md` allow-list sor bővítése; MCP runbook egy checkout-lépéssel | docs |

Sorrend: WP-1+2 zöld, aztán WP-3. A renderer a mély modul: a szerver csak betölti a snapshotot és a pinelt skilleket.

## 11. Elfogadás

1. Operator Codex/Claude/Goose-ból, már csatlakozott MCP-vel: `platform.agents.list` → `platform.agent.checkout`.
2. A kliens kiírja a fát. `AGENTS.md` a published `roleInstruction`-t tartalmazza, pin + `mcpUrl` benne van.
3. Új session ugyanabban a mappában a szerepet követi, enterprise toolt MCP-n hív (Drive seed agenten: search/read).
4. Control Plane: instruction publish → új `contentHash`. Következő checkout (vagy a stale-szabály) felülírja az `AGENTS.md`-t; egy mellétett `NOTES.md` megmarad.
5. Negatív: más tenant agentId → not found. `.py` path a rendererben lehetetlen (teszt). Nem aktív / unpublished agent → not found.

Nem acceptance: natív MCP-konfig a mappában, élő push, sandbox, memória.

## 12. Később (nem v1)

- Harness-adapter: `CLAUDE.md` egy-soros pointer, Goose recipe, Grok, `.mcp.json`.
- Overlay mode: checkout egy meglévő git gyökerébe.
- `platform.agent.load_skill` MCP-n, ha a helyi `SKILL.md` cache-t el akarjuk hagyni.
- Sandbox tool: bemenet `skillVersionId` (+ opcionális args). Tilos: fájl-upload a workspace-ből.
- Projektmemória MCP toolok: az `AGENTS.md` routing-mondata már kész rájuk.

## 13. Grill-nyom

| Q | Válasz |
|---|---|
| Q1 Hol landol? | A — dedikált workspace |
| Q2 Egy mappa = ? | egy agent |
| Q3 Kliensek | Claude, Codex, Goose most; Grok később adapterrel |
| Q4 Skillek | instrukció cache igen; kód soha; sandbox = `skillVersionId` |
| Q5 Csomagolás | kanonikus `AGENTS.md` + manifest |
| Q6 MCP-konfig a mappában? | nem v1 |
| Q7 Fájl-tulajdon | generált path-ok a manifestben; AGENTS.md generált |
