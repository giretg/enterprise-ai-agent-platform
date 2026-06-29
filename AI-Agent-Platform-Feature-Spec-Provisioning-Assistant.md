# Feature-spec — Connector Onboarding / Provisioning Assistant (Admin/Provisioning Agent)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-28
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, 4.5–4.5.1, 4.6.4, 4.8.4, 4.9.2, 4.12–4.12.1, 5.6, 8.2), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (4.6, 5.3, 5.8, 5.11, CR-MVP-002), `AI-Agent-Platform-Feature-Spec-AppRegistry.md`, `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md`
**Olvasó:** fejlesztő(k), architect, product owner. Feltételezi a Control Plane, Tool Broker, connector registry (4.12), capability-modell (8.2), Agent Registry (4.5), write-gate (4.6.1) és audit alapmodell ismeretét.
**Státusz:** tervezet — önálló feature-spec. **Fázis 2** (MVP-n túli), de a séma- és biztonsági határok production-kompatibilisek; az MVP-be csak inert séma-kampó kerül (lásd 3.).

---

## 0. Mit ad ez a dokumentum

Ez a specifikáció meghatározza, hogyan lesz egy **admin által vezérelt provisioning-asszisztensből** olyan agent, amely **felgyorsítja a connectorok (és tágabban: agent-konfigurációk) beállítását** — anélkül, hogy a rendszer privilégium-eszkalációs felületévé válna.

A motiváció gyakorlati: egy új rendszer (pl. CRM) bekötéséhez ma sok manuális munka kell — az API-dokumentációból ki kell olvasni az endpointokat, az auth-módot, a scope-okat, a rate limiteket, majd ezekből connector-konfigurációt kell összeállítani. A provisioning-asszisztens ezt a **fáradságos, hibára hajlamos kézi munkát** veszi le: az admin bedobja az API-dokumentációt, az agent pedig **draft connector-deskriptort** állít elő. A user/admin dolga ezután már csak az, hogy ellenőrizze, a secretet beinjektálja, aktiválja, és a kész connectort **hozzárendelje** a megfelelő agenthez.

A dokumentum központi tervezési döntése: **az asszisztens javaslatot készít, nem hajt végre (propose, not apply).** Az agent soha nem ír éles registry-be, soha nem kezel kredenciált, és soha nem ad/módosít jogosultságot. A connector éles aktiválása és agenthez rendelése **emberi admin-aktus marad** — összhangban a koncepció kemény padlójával (4.6.4, CR-MVP-002): *capability/RBAC-változás csak külön admin-aktus lehet, sosem self-service.*

Ez a feature nem új átjáró és nem új bizalmi réteg. A meglévő connector registry (4.12) és Agent Registry (4.5) köré tesz egy **drafting + validációs + jóváhagyási** munkafolyamatot.

---

## 1. Scope

### 1.1 In scope — a feature teljes megvalósítása (Fázis 2)

- **Provisioning-asszisztens agent** mint konfigurálható, erősen korlátozott szerep az Agent Registryben (4.5).
- **Connector-draft életciklus:** `draft → validated → (admin) activated` állapotok a `connectors` erőforráson, külön draft-rétegen.
- **API-dokumentáció → draft connector-deskriptor** generálás (endpointok, `auth_mode`, scope-ok, rate limit, egress-célhostok, javasolt tool-felület).
- **Determinisztikus policy-validáció** a generált drafton: egress-allowlist, scope-minimalizálás, tiltott művelet-minták — LLM-en kívül, szerveroldali kódban.
- **Admin review + diff-nézet + aktiválás** (négy-szem elv / dual-control banki presetben).
- **Sandbox connection-test** aktiválás előtt, szűk jogú, non-prod tokennel.
- **Tool Broker toolok** az asszisztens felé (`provisioning.*`), kizárólag a draft-rétegre íróan, deny-by-default.
- **Audit** minden draft-, validációs, aktiválási és hozzárendelési eseményre; a forrásdokumentum hash-elve.
- Általánosítás: a draft-modell nem csak connectorra, hanem **más konfig-artefaktokra** is kiterjeszthető (pl. agent-szerep-sablon, Playbook-vázlat) — lásd 13.

### 1.2 Out of scope — most NEM

