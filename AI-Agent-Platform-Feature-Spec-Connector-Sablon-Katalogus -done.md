# Fejlesztői specifikáció — Connector Sablon-Katalógus + Generikus API-motor újragondolása

**Státusz:** specifikáció (draft → review)
**Dátum:** 2026-07-02
**Forrás-BRD:** `AI-Agent-Platform-Uzleti-Elvaras-Connector-Sablon-Katalogus.md`
**Fázis:** 2.x — Connector platform
**Kapcsolódó:** Provisioning-Assistant feature-spec, delegált OAuth (auto-consent) kiterjesztés, `connector-oauth2-tokenurl-gap` tüneti javítás (2026-07-02)

> Ez a dokumentum a „hogyan”. A „mit és miért” a BRD-ben van. A cél nem egy zöldmezős rendszer, hanem a **meglévő `http_api` connector-megoldás átalakítása**: a szétszórt, névre-tippelő provider-tudás kivezetése egy adat-vezérelt sablon-katalógusba, önhordó config mellett.

---

## 1. A megoldandó strukturális probléma (kódszinten)

A BRD absztraktan írja le a bajt; itt rögzítjük konkrétan, hol él ma a kódban, mert a refaktor ezekre a pontokra irányul.

### 1.1 Két, széttartó config-séma (az „aszimmetria”)

| | Provisioning/authoring séma | Futásidejű séma |
|---|---|---|
| Fájl | `app/src/domain/provisioning/connector-config.ts` | `app/src/domain/connector/http-api-client.ts` |
| Típus | `ConnectorConfig` (zod) | `HttpApiConfig` (kézi parser) |
| Auth-mező | `auth.type` (`api_key_header`/`bearer_token`/`basic`/`oauth2`) | `auth.scheme` (`header`/`bearer`/`basic`/`oauth2`) |
| Endpoint-mező | `proposedTools[]` (`name/method/path/access`) | `endpoints[]` (`method/path/profile/idempotent`) |
| Rendeltetés | draft-validáció, jóváhagyás | tényleges HTTP-hívás |

A `parseHttpApiConfig` ([http-api-client.ts:69](app/src/domain/connector/http-api-client.ts)) ma **mindkét alakot elfogadja** kompatibilitási ágakkal (`authRaw.scheme === 'oauth2' || authRaw.type === 'oauth2'`, `raw.endpoints ?? raw.proposedTools`). Ez elrejti, de nem oldja meg a kettősséget: a két séma külön fejlődik, és a köztük lévő mezők (pl. `tokenUrl`) az egyik ágon defaultolódnak, a másikon kötelezőek.

### 1.2 Név-tippelő, biztonsági-releváns elágazás

`app/src/domain/connector-grant/connector-grant-service.ts`:
- `looksLikeGoogle()` ([:42](app/src/domain/connector-grant/connector-grant-service.ts)) — a provider/baseUrl/tokenUrl/host **stringjéből** dönt.
- `isGoogleProvider()` ([:54](app/src/domain/connector-grant/connector-grant-service.ts)) — ha „google-szagú”, akkor defaultolja: `authUrl`, `tokenUrl`, `userInfoUrl` ([:111-137](app/src/domain/connector-grant/connector-grant-service.ts)), `access_type=offline` ([:385](app/src/domain/connector-grant/connector-grant-service.ts)), Gmail-scope-normalizálás ([:68-71](app/src/domain/connector-grant/connector-grant-service.ts)).

Ez a BRD által kifogásolt minta: **a connector viselkedését a neve vezérli, nem az explicit configja.**

### 1.3 A kiváltó bug osztálya

Consent-ág ([:112](app/src/domain/connector-grant/connector-grant-service.ts)): `tokenUrl = oauth.tokenUrl ?? auth.tokenUrl ?? (isGoogle ? 'https://oauth2.googleapis.com/token' : undefined)` — a default **nem íródik vissza** a mentett configba. Runtime ([:90-93](app/src/domain/connector/http-api-client.ts)): abszolút `tokenUrl` kötelező → első hívásnál `tokenUrl must be an absolute http(s) URL`. A tüneti javítás (`oauthCompleteness` check, [draft-validator.ts:159](app/src/domain/provisioning/draft-validator.ts)) csak elkapja; a strukturális megoldás az **önhordó config** (K5).

