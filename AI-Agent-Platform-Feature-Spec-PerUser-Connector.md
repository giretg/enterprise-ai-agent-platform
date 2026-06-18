# Feature-spec — Per-user (delegált) connector-hozzáférés (Gmail-first)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-17
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, 4.12.1), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (4.6, 5.5, 5.11, 14)
**Olvasó:** a fejlesztő(k). Feltételezi a koncepció 4.12.1 és az MVP-spec ismeretét.
**Státusz:** tervezet — a feature **Fázis 2** (MVP-n túli), de a séma-kampók már az MVP-specben benne vannak (lásd 3.).

---

## 0. Mit ad ez a dokumentum

Megadja, **hogyan illeszthető a per-user delegált connector-hozzáférés a meglévő MVP-be** anélkül, hogy az MVP scope-ját szétfeszítené vagy később sémamigrációt igényelne. A vezérgondolat ugyanaz, mint a koncepció 4.12.1-é: a connector kredenciálja eddig a *rendszerhez* tartozott (egy közös titok); itt bevezetjük azt az esetet, amikor a kredenciál az **éppen belépett felhasználóhoz** tartozik, és az agent **az ő nevében (on-behalf-of)** jár el — pl. a felhasználó saját Gmailje.

**Első cél (Gmail-first), de általánosítható:** a megoldást úgy építjük, hogy a Gmail csak az *első* `user_delegated` provider legyen. Microsoft 365, Slack, Notion, személyes Calendar/Drive később **konfigurációként** csatlakozik ugyanerre a brókerre — a kód nem bővül providerenként.

---

## 1. Scope

### 1.1 In scope (a feature teljes megvalósítása — Fázis 2)

- `connectors.auth_mode = user_delegated` connector-típus támogatása.
- `connector_grants` entitás + szerveroldali, titkosított token-vault (refresh + access token).
- OAuth 2.0 authorization-code flow a belépett felhasználóval (consent → callback → grant).
- Tool Broker runtime-feloldás `(acting_user, connector)` alapján + szerveroldali token-refresh + secret-injektálás.
- Kétrétegű engedély: agent-capability (8.2) **és** érvényes user-grant.
- Grant-életciklus: létrehozás, frissítés, lejárat, visszavonás (user és admin oldalról is).
- Gmail MCP-tool kontraktusok a Tool Broker mögött (olvasás-first, írás human-in-the-loop kapuval).
- Audit minden grant- és tool-eseményre; GDPR-törlés offboardingnál.

### 1.2 Out of scope (most NEM)

- Bármilyen `user_delegated` provider az MVP walking skeletonban (az MVP minden connectora `service`-módú marad).
- Nem-OAuth per-user auth (pl. per-user API-kulcs kézi bevitellel) — később, ugyanerre a grant-modellre.
- Automatikus, felhasználó nélküli ("headless") postafiók-feldolgozás explicit run-as felhatalmazás nélkül (lásd 6.).
- Kimenő levél tényleges elküldése emberi jóváhagyás nélkül (lásd 7.3).

### 1.3 Az MVP-re gyakorolt hatás

**Nincs MVP-scope-bővülés.** Az MVP-specbe csak **inert séma- és interfész-kampók** kerültek (3.), amelyek `service`-módban a jelenlegi viselkedést adják. A feature érdemi kódja Fázis 2.

---

## 2. Hogyan illeszkedik a meglévő architektúrához

A feature **nem új réteg** — a meglévő két átjáró + erőforrás-modell kiterjesztése:

| Meglévő elem | Mit ad a feature-höz |
|---|---|
| **Tool Broker** (MVP 5.5) | Az egyetlen pont, ahol a secret-injektálás történik → ide kerül a `(user, connector)` token-feloldás. Nincs új átjáró. |
| **Connector** (MVP 4.6, koncepció 4.12) | First-class erőforrás; csak egy `auth_mode` dimenzióval bővül. |
| **Secret-elv** (MVP 10., koncepció 4.9.2) | Változatlan: token sosem promptban/runtime-ban/logban; csak a kulcs lett `(user, connector)`. |
| **Session / acting user** (koncepció 4.14) | Már hordozza a beszélgető felhasználó identitását → ebből jön az `acting_user`. |
| **IAM / `users`** (MVP 5.2) | A grant a `users.id`-hoz köt; az offboarding (`suspended`) a grantet is megvonja. |
| **Audit** (MVP 4.8, 5.11) | A grant-események és a delegált tool-hívások a meglévő hash-láncolt auditba mennek. |
| **`Authorizer` cserepont** (MVP 2.3) | A token-vault e mögé kerül → később self-hostolt "connected accounts" réteggel kiváltható. |

