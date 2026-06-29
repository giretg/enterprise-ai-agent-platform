# Feature-spec - Model Gateway (modellabsztrakcio + routing + guardrail)

**Keszitette:** Excellence Pay KFT (Enterprise AI tanacsadas)  
**Verzio:** 1.0  
**Datum:** 2026-06-27  
**Forrasdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, 3.2.1, 4.7-4.7.2, 4.8.1-4.8.2, 6., 8.2, 8.6, 8.7), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (5.4, 4.7 `model_calls`, 4.8 audit, 5.7 dispatcher, 9.2 negativ tesztek, D2)  
**Olvaso:** fejleszto(k), architect, product owner. Feltetelezi az Agent Registry, IAM/RBAC, audit log (hash-lancolt), dispatcher es a Goose-harness provider-rétegenek alapmodell-ismeretet.  
**Statusz:** tervezet - onallo feature-spec. Az MVP-ben a Gateway egyetlen provideren (ChatGPT OAuth) all es alap guardraillel mukodik; ez a dokumentum az MVP-magot **es** a Fazis 2 (multi-provider routing, koltsegkeret, sensitivity-aware router) fejlesztoi specifikaciojat egy helyen adja meg, fazis-cimkekkel.

---

## 0. Mit ad ez a dokumentum

Ez a specifikacio meghatarozza a **Model Gateway** belso felepiteset es szerzodeseit: hogyan kapja a Goose-harness (es minden mas hivo) a modell-valaszt **egyetlen, szerveroldali, naplozott vegponton** keresztul ugy, hogy az agent **soha nem birtokol modell-kredencialt**, **nem dont modellrol**, es minden hivas **attribútalhato es koltseg-/token-merheto**.

A koncepcio lenyege:

- az agent egy promptot kuld; a **modellvalasztast a Gateway szabalyai dontik**, szerveroldalon, determinisztikusan;
- a modell-kredencial (OAuth-token / API-kulcs) **alias mogott**, Secret Managerben el, sosem promptban, runtime-ban vagy logban;
- minden hivas `model_calls` + `audit_log` (`model.call`) bejegyzest ir;
- a prompt **az egyetlen pont**, ahol tartalom elhagyhatja a kontrollalt hatart egy kulso modell fele - ezert itt kell a legerosebb guardrail (es ide kerul kesobb a sensitivity-aware router);
- a Gateway egyutt dolgozik a dispatcher koltsegkeretevel (heti kvota-plafon).

Ez a feature a **Tool Broker tukorkepe**: a Tool Broker az **eszkoz-/MCP-hivasokat** brokeralja, a Model Gateway a **modellhivasokat**. Ketten egyutt adjak a termek fo differenciátorat (a "ket atjaro" elv).

| Elem | Mit brokeral | Kemeny kapu |
|---|---|---|
| **Model Gateway** | LLM "gondolkodasi" hivasok (prompt -> valasz) | routing + guardrail + koltsegkeret, szerveroldalon |
| **Tool Broker** | Eszkoz-/MCP-hivasok (fajl, web, DB, connector) | `authorize()` capability, deny-by-default |
| **Ticket-allapotgep** | Folyamatkapuk, human-in-the-loop | allapotatmenetek, jovahagyas |

---

## 1. Scope

### 1.1 In scope - MVP-mag

- Egyetlen, OpenAI-kompatibilis HTTP-vegpont, amelyre a Goose provider-rétege kot.
- Egyetlen provider: **`ChatGptOAuthProvider`** (D2, ChatGPT OAuth / Codex-provider).
- OAuth-token szerveroldali mediacioja (Secret Manager alias mogott); a Goose-konteiner csak a Gateway **sajat, rovid eletu belso kulcsat** kapja.
- `ModelGateway.chat()` domain-interfesz.
- Minden hivasra `model_calls` napló + `audit_log` (`model.call`) bejegyzes agent-attribútalassal (`agentId`, `agentVersion`).
- Alap guardrail: ticketenkenti/beszelgetésenkenti hivas-/token-keret + egyszeru kimenet-validacio.
- Egyuttmukodes a dispatcher budget-cap-jevel (heti flat-rate plafon).
- Becsult/aggregalt koltseg (`cost_estimate`), mert a flat-rate OAuth nem ad pontos per-call koltseget.
- Hibakezeles es statusz-leképzes (`ok | error | rate_limited`).