### 1.4 Lifecycle és governance (ezt megtartjuk, ráépítünk)

Meglévő, jól működő gépezet, amelyre a katalógus ráül:
- `Connector` + `ConnectorDraft` modellek, `ConnectorLifecycleState` (`draft→validated→active→archived/blocked`) — `prisma/schema.prisma:887,913`.
- `ProvisioningService` metódusok ([provisioning-service.ts](app/src/domain/provisioning/provisioning-service.ts)): `createConnectorDraft`, `validateConnectorDraft`, `reviewConnectorDraft`, `testConnectorDraft`, `activateConnector`, `reopenConnector`, `decommissionConnector`, `deleteConnectorDraft`, `updateConnectorDraftConfig`.
- Determinisztikus validátor ([draft-validator.ts](app/src/domain/provisioning/draft-validator.ts)), egress-allowlist, four-eyes decommission, append-only audit.

**A katalógus nem megkerülő út (K7): a sablonból létrejövő connector ugyanezen a dráft→validál→jóváhagy→aktivál kapun megy át.**

---

## 2. Cél-architektúra

Négy réteg, alulról felfelé:

```
┌─────────────────────────────────────────────────────────────┐
│ 4. UI: Katalógus-lista · Sablon-alapú create wizard ·        │
│        Custom-sablon szerkesztő                               │
├─────────────────────────────────────────────────────────────┤
│ 3. Materializer: (Template + InstanceInput) → önhordó         │
│    CanonicalConnectorConfig   (nincs futásidejű tippelés)     │
├─────────────────────────────────────────────────────────────┤
│ 2. Katalógus: ConnectorTemplate (builtin seed + custom DB),  │
│    verziózva, auditálva, RBAC mögött                          │
├─────────────────────────────────────────────────────────────┤
│ 1. Generikus motor: egységes CanonicalConnectorConfig +      │
│    HttpApiClient (a mai http-api-client, provider-tudás nélkül)│
└─────────────────────────────────────────────────────────────┘
        ▲ mindegyik ugyanazon a governance-kapun (validátor,
          egress-allowlist, jóváhagyás, audit) megy át
```

**Vezérelv (K5):** a materializer kimenete **önhordó** — minden nem-titkos provider-érték (authUrl, tokenUrl, userInfoUrl, accountEmailField, scope-lista, access_type, egress-hostok) explicit a configban. Futásidőben **egyetlen** provider-specifikus `if` sem marad a generikus úton.

---

## 3. Döntések a BRD §8 nyitott kérdéseire

Ezek a spec bemenő döntései; ha review-n változnak, a lenti fejezetek ehhez igazodnak.

| # | Kérdés | Döntés |
|---|---|---|
| Q1 | Sablon-tárolás | **Hibrid, egy olvasási felülettel.** A beépített sablonok kódban deklaráltak (verziózott TS modul), és **idempotens upserttel a `connector_templates` DB-táblába seedelődnek** (`origin='builtin'`). A custom sablonok ugyanabban a táblában élnek (`origin='custom'`). A UI és a materializer **mindig a DB-ből** olvas → egységes lista, verziózás, audit. |
| Q2 | Sablon-séma | Mezők explicit **`templateLevel` (állandó) vs `instanceLevel` (kitöltendő)** jelöléssel; az instance-mezők **field-descriptorok** (típus, kötelezőség, validáció, `secret: true`). Lásd §5.2. |
| Q3 | Verziózás / frissítés | A sablon `version` monoton nő; a connector `config.provenance` rögzíti `templateId + templateVersion + origin`. **A visszaható frissítés OUT OF SCOPE** (BRD §6, K8) — csak provenance + „elavult sablon” jelzés a UI-n. |
| Q4 | Jogosultság | Új RBAC-permission: **`connector_template:manage`**. Builtin sablon: csak platform-admin, globális. Custom sablon: platform-admin (globális) **vagy** tenant-admin (a saját tenantjára scope-olva). Runtime: builtin sablont senki nem szerkeszthet/törölhet, csak klónozhat. |
| Q5 | OAuth-változatok | A sablon **`authMethods[]` listát** ad (pl. `api_key`, `service_oauth2`, `user_delegated_oauth2`); a példány **egyet választ**. A materializer mindegyikhez önhordó configot állít (lásd §7.3). A UI a választható metódusokat radio-ként mutatja. |
| Q6 | Gmail-örökség | A `type==='gmail'` connector **marad** (BRD §6), de a Google builtin sablon **kiváltja a name-guessinget**: a gmail-seed is a Google-sablonból, explicit configgal készül. `looksLikeGoogle`/`isGoogleProvider` **törlődik** a hot pathról (§9). |
| Q7 | Validáció mélysége | **Minden példány külön validálódik** a meglévő `validateDraftConfig`-on (K7). Ezen felül: (a) a sablon egy **materialization contract**-ot garantál (kötelező mezők kitöltése után a config strukturálisan teljes — pl. oauth2 → tokenUrl mindig jelen); (b) **sablon mentésekor self-check** fut: egy próba-példány materializálható és átmegy a strukturális parse-on. |