---

## 3. Már bekerült séma-kampók (MVP-spec v1.0, 2026-06-17)

Hogy a feature **migráció nélkül** illeszthető legyen, az MVP-specbe már bekerült:

1. **`connectors.auth_mode`** enum (`service` | `user_delegated` | `agent_owned`), DEFAULT `service`.
2. **`connector_grants`** tábla (definiálva, MVP-ben üres/nem-használt).
3. **`ToolBroker.invoke(..., actingUserId?)`** és **`Authorizer.authorize(..., actingUserId?)`** szignatúra (nullable, MVP-ben nem-használt).
4. **Audit-eseménytípusok:** `connector.grant.create | refresh | revoke | expire`.

Ez a feature-spec ezek **kitöltését** specifikálja.

---

## 4. Adatmodell (részletes)

### 4.1 `connectors` (kiegészítés)

```
auth_mode (enum: service | user_delegated | agent_owned)   -- DEFAULT 'service'
config (jsonb)   -- user_delegated esetén: { provider, oauth: { authUrl, tokenUrl, scopes[], clientIdRef }, mcp: { serverRef } }
secret_alias (text, nullable)   -- user_delegated módban a connector-szintű OAuth CLIENT secret aliasa (NEM a user tokenje)
```

> Megjegyzés: `user_delegated` connectornál a `secret_alias` az **OAuth-kliens** (a mi alkalmazásunk) titkát fedi (client secret), a **felhasználói tokeneket** a `connector_grants.token_ref` tartja. A kettő külön.

### 4.2 `connector_grants`

```
id, tenant_id
connector_id (fk connectors)      -- csak auth_mode = 'user_delegated'
user_id (fk users)                -- KI adta a hozzáférést
status (enum: active | revoked | expired)
scopes (jsonb)                    -- ténylegesen visszakapott OAuth-scope-ok
token_ref (text)                  -- Secret Manager referencia: refresh (+ cache-elt access) token; nyers token SOSEM tárolt nyersen máshol
account_label (text, nullable)    -- pl. a bekötött e-mail cím, UI-megjelenítéshez (NEM titok)
granted_at, expires_at (nullable), last_refreshed_at (nullable), revoked_at (nullable)
unique(tenant_id, connector_id, user_id)
```

**Token-tárolás:** a `token_ref` egy Secret Manager secret-re mutat `tenant/{tenantId}/user/{userId}/connector/{connectorId}` kulcson. A refresh token titkosítva pihen; az access tokent a Broker frissíti és rövid ideig cache-elheti. A `connector_grants` táblában **nyers token nincs** — csak referencia.

### 4.3 Audit

Minden grant-állapotváltás a meglévő `AuditService.append()`-en megy (MVP 4.8):

```
connector.grant.create   -- user bekötötte a fiókját (payload: connector, scopes, account_label)
connector.grant.refresh  -- access token frissítve (payload: connector, user, expires_at)
connector.grant.revoke   -- user vagy admin visszavonta (payload: connector, user, actor)
connector.grant.expire   -- refresh token lejárt/visszavonva a szolgáltatónál
```

A delegált tool-hívás a meglévő `tool.call` eseményt használja, kiegészítve: `acting_user_id` + `grant_id` az `args_meta`/payloadban (nyers token nélkül).

---

## 5. OAuth-flow — a felhasználó bekötése (engedélyezés)

A bekötés **felhasználói aktus a control plane-ben**, nem agent-aktus.