- **Az agent általi éles connector-aktiválás.** Az aktiválás kizárólag emberi admin-aktus (lásd 3., 6.).
- **Kredenciál-kezelés az agent által.** Az asszisztens secretet nem olvas, nem ír, nem lát; legfeljebb a *helyét* (alias-nevet) javasolja (4.9.2).
- **Capability / `agent_connectors` / RBAC írás az asszisztens által.** Kemény padló (CR-MVP-002).
- **Connector→agent hozzárendelés automatizálása.** Marad emberi aktus (a felhasználó kifejezett igénye is ez).
- **Tetszőleges külső dokumentum-URL behúzása az agent által.** A forrásdokumentumot az admin tölti fel / adja át kontrollált csatornán (lásd 7.1).
- **Nem-HTTP / nem-API connector-típusok** (pl. natív DB-driver) automatikus generálása — később.
- Bármilyen `provisioning.*` képesség az MVP walking skeletonban (az MVP-be csak inert séma-kampó kerül, 3.).

### 1.3 Az MVP-re gyakorolt hatás

**Nincs MVP-scope-bővülés.** Az MVP-specbe csak **inert kampók** kerülnek: a `connectors` táblán a `lifecycle_state` mező (DEFAULT `active`, hogy a mai viselkedés változatlan), és a `provisioning.*` audit-eseménytípusok regisztrálása. A feature érdemi kódja Fázis 2.

---

## 2. Hogyan illeszkedik a meglévő architektúrához

A feature **nem új réteg** — a meglévő erőforrás- és kontrollmodell köré tett munkafolyamat:

| Meglévő elem | Mit ad a feature-höz |
|---|---|
| **Connector registry** (koncepció 4.12, MVP 4.6) | A draft ugyanazt a `connectors` sémát célozza, `lifecycle_state = draft` állapotban; az aktiválás teszi `active`-vá. Nincs új connector-fogalom. |
| **Agent Registry** (4.5–4.5.1) | A provisioning-asszisztens egy konfigurálható agent-szerep — eszközjogok nélkül, egyetlen kimenete a draft. |
| **Tool Broker + capability** (4.8.4, 8.2) | Az asszisztens `provisioning.*` capability-ket kap, deny-by-default; nincs `capability.grant`, nincs `connector.activate`. |
| **Kemény padló** (4.6.4, CR-MVP-002) | A feature ezt **megerősíti**: a draft-író út kódszinten nem érhet `capabilities`/`agent_connectors`/RBAC sorhoz. |
| **Write-gate / jóváhagyás** (4.6.1, 5.6) | Az aktiválás a kritikussági-szint szerinti emberi jóváhagyási kapun megy (L1–L3); banki presetben dual-control. |
| **Secret-elv** (4.9.2) | Változatlan: a token/secret sosem az agentnél; az asszisztens csak alias-nevet javasol, a secretet admin injektálja. |
| **Audit** (7., MVP 5.11) | A draft-, validációs, aktiválási és hozzárendelési események a meglévő hash-láncolt auditba mennek; a forrásdoksi hash-elve. |
| **App Registry validátor-minta** (AppRegistry-spec 6.4) | A determinisztikus, szerveroldali artefakt-validáció mintáját követjük (ott HTML-re, itt connector-deskriptorra). |

---

## 3. Alapelv — propose, ne apply (a feature biztonsági magja)

A provisioning-asszisztens **a legmagasabb tétű agent** lenne a rendszerben, ha írhatna connectort, kredenciált vagy jogosultságot, mert pont a bizalmi határt konfigurálja. Ráadásul a fő bemenete — az **API-dokumentáció — megbízhatatlan külső input** (OWASP LLM01, prompt injection; LLM06, Excessive Agency). Egy mérgezett doksi rávehetné az agentet exfiltrációs endpoint beállítására vagy túl tág scope kérésére.

Ezért a feature a **javaslatkészítést élesen elválasztja a végrehajtástól**:

1. **Az agent kimenete adat, nem művelet.** Az asszisztens egy strukturált **draft connector-deskriptort** állít elő (`lifecycle_state = draft`). Ez egy javaslat, nem élő connector.
2. **Az agent nem kezel kredenciált.** A secret a Secret Managerbe kerül, aliassal, **admin által, külön aktusban**. Az asszisztens legfeljebb a `secret_alias` *nevét* javasolja.
3. **A human admin ellenőriz, validál és aktivál.** Diff-nézet + determinisztikus policy-validáció eredménye mellett; banki presetben két admin (dual-control).
4. **A connector→agent hozzárendelés emberi admin-aktus marad** (CR-MVP-002), az Agent Registryn keresztül.

