# Feature-spec — Tool Broker (eszköz-/MCP-átjáró + connector registry)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-07-01
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, 3.2.1, 4.8.4, 4.9.1–4.9.4, 4.12, 4.12.1, 4.13, 4.14, 8.2, 8.5, 8.8), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (2.2, 2.3, 4.6 `connectors`/`agent_connectors`/`capabilities`, 4.7 `tool_calls`, 4.8 audit, 5.5 Tool Broker, 5.9 connector-réteg, 9.2 N2/N6/N7, 10. security baseline, D2/D4)
**Olvasó:** fejlesztő(k), architect, product owner. Feltételezi az Agent Registry, IAM/RBAC, audit log (hash-láncolt), dispatcher és a Goose-harness extension-rétegének alapmodell-ismeretét.
**Státusz:** implementálva — önálló feature-spec. A Broker egy központi `AllowlistAuthorizer` mögött, `service` / `user_delegated` / `agent_owned` auth-mód horoggal, connector lifecycle-kapuval, tenant-izolációval, secret-alias szerveroldali feloldással, MCP bridge-dzsel, `tool_calls` + hash-láncolt audit bejegyzéssel és negatív governance-tesztekkel védi az eszközhívásokat. A Tool Broker a Model Gateway (`AI-Agent-Platform-Feature-Spec-ModelGateway.md`) **tükörképe**; a két dokumentum szándékosan szimmetrikus.

---

## 0. Mit ad ez a dokumentum

Ez a specifikáció meghatározza a **Tool Broker** belső felépítését és szerződéseit: hogyan ér el a Goose-harness (és minden más hívó) **eszközöket, MCP-szervereket és connectorokat egyetlen, szerveroldali, naplózott átjárón** keresztül úgy, hogy az agent **soha nem birtokol nyers kredenciált**, **csak az explicit engedélyezett eszközöket** éri el, és minden hívás **attribútálható, policy-ellenőrzött és auditálható**.

A koncepció lényege (4.8.4):

- a Goose minden eszköze egy MCP-extension, de ezek **mind a Tool Broker MCP-végpontjára** mutatnak, nem közvetlen szerverekre — a Goose natív MCP-támogatása változtatás nélkül használható, a kontroll a brokerben marad;
- az eszközjog **deny-by-default** (8.2): az agent csak azokat a tool-okat/connectorokat hívhatja, amelyekre **explicit `capability`/`agent_connectors` joga van**;
- a connector-kredenciál **alias mögött**, Secret Managerben él; a broker **futásidőben, szerveroldalon injektálja** — a harness és a modell sosem látja, ezért prompt injectionnel nem csalható ki (4.9.2);
- minden hívás `tool_calls` + `audit_log` (`tool.call` / `tool.call.denied`) bejegyzést ír;
- a háttérrendszer protokollja (REST/SOAP/MQ/DB/fájl/MCP) a connector mögött rejtve marad; az agent egységes MCP-interfészt lát (4.12), ezért a rendszercsere nem írja át az agentet.