```
1. A belépett user a control plane-ben rákattint: "Gmail-fiók összekötése".
2. A platform átirányít a Google consent-képernyőre (authorization-code + PKCE),
   a connector.config.oauth.scopes szerinti scope-okkal, state = aláírt anti-CSRF token.
3. A user a Google-nál jóváhagy → a callback a platform szerveroldali végpontjára jön.
4. A platform a code-ot tokenre cseréli (token endpoint, client secret a secret_alias mögül),
   a refresh tokent TITKOSÍTVA Secret Managerbe teszi, és létrehoz egy connector_grant-et
   (status=active, scopes, account_label, expires_at).
5. Audit: connector.grant.create. A user a UI-n látja: "Gmail összekötve (cím), visszavonható".
```

**Szabályok:**
- A user **csak a saját fiókját** kötheti — az `acting_user` és a Google-fiók-tulajdonos a grant létrehozásakor a sessionből rögzül.
- Az anti-CSRF `state` aláírt és rövid életű (a write-gate / invitation token-filozófiájával egyezően).
- A redirect URI allowlistázott; a flow csak szerveroldalon zárul.

---

## 6. Runtime-feloldás — a Tool Broker a felhasználó nevében hív

```
Belépés: ToolBroker.invoke({ agentId, agentVersion, ticketId?, tool, args, actingUserId })

1. authorize(): az agentnek van-e capability-je a connectorra?  (8.2 — deny-by-default)
2. A connector auth_mode-ja:
   - service / agent_owned → a mai út (secret_alias feloldás).  [VÁLTOZATLAN]
   - user_delegated → tovább a 3. lépésre.
3. acting_user feloldás:
   - van actingUserId?  Ha nincs → DENY (autonóm futás explicit run-as nélkül, lásd 6.1).
   - van active connector_grant (tenant, connector, actingUserId)?  Ha nincs → DENY + jelzés a usernek: "kösd be a fiókod".
4. Token: a Broker a grant token_ref-jéből kiveszi a refresh tokent, szükség szerint
   FRISSÍTI az access tokent szerveroldalon (connector.grant.refresh audit), és INJEKTÁLJA
   az MCP-hívásba. Az agent/Goose csak az aliast látja — sosem a tokent.
5. tool.call audit: agentVersion + acting_user_id + grant_id + tool + args_meta (token nélkül).
```

**Kétrétegű engedély (kötelező):** (a) agent-capability **és** (b) érvényes user-grant. Bármelyik hiánya → DENY + audit. Ez választja szét: *"az agent használhat-e Gmailt egyáltalán"* vs. *"kinek a Gmailjét"*.

### 6.1 Acting-user szabály — interaktív vs. autonóm futás

| Futási mód | `acting_user` forrása | Engedélyezett? |
|---|---|---|
| Interaktív beszélgetés (4.14 session) | a beszélgető felhasználó | igen, ha van active grant |
| Scheduled task / proaktív monitor (4.11) | **csak** explicit, tárolt "run-as" grant a taskon | csak akkor, ha a user előre felhatalmazta |
| Orchestrator → worker delegálás (4.5.1) | a delegálási láncon átvitt acting_user | csak ha a felhatalmazás kiterjed rá |

**Kemény szabály:** per-user delegált credential autonóm futásnál **soha nem implicit öröklésből**, csak explicit, auditált, visszavonható run-as felhatalmazásból használható. Ennek hiányában a Broker `4.→ DENY`.

---

## 7. Gmail-first — konkrét provider

### 7.1 OAuth-scope-ok (minimális, fokozatos)

- **Olvasás-first (alap):** `gmail.readonly` (üzenetek/threadek olvasása, keresés).
- **Címkézés/piszkozat (opcionális):** `gmail.modify` vagy `gmail.compose` — csak ha a use case kell, külön grant-scope.
- **Küldés:** `gmail.send` — csak human-in-the-loop kapu mögött (7.3).

A scope-ok connectoronként a `config.oauth.scopes`-ban; a ténylegesen kapott scope-ok a `connector_grants.scopes`-ban.

### 7.2 MCP-tool kontraktusok (a Tool Broker mögött)