Az így kapott munkafolyamat a manuális erőfeszítés nagy részét leveszi (a doksi-parsing és a séma-összeállítás), de **egyetlen kontrollpontot sem mozdít el**:

```
admin feltölti a doksit
        │
        ▼
  PROVISIONING ASSISTANT  ──►  draft connector-deskriptor  (lifecycle_state = draft)
        │                            │
        │                            ▼
        │                    🔒 DETERMINISZTIKUS POLICY-VALIDÁCIÓ (szerveroldali, nem LLM)
        │                       egress-allowlist · scope-min · tiltott minták
        │                            │
        ▼                            ▼
  admin REVIEW (diff)  ──►  secret injektálás (admin)  ──►  🔒 sandbox connection-test
        │                                                          │
        ▼                                                          ▼
  🔒 ADMIN ACTIVATE (L1–L3 kapu, banki: dual-control)  ──►  connector active
        │
        ▼
  🔒 ADMIN ASSIGN connector → agent  (agent_connectors, CR-MVP-002)
```

> **Tervezési állásfoglalás:** az „auto-configure-and-activate" autonóm admin agent **kifejezetten nem** célja ennek a featuré-nek. A doksi-alapú konfiguráció egy magas tétű, *egyszer-beállítom-sokszor-használom* művelet, ahol a human-in-the-loop költsége elenyésző a kockázathoz képest. A teljes automatizálás itt rossz kompromisszum lenne.

---

## 4. Adatmodell

### 4.1 `connectors` (kiegészítés)

```
lifecycle_state (enum: draft | validated | active | archived | blocked)   -- DEFAULT 'active'
```

> Megjegyzés: a meglévő, működő connectorok a DEFAULT `active` értéket kapják (migrációkor minden mai sor `active`) → **nincs viselkedésváltozás** a mai connectorokra. A draft-connector `lifecycle_state IN (draft, validated)` állapotban **soha nem oldódik fel** a Tool Brokerben (runtime DENY), így egy fél kész draft nem használható élesben.

A draft a teljes `connectors` sémát használja (id, type, name, scope, secret_alias, version, config, tenant_id), de:

- `secret_alias` draftban **csak javasolt név** lehet, mögötte tényleges secret nélkül;
- `config` a generált deskriptort tartja (lásd 4.3);
- a Tool Broker `lifecycle_state != active` esetén `CONNECTOR_NOT_ACTIVE` DENY-t ad.

### 4.2 `connector_drafts` (provisioning-melléktábla)

A draft eredetét, forrását és validációs eredményét külön tartjuk, hogy a `connectors` tábla tiszta maradjon:

```
id, tenant_id
connector_id (fk connectors)            -- a draft állapotú connector
source_type (enum: api_doc | openapi | manual)
source_ref (text, nullable)             -- a feltöltött doksi storage-referenciája (GCS), NEM a tartalom
source_hash (text)                      -- a forrásdokumentum SHA-256 hash-e (visszakövethetőség)
generated_by_agent_id (fk agents, nullable)
generated_by_agent_version (int, nullable)
generated_from_conversation_id (fk conversations, nullable)
validation_result (jsonb)               -- a determinisztikus validáció kimenete (4.4)
review_status (enum: pending | changes_requested | approved | rejected)
reviewed_by (fk users, nullable)
second_approver_id (fk users, nullable) -- dual-control presetben
created_at, updated_at
unique(tenant_id, connector_id)
```

### 4.3 A generált `config` deskriptor (draft tartalma)

A javasolt connector-konfiguráció determinisztikusan ellenőrizhető szerkezetben:

```json
{
  "provider": "acme-crm",
  "baseUrl": "https://api.acme-crm.example",
  "egressHosts": ["api.acme-crm.example"],
  "authMode": "service",
  "auth": { "type": "api_key_header", "headerName": "X-Api-Key", "secretAliasSuggested": "acme-crm-service-key" },
  "scopesSuggested": ["contacts.read", "deals.read"],
  "rateLimit": { "rps": 5, "burst": 10 },
  "proposedTools": [
    { "name": "acme_crm.search_contacts", "method": "GET", "path": "/v1/contacts", "access": "read" },
    { "name": "acme_crm.get_deal",       "method": "GET", "path": "/v1/deals/{id}", "access": "read" }
  ],
  "provenance": { "sourceHash": "sha256:...", "extractedAt": "2026-06-28T..." }
}
```