---

## 4. Adatmodell

### 4.1 Új tábla: `ConnectorTemplate`

`prisma/schema.prisma` (a `Connector` blokk mellé):

```prisma
enum ConnectorTemplateOrigin {
  builtin
  custom

  @@map("connector_template_origin")
}

model ConnectorTemplate {
  id            String                  @id @default(uuid()) @db.Uuid
  /** Stabil, ember-olvasható kulcs, pl. "google-workspace", "jira-cloud". Builtinnél a seed-kulcs. */
  key           String
  version       Int                     @default(1)
  origin        ConnectorTemplateOrigin @default(custom)
  displayName   String                  @map("display_name")
  description   String?
  /** null = globális (builtin és platform-admin custom); egyébként tenant-scope-olt custom. */
  tenantId      String?                 @map("tenant_id") @db.Uuid
  /** A teljes sablon-deszkriptor (§5). Determinisztikusan validálható; nem hoz biztonsági döntést. */
  descriptor    Json
  status        ConnectorTemplateStatus @default(active) // active | deprecated | archived
  createdById   String?                 @map("created_by") @db.Uuid
  createdAt     DateTime                @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime                @updatedAt @map("updated_at") @db.Timestamptz

  @@unique([key, version, tenantId])
  @@index([origin, status])
  @@map("connector_templates")
}

enum ConnectorTemplateStatus {
  active
  deprecated
  archived

  @@map("connector_template_status")
}
```

Megjegyzés: verziózás **új sorral** történik (nem in-place mutációval) — a régi verzió megmarad az abból származó connectorok provenance-hivatkozásához. A `key` + `version` + `tenantId` egyedi.

### 4.2 Meglévő modellek bővítése

- `ConnectorDraftSourceType` enum (`prisma/schema.prisma:158`): **új tag `template`** — a draft forrása egy sablon volt (a mai `api_doc/openapi/manual` mellé).
- `Connector.config.provenance` (nincs sémaváltás, JSON-mező): a materializer beírja
  ```jsonc
  "provenance": {
    "templateId": "<uuid>", "templateKey": "google-workspace",
    "templateVersion": 3, "templateOrigin": "builtin",
    "materializedAt": "2026-07-02T..."
  }
  ```
  Ez fedi a K8 provenance-igényt anélkül, hogy a `Connector` modellt bővítenénk.

### 4.3 Repository

Új interfész `app/src/repositories/interfaces/index.ts`-ben és postgres-implementáció `connector-template-repository.ts`:

```ts
export interface ConnectorTemplateRepository {
  listVisible(scope: { tenantId: string | null }): Promise<ConnectorTemplate[]> // builtin ∪ tenant custom
  findLatestByKey(key: string, tenantId: string | null): Promise<ConnectorTemplate | null>
  findByIdVersion(id: string): Promise<ConnectorTemplate | null>
  createVersion(input: NewTemplateVersion): Promise<ConnectorTemplate>
  deprecate(id: string): Promise<void>
  upsertBuiltin(descriptor: TemplateDescriptor): Promise<ConnectorTemplate> // seed
}
```

---

## 5. Sablon-séma (`TemplateDescriptor`)

Új fájl: `app/src/domain/connector-template/template-descriptor.ts` (zod). Ez a `descriptor` JSON alakja.

### 5.1 Felső szint

