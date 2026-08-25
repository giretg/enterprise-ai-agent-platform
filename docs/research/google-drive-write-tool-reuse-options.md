# Google Drive read/write tool — újrahasznosítható libraryk és forráskódok

> Dátum: 2026-08-25. A vizsgálat elsődleges forrásokra épül: official Google GitHub repók és dokumentáció, npm package metadata, valamint a jelölt MCP repók saját forráskódja. A háttérkutató agent kreditkorlát miatt nem tudta befejezni a feladatot, ezért a forrásellenőrzés közvetlenül történt.

## Döntés

**Ne írjunk saját Drive REST-klienst, és ne telepítsünk egy harmadik fél által készített MCP-servert a platform jogosultsági rétege helyére.**

Javasolt megoldás:

1. production dependencyként a Google official, moduláris Node.js kliensei:
   - [`@googleapis/drive`](https://www.npmjs.com/package/@googleapis/drive);
   - Google-native tartalommódosításhoz [`@googleapis/docs`](https://www.npmjs.com/package/@googleapis/docs), [`@googleapis/sheets`](https://www.npmjs.com/package/@googleapis/sheets), [`@googleapis/slides`](https://www.npmjs.com/package/@googleapis/slides);
   - az OAuth access token kliensbe injektálásához közvetlen dependencyként `google-auth-library`.
2. a platform meglévő ConnectorGrant + token-vault + Tool Broker rétege marad az egyetlen credential- és authorization-forrás;
3. az official Google mintákból vegyük át a stream, multipart/resumable upload, export és shared-drive paraméterezés alapmintáit;
4. a [`piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp) repót csak implementációs referenciaként használjuk tool-sémákhoz, MIME-kezeléshez, permission műveletekhez és tesztesetekhez;
5. harmadik fél MCP szerverét ne futtassuk közvetlenül és ne adjuk át neki a platform refresh tokenjét.

## 1. Ajánlott production dependency: Google official Node.js kliens

### `googleapis/google-api-nodejs-client`

- Repó: [`googleapis/google-api-nodejs-client`](https://github.com/googleapis/google-api-nodejs-client)
- Tulajdonos: Google APIs GitHub organization.
- Licenc: Apache-2.0.
- Állapot a vizsgálatkor: aktív, nem archivált; legutóbbi push 2026-08-18.
- Az npm `googleapis` verziója a vizsgálatkor `176.0.0`; a moduláris `@googleapis/drive` verziója `21.0.0`.
- A generált Drive v3 kliens típusosan lefedi többek között a `files`, `permissions`, `drives`, `revisions` resource-okat és a `supportsAllDrives` paramétereket.

Miért a moduláris csomag:

- kisebb függőségi és bundle-felület, mint a teljes `googleapis` csomagnál;
- TypeScript típusok a Drive v3 request/response objektumokhoz;
- stream response támogatás download/export esetén;
- `requestBody` + `media.body` feltöltés;
- a Google API változásait nem nekünk kell kézzel lekövetni;
- ugyanaz a kliens használható My Drive és Shared Drive műveletekre.

Az official [`googleworkspace/node-samples`](https://github.com/googleworkspace/node-samples) repó Apache-2.0 licencű és konkrét Drive v3 példákat tartalmaz:

- `upload_basic.js` — `files.create({ requestBody, media })`;
- `move_file_to_folder.js` — parents lekérése, majd `files.update({ addParents, removeParents })`;
- `share_file.js` — `permissions.create`;
- `download_file.js` — `files.get({ alt: 'media' })`;
- `export_pdf.js` — `files.export`;
- a google-api-nodejs-client `samples/drive/upload.js`, `download.js`, `export.js` stream- és upload-progress mintákat ad.

### Auth integráció

A platform ne engedje, hogy a Google kliens saját lokális tokenfájlt kezeljen. A Broker:

1. feloldja az acting user grantjét;
2. a token-vaultból/refresh folyamatból friss access tokent kap;
3. egy request-élettartamú OAuth2Clientnek csak az access tokent adja át;
4. a Google kliens példányt ezzel hozza létre;
5. a refresh token soha nem kerül a Drive adapterhez vagy harmadik fél kódjához.

Ez megőrzi a jelenlegi auditot, tenant boundaryt és a szerveroldali token-injektálási invariánst.

## 2. Google-native dokumentumok írása

A Drive API fájl- és metadata-műveleteket végez, de egy meglévő Google Doc, Sheet vagy Slides belső tartalmának strukturált módosításához a megfelelő Workspace API kell:

- Docs `documents.batchUpdate`;
- Sheets `spreadsheets.values.update/append` és szükség esetén `spreadsheets.batchUpdate`;
- Slides `presentations.batchUpdate`.

Az official API reference mindháromnál elfogadja a `drive.file` és a teljes `drive` scope-ot is alternatív authorization scope-ként. Emiatt a per-file write modellhez nem szükséges automatikusan teljes `documents`/`spreadsheets`/`presentations` scope-ot kérni.

Javaslat: a Drive connector adaptere maradjon egy deep module; belül külön Drive/Docs/Sheets/Slides official clientet használhat, kifelé azonban stabil, üzleti tool-kontraktusokat adjon.

## 3. `piotr-agier/google-drive-mcp` — jó referencia, nem közvetlen runtime

- Repó: [`piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp)
- Npm: `@piotr-agier/google-drive-mcp` `2.6.0` a vizsgálatkor.
- Licenc: MIT.
- TypeScript, aktív kiadások és jelentős tesztkészlet.
- Függőségei között `googleapis`, `google-auth-library`, MCP SDK és Zod.

Hasznos minták:

- search és query escaping;
- My Drive / Shared Drive paraméterezés (`supportsAllDrives`, `includeItemsFromAllDrives`);
- fájl/folder create, upload, update, rename, move, copy, trash/delete;
- permission list/create/update/remove;
- download/export MIME routing;
- revision kezelés;
- Zod inputok és Google API fixture-ek;
- account/scope diagnosztika és refresh tesztek.

Miért ne telepítsük közvetlen platform-runtime-ként:

- saját account- és token-store modellt valósít meg, ami duplikálná a ConnectorGrant/token-vault réteget;
- stdio/HTTP MCP processzként külön authorization és audit boundaryt hozna létre;
- több tool `localPath` vagy base64 inputot fogad; a platformon ehelyett tenant-ellenőrzött `artifactRef` kell;
- default scope-listája egyszerre tartalmaz `drive`, `drive.file`, `drive.readonly`, Docs, Sheets, Slides és Calendar scope-okat, ami a platform least-privilege elvéhez túl széles;
- toolkészlete jóval szélesebb a javasolt első kiadásnál;
- a saját multi-account routingja nem azonos a platform acting-user szabályával.

Következtetés: **forrásminta és teszteset-katalógus**, nem dependency és nem authorization komponens. Kód átvétele esetén az MIT notice megőrzése és célzott security review szükséges; egyszerűbb a mintát az official SDK fölött saját adapterben újraalkalmazni.

## 4. Egyéb MCP megoldások

### `felores/gdrive-mcp-server`

- MIT, TypeScript, de a repó lényegében két read-only toolra (`gdrive_search`, `gdrive_read_file`) és lokális desktop OAuth tokenfájlra épül.
- Hasznos a Google-native exportformátumok legegyszerűbb példájaként.
- Írási toolhoz, multi-tenant szerverhez és platform token-vault integrációhoz nem ad megfelelő alapot.

### `@modelcontextprotocol/server-gdrive`

- Az npm-en létező csomag, de a vizsgálatkor nem találtunk hozzá aktívan karbantartott official Model Context Protocol forrásrepót.
- A jelenlegi `modelcontextprotocol/servers` repóban nincs Google Drive reference server; a `servers-archived` repó kifejezetten nem karbantartott reference servereket tartalmaz.
- Emiatt production dependencyként nem ajánlott.

### További community MCP repók

A GitHub keresés sok, gyorsan változó Drive MCP repót ad. Ezek toolnevei és edge-case megoldásai tanulmányozhatók, de a csillagszám vagy friss commit nem helyettesíti a dependency security review-t. Különösen kerülendő:

- ismeretlen/nem egyértelmű licenc;
- nyers refresh token átadása;
- desktop OAuth flow szerveroldali multi-tenant környezetben;
- tetszőleges lokális fájlútvonal vagy base64 tool argumentum;
- teljes `drive` scope indoklás nélkül;
- permanent delete és `anyone`/domain share approval nélkül;
- saját authorization, ami megkerüli a Tool Brokert.

## 5. Scope- és Picker-döntés írásnál

Az official [Drive scope útmutató](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) szerint:

- `drive.file`: non-sensitive, per-file hozzáférés az app által létrehozott vagy a user által az appnak megnyitott/kiválasztott fájlokra; Google Pickerrel ajánlott;
- `drive.readonly`: az összes user által elérhető fájl olvasása, restricted scope;
- `drive`: az összes user által elérhető fájl teljes kezelése, restricted scope.

Javasolt profilok:

| Profil | Scope | Írási hatókör |
|---|---|---|
| Csak olvasás | `drive.readonly` | nincs |
| Olvasás + írás kijelölt fájlokon | `drive.readonly` + `drive.file` | app által létrehozott és Pickerrel kiválasztott fájlok/folder |
| Teljes olvasás + írás | `drive` | minden fájl, amelyet a user Google ACL-je enged; admin által külön engedélyezett profil |

A kiválasztott-fájlos profilhoz Google Picker szükséges. Az official Picker minta `setDeveloperKey(API_KEY)`, `setAppId(CLOUD_PROJECT_NUMBER)` és `setOAuthToken(accessToken)` beállítást használ. Provisioningben ezért a Drive API mellett a Google Picker API-t is engedélyezni, valamint origin/API szerint korlátozott API keyt és Cloud project numbert konfigurálni kell.

## 6. Írási biztonsági minták

Az official SDK csak transport és API kliens; a következőket a platformnak kell hozzáadnia:

- agent assignment `write` módban és tool capability;
- toolonkénti scope-ellenőrzés;
- Google ACL és `drive.file` korlátozás fail-closed kezelése;
- meglévő Consequence Gate integráció;
- permanent delete hiánya; csak trash + külön restore;
- share esetén csak konkrét user/group, owner transfer és `anyone`/domain tiltva az első kiadásban;
- upload inputként csak tenant-ellenőrzött `artifactRef`, nem tetszőleges path vagy raw base64;
- idempotency key a create/upload hívásokhoz;
- optimista konfliktusellenőrzés update előtt;
- retry csak idempotens vagy deduplikált műveletnél;
- méret-, MIME-, fájlszám- és hívásszám limit;
- nyers tartalom és credential nélküli audit.

## 7. Implementációs ajánlás

```text
Tool Broker
  → GoogleDriveAuthorizer (capability + assignment + acting user + grant + scope)
  → Consequence Gate (tool risk + approval/preapproval budget)
  → GoogleDriveService (stabil platform-kontraktus)
       ├─ @googleapis/drive
       ├─ @googleapis/docs
       ├─ @googleapis/sheets
       └─ @googleapis/slides
  → Google API
```

Ne legyen általános „Drive MCP passthrough” vagy tetszőleges Google API request tool. A modell kis, szemantikus toolkészletet kap; az SDK és a Google request részletei a service mögött maradnak.

## 8. Ellenőrzött források

- [Google official Node.js API client](https://github.com/googleapis/google-api-nodejs-client)
- [Google Workspace Node samples](https://github.com/googleworkspace/node-samples/tree/main/drive)
- [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Picker sample](https://developers.google.com/workspace/drive/picker/guides/sample)
- [Docs `documents.batchUpdate`](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)
- [Sheets `spreadsheets.values.update`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update)
- [Slides `presentations.batchUpdate`](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate)
- [`piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp)
- [`felores/gdrive-mcp-server`](https://github.com/felores/gdrive-mcp-server)
- [Model Context Protocol servers](https://github.com/modelcontextprotocol/servers)