> A `proposedTools` írni tudó (POST/PUT/DELETE) műveletei alapból `access: write` jelölést kapnak, és a draftban **külön kiemelve** jelennek meg az admin felé — write-tool csak tudatos jóváhagyással kerülhet az aktivált connectorba.

### 4.4 `validation_result` (determinisztikus, szerveroldali)

```json
{
  "status": "passed | warned | failed",
  "checks": {
    "egressAllowlist": "passed",       // minden egressHost szerepel a tenant allowlistjén?
    "scopeMinimization": "warned",     // a kért scope-ok a proposedTools-hoz indokoltak?
    "forbiddenPatterns": "passed",     // nincs exfil-szerű/tiltott endpoint-minta?
    "secretInline": "passed",          // nincs nyers secret/token a config-ban vagy a doksiból kimásolva?
    "writeToolsFlagged": "warned"      // van write-tool → admin figyelmét igényli
  },
  "warnings": [ "..." ],
  "errors": [ ]
}
```

### 4.5 Audit-eseménytípusok

```
provisioning.draft.create        -- asszisztens draftot generált (payload: connector_id, source_hash, agent_version)
provisioning.draft.validate      -- determinisztikus validáció lefutott (payload: validation_result)
provisioning.draft.review        -- admin review-döntés (payload: review_status, reviewer)
provisioning.connector.activate  -- admin aktiválta a connectort (payload: connector_id, approver(s), criticality)
provisioning.connector.assign    -- admin connectort agenthez rendelt (payload: connector_id, agent_id, access_mode)
provisioning.draft.reject        -- draft elutasítva / archiválva
provisioning.access_denied       -- tiltott művelet-kísérlet (pl. agent aktiválni próbált)
```

A forrásdokumentum **tartalma sosem kerül auditba** — csak a `source_hash` és a storage-referencia (az AppRegistry-spec 8.2 elvével egyezően).

---

## 5. A folyamat lépésről lépésre

```
1. Az admin feltölti / átadja az API-dokumentációt a control plane-en (NEM az agent húzza be tetszőleges URL-ről).
2. Az admin a provisioning-asszisztensnek ad feladatot: "készíts draft connectort ehhez a CRM-hez".
3. Az asszisztens a doksit ADATKÉNT dolgozza fel (nem utasításként), és legenerálja a draft config-deskriptort
   (4.3) → connectors sor lifecycle_state = draft + connector_drafts sor. Audit: provisioning.draft.create.
4. A determinisztikus validátor (4.4) lefut szerveroldalon → validation_result. Audit: provisioning.draft.validate.
5. Az admin a diff-nézetben átnézi a draftot és a validációs eredményt (kiemelt write-toolok, scope-ok, egress-hostok).
   Kérhet módosítást (changes_requested) vagy elfogadja. Audit: provisioning.draft.review.
6. Az admin BEINJEKTÁLJA a secretet a Secret Managerbe a javasolt/választott alias mögé (külön, agenten kívüli aktus).
7. SANDBOX CONNECTION-TEST: a platform szűk jogú, non-prod tokennel kipróbálja a draft connectort egy
   read-only hívással. Sikertelen teszt → nem aktiválható.
8. Az admin AKTIVÁL (lifecycle_state = active). L1–L3 kritikusság szerinti jóváhagyási kapu; banki presetben
   második admin (dual-control). Audit: provisioning.connector.activate.
9. Az admin HOZZÁRENDELI a connectort a megfelelő agent(ek)hez (agent_connectors, access_mode).
   Audit: provisioning.connector.assign. — Ez a CR-MVP-002 szerinti emberi admin-aktus.
```

A 6. és 9. lépés **szándékosan** az emberé. A 3–4. lépés az, amit az asszisztens automatizál — ez a manuális munka java.

---

## 6. A provisioning-asszisztens mint bounded agent

### 6.1 Szerep és jogosultságok

