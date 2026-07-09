# Ostorosbor CRM - platform integracios atado

**Datum:** 2026-06-28  
**Celkozonseg:** platform uzemelteto / agent platform fejleszto  
**Cel:** a platform agentjei biztonsagosan elerjek az Ostorosbor CRM-et lokalis es Firebase/App Hosting kornyezetben.

---

## 1. Integracios modell

A CRM oldalon az agentek szamara a hivatalos szerzodes a Connector API:

```txt
/api/connector/v1
```

OpenAPI szerzodes:

```txt
openapi/connector-v1.yaml
```

A platform oldalon ajanlott hivaslanc:

```txt
Agent -> platform backend / tool broker -> CRM Connector API
```

Ne a bongeszos frontend hivja kozvetlenul a CRM connector API-t, mert a Bearer kulcs titok. CORS-konfiguracio nem szukseges, ha a hivas szerveroldalrol tortenik.

---

## 2. CRM oldalon beallitott konfiguracios pontok

Az App Hosting konfiguracio tartalmazza a platformkapcsolathoz szukseges runtime secret valtozokat:

```txt
DATABASE_URL
DIRECT_URL
BOOTSTRAP_ADMIN_EMAILS
FIREBASE_ADMIN_CREDENTIALS
FIREBASE_STORAGE_BUCKET
CONNECTOR_API_KEYS
EVENT_WEBHOOK_URL
EVENT_WEBHOOK_SECRET
INTERNAL_SERVICE_TOKEN
ERP_WEBHOOK_SECRET
```

A lokalis pelda konfiguracio a `.env.example` fajlban szerepel.

Fontos: a CRM a connector API-kulcsoknak csak a SHA-256 hash-et tarolja. A nyers kulcsot a platform titoktaraban kell kezelni.

---

## 3. Lokalis osszekotes

Ha mindket alkalmazas ugyanazon a gepen fut:

```txt
CRM app:      http://localhost:3000
Platform app: http://localhost:<platform-port>
```

Platform oldali kornyezeti valtozok:

```env
CRM_BASE_URL="http://localhost:3000/api/connector/v1"
CRM_SERVICE_API_KEY="<nyers-service-kulcs>"
CRM_DELEGATED_API_KEY="<nyers-user-delegated-kulcs>"
CRM_AGENT_ID="ostoros-crm-testpilot"
CRM_EVENT_WEBHOOK_SECRET="<EVENT_WEBHOOK_SECRET>"
```

CRM oldali lokalis `.env`:

```env
CONNECTOR_API_KEYS='[
  {"id":"crm-service-local","hash":"<sha256-service-kulcs>","profile":"service"},
  {"id":"crm-delegated-local","hash":"<sha256-delegated-kulcs>","profile":"user_delegated"}
]'
EVENT_WEBHOOK_URL="http://localhost:<platform-port>/api/crm/events"
EVENT_WEBHOOK_SECRET="<kozos-secret>"
```

Kulcsgeneralas:

```bash
openssl rand -hex 32
printf '%s' "<nyers-kulcs>" | shasum -a 256
```

A parancs elso sora adja a platform oldalon tarolando nyers kulcsot. A masodik sor eredmenyet kell a CRM `CONNECTOR_API_KEYS` JSON `hash` mezojebe irni.

Ha a platform Firebase-ben fut, de a CRM lokalisan, a platform nem fogja elerni a sajat `localhost` cimet. Ilyenkor ideiglenesen publikus tunnel kell, peldaul `ngrok`, es a platform oldali `CRM_BASE_URL` a tunnel URL-je legyen.

---

## 4. Firebase / App Hosting osszekotes

Ha mindket alkalmazas Firebase/App Hosting alatt fut, a platform oldalon:

```env
CRM_BASE_URL="https://<crm-apphosting-domain>/api/connector/v1"
CRM_SERVICE_API_KEY="<nyers-service-kulcs>"
CRM_DELEGATED_API_KEY="<nyers-user-delegated-kulcs>"
CRM_AGENT_ID="ostoros-crm-testpilot"
CRM_EVENT_WEBHOOK_SECRET="<EVENT_WEBHOOK_SECRET>"
```