### 1.2 In scope - Fazis 2 (cimkezve, nem MVP-gate)

- **Multi-provider routing** prioritas-lanccal (ticket-feluliras -> agent-konfig -> globalis policy/fallback).
- Tobb provider-adapter: API-alapu (Gemini API), lokalis/on-prem (Ollama) - azonos provider-interfesz mogott.
- **Koltseg-/kvota-policy motor**: per-tenant, per-agent, per-tickettipus keretek, soft/hard cap, fallback olcsobb modellre.
- **Sensitivity-aware router (4.7.2)** mint pre-flight, lokalisan futo osztalyozo: tiszta -> kulso; erzekeny -> lokalis; tiltott -> blokk/jovahagyas; opcionalis redakcio.
- Provider-kieses eseten automatikus fallback (lokalisra vagy olcsobb modellre).
- Strukturalt streaming (stream-json) atvitel a harness fele.

### 1.3 Out of scope - most nem

- Sajat modell betanitasa/finomhangolasa (nem a Gateway feladata).
- Embedding-/vektorkereses szolgaltatas (a memoria-retrieval kulon komponens, 4.6.2).
- Prompt-sablon menedzsment / prompt-verziozas (Agent Registry / recipe felelosseg).
- Tobb egyideju emberi OAuth-identitas kezelese (MVP: egy elofizetoi token).
- Pontos, szamlazas-szintu per-call koltseg flat-rate provideren.

### 1.4 Feature-szint dontes

A Model Gateway **Control Plane komponens**, nem Sandbox artefakt es nem a harness resze. Ennek oka:

- a modell-kredencial bizalmi elem, amely sosem kerulhet a harnessbe vagy a promptba;
- a routing- es koltseg-policy governance-dontes (ki melyik modellt hasznalhatja, mennyiert);
- minden modellhivas auditforras - a "milyen adathoz fert hozza, mennyit koltott" sztori innen jon;
- a sensitivity-aware kikenyszerites (Fazis 2) szabalyozoi elvaras lehet (bank/PSP).

---

## 2. Fo invariansok

Ezeket **kodszinten** kell vedeni, nem UI-szinten.

1. Az agent (es a Goose-harness) **soha nem birtokol** modell-kredencialt; a felfele meno hivashoz a Gateway csatolja a tokent szerveroldalon.
2. Az agent **nem dont** modellrol - csak promptot kuld; a modellvalasztas a Gateway szerveroldali szabalya.
3. A Goose provider-rétege **kizarolag** a Gateway vegpontjara van konfiguralva; kozvetlen modell-szolgaltatohoz nem mehet (deny-by-default egress, koncepcio 3.2.1).
4. Minden sikeres **es** sikertelen hivas pontosan egy `model_calls` sort **es** egy `audit_log` (`model.call`) bejegyzest ir.
5. Nyers prompt/valasz-tartalom **nem** kerul az `audit_log` payloadjaba (csak metaadat: modell, token-becsles, latency, statusz, hash/ref) - a content/metadata szetvalasztas (koncepcio 6., roadmap 4.8/4.10) ervenyes.
6. A modell-kredencial (`secret_alias` -> Secret Manager) **sosem** jelenik meg promptban, runtime-ban vagy logban.
7. A koltseg-/hivaskeret tullepese **kemeny kapu**: a Gateway elutasit, mielott a hivas a providerhez menne, es auditba flag-el.
8. A routing-dontes **determinisztikus** es szerveroldali; nem LLM donti el, melyik modell hivodik.
9. A hivas **attribútalt**: `agentId` + `agentVersion` minden bejegyzesben szerepel, akkor is, ha a provider emberi (OAuth) identitashoz kot.
10. **Fazis 2 invarians:** a sensitivity-aware router donttese (erzekeny -> lokalis / blokk) **nem felulirhato** az agent vagy a prompt altal; csak admin-policy valtoztathatja.
11. Cross-tenant modell-konfiguracio, kredencial vagy napló olvasasa tiltott; a tenant-hatar az agent (koncepcio 8.8).

