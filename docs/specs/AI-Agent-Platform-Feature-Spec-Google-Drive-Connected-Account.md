# Feature-spec — Google Drive kapcsolt fiók és agent-hozzáférés

**Verzió:** 1.1  
**Dátum:** 2026-08-25  
**Státusz:** fejlesztésre kész javaslat  
**GitHub issue:** [#378](https://github.com/giretg/enterprise-ai-agent-platform/issues/378)  
**Célközönség:** product, platform-admin, security/compliance és fejlesztők

## 0. Vezetői döntés

A Google Drive nem tehető valóban használhatóvá pusztán egy új „Összekötés” kártyával. A jelenlegi kódban a per-user OAuth, a token-vault, a grant-életciklus és a Tool Broker biztonsági alapjai nagyrészt rendelkezésre állnak, de hiányzik a Drive first-class connector-típusa, a Drive-specifikus scope-ellenőrzés, az agent tool-készlete és a dokumentumtartalom biztonságos letöltési/exportálási útja.

**Javasolt termékdöntés:**

- Az első kiadás adjon **olvasási és kontrollált írási** Google Drive-hozzáférést. A user választhasson read-only, kijelölt fájlokra szóló read/write és — admin által engedélyezve — teljes read/write profil közül.
- A Drive a meglévő **Tool Broker mögött**, providerfüggetlen saját toolokkal működjön; ne közvetlenül az OpenAI beépített Drive connectorára épüljön.
- A least-privilege alapértelmezés `drive.readonly`; az ajánlott írási profil `drive.readonly + drive.file` Google Pickerrel. A teljes `drive` scope külön admin opt-in.
- Az API-réteget ne találjuk fel újra: production dependencyként a Google official `@googleapis/drive` kliensét, Google-native tartalomíráshoz pedig az `@googleapis/docs`, `@googleapis/sheets` és `@googleapis/slides` modulokat használjuk.
- A Gmail és a Drive külön Google Cloud projectet és külön OAuth client ID-t használjon. A külön client megoldja a callback scope-ütközését, a külön project pedig a provider-oldali visszavonási életciklust is izolálja.
- Egy összekapcsolt Drive-fiók csak akkor legyen „agent által használható”, ha az adott agenthez aktív Drive connector és megfelelő Drive tool-capability is hozzá van rendelve.

**A jelenlegi állapot röviden:** a user elvileg már végig tudna menni egy generikus Google OAuth-flow-n, és egy `http_api` connector néhány Drive JSON metaadat-végpontot meg tudna hívni. Ez azonban nem elég ahhoz, hogy az agent megbízhatóan keressen és tényleges dokumentumtartalmat olvasson; a jelenlegi root `google-drive-connector-template.json` ezért prototípus, nem production megoldás.

## 1. Cél és scope

### 1.1 In scope — v1

- Google Drive megjelenítése a felhasználó „Kapcsolt fiókok” oldalán.
- Authorization Code + PKCE, offline access és refresh-token támogatás.
- Felhasználónként és connectoronként izolált Drive grant.
- Drive-fájlok keresése és listázása a felhasználó Google-jogosultságai szerint.
- Normál fájlok letöltése, Google Workspace-fájlok exportálása és szöveges tartalmuk átadása az agentnek.
- Saját meghajtó és megosztott meghajtók olvasása, valamint a grant/profile és a Google ACL által engedett írása.
- Fájl és folder létrehozása, feltöltés, tartalomfrissítés, átnevezés, mozgatás, másolás, kukába helyezés és visszaállítás.
- Google Docs, Sheets és Slides tartalmának strukturált módosítása a megfelelő Workspace API-kon keresztül.
- Szűkített megosztás konkrét userrel vagy grouppal; külön danger approval mellett.
- Agentenként explicit read/write Drive-hozzárendelés, tool-capability és írási approval policy.
- Admin provisioning, readiness-check, audit és visszavonás.
- Gmail és Drive egyidejű összekapcsolásának biztonságos működése.

### 1.2 Out of scope — v1

- Végleges `files.delete`; v1-ben csak recoverálható `trashed=true` és restore.
- Tulajdonjog-átruházás, `anyone` vagy teljes domain megosztás.
- Shared Drive létrehozása/törlése és tagságának adminisztrációja.
- Google Drive változásfigyelés, webhook vagy folyamatos indexelés.
- Domain-wide delegation / service account, amellyel a platform admin felhasználói consent nélkül kezelne Drive-okat.
- A teljes Drive-tartalom platformoldali tartós tárolása vagy központi keresőindexbe másolása.
- Közvetlen OpenAI Responses API `connector_googledrive` használata elsődleges runtime-ként.

### 1.3 Írási biztonsági határ

Az írás nem jelent korlátlan háttérjogot. Minden művelethez kell `write` agent-connector assignment és megfelelő OAuth scope. A meglévő Consequence Gate legyen az alap:

- default: író műveletenként emberi jóváhagyás;
- admin által explicit `preapproved` módban: csak lejáró, futásonként limitált, szigorú policyval engedhető automatikus create/update/rename/move/copy;
- share, trash és más danger művelet mindig per-call approval;
- permanent delete nincs;
- az approval nem tud hiányzó OAuth scope-ot, Google ACL-t vagy read-only assignmentet felülírni.

## 2. Kódfeltárás: mi van már meg, és mi hiányzik

| Terület | Jelenlegi állapot | Következmény |
|---|---|---|
| Grant-adatmodell | A `ConnectorGrant` tartalmaz usert, tenantot, connectort, scope-okat, token referenciát és állapotot. | Új Drive-specifikus grant-tábla nem kell. |
| Tokenkezelés | A refresh/access token a token-vaultban van, nem a promptban vagy a connector rekordban. Token refresh támogatott. | Az alap újrahasznosítható. |
| OAuth | Providerfüggetlen authorization-code + PKCE flow van; Google-nél offline paraméter és incremental authorization támogatás is van. | A flow bővíthető Drive-ra, de a Google scope-kezelést javítani kell. |
| Google OAuth konfiguráció | Egyetlen `oauth.google` platform setting és történeti `GMAIL_OAUTH_*` env fallback van. | Gmail és Drive jelenleg ugyanabba a kliensbe esne, ha a Drive-nak nincs saját klienskonfigurációja. |
| Delegált provider-regiszter | Csak a `gmail` first-class; az ismeretlen provider grant meglétét ellenőrzi, de tool-szintű scope-elégséget nem. | Drive-specifikus registry és scope-mátrix szükséges. |
| Connector-típus | A Prisma `ConnectorType` enum nem tartalmaz `google_drive` értéket. | A Drive generikus `http_api` lenne, így nem kap stabil saját tool-, capability- és scope-szemantikát. |
| Drive sablon | Van `google-drive-connector-template.json`, de sem a builtin katalogizálás, sem a seed nem hivatkozza. | Admin csak kézi/custom sablonként tudná használni; automatikusan nem jelenik meg. |
| Drive REST-végpontok | A sablonban a `get_file` csak fájlmetaadatot kér le. | Az agent nem kap tényleges dokumentumtartalmat. |
| Generikus HTTP kliens | JSON request/response-ra épül; bináris választ szövegként olvas, multipart uploadot nem kezel. | PDF/DOCX/XLSX letöltés és Drive-upload erre nem építhető biztonságosan. |
| Tool Broker | Capability, connector-hozzárendelés, tenant, acting user és aktív grant ellenőrzése megvan. | A Drive-t hozzá kell adni a tool requirements mátrixhoz és a registryhez. |
| Toolok | Gmail- és generikus HTTP-toolok vannak, Drive-toolok nincsenek. | Az agent nem tudja megbízhatóan, szemantikusan használni a Drive-ot. |
| Kapcsolt fiókok UI | Az aktív `user_delegated` connectorokat automatikusan listázza. A Gmailnek saját szövege/scope-választója van; a Google provider ikonja Gmail ikon. | Egy aktivált generikus Drive megjelenhetne, de hibás ikonnal, generikus szöveggel és Drive-scope UX nélkül. |
| Provisioning | Template → validate → sandbox → review → activate → agent assignment folyamat létezik. A platform Google OAuth readiness csak Gmailre first-class. | Drive readiness és Drive OAuth beállítás külön szükséges. |
| OpenAI Drive connector | Az OpenAI támogat `connector_googledrive` connectort, de a platform jelenlegi tool-loopja nincs erre bekötve. | Közvetlen használata új, OpenAI-specifikus runtime-ág lenne, és külön kellene integrálni a Broker/audit/capability kapukkal. |

### 2.1 Érintett jelenlegi kód

- `app/prisma/schema.prisma` — `ConnectorType`, `ConnectorGrant`, `AgentConnector`.
- `app/src/domain/connector-grant/connector-grant-service.ts` — OAuth, PKCE, scope-visszaellenőrzés, token refresh.
- `app/src/domain/connector-grant/delegated-oauth-registry.ts` — provider- és tool-scope szabályok.
- `app/src/lib/platform-google-oauth-config.ts` — egyetlen Google OAuth platformkonfiguráció.
- `app/src/domain/connector-template/template-descriptor.ts` és `builtin-templates.ts` — connector-típusok és seedelt sablonok.
- `app/src/domain/tool-broker/tool-connector-requirements.ts` és `tool-broker-authorizer.ts` — capability/connector/grant kapu.
- `app/src/domain/connector/http-api-client.ts` — generikus JSON HTTP adapter.
- `app/src/components/account/linked-accounts-panel.tsx`, `connector-connection-card.tsx`, `provider-icon.tsx` — user UI.
- `app/src/app/control-plane/system/delegated-connectors-admin-panel.tsx` és a provisioning oldalak — admin readiness és aktiválás.
- `google-drive-connector-template.json` — jelenlegi, kódba be nem kötött Drive-váz.

## 3. Mikor tudja egy agent ténylegesen használni a Drive-ot?

A hozzáférés csak akkor engedélyezett, ha a teljes lánc minden eleme igaz:

```text
Google/Workspace policy engedi az OAuth appot
  AND a user consentje aktív és tartalmazza a szükséges scope-ot
  AND a Google-fájl ACL-je engedi az adott usernek a fájl olvasását
  AND a platform Drive connector aktív és az adott tenant számára látható
  AND az agenthez az adott művelethez read vagy write módban hozzá van rendelve
  AND az agent verziójának megvan a konkrét Drive tool-capabilityje
  AND a futásnak van hiteles actingUserId-ja
  AND az acting userhez aktív ConnectorGrant tartozik
  AND a grant scope-ja elegendő az adott toolhoz
```

Bármely feltétel hiánya `DENY`, audit és javítható felhasználói/admin hibaüzenet legyen. Nem lehet service credentialre, másik user grantjére vagy egy másik `http_api` connectorra csendben fallbackelni.

**Válasz a központi kérdésre:** a jelenlegi kódban egy Drive-fiók összekapcsolása után az AI agentek **nem automatikusan** tudják azt érdemben használni. A grant-infrastruktúra megvan, de kell agent-hozzárendelés, capability, Drive-tool és tartalomadapter. Ezek nélkül legfeljebb generikus metaadat-hívás lehetséges.

## 4. Javasolt célarchitektúra

### 4.1 First-class `google_drive` connector

Új Prisma enumérték:

```prisma
enum ConnectorType {
  knowledge_base
  board
  gmail
  google_drive
  workspace
  http_api
  web_search
}
```

Indoklás:

- nem az első hozzárendelt `http_api` connectorra bízzuk a feloldást;
- a tool requirements mátrix típusbiztos marad;
- lehet Drive-specifikus scope-ellenőrzés és felhasználói üzenet;
- az admin egyértelműen látja, melyik agent használ Drive-ot;
- több model provider ugyanazt a Broker-kontraktust használhatja.

### 4.2 V1 tool-kontraktus

```ts
google_drive_search({
  query?: string,
  nameContains?: string,
  mimeTypes?: string[],
  modifiedAfter?: string,
  driveId?: string,
  pageSize?: number,
  pageToken?: string
})
  -> { files: DriveFileSummary[], nextPageToken?: string }

google_drive_get_file({ fileId: string })
  -> { id, name, mimeType, modifiedTime, size?, webViewLink?, driveId?, owners? }

google_drive_read_file({
  fileId: string,
  maxBytes?: number,
  sheetName?: string
})
  -> { file, contentType, text?, artifactRef?, truncated, warnings[] }

google_drive_list_drives({ pageSize?: number, pageToken?: string })
  -> { drives: [{ id, name }], nextPageToken?: string }

google_drive_create_folder({ name: string, parentFolderId?: string, idempotencyKey: string })
  -> { file: DriveFileSummary, created: boolean }

google_drive_upload_file({
  artifactRef: string,
  name?: string,
  parentFolderId?: string,
  convertToGoogleType?: 'doc' | 'sheet' | 'slides',
  idempotencyKey: string
})
  -> { file: DriveFileSummary, created: boolean }

google_drive_update_file({
  fileId: string,
  artifactRef?: string,
  textContent?: string,
  expectedModifiedTime?: string,
  idempotencyKey: string
})
  -> { file: DriveFileSummary, conflict: boolean }

google_drive_rename_file({ fileId: string, newName: string })
google_drive_move_file({ fileId: string, destinationFolderId: string })
google_drive_copy_file({ fileId: string, newName?: string, parentFolderId?: string, idempotencyKey: string })
google_drive_trash_file({ fileId: string })
google_drive_restore_file({ fileId: string })

google_drive_share_file({
  fileId: string,
  recipientType: 'user' | 'group',
  emailAddress: string,
  role: 'reader' | 'commenter' | 'writer',
  sendNotificationEmail?: boolean,
  emailMessage?: string
})
  -> { permissionId: string }

google_docs_apply_edits({ fileId: string, operations: DocsEditOperation[] })
google_sheets_write_range({ fileId: string, range: string, values: Scalar[][], mode?: 'replace' | 'append' })
google_slides_apply_edits({ fileId: string, operations: SlidesEditOperation[] })
```

Az első négy tool `ConnectorAccessMode.read`, a többi `write`. A keresés a Drive API `files.list` végpontját használja explicit `fields` projekcióval. Shared Drive esetén kezelni kell a `supportsAllDrives`, `includeItemsFromAllDrives`, `corpora` és `driveId` paramétereket.

Az upload tool kizárólag tenant-ellenőrzött `artifactRef`-et fogad; tetszőleges szerveroldali `localPath`, URL vagy korlátlan base64 nem lehet modellargumentum. A native Docs/Sheets/Slides tartalmat nem szabad `files.update` médiacserének álcázni: a megfelelő Docs/Sheets/Slides `batchUpdate`/values API-t kell használni.

### 4.2.1 Tool-kockázati mátrix

| Toolcsoport | Access mode | Consequence Gate |
|---|---|---|
| search/get/read/list | `read` | nincs approval |
| create folder, upload, create/copy | `write` | default per-call; admin strict preapproval engedhető limittel és lejárattal |
| tartalomfrissítés, Docs/Sheets/Slides edit, rename/move/restore | `write` | default per-call; strict preapproval engedhető |
| share/permission változás | `write` + danger | mindig per-call; `anyone`, domain és owner tiltott |
| trash | `write` + danger | mindig per-call |
| permanent delete | nincs tool | v1-ben tiltott |

Az új Drive toolokat be kell kötni a `SIDE_EFFECTING_TOOLS` és a consequence risk-class registrybe. Az ismeretlen Drive write tool fail-safe módon approval-köteles. Az approval fingerprint tartalmazza a connector ID-t, file/folder ID-t, célcímet, szerepkört és content/artifact hash-t, de nem a fájltartalmat.

### 4.3 Tartalomolvasási pipeline

| Drive MIME-típus | Eljárás |
|---|---|
| Google Docs | `files.export` → `text/plain` vagy DOCX; elsődlegesen tisztított szöveg. |
| Google Sheets | `files.export` → XLSX/CSV; a meglévő spreadsheet reader használata. |
| Google Slides | `files.export` → PPTX vagy PDF; a meglévő presentation/PDF reader használata. |
| PDF, DOCX, XLSX, PPTX, TXT, CSV | `files.get?alt=media`; izolált ideiglenes artifact, majd meglévő dokumentumadapter. |
| Nem támogatott vagy túl nagy fájl | Strukturált hiba, metaadat és letöltési/view link; nincs nyers bináris a modellkontextusban. |

Kötelező korlátok:

- konfigurálható maximális letöltési és kinyert szövegméret;
- MIME allowlist;
- timeout, lapozás és rate-limit/backoff;
- a bináris és az OAuth token soha nem kerül promptba vagy audit payloadba;
- ideiglenes artifact automatikus törlése a retention policy szerint;
- a Drive-dokumentum tartalma nem megbízható input: prompt-injectionként kell kezelni, és nem írhatja felül az agent/tool policyt.

### 4.4 Miért nem az OpenAI connector az elsődleges megoldás?

Az OpenAI hivatalos connectora valóban biztosít Drive `search`, `fetch`, `recent_documents` és drive-listázó műveleteket `drive.readonly` scope-pal. A Responses API híváshoz azonban az alkalmazásnak kell átadnia a felhasználói OAuth access tokent, és a funkció OpenAI runtime-hoz kötött.

A platform jelenleg saját Tool Brokeren keresztül biztosít:

- model-provider függetlenséget;
- agent capabilityt és connector-hozzárendelést;
- acting-user/grant ellenőrzést;
- egységes auditot, approvalt és token-injektálást.

Ezért a v1 saját Broker-toolokat használjon. Az írás ezt véglegessé teszi: az OpenAI dokumentált `connector_googledrive` toolkészlete read-only, szélesebb token megadása sem hoz létre write toolokat. Később készülhet OpenAI-specifikus read adapter ugyanazon Broker-authorize után, de az access token nem kerülhet a modell által látható inputba/logba, és az OpenAI toolhívás eredményének ugyanazon audit- és adatkezelési szabályokon kell átmennie.

### 4.5 Újrahasznosítható kód és library döntés

A részletes vizsgálat: [`docs/research/google-drive-write-tool-reuse-options.md`](../research/google-drive-write-tool-reuse-options.md).

| Forrás | Döntés | Mire használjuk? |
|---|---|---|
| [`@googleapis/drive`](https://www.npmjs.com/package/@googleapis/drive) | **production dependency** | Drive v3 types, files/permissions/drives/revisions, stream, multipart/resumable upload, shared-drive paraméterek. |
| `@googleapis/docs`, `@googleapis/sheets`, `@googleapis/slides` | **production dependency, ha az adott native edit tool bekerül** | Google-native dokumentumtartalom írása. |
| [`googleapis/google-api-nodejs-client`](https://github.com/googleapis/google-api-nodejs-client) és [`googleworkspace/node-samples`](https://github.com/googleworkspace/node-samples/tree/main/drive) | **official referenciakód** | upload, stream download/export, move, share és hibakezelési minták. |
| [`piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp) | **tanulási referencia, nem runtime dependency** | Tool-sémák, MIME/export routing, permissions, shared drives és tesztesetek. Saját token-store, localPath és túl széles default scope nem vehető át. |
| Egyéb community Drive MCP szerverek | **ne építsünk rájuk közvetlenül** | Ötletforrás lehet, de nem helyettesíthetik a Broker/grant/audit/approval réteget. |

Javasolt deep-module határ:

```text
Tool Broker → GoogleDriveService
               ├─ @googleapis/drive
               ├─ @googleapis/docs
               ├─ @googleapis/sheets
               └─ @googleapis/slides
```

A service request-élettartamú OAuth kliensnek csak a Broker által frissített access tokent adjuk. Refresh token, account store és OAuth callback nem kerülhet a Google SDK/MCP adapter felelősségébe.

## 5. OAuth- és scope-terv

### 5.1 V1 scope-profilok

Mindegyik profil kér `openid` és `email` scope-ot az account identity/címke miatt.

| UI-profil | Drive scope-ok | Mit tud? | Elérhetőség |
|---|---|---|---|
| **Csak olvasás** | `drive.readonly` | Teljes keresés és olvasás a user Google ACL-je szerint, írás nélkül. | mindig; least-privilege default |
| **Olvasás + írás kijelölt fájlokon** | `drive.readonly` + `drive.file` | Minden olvasható fájl kereshető/olvasható; írni csak az app által létrehozott vagy Google Pickerrel kiválasztott fájlba/folderbe lehet. | ajánlott írási profil |
| **Teljes olvasás + írás** | `drive` | Minden, a user által kezelhető fájl írása is. | csak admin által engedélyezett, külön figyelmeztetett profil |

A `drive.readonly` és a `drive` restricted scope. A `drive.file` non-sensitive per-file scope, de a read+write-selected profil a teljes olvasás miatt továbbra is restricted-scope compliance alá esik. A `drive.file` önmagában nem ad teljes Drive-keresést.

A Docs, Sheets és Slides write API-k az official method reference szerint elfogadják a `drive.file` vagy `drive` scope-ot is. Ne kérjünk automatikusan teljes `documents`, `spreadsheets` vagy `presentations` scope-ot, ha a Drive scope elegendő.

### 5.1.1 Google Picker

A kijelölt-fájlos write profilhoz Picker UX kötelező:

1. OAuth consent után a user „Írható fájlok/folder kiválasztása” műveletet indít.
2. A frontend a Google Picker API-t nyitja a user rövid életű access tokenjével.
3. A Picker `fileId`/folder ID eredményét a backend ugyanazzal az acting user + connector + tenant kötéssel validálja.
4. A platform a kiválasztást csak UX/audit manifestként tárolja; az authority a Google `drive.file` grant és a Google ACL marad.
5. Sikertelen/lejárt hozzáférésnél a write tool 403-at actionable „válaszd ki újra” hibára képez, nem próbál full-drive fallbacket.

Provisioninghez kell a Google Picker API, origin/API szerint korlátozott API key és Cloud project number (`APP_ID`). A frontendnek adott Picker API key nem secret, de szigorúan originre és a Picker API-ra kell korlátozni.

### 5.2 Gmail–Drive scope-izoláció

A jelenlegi `connector-grant-service.ts` Google-nél `include_granted_scopes=true` paramétert ad, majd elutasít minden olyan visszakapott scope-ot, amely nincs az adott connector konfigurációjában. Ha Gmail és Drive ugyanazt az OAuth client ID-t használja, Google incremental authorization esetén a válasz korábbi Gmail scope-okat is tartalmazhat a Drive callbackben, vagy fordítva. Ez callback-hibához és fizikailag túl széles tokenhez vezethet.

**Kötelező v1 megoldás:** külön OAuth project és web client:

- `oauth.google.gmail` — jelenlegi Gmail;
- `oauth.google.drive` — új Drive;
- a Drive saját Google Cloud projectet, consent konfigurációt és client ID/secretet kap;
- ugyanaz a callback URL használható, ha mindkét kliens redirect URI listáján szerepel;
- config feloldási sorrend Drive esetén: connector saját konfiguráció → `oauth.google.drive`; a történeti `oauth.google`/`GMAIL_OAUTH_*` fallback csak explicit backward-compatibility flaggel legyen megengedett.

A külön project nem csak a least privilege miatt fontos. A Google token-revocation a projekthez korábban adott scope-okat és tokeneket együtt is érintheti; közös projectnél a „Drive leválasztása” a Gmail-kapcsolatot is bonthatja. Ha az admin tudatosan közös projectet választ, a UI nem ígérhet szolgáltatásonként független provider-revoke-ot: a Drive-only leválasztás csak lokálisan törli/tiltja a Drive grantet, a teljes Google-visszavonás pedig külön, figyelmeztetett művelet legyen.

Ha üzleti döntés mégis közös client ID-t ír elő, a scope-kezelést át kell tervezni és integrációs teszttel igazolni kell: a provider által visszaadott scope-unióból a connector csak a saját kért/konfigurált scope-jait tárolhatja és authorizálhatja. Ettől a mögöttes token még szélesebb jogosultságú lehet, ezért ez a megoldás gyengébb izolációjú és nem ajánlott.

### 5.3 OAuth biztonsági követelmények

- Authorization Code + PKCE és aláírt, rövid életű, egyszer használható `state`.
- `access_type=offline`; a callback refresh tokent várjon el.
- Redirect URI exact match és HTTPS productionben.
- Client secret és user token csak secret store-ban; platform setting rekord ne tároljon visszaolvasható nyers secretet.
- Account/tenant/user/connector kötés ellenőrzése callbackben.
- Elkülönített Drive projectnél provider oldali token-revocation disconnectkor: `https://oauth2.googleapis.com/revoke`, utána lokális token törlés és grant revoke. Közös Google projectnél a project-szintű kereszt-hatás miatt a 5.2 szerinti külön UX/policy kötelező.
- Token refresh hibánál grant `expired`/reconnect-needed állapot, csendes fallback nélkül.
- Reconnect callbackben a Google által esetleg nem újraküldött refresh token nem nullázhatja a meglévő, még érvényes refresh tokent.
- Scope-változáskor re-consent; meglévő grant ne kapjon automatikusan szélesebb jogosultságot. Read-only → write upgrade külön user-aktus.
- A kiválasztott profil és a ténylegesen visszaadott scope-ok egyezését callback után ellenőrizni kell; granular consenttel hiányosan megadott write scope esetén a kapcsolat maradjon read-only/reconnect-needed, ne „read/write”.

## 6. Fejlesztési munkacsomagok

### GD-1 — Domain, séma és builtin template

1. `ConnectorType.google_drive` hozzáadása és Prisma migráció/generálás.
2. A template descriptor engedélyezze a `google_drive` típust.
3. A `google-drive` sablon kerüljön a `BUILTIN_CONNECTOR_TEMPLATES` listába és a seed/sync folyamatba.
4. A sablon a három explicit scope-profilt és a read/write endpoint-katalógust tartalmazza; permanent delete endpoint nincs.
5. Egress hostok: `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `drive.googleapis.com`.
6. Migrációs/backfill script hozza létre a builtin draftot meglévő telepítéseken is.

**Elfogadás:** új telepítésen és upgrade után az admin látja a Google Drive builtin sablont, kézi JSON import nélkül.

### GD-2 — Platform Google OAuth konfiguráció

1. A `platform-google-oauth-config` modell legyen szolgáltatásonként kulcsolt (`gmail`, `drive`).
2. Új env-ek: `GOOGLE_DRIVE_OAUTH_CLIENT_ID`, `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`, `GOOGLE_DRIVE_OAUTH_REDIRECT_URI`.
3. Platform settings UI-n külön Gmail és Google Drive readiness kártya.
4. A secret értéket Secret Manager/alias tárolja; UI csak configured/not configured állapotot mutasson.
5. Drive aktiválás legyen blokkolva hiányzó client ID, secret vagy redirect URI esetén.
6. Pickeres write profilhoz külön `GOOGLE_DRIVE_PICKER_API_KEY` és `GOOGLE_DRIVE_PICKER_APP_ID`/project number setting, origin/API restriction readinessszel.

**Elfogadás:** Gmail-only környezet változatlanul működik; Drive csak saját, teljes konfigurációval aktiválható.

### GD-3 — Delegált OAuth provider és grant

1. Új `google-drive-scopes.ts` normalizáló és tool → minimális scope mátrix.
2. `google_drive` provider regisztrálása a `delegated-oauth-registry.ts` fájlban.
3. Scope-elégség ellenőrzése minden Drive tool előtt.
4. Read-only, selected-write és full-write profil; upgrade/downgrade/re-consent állapotgép.
5. Picker selection manifest és backend validation az acting user grantjével.
6. Provider revocation és reconnect-needed állapot implementálása.
7. Gmail + Drive külön és egymás utáni consent flow integrációs tesztje.

**Elfogadás:** `drive.metadata.readonly` granttel a tartalomolvasás DENY; `drive.readonly` granttel az olvasás ALLOW, az írás DENY; `drive.file` esetén csak kiválasztott/app által létrehozott fájl írható; full `drive` csak adminengedélyezett profilból kérhető. Másik user grantje sosem használható.

### GD-4 — Drive API kliens és content adapter

1. Közvetlen production dependency: `@googleapis/drive`; a refresh tokent nem kezelő, request-élettartamú adapter.
2. `files.list/get/export/create/update/copy`, `drives.list`, `permissions.*` és szükséges revision műveletek.
3. Stream download, multipart/resumable upload, Shared Drive paraméterek és lapozás.
4. MIME-alapú exporter/router és integráció a meglévő PDF/DOCX/XLSX/PPTX olvasókkal.
5. Google-native edithez moduláris `@googleapis/docs`, `@googleapis/sheets`, `@googleapis/slides` adapterek.
6. Upload csak `artifactRef`-ből; artifact tenant/ownership és retention ellenőrzés.
7. Create/upload idempotency key, update conflict check, biztonságos retry-policy.
8. Méret-, MIME-, timeout-, rate-limit-, fájlszám- és futásonkénti write limit.
9. Strukturált, redaktált hibák; Google response body, token és dokumentumtartalom nem kerülhet auditba.

**Elfogadás:** az agent ténylegesen olvas és — scope/ACL szerint — létrehoz, feltölt, frissít és szervez fájlokat; Google Doc/Sheet/Slides tartalmat a natív API-val módosít. Retry nem hoz létre duplikált fájlt.

### GD-5 — Tool Broker és agent capabilities

1. Új ToolName-ek és JSON schema-k a 4.2 szerint.
2. Új Drive handler a Tool Brokerben.
3. `TOOL_REQUIREMENTS` Drive read/write mapping.
4. Az agent-connector hozzárendelés/szinkronizálás támogassa a `google_drive` típust és write approval trustot.
5. Drive tool risk-classok a Side Effect/Consequence Gate registryben; danger mindig per-call.
6. A ConsequenceApproval payload/fingerprint tudja a Drive műveleteket és a jóváhagyás utáni biztonságos replayt.
7. A modell system prompt/tool catalog kapjon emberileg egyértelmű Drive tool-leírásokat és connector ID-t.
8. Audit: agent/version, acting user, grant, connector, tool, file ID, content hash és eredmény státusz; dokumentumtartalom nélkül.

**Elfogadás:** azonos agent+user mellett assignment nélkül DENY, assignment és aktív grant mellett ALLOW. Több connector esetén nincs „első találat” alapú téves feloldás.

### GD-6 — Kapcsolt fiókok user UX

1. Google Drive ikon, címke és read/write leírás.
2. „Összekötés” OAuth indítás read-only, selected-write vagy adminengedélyezett full-write profillal; read-only legyen a least-privilege default.
3. Selected-write profilnál Picker CTA és a kiválasztott írható célok kezelése.
4. Kapcsolt állapotban account email, grant scope-profil, írható célok, utolsó sikeres használat/reconnect státusz és „Leválasztás”.
5. A jelenlegi általános szöveg helyett külön állapotok:
   - „Fiók összekötve, de még nincs agenthez rendelve”;
   - „Használható N agent által”;
   - „Újracsatlakoztatás szükséges”.
6. Scope-emelés csak új consenttel; write downgrade azonnal vonja vissza a platform write tool-engedélyét.
7. Jóváhagyási kártya mutassa a műveletet, fájlnevet/ID-t, célfoldert/recipientet és tartalomhash-t, nyers tartalom nélkül.
8. Felhasználóbarát hibák Workspace-admin tiltásra, scope-hiányra, Picker-újraválasztásra, konfliktusra és refresh-token hibára.

**Elfogadás:** a user nem kapja azt a hamis benyomást, hogy az összekötés önmagában már használhatóvá tette a Drive-ot minden agentnek.

### GD-7 — Admin provisioning és readiness

1. Google Drive builtin draft létrehozása/szinkronizálása.
2. Readiness panel a 7. fejezet checklistje szerint.
3. Validate: base URL, OAuth végpontok, scope-profilok, callback, egress, Picker config és write risk policy.
4. Sandbox csak strukturális/egress ellenőrzést végezzen consent előtt; valódi Drive API smoke csak tesztuser grant után legyen „verified”.
5. Review/approve/activate folyamat.
6. Tenantláthatóság és explicit read/write agent assignment; full-write és preapproval külön admin aktus.
7. Admin lássa, hány aktív user grant és agent assignment tartozik a connectorhoz, tokenek nélkül.

**Elfogadás:** hiányos Google Cloud vagy platform OAuth beállításnál aktiválás blokkolt; aktív connector assignment nélkül nem ad tool-jogot.

### GD-8 — Security, audit és lifecycle

1. Local disconnect + Google revoke endpoint best-effort meghívás; lokális revoke akkor is megtörténik, ha Google nem elérhető.
2. User suspend/delete és connector deactivate esetén grant/tool hozzáférés azonnali DENY.
3. Scope- és connector-konfiguráció változása auditált.
4. Monitoring: OAuth callback failure, refresh failure, 401/403, Picker failure, write conflict, idempotency hit, rate limit, upload/export/size rejection.
5. Tartalom és fájlnév logolási policy: file ID/name csak a vállalati auditbesorolás szerint; extracted content alapból nem logolható.
6. GDPR/offboarding token- és artifact-törlés.

### GD-9 — Tesztcsomag

- Unit: scope normalizálás, tool-scope/risk mátrix, MIME router, idempotency, conflict és Google API hibamapping.
- Contract: tool input/output schema és Drive API fixtures.
- Authorization negatív tesztek: nincs capability, nincs assignment, nincs acting user, másik user, revoked/expired grant, hiányos scope, suspended user, inactive connector.
- OAuth integráció: PKCE/state, offline refresh, provider revoke, Gmail + Drive egymás után.
- Content: Google Doc, Sheet, Slides, PDF, DOCX olvasás és írás, upload, nagy/tiltott fájl, shared drive.
- Write: create/upload/update/rename/move/copy/trash/restore/share; approval, strict preapproval budget és danger fallback.
- Picker: kijelölt fájl ALLOW, nem kijelölt fájl DENY, újraválasztás után ALLOW.
- UI: disconnected/connected/unassigned/usable/reconnect állapotok.
- Provisioning: incomplete readiness blokkol, teljes readiness aktivál.
- Live smoke: teszt Google Workspace userrel search → read → create/upload → update → approvalos trash/restore → token refresh → disconnect → DENY.

## 7. Admin provisioning — szükséges beállítások

A jelenlegi kód platformszintű Google OAuth konfigurációt old fel, és a grant-flow szándékosan nem keres idegen tenant settingekből client secretet. A v1 ezért **platform-owned Google OAuth appot** feltételez:

- egyetlen vállalati Google Workspace szervezetet kiszolgáló deploymentnél `Internal` audience használható;
- több, egymástól független customer Workspace domaint kiszolgáló SaaS-nál `External`, production/published és verifikált app szükséges;
- tenantonkénti `Internal`/BYO Google app külön feature: tenant-szintű titokfeloldást, credential-routingot, admin UX-et és isolation teszteket igényel, ezért nem tekinthető puszta provisioning beállításnak.

### 7.1 Google Cloud admin

1. Hozzon létre külön Google Cloud projectet a Drive-integrációhoz; dev/test és production környezethez is külön project ajánlott. A Drive project ne legyen a Gmail projectje, ha szolgáltatásonként független disconnect az elvárás.
2. Engedélyezze a **Google Drive API**-t; native tartalommódosításhoz a **Google Docs API**, **Google Sheets API** és **Google Slides API** szolgáltatásokat is. Selected-write profilhoz engedélyezze a **Google Picker API**-t.
3. Állítsa be az OAuth consent screent:
   - belső vállalati használatnál lehetőség szerint `Internal` audience;
   - app név, support email, developer contact és hitelesített domainek;
   - `openid`, `email`, `drive.readonly`, `drive.file`, és ha engedélyezett, `drive` scope-ok;
   - adatkezelési és privacy információk.
4. Hozzon létre külön **Web application OAuth clientet Google Drive-hoz**.
5. Vegye fel pontosan a platform callback URL-jét, például `https://<platform-domain>/api/connectors/oauth/callback`.
6. Pickerhez hozzon létre API keyt, korlátozza a platform HTTPS originkészletére és kizárólag a Google Picker API-ra; rögzítse a Cloud project numbert mint Picker App ID.
7. Állítsa az appot production/published státuszba az éles használathoz. Google `Testing` módban a tesztuser- és tokenélettartam-korlátok miatt tartós production működés nem várható.
8. External audience és restricted scope esetén indítsa el a szükséges Google OAuth app verificationt; ha a platform restricted scope adatot szerveren tárol vagy továbbít, a Google előírásai szerint security assessmentre és annak rendszeres megújítására is készülni kell.

### 7.2 Google Workspace admin

1. Admin console: **Security → Access and data control → API controls → Manage Third-Party App Access**.
2. A Drive OAuth client ID-t állítsa `Trusted` vagy `Specific Google data` állapotba a szervezeti policy szerint.
3. `Specific Google data` esetén engedje a kiválasztott profilhoz szükséges Drive és sign-in scope-okat; full `drive` scope külön admin döntés legyen.
4. Ellenőrizze, hogy a Google Drive szolgáltatás engedélyezett-e a cél organizational unit/group számára.
5. Ha a Workspace policy korlátozza a high-risk/restricted szolgáltatásokat, engedélyezze ezt az appot a megfelelő OU/group számára.

### 7.3 Platform superadmin

1. Adja meg a Drive OAuth client ID-t, secretet és redirect URI-t a platform settingsben/secret store-ban.
2. Selected-write profilhoz adja meg a Picker API keyt és App ID/project numbert; readiness ellenőrizze az origin/API restriction admin-igazolását.
3. Szinkronizálja a Google Drive builtin template-et.
4. Engedélyezze az egress hostokat.
5. Futtassa a template validate és sandbox ellenőrzéseket.
6. Security/review approval után aktiválja a tenant számára, és külön kapcsolja be az engedélyezett scope-profilokat.
7. Rendelje hozzá read vagy write módban a kiválasztott agentekhez, engedélyezze a toolokat, és write esetén állítsa be a per-call/preapproved trustot.
8. Tesztuserrel végezze el a consentet, Picker-kiválasztást és a read/write live smoke-ot.
9. Csak sikeres smoke után jelezze a connectort `verified/ready` állapotúnak.

## 8. UI- és API-követelmények

### 8.1 User UI

- Szolgáltatásnév: **Google Drive**.
- Leírás: „Az AI munkatárs a te engedélyeddel kereshet és olvashat Drive-fájlokat. Ha írási profilt választasz, a jóváhagyási szabályok szerint létrehozhat vagy módosíthat fájlokat is.”
- Scope-profilok: **Csak olvasás**, **Olvasás + írás kijelölt fájlokon**, és adminengedéllyel **Teljes olvasás + írás**.
- Selected-write profilnál a user Pickerrel látja és módosítja az írható fájlok/folderek listáját.
- A consent előtt rövid adatkezelési tájékoztató: a kiválasztott agent a kérés teljesítéséhez fájltartalmat küldhet a konfigurált AI modell szolgáltatójának.
- A leválasztás hatása azonnali; UI jelzi, hogy az agentek többé nem férnek hozzá.

### 8.2 Admin UI

Readiness státuszok külön-külön:

- Drive API enabled — ezt a Google API valódi hívása tudja bizonyítani;
- OAuth client ID configured;
- OAuth client secret configured;
- redirect URI configured/matches;
- Picker API key + App ID configured és restriction igazolt;
- Drive/Docs/Sheets/Slides/Picker API readiness;
- consent/audience/compliance — admin által igazolt checklist;
- egress allowed;
- connector validated/reviewed/active;
- legalább egy agent assigned;
- live OAuth/API smoke verified.

Ne állítsuk automatikusan, hogy a Google Cloud API engedélyezett pusztán a client ID meglétéből. A végső bizonyíték egy consent utáni `about.get` vagy minimális `files.list` smoke.

## 9. Elfogadási kritériumok

### 9.1 Funkcionális

1. Az aktív Drive connector megjelenik a Kapcsolt fiókok oldalon saját ikonnal és szöveggel.
2. A user összeköti a Google-fiókját; a platform aktív grantet és account emailt mutat, nyers tokent nem tárol/logol az adatbázisban.
3. Hozzárendelt agent keresni tud a user My Drive és engedélyezett shared drive fájljai között.
4. Az agent ténylegesen ki tudja olvasni Google Doc, Sheet, PDF és DOCX tartalmát.
5. A fájlkeresés és -olvasás csak olyan fájlra sikerül, amelyet a kapcsolt Google-user ACL-je enged.
6. Leválasztás után a következő toolhívás DENY, cache-elt access tokennel sem folytatható.
7. Gmail és Drive ugyanazon usernél egyszerre működik scope-ütközés nélkül.
8. Selected-write user Pickerrel kijelölt folderbe fájlt tölthet fel, azt frissítheti, átnevezheti és mozgathatja; nem kijelölt írható cél 403/DENY.
9. Full-write profil csak admin opt-in után jelenik meg és kérhető.
10. Google Doc, Sheet és Slides tartalomírás a natív API-kon keresztül működik.
11. Share és trash csak jóváhagyás után fut; retry nem duplikál create/upload műveletet.

### 9.2 Kötelező negatív

1. Capability nélkül DENY.
2. AgentConnector assignment nélkül DENY.
3. Acting user nélkül DENY, kivéve későbbi explicit run-as feature.
4. Másik user grantjével DENY.
5. Revoked/expired/insufficient-scope granttel DENY.
6. Inactive connectorral vagy suspended userrel DENY.
7. Nem támogatott/túl nagy fájlnál kontrollált hiba; nincs memória- vagy kontextustúlcsordulás.
8. Read-only assignmenttel vagy `drive.readonly` granttel write tool DENY; approval sem oldhatja fel.
9. Selected-write granttel nem Picker-kiválasztott, nem app-created fájl módosítása DENY/403; nincs full-drive fallback.
10. Permanent delete, owner transfer, `anyone` és domain share tool nincs, és generikus HTTP toolon keresztül sem kerülhető meg.
11. Approval nélküli danger művelet DENY; lejárt/elfogyott preapproval budget per-call approvalra esik vissza.
12. Ugyanazon idempotency key ismétlése nem hoz létre új fájlt; konfliktusos update nem ír felül újabb verziót csendben.
13. Token, client secret és dokumentumtartalom nem jelenik meg auditban, application logban vagy modellnek adott tool argumentumban.

## 10. Kiadási sorrend

1. **Alap:** GD-1 + GD-2 + GD-3 — séma, builtin template, Drive OAuth, scope-izoláció.
2. **Runtime:** GD-4 + GD-5 — Drive kliens, content pipeline, toolok, capability/assignment.
3. **Felületek:** GD-6 + GD-7 — connected accounts és admin readiness/provisioning.
4. **Hardening:** GD-8 + GD-9 — revoke, audit, negatív tesztek, live smoke.
5. **Pilot:** egy belső Workspace tenant, külön Drive OAuth kliens; először selected-write + Picker, majd külön full-write pilot, ha üzletileg szükséges.
6. **Általános kiadás:** csak security/compliance sign-off és sikeres pilot után.

Migrációnál a meglévő Gmail grantjei változatlanok maradnak. A root `google-drive-connector-template.json` ne legyen automatikusan production connectorrá alakítva; a builtin v1 sablon legyen új, first-class és explicit scope/risk profilú. Korábban kézzel létrehozott `provider=google-drive`, `type=http_api` connectorokat inventoryzni kell, majd admin jóváhagyással migrálni vagy deaktiválni.

## 11. Források és megfelelőségi hivatkozások

A részletes dokumentációs kutatás: [`docs/research/google-drive-oauth-openai-connector.md`](../research/google-drive-oauth-openai-connector.md).
A library/reuse vizsgálat: [`docs/research/google-drive-write-tool-reuse-options.md`](../research/google-drive-write-tool-reuse-options.md).

- [Google Drive API OAuth scope-ok](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) — a `drive.readonly` restricted scope; a `drive.file` szűkebb, Pickerrel ajánlott.
- [Google OAuth 2.0 web server flow](https://developers.google.com/identity/protocols/oauth2/web-server) — offline access, refresh token, exact redirect URI, state, incremental authorization és revocation.
- [Google OAuth app audience/publishing](https://support.google.com/cloud/answer/15549945?hl=en) — Internal/External, Testing/Production korlátok.
- [Google restricted-scope verification](https://support.google.com/cloud/answer/13464321) és [security assessment](https://support.google.com/cloud/answer/13465431) — external production megfelelőségi követelmények.
- [Google Workspace API controls](https://support.google.com/a/answer/7281227?hl=en&p=app_access_apps) — third-party app access és OAuth client allowlisting.
- [OpenAI connectors and remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) — `connector_googledrive`, alkalmazás által átadott OAuth token, tool- és approval-beállítások.
- [Google official Node.js API client](https://github.com/googleapis/google-api-nodejs-client) és [Workspace Node samples](https://github.com/googleworkspace/node-samples/tree/main/drive) — Drive v3 kliens, upload/download/export/move/share minták.
- [Google Picker sample](https://developers.google.com/workspace/drive/picker/guides/sample) — `drive.file` kiválasztási UX, API key, App ID és OAuth token.

## 12. Definition of Done

A feature csak akkor kész, ha nemcsak a Google OAuth consent sikeres, hanem egy hozzárendelt agent a saját Tool Brokerén át, az aktuális acting user grantjével képes valós Drive-dokumentumtartalmat keresni, olvasni és a kiválasztott scope/ACL szerint írni; a create/update/upload/native edit és approvalos share/trash út tesztelt, nincs permanent delete, a teljes permission chain és provisioning dokumentált, a Gmail–Drive scope-izoláció igazolt, és disconnect után a hozzáférés azonnal megszűnik.