CRM oldalon a kovetkezo secreteket kell letrehozni a Firebase/App Hosting projektben:

```txt
CONNECTOR_API_KEYS
EVENT_WEBHOOK_URL
EVENT_WEBHOOK_SECRET
INTERNAL_SERVICE_TOKEN
DATABASE_URL
DIRECT_URL
FIREBASE_ADMIN_CREDENTIALS
FIREBASE_STORAGE_BUCKET
ERP_WEBHOOK_SECRET
```

`EVENT_WEBHOOK_URL` erteke a platform fogado endpointja legyen:

```txt
https://<platform-domain>/api/crm/events
```

---

## 5. Connector API hivasok kotelezo fejlecei

Minden connector hivasnal:

```txt
Authorization: Bearer <nyers-connector-kulcs>
X-Acting-User: <crm-user-id-vagy-email>
X-Agent-Id: <agent-azonosito>
X-Connector-Call-Id: <egyedi-hivas-azonosito>
```

Iro hivasoknal pluszban kotelezo:

```txt
Idempotency-Key: <egyedi-idempotencia-kulcs>
```

`X-Acting-User` lehet CRM felhasznalo ID vagy e-mail cim. A felhasznalonak aktivnak kell lennie a CRM-ben, es az agent nem kap tobb jogot, mint ez az acting user.

`X-Connector-Call-Id` minden hivasnal legyen egyedi, naplozashoz es hibakereseshez.

`Idempotency-Key` iro muveleteknel legyen stabil ugyanarra az ujraprobalt muveletre, de mas legyen kulonbozo muveletekre.

---

## 6. Jogosultsagi profilok

### service profil

Monitoring, insight es belso agent-mezok frissitese:

```txt
accounts:read
accounts:write_agent_fields
quotes:read
documents:read
inquiries:read
insights:read
insights:write
```

Tipikus agentek:

```txt
health-monitor
weekly-insight-writer
crm-observer
```

### user_delegated profil

Ertekesito neveben vegzett, de tovabbra is belso es visszafordithato muveletek:

```txt
accounts:read
accounts:soft_delete
quotes:read
quotes:write
tasks:write
documents:read
documents:write_draft
inquiries:read
inquiries:write
```

Tipikus agentek:

```txt
sales-copilot
inquiry-intake
document-draft-assistant
```

---

## 7. Gyors ellenorzo hivasok

Account lista:

```bash
curl "$CRM_BASE_URL/accounts?limit=5" \
  -H "Authorization: Bearer $CRM_SERVICE_API_KEY" \
  -H "X-Acting-User: ertekesito@ostorosbor.hu" \
  -H "X-Agent-Id: ostoros-crm-testpilot" \
  -H "X-Connector-Call-Id: smoke-accounts-001"
```

Uj interakcio rogzitese:

```bash
curl "$CRM_BASE_URL/interactions" \
  -X POST \
  -H "Authorization: Bearer $CRM_DELEGATED_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Acting-User: ertekesito@ostorosbor.hu" \
  -H "X-Agent-Id: ostoros-crm-testpilot" \
  -H "X-Connector-Call-Id: smoke-interaction-001" \
  -H "Idempotency-Key: smoke-interaction-001" \
  -d '{
    "channel": "EMAIL",
    "summary": "Teszt interakcio a platform integralas ellenorzesere.",
    "refEntity": "Account",
    "refId": "<account-id>"
  }'
```

Dry-run iro hivasnal:

```txt
?dryRun=true
```

Pelda:

```bash
curl "$CRM_BASE_URL/tasks?dryRun=true" \
  -X POST \
  -H "Authorization: Bearer $CRM_DELEGATED_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Acting-User: ertekesito@ostorosbor.hu" \
  -H "X-Agent-Id: ostoros-crm-testpilot" \
  -H "X-Connector-Call-Id: smoke-task-dry-run-001" \
  -H "Idempotency-Key: smoke-task-dry-run-001" \
  -d '{"title":"Platform integracios dry-run teszt"}'
```