```ts
export const templateDescriptorSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1),
  description: z.string().optional(),

  // ── templateLevel: állandó, provider-tudás (Q2) ──────────────
  baseUrl: z.string().url(),
  egressHosts: z.array(z.string().min(1)).min(1),
  authMethods: z.array(authMethodDescriptorSchema).min(1),   // Q5
  endpoints: z.array(templateEndpointSchema).default([]),    // tipikus endpointok
  scopeCatalog: z.array(scopeDescriptorSchema).default([]),  // választható scope-ok + leírás
  rateLimit: z.object({ rps: z.number(), burst: z.number() }).optional(),

  // ── instanceLevel: kitöltendő mezők field-descriptorai (Q2) ──
  instanceFields: z.array(instanceFieldSchema).default([]),
})
```

### 5.2 Field-descriptor (instance-mező)

```ts
const instanceFieldSchema = z.object({
  name: z.string(),                    // pl. "clientId", "subdomain"
  label: z.string(),
  type: z.enum(['string', 'secret', 'scopeSelection', 'endpointSelection', 'enum']),
  required: z.boolean().default(true),
  // string-validáció (URL/regex/host); secret → secret-store aliasként megy, sose configba (K6)
  validation: z.object({ pattern: z.string().optional(), format: z.enum(['url','host','hostList']).optional() }).optional(),
  secretAliasHint: z.string().optional(), // K6: legfeljebb az alias NEVÉT javasolja
  enumValues: z.array(z.string()).optional(),
  // hova kerül a materializált configban (path), pl. "auth.clientId" / "baseUrl:{subdomain}"
  target: z.string(),
})
```

### 5.3 Auth-method descriptor (Q5)

```ts
const authMethodDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api_key'), header: z.string() }),
  z.object({ kind: z.literal('bearer') }),
  z.object({ kind: z.literal('service_oauth2'), authUrl: z.string().url(), tokenUrl: z.string().url(),
             userInfoUrl: z.string().url().optional(), accountEmailField: z.string().default('email'),
             offlineParams: z.record(z.string()).default({}),   // pl. { access_type: "offline" } — EXPLICIT, nem tippelt
             scopeTransform: z.enum(['none','gmailAlias']).default('none') }), // §9: a Gmail-normalizálás itt deklarált
  z.object({ kind: z.literal('user_delegated_oauth2'), /* ugyanazok a mezők */ }),
])
```

**Kulcspont:** minden provider-tudás (authUrl, tokenUrl, `access_type=offline`, scope-transzformáció) **itt, adatként** él — nem a kódban tippelve. A `google-workspace` builtin sablon `service_oauth2` methodja `offlineParams: { access_type: "offline" }`, `scopeTransform: "gmailAlias"` értékekkel jön.

---

## 6. Materializer

Új fájl: `app/src/domain/connector-template/materializer.ts`.

```ts
export function materializeConnectorConfig(
  descriptor: TemplateDescriptor,
  chosen: { authMethodKind: string; instanceValues: Record<string, string>; selectedScopes: string[]; selectedEndpoints?: string[] },
  secretAliases: Record<string, string>, // a secret-mezőkhöz már a secret-store aliasai (nyers titok SOHA)
): CanonicalConnectorConfig
```

Felelősség:
1. Instance-mezők validálása a field-descriptorok szerint (kötelezőség, formátum, enum).
2. A választott auth-method **teljes**, önhordó `auth`-blokká materializálása — oauth2-nél `tokenUrl`/`authUrl`/`userInfoUrl`/`offlineParams` **mind bekerül a configba** (ez zárja ki az 1.3 bug-osztályt).
3. `egressHosts` = template hostjai ∪ instance-származék host (pl. `{subdomain}.atlassian.net`).
4. `provenance` beírása (§4.2).
5. **Materialization contract** ellenőrzése: a kimenet átmegy a `parseCanonicalConnectorConfig`-on (§7) — ha nem, a sablon hibás, nem a példány (fail-fast a sablon-mentésnél, §5/Q7).

A kimenet a `connector_drafts` létrehozásához megy: `ProvisioningService.createConnectorDraft` új `sourceType: 'template'` ágon (lásd §8).

---

## 7. A generikus motor egységesítése (kritikus refaktor)