Ez a feature a **Model Gateway tükörképe**: a Model Gateway a **modellhívásokat** brokerálja, a Tool Broker az **eszköz-/MCP-/connector-hívásokat**. Ketten együtt adják a termék fő differenciátorát (a „két átjáró" elv, 2.2).

| Elem | Mit brokerál | Kemény kapu |
|---|---|---|
| **Model Gateway** (4.7) | LLM „gondolkodási" hívások (prompt → válasz) | routing + guardrail + költségkeret, szerveroldalon |
| **Tool Broker** (4.8.4) | Eszköz-/MCP-/connector-hívások (fájl, web, DB, e-mail) | `authorize()` capability deny-by-default + secret-injektálás + napló |
| **Ticket-állapotgép** (4.2) | Folyamatkapuk, human-in-the-loop | állapotátmenetek, jóváhagyás |

---

## 1. Scope

### 1.1 In scope — MVP-mag

- Egyetlen MCP-proxy/gateway HTTP-(MCP-)végpont, amelyre a Goose extension-konfigurációja köt.
- `Authorizer.authorize(agentId, tool, args)` deny-by-default policy-döntési pont — egyetlen impl: **`AllowlistAuthorizer`** (`capabilities` + `agent_connectors` táblák szerveroldali ellenőrzése).
- `ToolBroker.invoke()` domain-interfész és MCP-tool-dispatch.
- Két MVP-eszköz: **`kb_search`** (wiki-retrieval a tudásbázis-connectoron át) és **`board_write`** (ticket-frissítés a board-connectoron át).
- Connector mint **first-class, verziózott, scope-olt, many-to-many** erőforrás (`connectors`, `agent_connectors`); MVP-ben `auth_mode = service`.
- **Secret-injektálás** alias mögött, szerveroldalon, a hívás pillanatában (Secret Manager); a nyers secret sosem promptban/runtime-ban/logban.
- Minden hívásra `tool_calls` napló + `audit_log` (`tool.call` / `tool.call.denied`) agent-attribútálással (`agentId`, `agentVersion`), ticket **vagy** beszélgetés (`conversationId`) kontextusban.
- Egységes hibakezelés és státusz-leképzés (engedélyezett / megtagadott / hiba).

### 1.2 In scope — Fázis 2 (címkézve, nem MVP-gate)

- **Per-user (delegált) connector-hozzáférés (4.12.1):** `auth_mode = user_delegated` + `connector_grants` entitás; kétrétegű `authorize()` (agent-capability **és** acting-user grant); `(acting_user, connector)` alapú secret-feloldás; explicit „run-as" felhatalmazás autonóm futásnál.
- **Policy-as-code** csere: az `Authorizer` mögött `AllowlistAuthorizer` → OPA/Cedar (ABAC), kódváltás nélkül (4.13).
- **Rate-limit / budget / finomszemcsés kill-switch (4.9.4, 8.8):** eszköz-szintű korlát és **azonnali revoke** incidens esetén (connector vagy grant szinten).
- **Protokoll-adapterek (4.12):** REST/SOAP/MQ (Kafka)/fájl (S3/SFTP)/DB connector-adapterek azonos MCP-interfész mögött; további MVP-n túli eszközök (`email_read`, `db_query`, …).
- **Kimenet-/művelet-validáció (guardrail):** connector-szintű séma- és policy-ellenőrzés a visszatérő adaton, redakció.
- **Connector-katalógus / import-export:** újrahasznosítható connector-IP hordozható csomagként, write-gate-elt megosztott-erőforrás-változással (4.9.3).

### 1.3 Out of scope — most nem

- Modellhívás-brokerelés (a Model Gateway felelőssége, 4.7).
- Embedding-/vektorkereső szolgáltatás futtatása (a `kb_search` MVP-ben kulcsszavas/teljes beinjektálás; a hibrid retrieval külön komponens, 4.6.2).
- A connectorhoz tartozó háttérrendszer üzemeltetése (a Broker proxyz, nem hostol).
- Memória-írás (azt a write-gate végzi, 4.6.1/5.8 — a Brokeren át írni a tartós tudást tilos, lásd 2. invariáns).
- Sandbox-app deploy / graduation (App Registry felelőssége).

### 1.4 Feature-szintű döntés

A Tool Broker **Control Plane komponens** (saját Cloud Run service), nem Sandbox artefakt és nem a harness része. Ennek oka:

- a connector-kredenciál bizalmi elem, amely sosem kerülhet a harnessbe vagy a promptba (4.9.2);
- az eszközjog-kikényszerítés governance-döntés (mit hívhat ez az agent-verzió), ezért szerveroldali (8.2);
- minden eszközhívás auditforrás — a „milyen adathoz fért hozzá, milyen műveletet tett" sztori innen jön (8.3, 8.5);
- a per-user delegálás (4.12.1) és a kill-switch (4.9.4) szabályozói/biztonsági elvárás lehet (bank/PSP).

---

## 2. Fő invariánsok

Ezeket **kódszinten** kell védeni, nem UI-szinten.

1. Az agent (és a Goose-harness) **csak a Tool Broker MCP-végpontját** látja; közvetlen connectorhoz/internethez nem mehet (deny-by-default egress, koncepció 3.2.1, roadmap 5.6/N4).
2. Eszközhívás **deny-by-default**: ha az `(agent, tool)`/`(agent, connector)` nincs explicit engedélyezve (`capabilities` / `agent_connectors`), a hívás **blokk** + `tool.call.denied` audit — az állapot nem változik (N2).
3. A connector-kredenciál (`secret_alias` → Secret Manager) **sosem** jelenik meg promptban, runtime-ban, logban vagy a `tool_calls.args_meta`-ban; csak referencia/metaadat. A broker a hívás pillanatában, szerveroldalon injektálja.
4. Minden **sikeres és sikertelen** hívás pontosan egy `tool_calls` sort **és** egy `audit_log` bejegyzést ír (`tool.call` vagy `tool.call.denied`), agent-verzió-attribútálással.
5. Nyers eszköz-argumentum vagy eredmény-tartalom **nem** kerül az `audit_log` payloadjába (csak `args_meta` / `result_meta` metaadat) — content/metadata szétválasztás (koncepció 6., roadmap 4.8).
6. Az `authorize()` döntés **determinisztikus és szerveroldali**; nem LLM és nem a Goose belső `GOOSE_MODE` dönt róla (utóbbi csak puha, defense-in-depth réteg, koncepció 3.2.1).
7. A hívás **attribútált**: `agentId` + `agentVersion` minden bejegyzésben szerepel, ticket **vagy** `conversationId` kontextusban (ticket nélküli beszélgetésnél is teljes az audit, N7).
8. **A `capabilities` / `agent_connectors` sorokat kizárólag admin-aktus** írhatja az Agent Registryn keresztül; az önfejlesztési/tanítási útvonal **soha** nem bővítheti az agent eszközjogát (kemény padló, OWASP LLM06, N6).
9. A Broker **nem írhatja** az agent tartós memóriáját (`memory_versions`); tudás-beemelés kizárólag a write-gate-en át (4.6.1) — a Brokeren át írni a tartós tudást tilos.
10. Cross-tenant connector, kredenciál, grant vagy napló elérése **tiltott**; a tenant-határ az agent (koncepció 8.8).
11. **Fázis 2 invariáns (per-user):** `user_delegated` connectornál a hívás csak akkor mehet, ha **mind** az agent-capability **mind** az acting-user érvényes (`active`) grantje teljesül; a token `(acting_user, connector)` kulcson oldódik fel, és autonóm futásnál csak explicit, tárolt „run-as" felhatalmazással használható (4.12.1) — sosem implicit öröklés.

---

## 3. Adatmodell

### 3.1 Meglévő táblák használata

A Broker a roadmap meglévő tábláit használja változatlanul.

**`tool_calls`** (4.7 — Tool Broker napló):
```
tool_calls
  id, ticket_id (fk, nullable), conversation_id (fk conversations, nullable)
  agent_id (fk), agent_version (int)
  tool (text), args_meta (jsonb)        -- argumentum-METAADAT, NEM nyers secret/tartalom
  result_meta (jsonb), authorized (bool), denied_reason (text, nullable)
  latency_ms (int), created_at
```

**`connectors`** (4.6 — first-class erőforrás):
```
connectors
  id, type (enum: knowledge_base | board | ...), name
  scope (enum: global | single), secret_alias (text, nullable)
  version (int), config (jsonb), tenant_id, created_at
```

**`agent_connectors`** (4.6 — many-to-many, access-mode):
```
agent_connectors
  agent_id (fk), connector_id (fk), access_mode (enum: read | write)   -- pk(agent_id, connector_id)
```

**`capabilities`** (4.6 — deny-by-default eszközjog):
```
capabilities
  agent_id (fk), tool_name (text), allowed (bool)                      -- pk(agent_id, tool_name)
```

Audit: minden hívás a meglévő hash-láncolt `audit_log`-ba ír `AuditService.append()`-en át, `type = tool.call` (engedélyezett, lefutott) vagy `type = tool.call.denied` (capability/grant/scope elutasítás). A payload csak metaadat (tool, connector-id, access-mode, `args_meta`, `result_meta`, `authorized`, `denied_reason`) — soha nem nyers secret/tartalom (5. invariáns).

### 3.2 Új mező a connectoron — `auth_mode` [Fázis 2, séma-horog MVP-ben]

A koncepció 4.12.1 szerinti kredenciál-tulajdonlási dimenzió. **MVP-ben olcsó séma-horog** (most-migráció elkerülése), default `service`:

```
connectors
  + auth_mode (enum: service | user_delegated | agent_owned, default service)
```

| `auth_mode` | Kihez tartozik a kredenciál | Feloldás | Fázis |
|---|---|---|---|
| `service` | a connectorhoz — közös titok | 1 `secret_alias` (4.9.2) | **MVP** |
| `user_delegated` | az **éppen belépett felhasználóhoz** | per-user `connector_grants` + token-ref | Fázis 2 |
| `agent_owned` | egy konkrét agent dedikált fiókja | privát `secret_alias` | Fázis 2 |

### 3.3 Új entitás — `connector_grants` [Fázis 2]

A per-user (delegált) felhatalmazás (4.12.1). A connector marad a *definíció* (control plane, tenant-szint); a grant a *konkrét felhasználói felhatalmazás*:

```
connector_grants
  id, tenant_id (uuid)
  connector_id (fk connectors)      -- melyik rendszer (pl. "gmail")
  user_id (fk users)                -- KI adta a hozzáférést (az ő fiókja)
  status (enum: active | revoked | expired)
  scopes (jsonb)                    -- amit ténylegesen engedélyezett
  token_ref (text)                  -- Secret Manager refresh-token referencia (user/connector kulcson); SOHA promptban/logban
  granted_at, expires_at (nullable), revoked_at (nullable)
  -- egyediség: (tenant_id, connector_id, user_id) aktív granten
```

> A nyers token **sosem** a connectoron, sosem promptban/memóriában/logban — a 4.9.2 elv `(user, connector)` kulcson injektálva. A token-vault az `Authorizer`/connector-interfész mögött **cserepont** (4.13): self-hostolt „connected accounts" réteggel kiváltható, de a séma, a kétrétegű `authorize()` és az acting-user-feloldás a miénk marad.

### 3.4 „Run-as" felhatalmazás autonóm futáshoz [Fázis 2]

Scheduled task / proaktív monitor / orchestrator→worker delegálásnál nincs élő felhasználó (4.12.1). A per-user grant ilyenkor **kizárólag explicit, tárolt, visszavonható „run-as" felhatalmazással** használható, a scheduled taskra / Playbookra kötve:

```
run_as_grants
  id, tenant_id, user_id (fk -- kinek a nevében), connector_id (fk)
  bound_to_type (enum: scheduled_task | playbook), bound_to_id
  status (enum: active | revoked), created_at, revoked_at (nullable)
```

---

## 4. Interfész-szerződés

A standard API-válasz: `{ success: boolean, data?, error? }`. A Goose felé a Broker **MCP-tool-kontraktusokat** exponál; a domain-réteg felé thin interfész.

### 4.1 Authorizer (cserepont — 4.13)

```
Authorizer.authorize(agentId, tool, args, ctx) -> { allowed: boolean, reason? }
  -- MVP: AllowlistAuthorizer (capabilities + agent_connectors)
  -- Fázis 2: OPA/Cedar policy-as-code; user_delegated esetén kétrétegű (lásd 5.3)
  -- ctx = { agentVersion, ticketId?, conversationId?, actingUserId?, tenantId }
```

### 4.2 ToolBroker (domain + MCP-dispatch)

```
ToolBroker.invoke({ agentId, agentVersion, tenantId, ticketId?, conversationId?, actingUserId?, tool, args })
  -> { result, resultMeta, latencyMs }            -- engedélyezett és lefutott
  -> { denied: true, reason }                     -- nem engedélyezett (audit-flag, állapot nem változik)
```

**Belépési minta (kötelező, minden hívásra):** `auth-check (agent-key/scope) → Zod-validáció (tool + args) → authorize() → secret-injektálás → connector-dispatch → tool_calls + audit`.

### 4.3 MVP eszköz-kontraktusok (MCP-tool)

```
kb_search(query: string, k?: int)
  -> { hits: [{ docId, snippet, sourceRef, memoryVersion }] }
  -- a tudásbázis-connectoron át (access_mode: read); a beolvasott memória-verziót naplózza

board_write(ticketId: string, patch: { state?, payload? })
  -> { ok: boolean }
  -- a board-connectoron át (access_mode: write); scope-ellenőrzött; az állapotgépet NEM kerülheti meg:
  --   állapot-átmenetet csak a ticket-állapotgép szerveroldali szabálya enged (5.1), a board_write
  --   tiltott átmenetet nem írhat (egyezik a koncepció 4.10.4 kemény-kapu elvvel)
```

### 4.4 Fázis 2 eszköz-kontraktusok (példa)

```
email_read(query, max?)        -- user_delegated Gmail/M365 connector; acting-user grant kötelező
db_query(connectorId, sql)     -- service-connector; read-only scope; param-binding kötelező
```

---

## 5. Belső feldolgozási sorrend (request lifecycle)

### 5.1 Engedélyezett (`service`-mode, MVP)

```
GOOSE (extension) ── MCP-hívás ──► TOOL BROKER
                                     │
                                     │ 1. agent-key + scope ellenőrzés (agent_api_keys.scopes)
                                     │ 2. Zod-validáció: ismert tool? args séma-helyes?
                                     │ 3. 🔒 authorize(agentId, tool, args):
                                     │      - capabilities[(agent, tool)].allowed == true ?
                                     │      - agent_connectors[(agent, connector)].access_mode elég ?
                                     │      - tenant-egyezés ?
                                     │      → nem? { denied, reason } + audit(tool.call.denied) → STOP
                                     │ 4. 🔒 secret-feloldás: connector.secret_alias → Secret Manager
                                     │      (szerveroldalon, csak most; a nyers érték nem lép ki)
                                     │ 5. connector-dispatch (protokoll-adapter: REST/DB/…)
                                     │ 6. result → resultMeta (metaadat, nem nyers tartalom az auditba)
                                     │ 7. tool_calls INSERT + audit(tool.call) [authorized=true]
                                     ▼
                              CONNECTOR (KB / board / …)
```

### 5.2 Megtagadott

`authorize()` false → `{ denied, reason }`, `tool_calls` sor (`authorized=false`, `denied_reason`), `audit_log` (`tool.call.denied`). Az eszköz **nem fut le**, secret **nem oldódik fel**, a connectorhoz hívás **nem megy**.

### 5.3 Kétrétegű engedély (`user_delegated`, Fázis 2)

```
... 3. 🔒 authorize() RÉTEG A — agent-jog:
       "használhat-e az agent EGYÁLTALÁN ilyen connectort?" (capabilities/agent_connectors, 8.2)
   3b. 🔒 authorize() RÉTEG B — felhasználói felhatalmazás:
       acting_user-nek van-e érvényes (active) connector_grant-je erre a connectorra?
       (autonóm futásnál: van-e a taskhoz/Playbookhoz kötött run_as_grant?)
   4.  🔒 secret-feloldás (acting_user, connector) kulcson:
       grant.token_ref → access-token frissítés szerveroldalon → injektálás
```

Mindkét rétegnek teljesülnie kell — tisztán szétválasztja az *agent-jogot* a *felhasználói felhatalmazástól* (4.12.1). Audit: `tool.call` payload tartalmazza az `actingUserId`-t és a használt grant referenciáját; a grant életciklusa (engedélyezés/frissítés/visszavonás/lejárat) önálló auditesemény.

---

## 6. Connector registry — életciklus

| Művelet | Ki | Megjegyzés |
|---|---|---|
| `createConnector({ type, name, scope, authMode, config, secretAlias? })` | admin | first-class erőforrás; secret csak alias |
| `assignConnector({ agentId, connectorId, accessMode })` | admin | `agent_connectors` sor — **csak admin-aktus** (8. invariáns) |
| `setCapability({ agentId, toolName, allowed })` | admin | `capabilities` sor — **csak admin-aktus** |
| `versionConnector({ connectorId, config })` | admin | verziózott; megosztott connector változása sok agentre hat → write-gate-elt jóváhagyás (4.9.3) |
| `rotateSecret({ connectorId })` | admin | alias mögötti érték rotációja; futó hívás nem érinti |
| `revokeConnector({ agentId, connectorId })` | admin | finomszemcsés kill-switch (4.9.4): csak ezt a hozzáférést veszi el |
| `grantUserConnector({ connectorId, userId, scopes })` *(Fázis 2)* | a felhasználó maga (OAuth-consent) | `connector_grants` sor; a felhasználó **csak a saját fiókját** kötheti |
| `revokeGrant({ grantId })` *(Fázis 2)* | a felhasználó vagy admin | a grant `revoked`, token törölve |

> **Hol él (4.12):** a connector *definíciója és jogosultsága* a control plane-ben (governance, audit); a tényleges *adatforgalom* az execution plane-ben (data plane). Ugyanaz a kontroll/adat szétválasztás, mint a 6. fejezetben.
> **Offboarding/GDPR (4.12.1):** `suspended` felhasználó → grantjei automatikusan `revoked`, tokenek törölve; a grant személyes adat, retenció/törlés rá is vonatkozik.

---

## 7. Hibakezelés és státusz-leképzés

| Eset | `tool_calls.authorized` | Audit-típus | Goose felé |
|---|---|---|---|
| Engedélyezett, lefutott | `true` | `tool.call` | `{ result, resultMeta }` |
| Ismeretlen/nem engedélyezett tool | `false` | `tool.call.denied` | `{ denied, reason: "capability" }` |
| Hiányzó/elégtelen connector-access | `false` | `tool.call.denied` | `{ denied, reason: "connector_access" }` |
| Acting-user grant hiányzik *(Fázis 2)* | `false` | `tool.call.denied` | `{ denied, reason: "no_user_grant" }` |
| Connector/háttérrendszer hiba | `true` (engedélyezve volt) | `tool.call` (`result_meta.error`) | `{ error }` |
| Rate-limit túllépés *(Fázis 2)* | `false` | `tool.call.denied` | `{ denied, reason: "rate_limited" }` |
| Cross-tenant kísérlet | `false` | `tool.call.denied` | `{ denied, reason: "tenant_isolation" }` |

A megtagadás **nem hiba** a hívó felé abban az értelemben, hogy determinisztikus, naplózott governance-döntés; a Goose `GOOSE_MODE` puha rétege ettől függetlenül létezik, de nem ez a garancia (3.2.1).

---

## 8. Biztonsági követelmények

- **Secret:** soha promptban/runtime-ban/logban; `secret_alias` + szerveroldali injektálás a hívás pillanatában; GCP Secret Manager (roadmap 10.). A `tool_calls.args_meta` csak metaadat, nem nyers érték.
- **Egress:** a Broker mögötti connector-hálózat allowlistezett; a harness-konténer deny-by-default csak a Gateway + Broker felé (N4).
- **Deny-by-default eszközjog:** `authorize()` minden hívásra; explicit engedély nélkül blokk (N2).
- **Kemény padló (önfejlesztés):** `capabilities`/`agent_connectors` írás kizárólag admin; önmódosítással az agent nem bővítheti a jogát (N6, `training.capability_escalation_denied`).
- **Kapu-leválasztás a tickettől:** az `authorize()` szerveroldali és **nem a ticket meglététől** függ; beszélgetésből (ticket nélkül) kért jogosulatlan eszköz is blokk (N7).
- **Audit:** append-only, hash-láncolt; `UPDATE/DELETE` megvonva; `verifyChain()`.
- **Kill-switch (4.9.4, 8.8):** connector- vagy grant-szintű azonnali revoke; agent-szintű `setAgentStatus(suspended)`.
- **Prompt injection:** a connectorból visszatérő dokumentum-/web-tartalom **adat, nem utasítás**; a secret nem csalható ki, mert a modell nem látja.
- **Tenant-izoláció:** minden connector/grant/napló `tenant_id`-scope-olt; cross-tenant elérés `tool.call.denied`.

---

## 9. Megfigyelhetőség (observability)

| Dimenzió | MVP-metrika | Forrás |
|---|---|---|
| Eszközhasználat | hívásszám tool/connector/agent szerint | `tool_calls` |
| Engedélyezési arány | denied / összes hívás; denied-ok ok szerint | `tool_calls.authorized`, `denied_reason` |
| Latency | per-tool p50/p95 broker-overhead + connector-latency | `tool_calls.latency_ms` |
| Hibaarány | connector-oldali hibák aránya | `result_meta.error` |
| Governance-bizonyíték | minden hívás auditban, hash-lánc ép | `audit_log`, `verifyChain()` |
| Grant-életciklus *(Fázis 2)* | grant engedélyezés/visszavonás/lejárat | grant-auditesemények |

---

## 10. Tesztek és elfogadási kritériumok

**Pozitív:**

- `kb_search` egy jogosult agenttel a wiki-connectoron át fut, a találatok `sourceRef` + `memoryVersion` naplózva.
- `board_write` a board-connectoron át frissít egy tickettet, de **tiltott állapot-átmenetet nem** ír (az állapotgép elutasít).
- A connector definíciója a control plane-ben, a forgalom a data plane-ben; az agent **csak** a jogosult connectort éri el (5.9).

**Kötelező negatív tesztek (governance-bizonyítékok, roadmap 9.2):**

| # | Teszt | Elvárt eredmény |
|---|---|---|
| **N2** | Agent egy nem engedélyezett toolt hív | Tool Broker blokk + `tool.call.denied` audit-flag; secret nem oldódik fel |
| **N4** | Goose-konténer közvetlen internet/rendszer-elérés kísérlete (a Brokert megkerülve) | Egress blokk; a kísérlet nem jut ki |
| **N6** *(CR-MVP-002)* | Agent önmódosítással (tanítási úton) megpróbálja bővíteni a `capabilities`/connector-jogát | Az írás **blokk**; a jogosultság nem változik; `training.capability_escalation_denied` audit |
| **N7** *(CR-MVP-003)* | Beszélgetésben (ticket nélkül) kért jogosulatlan/rendszerbe-író eszköz | `authorize()` **ugyanúgy elsül**, mint ticketből; a ticket hiánya nem megkerülési út; auditba kerül |
| **TB-1** *(secret)* | Bármely lefutott vagy megtagadott hívás után a `secret_alias` mögötti nyers érték keresése promptban/runtime-ban/logban | Sehol nem jelenik meg; csak alias/metaadat |
| **TB-2** *(tenant)* | Tenant A agentje tenant B connectorát/grantjét hívja | `tool.call.denied` (`tenant_isolation`) |
| **TB-3** *(Fázis 2, per-user)* | `user_delegated` connector hívása érvényes agent-capability-vel, de **acting-user grant nélkül** | Blokk (`no_user_grant`); a másik felhasználó fiókja nem érhető el |
| **TB-4** *(Fázis 2, run-as)* | Scheduled task per-user connectort hív explicit `run_as_grant` nélkül | Blokk; az implicit öröklés tiltott (4.12.1) |

**Kipróbálható, ha:** nem engedélyezett tool hívása blokk + audit-flag; a secret sehol nem szivárog; a connector csak a jogosult agentnek elérhető; a hash-lánc minden tool-hívás után ép.

---

## 11. Függőségek és illesztés

- **Agent Registry (4.5):** `capabilities` / `agent_connectors` / `agent_api_keys.scopes` forrása; agent-verzió-attribútálás.
- **IAM/RBAC (5.2):** az `assignConnector`/`setCapability` admin-aktus; az acting-user identitás a session/beszélgetés-rétegből (4.14) jön.
- **Model Gateway (4.7):** szimmetrikus átjáró; a harness a Brokerre az extension-rétegen, a Gateway-re a provider-rétegen kötve.
- **Harness — Goose (5.6):** a Goose extension-konfigurációja a Broker MCP-végpontjára mutat; developer-extension lezárva, csak a Broker látható.
- **Audit log (4.8):** `AuditService.append()`, hash-láncolt; `tool.call` / `tool.call.denied`.
- **Beszélgetés/session (4.14):** `conversationId` + `actingUserId` a ticket nélküli attribútáláshoz.
- **Secret Manager (D4):** alias-feloldás; per-user token-vault (Fázis 2) cserepont mögött (4.13).

---

## 12. Megvalósítási sorrend (javaslat)

1. **MCP-proxy váz + `Authorizer` interfész** (`AllowlistAuthorizer`) — deny-by-default; `tool_calls` + audit minden hívásra. *(Roadmap S3 spike: Goose extension → Broker; `authorize()` deny működik; secret nem szivárog.)*
2. **`kb_search` + wiki-connector** — read-mode, `memoryVersion` naplózás.
3. **`board_write` + board-connector** — write-mode, állapotgép-kompatibilis (tiltott átmenet nem írható).
4. **Secret-injektálás (`service`-mode)** Secret Managerből, szerveroldalon; TB-1/TB-2 negatív tesztek.
5. **N2/N4/N6/N7 negatív tesztek** zöld — governance-bizonyíték.
6. *(Fázis 2)* `auth_mode` + `connector_grants` + kétrétegű `authorize()` + per-user OAuth-bróker + `run_as_grants`; TB-3/TB-4.
7. *(Fázis 2)* `Authorizer` → OPA/Cedar csere; rate-limit/kill-switch; protokoll-adapterek.

---

## 13. Nyitott kérdések

- **Rate-limit granularitás:** per-agent, per-connector, per-tenant, vagy kombinált? (MVP-ben elég a dispatcher budget-cap, de a Fázis 2 eszköz-szintű limit helye itt van.)
- **`board_write` és az állapotgép határa:** mennyit írhat a `board_write` a `payload`-ba közvetlenül vs. mennyi megy kötelezően az állapotgép-átmeneten? (Javaslat: payload-tartalom igen, állapot-átmenet kizárólag a `transitionTicket`-en.)
- **Per-user token frissítési hibák kezelése (Fázis 2):** lejárt refresh-token → automatikus re-consent kérés a felhasználótól, vagy csendes `expired` grant + ticket?
- **Megosztott connector-verzióváltás jóváhagyási útvonala:** ugyanaz a write-gate-mechanizmus, mint a memóriáé (4.6.1), vagy könnyebb admin-approval elég? (4.9.3 nagy hatókörű változás → jóváhagyás-köteles.)
- **`AllowlistAuthorizer` → OPA/Cedar trigger:** melyik konkrét ügyfél-/skála-jel indítja a policy-as-code cserét (4.13)?