---

## 3. Adatmodell

### 3.1 Meglevo tablak hasznalata

A Gateway a roadmap `4.7 model_calls` tablat hasznalja valtozatlanul:

```
model_calls
  id, ticket_id (fk, nullable), conversation_id (fk, nullable)
  agent_id (fk), agent_version (int)
  model (text), prompt_tokens (int, nullable), completion_tokens (int, nullable)
  cost_estimate (numeric, nullable)        -- flat-rate -> becsult/aggregalt
  latency_ms (int), status (enum: ok | error | rate_limited)
  created_at
```

Audit: minden hivas a meglevo hash-lancolt `audit_log`-ba ir `AuditService.append()`-en at, `type = model.call` (sikeres) vagy `model.call.denied` (Gateway-szintu kapu-elutasitas) ertekkel - az utobbi a roadmap `tool.call.denied` mintajat koveti. A **dispatcher-szintu** budget-blokk megmarad a meglevo `dispatch.budget_blocked` (roadmap 5.11) tipuson; a Gateway-szintu hard-cap elutasitas a `model.call.denied`.

### 3.2 Uj/kiegeszitett mezok az Agent Registryn

A modellvalasztas inputja az Agent Registry (`4.2 agents`). Javasolt `model_config` (jsonb) mezo az agent-rekordon (ha meg nincs):

```
model_config (jsonb)
  {
    "default_model": "gpt-...",         -- agent alapertelmezett modellje (routing 2. prioritas)
    "params": { "temperature": ..., "max_tokens": ... },
    "allow_external": true,             -- Fazis 2: engedheto-e kulso modell
    "fallback_model": "..."             -- Fazis 2: kieses/koltseg eseten
  }
```

### 3.3 Fazis 2 - routing- es koltseg-policy tablak

```
model_routing_policies            -- Fazis 2
  id, tenant_id (uuid)
  scope (enum: global | agent | ticket_type)
  scope_ref (nullable)              -- agent_id vagy ticket_type
  model (text), provider (text)
  priority (int)                    -- alacsonyabb = elobbi
  conditions (jsonb, nullable)      -- pl. { max_cost, sensitivity }
  created_at

model_budgets                     -- Fazis 2
  id, tenant_id, scope (enum: tenant | agent | ticket_type), scope_ref (nullable)
  period (enum: day | week | month)
  call_limit (int, nullable), token_limit (int, nullable)
  soft_threshold (numeric, nullable)   -- figyelmeztetes
  hard_cap (bool)                      -- true -> elutasitas a limiten tul
```

> **MVP-megjegyzes:** MVP-ben a keret nem onallo tabla, hanem a dispatcher konfig + egy egyszeru, ticket/beszelgetes szintu szamlalo (5.7-tel kozos). A `model_routing_policies`/`model_budgets` Fazis 2.

---

## 4. Interfész-szerzodes

### 4.1 Befele - domain-interfesz (a hivok fele)

```
ModelGateway.chat({
  agentId, agentVersion,
  ticketId?, conversationId?,      -- legalabb az egyik attribútaciohoz (CR-MVP-003)
  messages,                        -- OpenAI-kompatibilis uzenet-tomb
  modelConfig?                     -- agent/ticket override hint; a vegso dontes a Gateway-e
}) -> {
  content,
  usage?: { promptTokens, completionTokens },
  latencyMs,
  status: "ok" | "error" | "rate_limited",
  model,                           -- a TENYLEGESEN hasznalt modell (naplozott)
  denied?: { reason }              -- kapu-elutasitas eseten content nelkul
}
```