---

## 8. CRM -> platform webhook

A CRM az esemenyeket a `EVENT_WEBHOOK_URL` cimre kuldi. A platform fogado endpointjan ellenorizni kell:

```txt
x-event-id
x-event-signature
content-type: application/json
```

Az alairas:

```txt
sha256=<HMAC_SHA256(raw_body, EVENT_WEBHOOK_SECRET)>
```

A body formaja:

```json
{
  "id": "<event-id>",
  "type": "<event-type>",
  "payload": {},
  "createdAt": "2026-06-28T00:00:00.000Z"
}
```

A platform oldalon az `x-event-id` alapjan idempotensen kell kezelni az ismetelt kezbesitest.

Ha a fogado endpoint nem 2xx valaszt ad, a CRM ujraprobal exponencialis kesleltetessel. Tobbszori sikertelen probalkozas utan az esemeny `FAILED` allapotba kerul.

---

## 9. MCP server ajanlas

Az MCP server hasznos, ha a platform agentjei MCP-native modon hivnak toolokat. Ilyenkor az MCP server legyen adapter, ne kerulje meg a CRM Connector API-t.

Ajanlott felallas:

```txt
Agent -> MCP server -> CRM Connector API
```

Az MCP server tooljai legyenek vekony wrapper-ek az OpenAPI muveletek korul:

```txt
listAccounts
getAccount360
listQuotes
createInquiry
createTask
createInteraction
listDocuments
createDocumentDraft
getInsights
upsertNlWeeklySummary
```

Nem ajanlott:

```txt
Agent -> MCP server -> CRM adatbazis
```

Ennek oka: az RBAC, audit, idempotencia, rate limit es agent-jogkorlat a Connector API retegeben van kikialakitva.

---

## 10. Uzemeltetesi checklist a platform oldalon

1. Hozzatok letre ket platform secretet: `CRM_SERVICE_API_KEY`, `CRM_DELEGATED_API_KEY`.
2. Allitsatok be a `CRM_BASE_URL` erteket lokalis vagy Firebase URL-re.
3. Allitsatok be egy stabil `CRM_AGENT_ID` erteket minden agenthez.
4. A platform backend minden hivasnal kuldje a kotelezo fejleceket.
5. Iro hivasnal mindig kuldjetek `Idempotency-Key` fejlecet.
6. A CRM webhook fogado endpoint ellenorizze az `x-event-signature` HMAC-et.
7. A webhook kezeles legyen idempotens az `x-event-id` alapjan.
8. Lokalis-felho hibrid tesztnel hasznaljatok tunnel URL-t, mert a felho nem eri el a lokalis `localhost` cimet.
9. MCP-t csak adapterkent hasznaljatok, a CRM adatbazist kozvetlenul ne erjetek el.
10. A teszteles elso koreben futtassatok vegig: account lista, account 360, inquiry create, task dry-run, interaction create, insights read, webhook receive.

---

## 11. Hibakeresesi jelek

`401`:

```txt
Hibas vagy hianyzo Bearer kulcs, X-Acting-User, X-Agent-Id vagy X-Connector-Call-Id.
```

`403`:

```txt
A hasznalt connector kulcs profilja nem jogosult az adott scope-ra.
```

`422`:

```txt
Validacios hiba, vagy iro hivasnal hianyzo Idempotency-Key.
```

`429`:

```txt
Rate limit. A valasz `Retry-After` fejlecet adhat.
```

`409`:

```txt
Idempotencia konfliktus vagy ervenytelen allapotatmenet.
```

---

## 12. Atadasi adatok, amiket a CRM uzemelteto adjon at a platformnak

Titkositott csatornan:

```txt
CRM_BASE_URL
CRM_SERVICE_API_KEY
CRM_DELEGATED_API_KEY
EVENT_WEBHOOK_SECRET
```

Nem titkos, de egyeztetendo:

```txt
CRM_AGENT_ID naming convention
platform webhook endpoint URL
teszt acting user e-mail vagy CRM user ID
teszt account ID
```