Az asszisztens az Agent Registryben (4.5) egy **konfigurálható szerep**, nem hardcode-olt típus. Jogosultsági profilja a legszűkebb működő felület:

- **Egyetlen „író" capability-osztálya** a draft-rétegre mutat: `provisioning.draft.*`.
- **Nincs** `connector.activate` capability.
- **Nincs** `capability.grant` / RBAC-író capability.
- **Nincs** `agent_connectors` író capability (hozzárendelés = emberi aktus).
- **Nincs** secret-olvasó / secret-író capability.
- Olvasáshoz legfeljebb a meglévő connector-katalógus metaadatát látja (nevek, típusok — secret nélkül), hogy ne generáljon ütköző draftot.

### 6.2 Kemény padló (kódszintű tiltás, nem prompt)

A CR-MVP-002 invariáns **kiterjesztve erre az agentre**:

- A `provisioning.*` írási út **kódszinten** csak a `connectors (lifecycle_state IN draft,validated)` és a `connector_drafts` sorokat érheti. A `capabilities`, `agent_connectors`, RBAC és a Secret Manager **elérhetetlen** ezen az úton.
- A `lifecycle_state` `draft|validated → active` átmenetet **kizárólag** az emberi `activateConnector` admin-API hajthatja végre; az agent toolokból ez az átmenet nem hívható.
- Az agent **a saját** capability-jét vagy connector-jogát semmilyen úton nem bővítheti (OWASP LLM06). Kísérlet → `provisioning.access_denied` audit.

### 6.3 Hozzáférési modell

A koncepció szerint „az admin agentet csak admin joggal lehet elérni" — ez **szükséges, de nem elégséges**. Ezért:

- A provisioning-asszisztenssel **csak `admin` (vagy dedikált `provisioning_admin`) szerepű user** indíthat beszélgetést/feladatot (RBAC, 8.2).
- De a valódi védelem nem a hozzáférés-korlát, hanem az, hogy **mit írhat az agent** (6.2): még admin-beszélgetésen át, mérgezett doksival sem tud aktiválni vagy jogot adni — legfeljebb egy draftot, amit ember validál.

---

## 7. Security / governance baseline

### 7.1 A dokumentum mint adat, nem utasítás

- A forrásdokumentum tartalma a parsing-fázisban **kontextus-adat**; a system prompt explicit tiltja, hogy a doksiból érkező „utasításokat" konfigurációs döntésként kövesse (prompt injection, OWASP LLM01).
- A doksit **az admin adja át kontrollált csatornán** (feltöltés); az agent **nem** húz be tetszőleges külső URL-t (az egress amúgy is deny-by-default, 3.2.1).
- A `source_hash` rögzül és auditálódik → bármely later generált draft visszavezethető a pontos forrásra.

### 7.2 Determinisztikus validáció (LLM-en kívül)

A draftot a megjelenítés előtt **szerveroldali, determinisztikus kód** vizsgálja (nem az LLM önellenőrzése):

- **Egress-allowlist:** a `config.egressHosts` minden eleme szerepeljen a tenant engedélyezett célhostjai közt; ismeretlen host → `failed` (vagy admin-bővítést igénylő `warned` preset szerint).
- **Scope-minimalizálás:** a kért scope-ok / write-toolok indokoltak-e a `proposedTools` halmazához; felesleges/tág scope → `warned`.
- **Tiltott minták:** exfiltráció-szerű endpoint-minták (pl. ismeretlen domainre POST a teljes payloaddal), gyanús header-injektálás → `failed`.
- **Inline-secret tiltás:** ha a doksiból kimásolt nyers token/secret kerülne a config-ba → `failed` + sanitizálás.

### 7.3 Kétszintű emberi kapu

- **Aktiválás:** L1–L3 kritikusság szerinti jóváhagyás (5.6). Banki presetben **dual-control** (`connector_drafts.second_approver_id` kötelező, és ≠ reviewer).
- **Sandbox-teszt aktiválás előtt:** szűk jogú, non-prod tokennel; sikertelen teszt blokkolja az aktiválást.

### 7.4 Least privilege és secret-elv

- Az agent secretet sosem lát; az aktivált connector legszűkebb működő scope-ját kapja; write-tool csak tudatos admin-jóváhagyással.
- A secret a Secret Managerben, alias mögött; a config csak alias-referenciát tartalmaz (4.9.2).