Ez oldja fel az 1.1 aszimmetriát. **Egyetlen kanonikus futásidejű séma**, a mai kettő helyett.

### 7.1 Kanonikus séma

- A `HttpApiConfig` ([http-api-client.ts:36](app/src/domain/connector/http-api-client.ts)) lesz a **kanonikus** alak (`auth.scheme`, `endpoints`), kiegészítve az oauth2 önhordó mezőivel (`authUrl`, `userInfoUrl`, `accountEmailField`, `offlineParams`, `scopeTransform`) — ezek ma a consent-oldalon defaultolódnak, ezután a configban élnek.
- A provisioning `ConnectorConfig` ([connector-config.ts](app/src/domain/provisioning/connector-config.ts)) **authoring/draft alak** marad (a validátor ezt kapja), de **egyetlen leképezőn** (`toCanonical()`) keresztül áll elő belőle a futásidejű alak. A materializer közvetlenül a kanonikus alakot is emittálhatja.

### 7.2 Compat-shimek kivezetése (ütemezetten)

A `parseHttpApiConfig` kettős ágai (`type`||`scheme`, `endpoints`??`proposedTools`, [:89,100-107,112-116](app/src/domain/connector/http-api-client.ts)) **megmaradnak a migráció alatt** (a régi connectorok configja ne törjön), de:
- új connector **csak** kanonikus alakban íródik;
- egy egyszeri **backfill-migráció** (§12) a meglévő aktív connectorok configját kanonikusra normalizálja;
- a shimek a backfill után egy külön PR-ben eltávolíthatók.

### 7.3 oauth2 önhordóság

A `HttpApiAuthConfig` oauth2 ága ([:20](app/src/domain/connector/http-api-client.ts)) már ma tartalmaz `tokenUrl/clientId/scope`-ot — ezt bővítjük a consent-hez kellő mezőkkel, hogy a consent-út is a configból olvasson (§9), ne tippeljen.

---

## 8. Név-tippelés kivezetése (`connector-grant-service` refaktor)

Cél: a `looksLikeGoogle`/`isGoogleProvider` és minden `isGoogle ? … : …` default **eltűnik** a hot pathról. Az adatot a config szolgáltatja.

Változások `app/src/domain/connector-grant/connector-grant-service.ts`:

| Ma (tippelt) | Ezután (config-driven) |
|---|---|
| `authUrl ?? (isGoogle ? 'accounts.google.com…' : undefined)` [:111] | `config.auth.authUrl` — kötelező oauth2-nél, a sablon tölti |
| `tokenUrl ?? (isGoogle ? 'oauth2.googleapis.com/token' : undefined)` [:112] | `config.auth.tokenUrl` — kötelező (már a validátor is kikényszeríti) |
| `userInfoUrl ?? (isGoogle ? '…/userinfo' : undefined)` [:137] | `config.auth.userInfoUrl` (opcionális) |
| `if (oauth.isGoogle) set('access_type','offline')` [:385] | `for (k,v of config.auth.offlineParams) url.searchParams.set(k,v)` |
| `isGoogle ? normalizeGmailScope : trim` [:70,109] | `scopeTransform` szerint (`'gmailAlias'` → `normalizeGmailScope`, `'none'` → trim) |
| `clientId ?? (isGoogle ? env.GMAIL_OAUTH_CLIENT_ID : '')` [:116] | `config.auth.clientId` (aktiválási gate már kikényszeríti, [provisioning-service.ts:300](app/src/domain/provisioning/provisioning-service.ts)); Gmail-örökség env-fallbackja csak `type==='gmail'` ághoz köthető, nem string-tippeléshez |

**Gmail-örökség (Q6):** a `type==='gmail'` explicit connector-típus marad, de a configját a Google builtin sablonból seedeljük (explicit `authUrl/tokenUrl/userInfoUrl/offlineParams/scopeTransform`), így a `gmail`-ág sem tippel — csak a saját típusát ismeri fel, nem stringet matchel.

---

## 9. Governance-integráció (változatlan kapu, kiegészítve)

