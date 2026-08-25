# Google Drive felhasználói OAuth és OpenAI Responses connector — kutatási alapvonal

> Dátum: 2026-08-25. Források: kizárólag hivatalos OpenAI- és Google-dokumentáció. Ez a jegyzet a fejlesztési specifikáció technikai és provisioning alapja; nem a repó jelenlegi implementációjának auditja.

> **Kiegészítés:** a product-spec v1.1 már kontrollált Drive-írást is tartalmaz saját Tool Broker toolokkal. Az itt dokumentált OpenAI `connector_googledrive` ettől változatlanul read-only; a write út az official Google API kliensekre épül. Lásd: [`google-drive-write-tool-reuse-options.md`](google-drive-write-tool-reuse-options.md).

## Vezetői összefoglaló

1. Az OpenAI Responses API jelenleg beépített Google Drive connectort dokumentál `connector_googledrive` azonosítóval. A connector az `mcp` tool-típussal használható, és a saját alkalmazás által megszerzett Google OAuth **access tokent** kell átadni neki. Az OAuth-regisztrációt és a teljes authorization flow-t az alkalmazás kezeli. ([OpenAI: MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))
2. A dokumentált Drive connector **csak olvasást** tud: profil lekérés, megosztott meghajtók listázása, keresés, legutóbbi dokumentumok és fájltartalom letöltése. A Drive-műveletekhez dokumentált scope a `drive.readonly`. Nincs létrehozó, módosító, törlő vagy megosztási tool. Egy szélesebb Google-token önmagában nem ad írási képességet a connector tool-felületéhez. ([OpenAI: available connectors and Google Drive tools](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))
3. A fiók UI-ban történő „csatlakoztatás” önmagában nem elég ahhoz, hogy az agent használja is a Drive-ot. Az agent minden releváns Responses-hívásában meg kell kapja az `mcp` tool-definíciót, a `connector_googledrive` azonosítót és az adott cselekvő felhasználó friss access tokenjét. A modell ezután a prompt alapján dönthet a tool használatáról. ([OpenAI: connector authorization and Responses example](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))
4. Az OpenAI nem tárolja el a Responses-kérés `authorization` mezőjét, és az nem jelenik meg a Response objektumban; emiatt minden új Responses-kéréshez ismét át kell adni az access tokent. Az alkalmazásnak kell a Google refresh tokent biztonságosan megőriznie, az access tokent frissítenie, és **csak az access tokent** továbbítania az OpenAI-nak. ([OpenAI: authorization token handling](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [Google: offline access and refresh tokens](https://developers.google.com/identity/protocols/oauth2/web-server))
5. A connectorhoz szükséges `https://www.googleapis.com/auth/drive.readonly` Google szerint **restricted scope**, mert az összes, a felhasználó által elérhető Drive-fájl megtekintését és letöltését engedi. Publikus/external produkciós appnál restricted-scope verificationre és főszabály szerint éves security assessmentre kell készülni. ([Google: Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Google: verification requirements](https://support.google.com/cloud/answer/13464321), [Google: security assessment](https://support.google.com/cloud/answer/13465431))
6. Ha az app csak egy saját Google Workspace/Cloud Identity szervezeten belül használható, a szervezet tulajdonában álló Cloud project `Internal` audience beállításával a nyilvános OAuth-verifikáció alól lehet mentesség. Ez nem alkalmas több, egymástól független Workspace-domain kiszolgálására; az Internal audience csak a project szülő szervezetének tagjait engedi. ([Google: verification exemptions](https://support.google.com/cloud/answer/13464323), [Google: app audience](https://support.google.com/cloud/answer/15549945))
7. Google Workspace-admin szabályzat a helyesen konfigurált és verifikált appot is blokkolhatja. Enterprise bevezetésnél az OAuth client ID-t az Admin console `Security > Access and data control > API controls > Manage App Access` részében engedélyezni kellhet `Trusted` vagy szűkebb `Specific Google data` hozzáféréssel, megfelelő szervezeti egységre/csoportra. ([Google Workspace Admin: app access control](https://support.google.com/a/answer/7281227))
8. Domain-wide delegation nem kell a felhasználó által kapcsolt fiókhoz. Az külön, service account alapú adminisztratív architektúra, amely felhasználói consent nélküli impersonációt tesz lehetővé; ezt a per-user connector fejlesztés ne kérje. ([Google: service accounts and domain-wide delegation](https://developers.google.com/identity/protocols/oauth2/service-account))

## 1. Mit tud pontosan az OpenAI Google Drive connector?

### 1.1 Responses API-konfiguráció

A dokumentált request-alak:

```json
{
  "model": "<MCP-t támogató modell>",
  "tools": [
    {
      "type": "mcp",
      "server_label": "google_drive",
      "connector_id": "connector_googledrive",
      "authorization": "<Google OAuth access token>",
      "require_approval": "<tudatosan megválasztott policy>"
    }
  ],
  "input": "..."
}
```

A connector ugyanazt az MCP tool-mechanizmust használja, mint a remote MCP szerverek, de `server_url` helyett OpenAI-féle `connector_id` szerepel. A tool-listázás és tool-hívás a response-ban `mcp_list_tools`, illetve `mcp_call` output itemként jelenik meg. ([OpenAI: MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))

### 1.2 Dokumentált toolok és scope-ok

| Tool | Képesség | Dokumentált scope |
| --- | --- | --- |
| `get_profile` | Aktuális Drive-felhasználó profilja | `userinfo.email`, `userinfo.profile` |
| `list_drives` | A felhasználó számára elérhető shared drive-ok | `drive.readonly` |
| `search` | Drive-fájlok keresése | `drive.readonly` |
| `recent_documents` | Legutóbb módosított dokumentumok | `drive.readonly` |
| `fetch` | Egy Drive-fájl tartalmának letöltése | `drive.readonly` |

Forrás: [OpenAI Google Drive connector tool table](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

Következmények:

- A v1 termékígéret legyen egyértelműen **Drive olvasás/keresés**, ne „olvasás + írás”.
- A connector a felhasználó jogosultságával dolgozik. A `drive.readonly` nem csak a felhasználó tulajdonában lévő, hanem az általa elérhető Drive-fájlokra ad olvasást; az OpenAI tool-listában a shared drive-ok kezelése is szerepel. ([Google: `drive.readonly` description](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [OpenAI: Drive tools](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))
- A szélesebb `drive` scope megadása sem hoz létre write toolokat. Ha később írás kell, ahhoz külön, saját Drive API function tool vagy ellenőrzött MCP-szerver és külön approval/policy terv szükséges.

## 2. Ajánlott OAuth scope-ok

### 2.1 Beépített OpenAI connector, read-only v1

Az OpenAI dokumentációjával egyező minimum:

```text
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

- A `drive.readonly` kell a listázás/keresés/fetch műveletekhez.
- A két `userinfo` scope a connector `get_profile` tooljához, illetve a kapcsolt fiók emberileg azonosítható megjelenítéséhez kell. Ha a termék OIDC-alapú Google-bejelentkezést is végez, az `openid` scope is indokolt lehet; az OpenAI Drive tool-táblája azt nem írja elő a Drive-műveletekhez. ([OpenAI: Drive connector scopes](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))
- A callback után a backend ellenőrizze a ténylegesen megadott scope-okat, mert Google granular consent mellett a felhasználó a kért scope-ok egy részét elutasíthatja. Hiányzó `drive.readonly` esetén a kapcsolat ne legyen agent számára használhatónak jelölve. ([Google: check granted scopes](https://developers.google.com/identity/protocols/oauth2/web-server))

Fontos compliance-tény: a `drive.readonly` Google-besorolása **restricted**, nem egyszerű „read-only = alacsony kockázat” scope. ([Google: Drive scope classification](https://developers.google.com/workspace/drive/api/guides/api-specific-auth))

### 2.2 Read-write alternatívák — nem a jelenlegi OpenAI connectorhoz

| Termékigény | Ajánlott scope | Besorolás / megjegyzés |
| --- | --- | --- |
| Csak a user által Pickerrel kiválasztott, vagy az appal megnyitott/létrehozott fájlok kezelése | `https://www.googleapis.com/auth/drive.file` | Non-sensitive, per-file hozzáférés; Google ezt ajánlja a legtöbb use case-re Google Pickerrel. |
| A felhasználó teljes elérhető Drive-jának megtekintése és kezelése | `https://www.googleapis.com/auth/drive` | Restricted, széles read-write hozzáférés; csak bizonyíthatóan szükséges funkcióhoz. |

Forrás és ajánlás: [Google: Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

A `drive.file` nem helyettesíti a jelenlegi connector teljes-Drive keresési ígéretét: az csak a felhasználó által egyedileg megosztott vagy az appal kezelt fájlokra korlátoz. Ha a későbbi cél „válassz dokumentumokat, amelyeket az agent használhat”, akkor a Picker + `drive.file` compliance- és least-privilege szempontból jobb, de ez más integráció, nem a dokumentált OpenAI Drive connector viselkedése.

## 3. Tokenéletciklus és szerveroldali felelősség

### 3.1 Authorization code flow

A webalkalmazás szerveroldali OAuth authorization code flow-t használjon:

1. generáljon erős, sessionhöz kötött `state` értéket CSRF ellen;
2. kérje a kiválasztott scope-okat;
3. kérjen `access_type=offline` hozzáférést, hogy a háttérben futó agent user-interakció nélkül is kaphasson friss access tokent;
4. opcionálisan, tudatosan használja az `include_granted_scopes=true` incremental authorization beállítást;
5. a callback redirect URI-n validálja a `state`-et, majd a kódot szerveroldalon váltsa tokenekre.

Google az offline access-t web server appoknál ajánlja, a `state` használatát pedig CSRF-védelemként írja elő/ajánlja. A redirect URI-nak pontosan egyeznie kell a Cloud Console-ban regisztrált URI-val, beleértve a sémát, kis-/nagybetűket és záró slash-t. ([Google: OAuth for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server))

### 3.2 Refresh token

- A refresh token csak `access_type=offline` esetén érkezik, és tipikusan csak az első authorization alkalmával. Reconnect/re-consent esetén a rendszer ne írjon felül egy meglévő, érvényes refresh tokent `null` értékkel. ([Google: offline access and token response](https://developers.google.com/identity/protocols/oauth2/web-server))
- A refresh tokent titkosított, tartós szerveroldali tárolóban kell tartani, felhasználóhoz, tenanthez, providerhez és granthez kötve; nem kerülhet kliensoldalra vagy logba. Google szintén secure, long-term storage-ot ír elő. ([Google: securely store refresh tokens](https://developers.google.com/workspace/drive/api/guides/api-specific-auth))
- A Responses-kérés előtt a backend frissítse a lejárt/közel lejáró access tokent, és az OpenAI-nak kizárólag ezt az access tokent adja át. Az OpenAI az `authorization` értéket nem tartja meg, ezért minden új response creation requesthez szükséges. ([OpenAI: connector authorization](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))
- Refresh-hiba (`invalid_grant`, visszavonás, admin policy, lejárás) esetén a kapcsolat kapjon `reauthorization_required`/egyenértékű állapotot; az agent ne fusson néma, régi credentiallel.

### 3.3 Testing mód korlátja

External, `Testing` státuszú Google Auth app legfeljebb 100 explicit test usert enged. Drive scope használatakor a test authorization hét nap után lejár, és az offline refresh token is lejár. Ezért staging teszten a heti reconnect várható viselkedés, produkcióban viszont nem elfogadható. Google külön Cloud projecteket ajánl fejlesztésre/tesztre és produkcióra. ([Google: Audience and publishing status](https://support.google.com/cloud/answer/15549945), [Google: verification exemptions and environment separation](https://support.google.com/cloud/answer/13464323))

## 4. Google Cloud / Google Auth Platform provisioning

### 4.1 Kötelező adminlépések

1. **Cloud project:** válasszanak vagy hozzanak létre Google Cloud projectet. Dev/test és prod külön project legyen. ([Google: submitting an app for verification](https://support.google.com/cloud/answer/13461325))
2. **API Library:** engedélyezzék a **Google Drive API**-t. A Data Access scope-listában csak engedélyezett API-k scope-jai jelennek meg automatikusan. ([Google: enable APIs](https://developers.google.com/identity/protocols/oauth2/web-server), [Google: Data Access](https://support.google.com/cloud/answer/15549135))
3. **Branding:** állítsák be az app nevét, support emailt, logót (ha használnak), fejlesztői contactokat, homepage-et, privacy policy-t és lehetőleg Terms of Service oldalt. External production appnál a homepage és privacy policy kötelező; a privacy policy mondja el, hogyan fér hozzá, használja, tárolja és osztja meg az app a Google user data-t. ([Google: Manage OAuth App Branding](https://support.google.com/cloud/answer/15549049))
4. **Authorized domains:** regisztrálják a homepage/privacy/redirect URI-khoz tartozó domaineket, és verifikálják a tulajdont Google Search Console-ban. ([Google: branding and authorized domains](https://support.google.com/cloud/answer/15549049), [Google: verification requirements](https://support.google.com/cloud/answer/13464321))
5. **Audience:** döntsék el, hogy `Internal` vagy `External` az app. Externalnál teszteléshez vegyék fel a test usereket; kiadáshoz állítsák `In production` státuszba. Internal csak a Cloud project szülő Workspace/Cloud Identity szervezetében használható. ([Google: Manage App Audience](https://support.google.com/cloud/answer/15549945))
6. **Data Access:** adják hozzá a pontos v1 scope-listát: `drive.readonly`, `userinfo.email`, `userinfo.profile` (plusz `openid`, ha az app OIDC-t is használ). A kód ne kérjen a Data Access oldalon nem deklarált scope-ot, és ne kérjen még nem verifikált új restricted scope-ot produkcióban. ([Google: Drive scopes in console and code](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Google: Manage App Data Access](https://support.google.com/cloud/answer/15549135))
7. **OAuth client:** a Google Auth Platform `Clients` részén hozzanak létre `Web application` klienst; rögzítsék a prod és az adott környezet callback URI-ját. A client secret csak létrehozáskor látható/letölthető, ezért azonnal secret managerbe kell tenni. ([Google: Manage OAuth Clients](https://support.google.com/cloud/answer/15549257), [Google: redirect URI matching](https://developers.google.com/identity/protocols/oauth2/web-server))
8. **Verification Center:** External production appnál publikálják a brandinget, majd adják be a restricted scope verificationt. Kell scope-justification, a teljes OAuth consentet és Drive-funkciót bemutató demo videó, verifikált domainek és megfelelő disclosure. ([Google: submit for verification](https://support.google.com/cloud/answer/13461325), [Google: verification requirements](https://support.google.com/cloud/answer/13464321))
9. **Security assessment:** restricted scope-os external appnál készüljenek a Google által elfogadott assessor által végzett, évente megújítandó vizsgálatra. ([Google: Security Assessment](https://support.google.com/cloud/answer/13465431))

### 4.2 Internal és External provisioning-modell

| Modell | Előny | Korlát / teher |
| --- | --- | --- |
| Egy platformszintű `External` OAuth app | Egyetlen, központilag kezelt client; bármely Google Account csatlakozhat | Restricted-scope verification, security assessment, privacy/compliance feladatok; customer Workspace-admin külön blokkolhatja/engedélyezheti |
| Tenant/customer tulajdonú `Internal` OAuth app | Saját szervezeten belül verification-mentesség lehet; customer kontroll | Tenantonkénti client ID/secret és provisioning; csak az adott Google-szervezet userei; a platformnak dinamikusan kell a tenant credentialt választania |

Ha a termék több független vállalati tenantet szolgál ki, az `Internal` modell csak **customer-owned OAuth credentials / BYO Google app** provisioninggel működik. Egyetlen platformprojekt nem lehet egyszerre több idegen szervezet Internal appja. ([Google: Internal audience](https://support.google.com/cloud/answer/15549945))

## 5. Google Workspace admin oldali engedélyezés

A customer Workspace admin beállítása független a Cloud projekt OAuth-verifikációjától. Ha a domain API Controls szabályai korlátozzák a Drive-ot vagy az unconfigured appokat, a user `admin_policy_enforced` hibát kaphat. ([Google: OAuth error](https://developers.google.com/identity/protocols/oauth2/web-server), [Google Workspace Admin: app access control](https://support.google.com/a/answer/7281227))

Javasolt admin runbook:

1. Google Admin console: `Security > Access and data control > API controls`.
2. `Manage App Access` alatt adja hozzá az OAuth appot a **pontos OAuth client ID** alapján.
3. Válasszon `Trusted` vagy — ha a tenant policy és a UI megengedi — `Specific Google data` hozzáférést, a szükséges Drive scope-okra.
4. Alkalmazza a megfelelő organizational unitokra/csoportokra; ne szükségszerűen az egész domainre.
5. Ellenőrizze a Drive szolgáltatás `Restricted/Unrestricted` és high-risk OAuth scope szabályait, valamint az unconfigured apps policy-t.
6. Változtatás után számoljon azzal, hogy policy-szigorítás tokeneket vonhat vissza, és az admin listák frissülése késhet.

Forrás és pontos adminfogalmak: [Control which apps access Google Workspace data](https://support.google.com/a/answer/7281227).

**Nem szükséges:** service account, service account key, Domain-wide Delegation vagy user impersonation. Ezek csak akkor kellenének, ha a platform user consent nélkül, admin által delegálva akarna egy teljes domain felhasználói nevében eljárni; ez más fenyegetési és jogosultsági modell. ([Google: domain-wide delegation](https://developers.google.com/identity/protocols/oauth2/service-account))

## 6. Security, privacy és compliance korlátok

### 6.1 Adatáram és Google Limited Use

A `fetch` által visszaadott Drive-tartalom az OpenAI modell kontextusába kerül. Az OpenAI külön figyelmeztet arra, hogy connectorok használatakor érzékeny adat kerülhet az OpenAI-hoz, illetve a modell olvasási hozzáférést kaphat érzékeny szolgáltatási adatokhoz. ([OpenAI: connector risks and safety](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))

Mivel a beépített connector a `drive.readonly` restricted scope-pal megszerzett tartalmat szerveres feldolgozásra továbbítja, nem kezelhető pusztán kliensoldali, adatot nem továbbító integrációként. A Google Drive scope-dokumentációja szerint restricted-scope adat szerveren történő tárolása **vagy továbbítása** security assessmentet von maga után; az Internal-use mentesség ettől külön audience-/ownership-kérdés. ([Google: restricted Drive scopes and security assessment](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Google: verification exemptions](https://support.google.com/cloud/answer/13464323))

Google Workspace API-adat csak a látható, user-facing funkció biztosítására használható; harmadik félnek továbbítás ehhez a funkcióhoz, felhasználói consenttel megengedhető. Az adat nem használható általános AI/ML modell létrehozására, tanítására vagy javítására az adott felhasználó személyre szabott, megfelelő use case-én túl. A privacy policy-ban és in-product disclosure-ben fel kell tüntetni az OpenAI felé történő feldolgozást, célt, tárolást és törlést. ([Google Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy))

Az OpenAI hivatalos API-adatkezelési oldala szerint az API-ba küldött adatot alapértelmezésben nem használják modelltréningre, kivéve explicit opt-int; ugyanakkor abuse-monitoring és application-state retention lehet, amelyet a szerződéses adatkezelési és retention konfigurációval együtt kell dokumentálni. ([OpenAI: Data controls](https://developers.openai.com/api/docs/guides/your-data))

### 6.2 Approval és prompt injection

- Az MCP tool-hívások alapértelmezésben approvalt kérnek; a `require_approval: "never"` ezt kikapcsolja. Az OpenAI azt ajánlja, hogy érzékeny actionöknél használják a `require_approval` és `allowed_tools` kontrollokat. A v1 Drive connector ugyan read-only, de az adatok érzékenyek lehetnek, ezért a „never” beállítás legyen dokumentált termék-/security döntés, ne véletlen default. ([OpenAI: approvals and safety](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))
- Drive-dokumentumok nem megbízható utasításokat/prompt injectiont tartalmazhatnak. A connector-adatot adatnak, nem rendszerutasításnak kell kezelni; ne lehessen Drive-tartalomból más connector write actiont vagy secret-exfiltrationt automatikusan indítani. Az OpenAI explicit kockázatként kezeli a prompt injectiont connectoroknál. ([OpenAI: prompt injection risk](https://developers.openai.com/api/docs/guides/tools-connectors-mcp))

### 6.3 Token- és grantizoláció

- A Responses-hívásba mindig a **cselekvő felhasználó** Drive-grantje kerüljön. System user, agent owner, ticket creator vagy más tenant credentialje nem lehet fallback.
- A tool csak olyan agent futásához kerüljön be, amelynél a termék policy szerint az adott user connectora engedélyezett. A kapcsolt fiók léte nem jelent automatikus jogosultságot minden agentnek vagy delegált futásnak.
- Ne logoljanak access/refresh tokent, authorization headert vagy teljes tool-outputot olyan auditcsatornába, amely nincs felkészítve restricted Google-adatra.
- Disconnectkor töröljék a helyi tokent és futásidejű elérést. A Google `/revoke` hívása projekt szinten minden korábban megadott scope-ot, illetve a projekthez tartozó kliensek access/refresh tokenjeit érintheti; ha Gmail és Drive ugyanazt a Google Cloud project/grantet használja, a „Drive leválasztása” más Google-kapcsolatot is megszakíthat. Ezt az OAuth project- és disconnect-architektúrában explicit tesztelni kell. ([Google: token revocation](https://developers.google.com/identity/protocols/oauth2/web-server))

### 6.4 Incremental authorization külön kockázata

Az `include_granted_scopes=true` Google által ajánlott incremental authorization minta, de az új access tokenbe korábban megadott scope-okat is bevonhat. Ha ugyanazon OAuth appban Gmail és Drive is él, ellenőrizni kell, hogy a Drive connectorhoz továbbított token nem hordoz-e a connectorhoz szükségtelen Gmail-jogosultságot. Független token- és visszavonási életciklushoz külön OAuth project/client vagy más bizonyítható izoláció lehet indokolt. ([Google: `include_granted_scopes`](https://developers.google.com/identity/protocols/oauth2/web-server))

## 7. A fejlesztési specifikációba emelendő invariánsok és acceptance criteria

### Funkcionális

- A Google Drive megjelenik a kapcsolható fiókok között, egyértelmű „Olvasás”/keresés képességgel; write opció nincs a beépített connectorhoz.
- Sikeres callback után csak akkor `connected`, ha a tényleges grant tartalmazza a `drive.readonly` scope-ot és tartós refresh token vagy egyértelműen működő hosszú távú tokenstratégia rendelkezésre áll.
- Agentfutásnál a Responses request tartalmazza a `connector_googledrive` MCP toolt és az acting user friss access tokenjét; e nélkül a rendszer ne állítsa, hogy az agent használhatja a Drive-ot.
- Integrációs teszt bizonyítsa a `search`, `fetch` és shared-drive elérést, továbbá azt, hogy írási művelet nem érhető el.

### Jogosultság és tenant boundary

- User A tokenje sem közvetlen, sem delegált, sem async agentfutásban nem használható User B vagy más tenant nevében.
- Hiányzó acting user vagy connector grant esetén fail closed; nincs platform-/admin-token fallback.
- A grant scope-ja, providerje, tulajdonosa, tenantje és státusza futás előtt validált.
- A tool availability és az approval policy agent/policy szinten auditálható.

### OAuth-életciklus

- `state` validáció, exact redirect URI, offline access, scope-visszaellenőrzés, refresh, reauthorization-required és revoke/disconnect tesztek.
- Első consent utáni refresh token megőrzése; reconnect callback nem nullázza.
- A Responses API-hívás minden alkalommal újra megkapja az access tokent; token nem kerül response persistence-be vagy logba.
- Külön teszt arra, hogy Drive disconnect nem bontja-e a Gmail-kapcsolatot, illetve fordítva.

### Provisioning/compliance

- Dokumentált dev/test/prod Google Cloud projektek, Drive API, Branding, Audience, Data Access, Clients és Verification Center beállítások.
- External modellnél restricted-scope verification és security assessment go-live blocker.
- Internal/BYO modellnél tenantonkénti client secret biztonságos provisioning és a helyes tenant-credential kiválasztása.
- Customer admin runbook tartalmazza az OAuth client ID allowlistinget és az `admin_policy_enforced` hiba elhárítását.
- Privacy policy és in-product disclosure kifejezetten leírja a Drive-adatok OpenAI API felé továbbítását és agent általi feldolgozását.

## 8. Nyitott architektúradöntések

1. Központi, verifikált External Google OAuth app lesz, vagy tenantonkénti Internal/BYO credential?
2. Gmail és Drive ugyanazt a Cloud projectet, OAuth clientet és grantet használja-e? Hogyan garantálható a token least privilege és a független disconnect?
3. A read-only Drive toolok automatikusan futhatnak-e (`require_approval: "never"`), vagy keresés/fetch előtt user approval kell? Mely agentek kapják meg a toolt?
4. A v1 teljes Drive-hozzáférést vállal `drive.readonly` scope-pal, vagy a compliance-teher miatt inkább Picker + `drive.file` alapú, kijelölt-fájlos saját integráció legyen?
5. Milyen OpenAI API retention/ZDR beállítás, audit-redaction és regionális feldolgozás felel meg a tenant adatkezelési elvárásainak?

## Elsődleges forráslista

- [OpenAI — MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [OpenAI — Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data)
- [Google — Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google — Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Auth Platform — Get started](https://support.google.com/cloud/answer/15544987)
- [Google Auth Platform — Manage App Branding](https://support.google.com/cloud/answer/15549049)
- [Google Auth Platform — Manage App Audience](https://support.google.com/cloud/answer/15549945)
- [Google Auth Platform — Manage App Data Access](https://support.google.com/cloud/answer/15549135)
- [Google Auth Platform — Manage OAuth Clients](https://support.google.com/cloud/answer/15549257)
- [Google — Verification requirements](https://support.google.com/cloud/answer/13464321)
- [Google — Security Assessment](https://support.google.com/cloud/answer/13465431)
- [Google Workspace Admin — Control which apps access Google Workspace data](https://support.google.com/a/answer/7281227)
- [Google Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [Google — Service accounts and domain-wide delegation](https://developers.google.com/identity/protocols/oauth2/service-account)