### 4.2 Kifele - a Goose fele

OpenAI-kompatibilis HTTP-vegpont. A Goose `OPENAI_BASE_URL`/provider-konfigja **kizarolag** erre mutat; a Goose a Gateway sajat, rovid eletu belso kulcsat hasznalja (nem a modell-szolgaltato kulcsat).

### 4.3 Provider-interfesz (belso, csereponti absztrakcio)

```
interface ModelProvider {
  id: string                       -- "chatgpt-oauth" | "gemini-api" | "ollama-local"
  invoke(req: NormalizedRequest) -> NormalizedResponse
  capabilities: { streaming, maxContext, isLocal }
}
```

- **MVP:** egyetlen implementacio - `ChatGptOAuthProvider`.
- **Fazis 2:** `GeminiApiProvider`, `OllamaLocalProvider` ugyanezen interfesz mogott; a routing csak provider-id-t valaszt, a hivo kod valtozatlan (koncepcio 4.7: "az agentek kodja nem valtozik").

---

## 5. Belso feldolgozasi sorrend (request lifecycle)

A Gateway minden `chat()` hivasnal a kovetkezo determinisztikus lancot futtatja (a 🔒 a kemeny, szerveroldali kapuk):

```
1. ATTRIBUCIO       -> agentId + agentVersion + ticketId/conversationId rogzitese
2. 🔒 SENSITIVITY    -> [Fazis 2] pre-flight osztalyozo (4.7.2):
                        tiszta -> tovabb | erzekeny -> lokalis modell kenyszer
                        | tiltott -> blokk/jovahagyas + audit-flag
3. 🔒 ROUTING        -> modellvalasztas prioritassal:
                        (1) ticket-/Playbook-feluliras
                        (2) agent-konfig (model_config.default_model)
                        (3) globalis policy / koltseg-fallback
4. 🔒 BUDGET GATE    -> hivas-/token-keret ellenorzes (dispatcher cap, model_budgets):
                        hard cap tul -> ELUTASITAS (status=rate_limited) + audit
5. SECRET INJEKT    -> a valasztott provider kredenciala alias mogul, szerveroldalon
6. PROVIDER HIVAS   -> NormalizedRequest -> provider.invoke()
7. 🔒 OUTPUT GUARD   -> kimenet-validacio (alap: meret/forma; Fazis 2: tiltott tartalom)
8. NAPLO            -> model_calls (token, latency, status, model)
                       + audit_log model.call (metadata, NEM tartalom)
9. VALASZ           -> { content, usage, latencyMs, status, model }
```

Hibaag: barmely 🔒 kapu elutasitasa -> `status` beallitas, `denied.reason`, `model.call.denied` audit, **nincs** providerhez meno hivas a budget/sensitivity kapunal.

---

## 6. Guardrail-reteg

| Guardrail | MVP | Fazis 2 | Hol |
|---|---|---|---|
| Hivas-/token-keret | igen (ticket/beszelgetes szint) | per-tenant/agent/tickettipus policy | 5./4. lepes |
| Kimenet meret-/forma-validacio | igen (alap) | sema-validacio tickettipus szerint | 5./7. lepes |
| PII / erzekeny tartalom kiszures | nem | sensitivity-aware router (4.7.2) | 5./2. lepes |
| Tiltott tartalom blokkolas | nem | igen (policy) | 5./2. es 5./7. |
| Redakcio/tokenizacio | nem | opcionalis | 5./2. lepes |
| Koltseg-fallback olcsobb modellre | nem | igen | 5./3. lepes |

> A guardrailek **szerveroldalon** futnak, fuggetlenul a Goose belso `GOOSE_MODE`-jatol; az utobbi csak defense-in-depth (koncepcio 3.2.1).

---

## 7. Hibakezeles es statusz-leképzes