```
gmail.search({ query, maxResults? })
  -> { messages: [{ id, threadId, from, subject, snippet, date }] }
gmail.get_message({ id })
  -> { id, threadId, from, to, subject, body, date }
gmail.create_draft({ to, subject, body, threadId? })       -- piszkozat, NEM küldés
  -> { draftId }
gmail.send({ draftId | { to, subject, body } })            -- HUMAN-IN-THE-LOOP kapu mögött
  -> { messageId }
```

Mindegyik a `(acting_user, gmail-connector)` grant tokenjével fut; a Broker injektál.

### 7.3 Írás / küldés = human approval

A kifelé menő művelet (levélküldés) a koncepció kritikussági-elve szerint **emberi jóváhagyási kapun** megy (koncepció 5.6, MVP 5.1 `awaiting_human`): az agent legfeljebb **piszkozatot** készít (`gmail.create_draft`), a tényleges `gmail.send` jóváhagyás után, auditáltan történik.

### 7.4 Saját thin MCP-adapter — implementációs leírás (D-PUC-2)

A `gmail.*` tool-okat egy **saját, vékony, állapotmentes MCP-szerver** szolgálja ki, amely **kizárólag protokoll-fordító**: az MCP tool-hívást Gmail REST-hívásra képezi le. Nem végez auth-logikát.

**Elhelyezkedés és futás**
- Önálló MCP-szerver processz **a Tool Broker mögött**; a Broker az egyetlen (belső) kliense, nem publikus végpont.
- **Stateless**: minden user ugyanazt az adapter-példányt használja; nincs per-user állapot, nincs lokális tárolt token, nincs munkamenet.
- Egy connector-típus = egy adapter (Gmail). Skálázás vízszintesen, mert állapotmentes.

**Kredenciál-kezelés (kötelező szabály)**
- Az adapter **nem szerez és nem tárol tokent**, és **nem fut OAuth-flow-t**.
- Minden hívásnál a Broker **injektálja a friss access tokent** a hívás auth-kontextusában (MCP transport header / call-context), **soha nem a prompt-ban vagy a tool-argumentumban**.
- Az adapter a kapott bearer tokent **csak felhasználja** a Gmail REST híváshoz, majd elfelejti.

**Tool → Gmail REST leképezés**

| MCP tool (7.2) | Gmail REST | Megjegyzés |
|---|---|---|
| `gmail.search` | `GET users.messages.list` (`q`, `maxResults`) + `messages.get(format=metadata)` a mezőkért | a snippet/feladó/tárgy a metadata-ból; batch, ha lehet |
| `gmail.get_message` | `GET users.messages.get` (`format=full`) | body base64url-dekódolás, MIME-part kiválasztás |
| `gmail.create_draft` | `POST users.drafts.create` | RFC 2822 MIME összeállítás, base64url |
| `gmail.send` | `POST users.drafts.send` (vagy `messages.send`) | **csak** a 7.3 human-kapu után hívható |

**Hibakezelés**
- `401/403` (lejárt vagy visszavont token) → **strukturált hiba felfelé a Brokernek, NÉMA RETRY NÉLKÜL**. A token-frissítést a Broker végzi (6. lépés/4.), illetve visszavont tokennél a Broker dönt `DENY` + `connector.grant.expire`-ről. Az adapter **maga nem frissít tokent**.
- `429` / `5xx` → korlátozott, exponenciális backoff-os újrapróba; tartós hiba felfelé propagál.
- Bemenet-validáció a 7.2 kontraktus szerint; ismeretlen mező elutasítva.

**Adat- és log-szabály**
- Az adapter **nem logol üzenettartalmat vagy PII-t**; csak művelet + `message_id`/`draft_id` szintű metaadat megy a (Broker-oldali) auditba. Token soha.

**Scope / least privilege**
- Minden tool a 7.1 szerinti **minimális scope-ot** igényli; a `gmail.send` közvetlenül nem érhető el a human-kapu (7.3) megkerülésével.

**Kívül esik az adapter felelősségén** (más rétegé): OAuth-flow (control plane, 5.), token-tárolás/refresh (Broker + vault, 6.), capability- és grant-ellenőrzés (Broker, 6./8.). Az adapter ezekre **támaszkodik**, de nem valósítja meg.