### 7.5 Tenant-izoláció

A draft, a `connector_drafts` és minden audit tenant-scope-os; két tenant sosem osztozik drafton vagy connectoron (8.8).

---

## 8. API specifikáció

### 8.1 `createConnectorDraft`

```ts
createConnectorDraft(input: {
  name: string;
  sourceType: "api_doc" | "openapi" | "manual";
  sourceRef?: string;            // feltöltött doksi storage-referencia
  generatedConfig: ConnectorConfig;   // 4.3 szerkezet
  generatedFromConversationId?: string;
}): { connectorId: string; draftId: string; lifecycleState: "draft" }
```

**Jogosultság:** `provisioning_admin+` **vagy** az asszisztens `provisioning.draft.create` capability-je.
**Szerveroldali lépések:** tenant-check → `source_hash` számítás → `connectors` sor `lifecycle_state=draft` → `connector_drafts` sor → audit `provisioning.draft.create`.

### 8.2 `validateConnectorDraft`

```ts
validateConnectorDraft(input: { draftId: string }): { validationResult: ValidationResult }
```

**Jogosultság:** `provisioning_admin+` vagy `provisioning.draft.validate`.
**Elv:** determinisztikus, szerveroldali (7.2). Audit `provisioning.draft.validate`.

### 8.3 `reviewConnectorDraft`

```ts
reviewConnectorDraft(input: {
  draftId: string;
  decision: "approve" | "changes_requested" | "reject";
  note?: string;
}): { reviewStatus: string }
```

**Jogosultság:** `provisioning_admin+` (emberi). Audit `provisioning.draft.review`.

### 8.4 `testConnectorDraft`

```ts
testConnectorDraft(input: { draftId: string }): {
  ok: boolean; statusCode?: number; detail?: string;
}
```

**Jogosultság:** `provisioning_admin+`.
**Elv:** szűk jogú, non-prod token; egyetlen read-only próbahívás a `baseUrl`-re. Token a Brokeren át, sosem az agentnél.

### 8.5 `activateConnector` *(emberi admin-aktus — agent NEM hívhatja)*

```ts
activateConnector(input: {
  draftId: string;
  secretAlias: string;           // a már beinjektált secret aliasa
  approverId?: string;           // dual-control presetben kötelező, ≠ reviewer
  reason?: string;
}): { connectorId: string; lifecycleState: "active" }
```

**Jogosultság:** `provisioning_admin+`, banki presetben **két** admin (dual-control).
**Előfeltétel:** `review_status = approved`, `validation_result.status != failed`, sikeres `testConnectorDraft`, létező secret az aliasnál.
**Audit:** `provisioning.connector.activate`.

### 8.6 `assignConnectorToAgent` *(emberi admin-aktus — agent NEM hívhatja)*

```ts
assignConnectorToAgent(input: {
  connectorId: string;
  agentId: string;
  accessMode: "read" | "write";
}): { agentId: string; connectorId: string }
```

**Jogosultság:** `admin` az Agent Registryn keresztül (CR-MVP-002).
**Audit:** `provisioning.connector.assign`.

---

## 9. Tool Broker toolok az asszisztens felé

Az asszisztens **csak a draft-rétegre** írhat, deny-by-default capability-vel:

```
provisioning.draft.create        -- 8.1 wrapper (csak lifecycle_state=draft)
provisioning.draft.validate      -- 8.2 wrapper
provisioning.catalog.read        -- meglévő connector-metaadat olvasása (secret nélkül)
```

**Kifejezetten NEM létező / az agent számára tiltott toolok:**

```
provisioning.connector.activate  -- nincs ilyen agent-tool; csak emberi API (8.5)
provisioning.connector.assign    -- nincs ilyen agent-tool; csak emberi API (8.6)
capability.grant / rbac.*        -- soha (CR-MVP-002)
secret.read / secret.write       -- soha (4.9.2)
```

Minden capability agent-verzióhoz kötött, deny-by-default. Az agent a draften kívül semmilyen állapotot nem módosíthat.

---

## 10. Audit és observability

### 10.1 Audit-payload minimum