| Helyzet | `status` | Viselkedes |
|---|---|---|
| Sikeres provider-valasz | `ok` | content + usage visszaadva, `model.call` audit |
| Provider 4xx/5xx, halozati hiba | `error` | retry-policy (lentebb), majd `model.call` audit `status=error` |
| Budget/kvota plafon tul | `rate_limited` | nincs provider-hivas; `denied.reason`, `model.call.denied` audit |
| Provider rate-limit (429) | `rate_limited` | backoff; Fazis 2: fallback olcsobb/lokalis modellre |
| Sensitivity blokk (Fazis 2) | `error` | `denied.reason="sensitivity_block"`, human-in-the-loop ticket |

**Retry-policy (MVP):** atmeneti hibara (5xx, halozat) max 2 ujraprobalas exponencialis backoffal; minden kiserlet kulon `latency`-vel, de **egy** vegso `model_calls` sorral (a kiserletszam a payload metaadataban). Idempotencia: a hivo nem ir ketszer ticketre ugyanazon valaszbol.

---

## 8. Biztonsagi kovetelmenyek

- **Kredencial-izolacio:** a modell-token kizarolag a Gateway processzeben, Secret Managerbol, alias feloldva. A Goose-konteiner soha nem latja. (Invarians 1, 6.)
- **Egress-zaras:** a harness konteiner kimeno halozata deny-by-default; csak a Gateway (es a Tool Broker) cimezheto (koncepcio 3.2.1).
- **Belso kulcs rotacio:** a Gateway -> Goose belso kulcs rovid eletu, rotalhato; kompromittalas eseten nem ad modell-szolgaltato hozzaferest.
- **Tenant-izolacio:** modell-konfig, kredencial es napló lekerese mindig tenant-scope-pal; cross-tenant tiltott (invarians 11).
- **Audit-integritas:** `model.call` bejegyzesek a hash-lancolt `audit_log`-ban; `verifyChain()` zold marad (nyers tartalom nelkul).
- **Prompt injection hatar:** a Gateway nem "ertelmezi" a promptot dontesre; a modell kimenete adat, nem parancs - a cselekvest a Tool Broker/ticket-kapu donti (koncepcio 8.2).

---

## 9. Megfigyelhetoseg (observability)

A Gateway a kovetkezo metrikakat adja (roadmap 8.6/11-gyel osszhangban):

- hivasszam (agent/tickettipus/modell bontasban), token-becsles, becsult koltseg-aggregatum;
- latency-percentilisek (p50/p95) providerenkent;
- hibaarany es `rate_limited` arany; budget-kihasznaltsag a plafonhoz kepest;
- (Fazis 2) sensitivity-router dontes-eloszlas: tiszta / lokalisra-kenyszer / blokk.

Forras: `model_calls` + `audit_log`. Dashboard a Control Plane admin-feluleten.

---

## 10. Tesztek es elfogadasi kriteriumok

### 10.1 Funkcionalis

- A Goose provider-rétege **csak** a Gateway-re kot; kozvetlen modell-hivas nem lehetseges (egress-teszt).
- Minden hivasra keletkezik `model_calls` **es** `model.call` audit; az agent-attribúcio (`agentVersion`) megjelenik akkor is, ha a provider OAuth emberi identitast hasznal.
- A flat-rate koltseg becsult/aggregalt mezokent latszik; a hivasszam pontos.
- Ticket nelkuli beszelgetesben a hivas a `conversation_id`-n attribútalodik (CR-MVP-003).

### 10.2 Kotelezo negativ tesztek (governance-bizonyitekok)