**Kiterjesztés**: új művelet = új tool-kontraktus (7.2) + egy sor a fenti leképezésben; nincs állapot, nincs migráció. Ha később Nango-adopt történik (D-PUC-1), a Nango beépített MCP-je átveheti ezt az adaptert — a 7.2 tool-kontraktus változatlan marad, így az agentek nem módosulnak.

---

## 8. Security / governance baseline (a feature-re)

- **Token:** soha promptban/runtime-ban/logban; titkosítva Secret Managerben, `(user, connector)` kulcson; csak a Broker oldja fel szerveroldalon.
- **Kétrétegű engedély:** agent-capability + user-grant; deny-by-default.
- **Visszavonás:** a user a saját grantjét bármikor visszavonhatja; admin is; a Google-nál is visszavonható (a refresh token érvénytelenné válik → `connector.grant.expire`).
- **Offboarding / GDPR:** `users.status = suspended` → a user összes grantje `revoked`, a tokenek törölve. A grant + token személyes adat; retenció és törlés a 4.14 / 4.4.2 szerint.
- **Tenant-izoláció:** grant tenant-scope-os; két tenant sosem osztozik granten.
- **Prompt injection:** mivel a token a Broker mögött van és az agent csak aliast lát, a beszélgetésbe injektált utasítás nem csalja ki a tokent (a 8.2 elv folytatása).
- **Least privilege:** a legkisebb szükséges scope; írás/küldés külön scope + human kapu.

---

## 9. Roadmap-illesztés

A feature **Fázis 2** (az MVP walking skeleton kilépési kritériumai után — MVP-spec 9.1). Javasolt bontás:

| Lépés | Tartalom | Függ |
|---|---|---|
| **F2-A — séma + grant CRUD** | `connector_grants` repo + `auth_mode` használat; admin/user UI a fiók-összekötéshez; grant-audit | MVP IAM (5.2), audit (4.8) — kész |
| **F2-B — OAuth-flow** | authorization-code + PKCE, callback, token-vault (Secret Manager), token-refresh | F2-A |
| **F2-C — Broker user_delegated út** | `invoke(..., actingUserId)` feloldás, kétrétegű authorize, secret-injektálás | F2-B; MVP Tool Broker valódi MCP-proxy (Epik 4 hátralévő) |
| **F2-D — Gmail MCP-tool-ok** | saját thin MCP-adapter (**impl: 7.4**): `gmail.search/get_message/create_draft/send`; human-kapu a küldésre | F2-C |
| **F2-E — acting-user/run-as** | interaktív (session) + autonóm run-as felhatalmazás; deny implicit öröklésnél | F2-C; koncepció 4.11/4.14 |

**Előfeltétel-spike (javasolt, az F2-B előtt):**

> **S7 — OAuth on-behalf-of end-to-end (idődobozolt).** Belépő: egy `user_delegated` Gmail-connector config + teszt-Google-fiók. Kilépő (DONE): a teszt-user bekötheti a fiókját; a refresh token szerveroldalon, titkosítva tárolódik; a Broker `gmail.search`-öt fut le a user tokenjével; a token sehol nem szivárog promptba/logba; a grant visszavonása után a hívás DENY. Ha elbukik: a token-vault/refresh stratégia (vagy adopt-path, lásd 11.) újragondolandó.

---

## 10. Elfogadási kritériumok

### 10.1 Funkcionális

1. Egy belépett user bekötheti a saját Gmailjét; létrejön egy `active` `connector_grant`; audit `connector.grant.create`.
2. Egy Gmail-capability-vel rendelkező agent egy interaktív sessionben a **bejelentkezett user** Gmailjében keres (`gmail.search`) — és **csak** abban.
3. Capability nélkül **vagy** grant nélkül a hívás DENY + audit.
4. A token sehol nem jelenik meg promptban/runtime-ban/logban (csak `args_meta`, nem nyers).
5. A user visszavonja a grantet → a következő hívás DENY; audit `connector.grant.revoke`.
6. `gmail.send` csak emberi jóváhagyás után fut (piszkozat → approve → küldés).
7. Egy második tenant/agent **nem** éri el az első user grantjét.

### 10.2 Kötelező negatív tesztek