```json
{
  "tenant_id": "...",
  "connector_id": "...",
  "draft_id": "...",
  "source_hash": "sha256:...",
  "actor_type": "user|agent|system",
  "actor_id": "...",
  "agent_version": 3,
  "validation_status": "passed|warned|failed",
  "review_status": "pending|approved|...",
  "criticality": "L1"
}
```

A forrásdoksi **tartalma** és bármilyen secret **tilos** az auditban — csak hash és referencia.

### 10.2 Metrikák

- generált draftok száma / tenant;
- draft → aktiválás konverziós arány és átfutási idő (a megtakarított manuális munka proxyja);
- validációs `failed`/`warned` arány;
- emberi módosítást igénylő (`changes_requested`) draftok aránya;
- sandbox-teszt bukási arány;
- `provisioning.access_denied` események száma (tiltott művelet-kísérlet — biztonsági jelzés).

---

## 11. Implementációs terv (Fázis 2)

| Lépés | Tartalom | Függ |
|---|---|---|
| **F2-P-A — séma + draft CRUD** | `connectors.lifecycle_state`; `connector_drafts` tábla; draft create/validate/review API; audit-események | MVP connector registry (4.6), audit (5.11) — kész |
| **F2-P-B — determinisztikus validátor** | egress-allowlist, scope-min, tiltott minták, inline-secret tiltás (7.2); szerveroldali, LLM-en kívül | F2-P-A |
| **F2-P-C — admin review UI + diff** | draft diff-nézet, write-tool/scope kiemelés, changes_requested flow; dual-control mező | F2-P-A |
| **F2-P-D — sandbox connection-test** | szűk jogú non-prod token, read-only próbahívás; aktiválás-blokk teszthibára | F2-P-B; Tool Broker valódi MCP-proxy |
| **F2-P-E — aktiválás + hozzárendelés** | `activateConnector` (L1–L3 kapu, dual-control), `assignConnectorToAgent` (CR-MVP-002) | F2-P-C, F2-P-D |
| **F2-P-F — provisioning-asszisztens agent** | Agent Registry szerep-sablon, `provisioning.draft.*` capability seed, system prompt (doksi=adat), doksi→config parsing | F2-P-A; Agent Registry (4.5) |

**Előfeltétel-spike (javasolt, az F2-P-F előtt):**