| ID | Teszt | Elvart eredmeny |
|---|---|---|
| **MG-N1** | A Goose-konteiner megprobal kozvetlenul modell-szolgaltatot hivni | Egress blokk; nincs kimeno kapcsolat; (opc.) audit-flag |
| **MG-N2** | Egy hivas megprobalja kiolvasni/visszakapni a nyers OAuth-tokent (prompt/log) | A token sehol nem jelenik meg promptban/runtime-ban/logban |
| **MG-N3** | Budget hard cap tullepese | A hivas **nem** megy providerhez; `status=rate_limited` + `model.call.denied` audit |
| **MG-N4** | `model.call` audit utan a lancot ellenorizzuk | `verifyChain()` zold; a payload nem tartalmaz nyers prompt/valasz tartalmat |
| **MG-N5** *(Fazis 2)* | Erzekeny (PII/PAN) prompt kulso modell fele | A sensitivity-router lokalisra kenyszerit vagy blokkol; az adat nem megy ki; audit-flag |
| **MG-N6** *(Fazis 2)* | Agent/prompt megprobalja felulirni a sensitivity-dontest | A feluliras **nem** ervenyesul; csak admin-policy valtoztathat |

> MG-N1-MG-N4 az MVP-mag kotelezo negativ tesztje. MG-N5-MG-N6 akkor kotelezo, ha a sensitivity-aware router (Fazis 2) implementalasra kerul. Ezek a koncepcio 8.2/8.7 es a roadmap 9.2 invariansait bizonyitjak.

### 10.3 "Kiprobalhato, ha" (roadmap 5.4 atvezetese)

- az agent nem birtokolja az OAuth-tokent;
- a hasznalat ticketenkent/beszelgetesenkent legalabb aggregaltan latszik;
- a futas megjelenik a Gateway naplojaban (`model_calls` + audit).

---

## 11. Fuggosegek es illesztes

- **Agent Registry (4.5):** a `model_config` az agent-rekordon; a routing 2. prioritasa.
- **Dispatcher (5.7):** kozos budget-cap a heti flat-rate plafonhoz; a Gateway a cap-et kemeny kapukent kenyszeriti.
- **Audit (5.11):** `AuditService.append()`, `model.call` / `model.call.denied` eseménytipusok.
- **Tool Broker (5.5):** parhuzamos minta; a ketto egyutt a "ket atjaro". Megosztott elv: deny-by-default, alias-mogotti secret, minden hivas auditba.
- **Beszelgetes/session (4.14, 5.13):** az `acting user` es a `conversation_id` innen jon; ticket nelkuli futas is teljesen attribútalt.
- **S2 spike (roadmap):** a ChatGPT OAuth illesztest (D2 harom kovetkezmenye) a fejlesztes elott az S2 spike igazolja.

---

## 12. Megvalositasi sorrend (javaslat)

1. **MVP-1:** `ModelGateway.chat()` + `ChatGptOAuthProvider` + Secret Manager mediacio + `model_calls`/`audit_log` napló. (Kemeny: invarians 1-6, 9.)
2. **MVP-2:** budget-gate a dispatcher cap-jevel + statusz-leképzes + MG-N1-MG-N4 negativ tesztek.
3. **MVP-3:** observability dashboard (hivasszam, latency, budget-kihasznaltsag).
4. **Fazis 2-A:** `ModelProvider` absztrakcio kibovitese (Gemini API, Ollama) + routing prioritas-lanc + `model_routing_policies`/`model_budgets`.
5. **Fazis 2-B:** sensitivity-aware router (4.7.2) + MG-N5-MG-N6.
6. **Fazis 2-C:** koltseg-/kieses-fallback + streaming atvitel.

---

## 13. Nyitott kerdesek

- A flat-rate ChatGPT OAuth heti plafon pontos erteke es a dispatcher cap kalibralasahoz szukseges meresi ablak (S2 spike).
- A sensitivity-router lokalis osztalyozojanak megvalositasa: nem-LLM mintaillesztes/NER vs. kis lokalis modell - dontes szabalyozott ugyfelnel (bank/PSP).
- Redakcio/tokenizacio visszaallitasi mechanizmusa (a valaszban) - csak ha a redakcio-opcio kerul implementalasra.
- Streaming (stream-json) atvitel a harness fele - kell-e MVP-ben, vagy eleg a blocking valasz.