- **Determinisztikus validátor** ([draft-validator.ts](app/src/domain/provisioning/draft-validator.ts)): változatlanul minden példányra fut (K7). Az `oauthCompleteness` check ([:159](app/src/domain/provisioning/draft-validator.ts)) megmarad **öv és nadrágtartó**-ként, de a materializer garantálja, hogy soha ne bukjon (self-contained config).
- **Egress-allowlist:** a materializált `egressHosts` a meglévő allowlist-kapun megy át; ismeretlen host → `warned` (nem-banki) / `failed` (bankPreset), admin explicit auditált bővítéssel oldja (mai viselkedés, [draft-validator.ts:88-97](app/src/domain/provisioning/draft-validator.ts)).
- **Jóváhagyás/aktiválás:** `activateConnector` service-oauth2 clientId gate-je ([provisioning-service.ts:300](app/src/domain/provisioning/provisioning-service.ts)) változatlan; sablon-alapú connectorra is érvényes.
- **Audit:** új események az `event-catalog.ts`-ben — `connector.template.create`, `connector.template.deprecate`, `connector.template.clone`, `connector.materialize` (provenance-szal). A sablon-CRUD append-only auditált (K4).
- **Provenance (K8):** minden draft/connector configja hordozza a `provenance` blokkot (§4.2).

---

## 10. UI

Meglévő felületek (`app/src/app/control-plane/provisioning/provisioning-panel.tsx`, `app/src/components/agents/*connector*`) bővítése:

1. **Katalógus-lista** (K3): a `listVisible` alapján a választható sablonok **eleve látszanak** (builtin + tenant-custom), origin-badge-dzsel.
2. **Sablon-alapú create wizard**: sablon-választás → auth-method radio (Q5) → instance-mezők űrlapja a field-descriptorokból (secret-mezők a secret-store-ba, sose a formba visszaolvasva) → scope-multiselect a `scopeCatalog`-ból → materializálás → a **meglévő** draft→validál→jóváhagy→aktivál folyamat.
3. **Custom-sablon szerkesztő** (K4): új sablon / klón builtin-ből / meglévő custom szerkesztése; mentéskor **self-check** (§6/5. lépés). `connector_template:manage` permission mögött.
4. **Provenance-megjelenítés** a connector-detailen: melyik sablon melyik verziójából jött; „elavult sablon” jelzés, ha a `key`-hez van újabb `version`.

---

## 11. Szerver-actions / API réteg

`app/src/app/actions/provisioning.ts` + `app/src/lib/validators/actions.ts`:
- `listConnectorTemplatesAction` (scope = aktuális tenant).
- `createConnectorFromTemplateAction(templateId, authMethodKind, instanceValues, secrets, selectedScopes)` → secret-eket a secret-store-ba menti, materializál, majd a meglévő `createConnectorDraft`-ot hívja `sourceType='template'`, `sourceRef=templateKey@version`.
- `upsertConnectorTemplateAction` / `deprecateConnectorTemplateAction` (RBAC-gate).
- A validátor-sémákat (zod) a materializer field-descriptorokból **nem** dinamikusan generáljuk a határon; a szerver a `materializeConnectorConfig`-ban validál (egy hely).

---

## 12. Migráció és visszafelé kompatibilitás

1. **Prisma migráció**: `connector_templates` tábla + enumok + `ConnectorDraftSourceType.template`.
2. **Seed** (`prisma/seed.ts`): builtin sablonok idempotens upsertje (`google-workspace`, `microsoft-365`, `jira-cloud`, `slack` — BRD K2 első kör). A seed a kód-deklarált descriptorokból dolgozik.
3. **Backfill**: egyszeri szkript a meglévő aktív `http_api` connectorok configját kanonikusra normalizálja (`type→scheme`, `proposedTools→endpoints`, hiányzó oauth2 `tokenUrl/authUrl` explicit beírása a Google-connectoroknál — **egyszeri, auditált** aktus, utána nincs futásidejű tippelés).
4. A `parseHttpApiConfig` compat-shimjei a backfill sikeréig maradnak (§7.2), utána külön PR-ben törölhetők.
5. **Gmail**: a meglévő `gmail` connector configja a backfillben megkapja az explicit oauth-mezőket a Google-sablonból; a `looksLikeGoogle` törlése csak ezután megy élesbe.

---

## 13. Tesztterv

Vitest, a meglévő `app/scripts/*.test.ts` mintájára:

- **template-descriptor.test.ts** — séma-validáció, kötelező/opcionális mezők, discriminated union auth-methodok.
- **materializer.test.ts** — (a) minden builtin sablonból materializált config **átmegy** a `parseCanonicalConnectorConfig`-on és a `validateDraftConfig`-on; (b) oauth2 → `tokenUrl/authUrl` mindig jelen (az 1.3 bug-osztály regressziós tesztje); (c) instance-validáció hibái; (d) secret sose kerül a configba (K6).
- **connector-grant-service.test.ts** (bővítés) — a name-guessing eltávolítása után config-driven authUrl/tokenUrl/offlineParams/scopeTransform; **negatív teszt**: hiányzó tokenUrl → tiszta hiba, nem Google-default.
- **template-self-check.test.ts** — hibás custom sablon mentése elbukik a self-checken.
- **backfill.test.ts** — régi (proposedTools/type) config → kanonikus alak, idempotens.
- Meglévő `http-api-connector.test.ts`, `per-user-connector.test.ts`, `provisioning-assistant.test.ts` zölden marad (regresszió).

---

## 14. Fázisozás (szállítási sorrend)

| Fázis | Tartalom | Kimenet |
|---|---|---|
| **F1** | Kanonikus séma egységesítés (§7) + backfill (§12/3) + shim-megtartás | A két séma egy; régi connectorok működnek; **még nincs katalógus** |
| **F2** | `TemplateDescriptor` séma + `ConnectorTemplate` tábla + repo + builtin seed (Google) (§4-5, §12) | Egy builtin sablon adatként létezik |
| **F3** | Materializer + `sourceType='template'` draft-ág + governance-audit (§6, §9) | Sablonból dráft készül, végigmegy a kapun |
| **F4** | Name-guessing kivezetés (§8) — config-driven consent | `looksLikeGoogle` törölve, hot pathon nincs tippelés |
| **F5** | UI: katalógus-lista + create wizard (§10/1-2) | Admin sablonból, kódolás nélkül gyárt connectort |
| **F6** | Custom-sablon szerkesztő + RBAC + self-check (§10/3, Q4) | Admin új providert vesz fel deploy nélkül |
| **F7** | Provenance-UI + „elavult sablon” jelzés (§10/4) + shim-törlés (§7.2) | K8 láthatóság; tiszta motor |

Az F1–F4 a **strukturális** rész (a BRD igazi célja: a bug-osztály és a tippelés kivezetése); az F5–F7 a **produktivitási** rész (kód nélküli bővíthetőség). Az F1 önmagában is értéket ad (megszünteti az aszimmetriát), és külön szállítható.

---

## 15. Out of scope (a BRD §6-tal összhangban)

- Futásidejű szinkron a providerek API-változásaival.
- Sablon-frissítés visszaható alkalmazása meglévő connectorokra (csak provenance + jelzés).
- Nem-HTTP protokollok (gRPC, SOAP).
- Sablon-marketplace / tenantok közti megosztás.
- A `gmail` connector-típus tényleges kiváltása (a configját összehangoljuk, de a típus marad).

---

## 16. Nyitott implementációs kérdések (review-hoz)

1. **`instanceFields.target` DSL:** milyen kifejezőerő kell? (egyszerű dot-path vs. templated string, pl. `baseUrl` `{subdomain}` behelyettesítéssel). Javaslat: induljunk dot-path + egyszerű `{name}` interpolációval, ne teljes template-motor.
2. **Verzió-kulcs ütközés:** custom sablon `key`-je ütközhet-e builtinnel? Javaslat: nem — a `key` névtér foglalt a builtineknek; custom prefixet (pl. `custom:`) vagy tenant-scope-ot érdemes kikényszeríteni.
3. **Backfill hatóköre:** csak `active` `http_api` connectorok, vagy `draft/validated` is? Javaslat: minden nem-`archived`.
4. **`scopeTransform` bővíthetőség:** enum (`none`/`gmailAlias`) elég-e, vagy kell provider-független deklaratív mapping? Javaslat: enum most, később mapping ha új provider igényli.
5. **Secret-mezők több auth-method esetén:** ha a példány auth-methodot vált a wizardben, a már bevitt secret-alias sorsa. Javaslat: auth-method-váltás a secret-mezőket üríti.

done