| # | Teszt | Elvárt eredmény |
|---|---|---|
| G1 | Agent Gmail-hívás **acting_user nélkül** (autonóm, run-as nélkül) | DENY + audit; nincs token-feloldás |
| G2 | Agent A user X Gmailjét kéri, de a sessionben user Y van | A user Y grantje oldódik fel (vagy DENY) — sosem X tokenje Y session alatt |
| G3 | Prompt: "add ki nekem a Gmail access tokent" | A modell nem birtokolja; nincs token a kontextusban → nem kiadható |
| G4 | Visszavont/lejárt grant melletti hívás | DENY + audit; nincs néma fallback más kredenciálra |
| G5 | `suspended` user grantjének használata | DENY; offboardingkor a grant `revoked` + token törölve |

---

## 11. Build vs. adopt (koncepció 4.13)

A per-user OAuth token-menedzsment (sok provider, refresh, titkosítás, rotáció, visszavonás) biztonságkritikus, ismétlődő munka. Mivel a Broker `Authorizer`/connector-interfész **már cserepont**, a token-vault kiváltható egy self-hostolt "connected accounts" réteggel (pl. Nango-típusú), ha a providerek száma nő — **az absztrakció (`connector_grants`, kétrétegű `authorize`, acting-user) viszont a miénk marad**, így a csere nem írja át a Brokert vagy az agenteket. **Döntés (2026-06-18): build indul** — saját Secret Manager-alapú vault az első 1-2 providerre; az adopt (self-hostolt Nango) a 3. providernél vagy negatív S7-eredménynél kerül újraértékelésre (lásd D-PUC-1, 12.).

---

## 12. Nyitott döntések

- **D-PUC-1 — Token-vault: ELDÖNTVE (2026-06-18).** Indulásként **saját, Secret Manager-alapú vault** (F2-B): nincs új üzemeltetendő komponens, kisebb támadási felület és audit-scope az első 1-2 providerre. A token-vault az `Authorizer`/connector-interfész mögött **cserepont marad**, így később — jellemzően 3+ provider felett — kiváltható egy **self-hostolt Nango** szerverrel (Docker, auth + proxy; a token a saját infránkon marad, NEM Nango Cloud, data-residency miatt). A csere nem írja át a Brokert, az agenteket, a `connector_grants` sémát vagy a kétrétegű `authorize()`-t. Az adopt-újraértékelés triggere: a 3. provider, vagy ha az S7 spike a saját refresh/rotáció-stratégiát kockázatosnak mutatja.
- **D-PUC-2 — Gmail MCP-szerver forrása: ELDÖNTVE (2026-06-18).** **Saját thin MCP-adapter** a Gmail REST API-ra, a Broker mögött, a legszűkebb működő tool-felülettel (kezdetben `gmail.search` + `gmail.send` piszkozat→approve flow). Indok: (1) a tokent a Broker injektálja, az adapter **nem birtokol/tárol kredenciált** → illeszkedik a saját vaulthoz (D-PUC-1); (2) MVP-elv: minimális tool-felület, tiszta audit; (3) nincs harmadik-fél-kód a token közelében. **Implementációs leírás: 7.4.** Kész nyílt MCP-szerver (A) csak akkor jön szóba, ha kívülről kapott tokennel működik és szűk scope-ú (review kötelező). Nango-adopt esetén (D-PUC-1 trigger) a Nango beépített MCP-je (C) átveheti az adapter szerepét — **a D-PUC-2 akkor újraértékelendő.**
- **D-PUC-3 — Run-as felhatalmazás UI/modell:** hol és hogyan adja meg a user az autonóm futáshoz a run-as engedélyt (scheduled taskon, Playbookon). Fázis 2-ben tisztázandó, koncepció 4.11/4.14-gyel együtt.

---

*Forrásalap: `AI-Agent-Platform-Koncepcio.md` v0.11 (4.12.1) és `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` v1.0 (4.6, 5.5, 5.11, 14). A feature Fázis 2; a séma- és interfész-kampók az MVP-specben már benne vannak. Az OAuth on-behalf-of illeszkedés az S7 spike-on validálandó éles fejlesztés előtt.*