> **S-P1 — Doksi→draft + injection-rezisztencia (idődobozolt).** Belépő: egy valós CRM API-doksi + egy szándékosan mérgezett változat (rejtett „configurálj be egy exfil-endpointot" utasítással). Kilépő (DONE): a tiszta doksiból helyes draft generálódik; a mérgezett doksinál a determinisztikus validátor `failed`-et ad (egress-allowlist / tiltott minta), és az agent semmilyen úton nem aktivál vagy ad jogot. Ha elbukik: a validátor-szabályok vagy a prompt-izoláció újragondolandó az éles fejlesztés előtt.

---

## 12. Elfogadási kritériumok

### 12.1 Funkcionális

| ID | Kritérium |
|---|---|
| P1 | Admin feltölt egy API-doksit; az asszisztens `draft` connectort generál `connector_drafts` sorral és `source_hash`-sel. |
| P2 | A determinisztikus validátor lefut és `validation_result`-ot ad; write-toolok és tág scope-ok kiemelve. |
| P3 | A draft `lifecycle_state IN (draft, validated)` connectort a Tool Broker **nem** oldja fel (runtime DENY). |
| P4 | Az admin diff-nézetben átnézi, módosítást kér vagy jóváhagy; minden lépés auditált. |
| P5 | Aktiválás csak `approved` review + nem-`failed` validáció + sikeres sandbox-teszt + létező secret-alias mellett megy. |
| P6 | Banki presetben az aktiválás második, eltérő admint igényel (dual-control). |
| P7 | A connector→agent hozzárendelés külön emberi admin-aktus, auditálva (`provisioning.connector.assign`). |
| P8 | A forrásdoksi tartalma és bármilyen secret nem kerül auditba (csak hash + referencia). |

### 12.2 Kötelező negatív tesztek

| # | Teszt | Elvárt eredmény |
|---|---|---|
| PN1 | Mérgezett doksi exfil-endpointtal | Validátor `failed` (egress-allowlist / tiltott minta); draft nem aktiválható |
| PN2 | Az asszisztens megpróbál `activateConnector`-t hívni | Nincs ilyen agent-tool → `TOOL_NOT_AUTHORIZED` + `provisioning.access_denied` |
| PN3 | Az asszisztens megpróbál capability-t / `agent_connectors`-t írni | Kódszintű blokk (CR-MVP-002) + audit; jogosultság nem változik |
| PN4 | Az asszisztens megpróbál secretet olvasni/írni | DENY; secret elérhetetlen a `provisioning.*` úton |
| PN5 | Draft connector futtatása aktiválás előtt | `CONNECTOR_NOT_ACTIVE` DENY a Tool Brokerben |
| PN6 | Aktiválás bukott sandbox-teszt után | Blokk; connector `draft` marad |
| PN7 | Dual-control presetben ugyanaz a user reviewer és approver | `APPROVAL_SAME_ACTOR` hiba; aktiválás blokk |
| PN8 | Audit-payload doksi-tartalmat vagy nyers secretet tartalmazna | Teszt bukjon; sanitization kötelező |
| PN9 | Más tenant draftjának elérése | `DRAFT_NOT_FOUND_OR_FORBIDDEN` + `provisioning.access_denied` |
| PN10 | Az asszisztens tetszőleges külső URL-ről próbál doksit behúzni | Egress deny-by-default; a doksit csak admin tölti fel |

---

## 13. Roadmap / kiterjesztés

A draft+review+activate minta **általánosítható** más konfig-artefaktokra (mindig propose-not-apply elvvel):

- **Agent-szerep-sablon draft:** új agent vázának (prompt, modell, szerep) generálása leírásból — aktiválás emberi aktus (kapcsolódik az `agent-scaffold` skillhez).
- **Playbook-vázlat draft:** egy folyamatleírásból deklaratív Playbook-váz (4.10) — a verziózott aktiválás emberi.
- **OpenAPI-natív import:** ha a forrás strukturált OpenAPI/Swagger, a parsing nagyrészt determinisztikus, az LLM csak a tool-nevet/leírást és a scope-indoklást adja → kisebb injection-felület.
- **Per-user (delegált) connector draftolása:** a `user_delegated` connectorok (4.12.1) OAuth-konfigjának draftolása — a grant-flow továbbra is felhasználói aktus marad.

---

## 14. Nyitott döntések

1. **Draft-tárolás:** a draft a `connectors` táblában `lifecycle_state=draft`-fal éljen-e (séma-egységesség), vagy teljesen külön `connector_drafts.config`-ban a tényleges aktiváláskori átemeléssel? Javaslat: **a `connectors` táblában**, `lifecycle_state` őrrel — kevesebb adatduplikáció, a runtime-őr (`!= active → DENY`) elég.
2. **Egress-allowlist forrása:** a tenant allowlistjét hol vezetjük (külön config vs. a meglévő egress-policy 3.2.1)? Javaslat: a **meglévő deny-by-default egress-policy** kiterjesztése, ne új lista.
3. **Validátor szigor:** ismeretlen egress-host `failed` legyen-e, vagy `warned` + admin-bővítés? Javaslat: alapból `warned` + admin-bővítés; **banki presetben `failed`** (allowlist-only).
4. **Dual-control hatóköre:** minden connector-aktiválásra kell-e két admin, vagy csak `L2–L3` kritikusságúra? Javaslat: **L1: egy admin; L2–L3: dual-control**; banki presetben minden aktiválás dual-control.
5. **Doksi-méret / chunkolás:** nagy API-doksiknál a parsing chunkolása és a költségkeret (Model Gateway guardrail) — token-plafon és részleges feldolgozás kezelése Fázis 2-ben tisztázandó.

---

*Forrásalap: `AI-Agent-Platform-Koncepcio.md` v0.11 (4.5–4.5.1, 4.6.4, 4.8.4, 4.9.2, 4.12–4.12.1, 5.6, 8.2) és `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` v1.0 (4.6, 5.3, 5.8, 5.11, CR-MVP-002). A feature Fázis 2; az MVP-be csak inert séma-kampó kerül. A doksi→draft injection-rezisztencia az S-P1 spike-on validálandó éles fejlesztés előtt. A propose-not-apply elv és a CR-MVP-002 kemény padló nem felülírható: connector-aktiválás, capability-/RBAC-változás és connector→agent hozzárendelés mindig emberi admin-aktus.*
