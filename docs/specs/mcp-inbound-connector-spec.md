# Feature-spec — MCP-connector: külső MCP-szerverek csatolása kódírás nélkül

**Verzió:** 2.0
**Dátum:** 2026-10-16
**Státusz:** fejlesztésre kész
**GitHub issue:** [#395](https://github.com/giretg/enterprise-ai-agent-platform/issues/395)
**Célközönség:** product, platform-admin, security/compliance és fejlesztők

> **Mi változott a v1.1-hez (08-27) képest.** A v1.1 a platformon belüli agent-runtime-ra épült
> (Tool Broker, `TOOL_REGISTRY`, a platform által épített prompt). A 09-18-i Phase 0 átszervezés
> óta ezek a `legacy/` alatt vannak, a platform **MCP vezérlősík**: az agent a kliensben fut
> (Codex, Claude, Hermes), és a platform `/api/mcp/{tenantSlug}` végpontját hívja
> (`docs/architecture.md`). A v2.0 erre a felületre teszi a funkciót. A biztonsági döntések
> (admin-besorolás, befagyott eszközlista, egress-őr, domain-allowlist, fail-closed) változatlanok;
> a prompt-specifikus döntések (v1.1 D5 prompt-burkolás, D13 prompt-plafon, D10 `log_only`) helyett
> az MCP-felületre szabott változat áll. A v1.1 `McpToolManifest` táblája kimarad, mert a
> `ConnectorSpecVersion` már pontosan ez.

## 0. Vezetői döntés

**A probléma:** ma a Konnektorok között nincs olyan típus, amellyel egy külső MCP-szervert a platformhoz lehetne kötni. Minden új külső rendszer kódot (Gmail, Drive) vagy kézzel írt `http_api` configot igényel.

**A javaslat:** új **`mcp` connector-típus**. A platform a külső MCP-szerverrel **kliensként** beszél, és annak eszközeit **közvetítőként** adja tovább a saját tenant-MCP végpontján. Az admin megadja a szerver címét, kipipálja a kért eszközöket, besorolja a kockázatukat, és agenthez köti. **Új integráció = nulla kód.**

**Miért közvetítő, és miért nem kapcsolódik a kliens közvetlenül a külső szerverhez:** mert akkor elveszne minden, amiért a platform létezik — a belépési adatok a kliensre kerülnének (ma: „credentials never leave the server"), nem lenne `authorizeToolCall`, írás-jóváhagyás és `audit_log`.

**A kulcs-belátás:** ez az `http_api` mintája. Ott is fix eszköznevek vannak (`http_api_get`, `http_api_request`), a tényleges képességek a connector configjából jönnek. Az MCP-nél a configot nem ember írja, hanem a szerver `tools/list` válasza tölti.

## 1. Cél és scope

### 1.1 In scope — v1

- `mcp` érték a `ConnectorType` enumban; csak távoli, Streamable HTTP transzport.
- Két auth-mód **már az első kiadásban**: `service` (közös token a titoktárban) és `user_delegated` (mindenki a saját fiókjával, OAuth + PKCE) — mert lesz felhasználónként eltérő adatot adó szerver (D5).
- Admin-folyamat: cím → ellenőrzés (`initialize` + `tools/list`) → eszközök kiválasztása és besorolása → kipróbálás → agenthez rendelés.
- Két fix eszköz a tenant-MCP-n: `mcp_list_tools` és `mcp_call` (D1).
- Olvasó eszköz azonnal fut; író / veszélyes eszköz a meglévő jóváhagyási sorba kerül (`GatewayOperation`) (D3).
- Az eszközlista verziózva befagy; a szerver változása eltérés-nézetet és újrajóváhagyást kér (D4).
- A tenant-admin a connector létrehozásával engedélyezi a szervert; a hívás a connector hostjára van pinelve (D8). SSRF-őr marad (D10).
- Teljes `audit_log`: connector, belső eszköznév, kimenetel, acting user.

### 1.2 Out of scope — v1

- **Helyi (stdio) MCP-szerverek.** Idegen processz futtatása a platform gépén supply-chain- és sandbox-kérdés.
- **`resources`, `prompts`** — csak `tools`.
- **Sampling, elicitation, roots** — nem hirdetjük, a kérést elutasítjuk és auditáljuk (D9).
- **`notifications/tools/list_changed` automatikus átvétele** — csak jelzés, a lista nem frissül magától (D4).
- **A Gmail és a Drive visszabontása MCP-re** — maradnak first-class connectorok.
- **Szerverenkénti külön eszköznevek** a tenant-MCP `tools/list`-jében (D1).

### 1.3 Biztonsági határ egy mondatban

A külső MCP-szerver **adatforrás, nem bizalmi fél**: minden hívás ugyanazon az `invokeEnterpriseTool` úton megy (definíció-pin → agent-hozzáférés → `authorizeToolCall` → írás-kapu → audit), mint bármely más enterprise eszköz, és a belépési adata soha nem hagyja el a platformot.

## 2. Mi van már meg

| Szükséglet | Meglévő elem | Megjegyzés |
|---|---|---|
| MCP-kliens | `@modelcontextprotocol/sdk` 1.30 (`app/package.json`): `Client`, `StreamableHTTPClientTransport` | A transzport `fetch`-je cserélhető → egress-őr bekötése egy helyen. Saját JSON-RPC réteg nem kell. |
| OAuth-felderítés | SDK `client/auth` (RFC 9728 protected resource + RFC 8414 AS metadata, DCR) | Csak a felderítést használjuk; a tokent a saját vault tárolja. |
| Belső cím elleni védelem | `domain/net/egress-guard.ts` `guardEgressUrl` | A connection-teszt, a felderítés és a futás is ezen megy át. |
| Eszközlista tárolása + verziózás | `ConnectorSpecSource` (`specUrl`, `specFormat`, `urlApprovedById`), `ConnectorSpecVersion` (`rawSnapshot`, `rawHash`, `capabilitySet`, `status`, `approvedById`), `Connector.activeSpecVersionId` | `specFormat = 'mcp_tools'`. **Nincs új tábla.** |
| Változáskezelés | `connector-self-update/spec-diff.ts`, `spec-sync.ts`, `capability-set.ts`, `self-update-service.ts` | Az `opKey` itt a tool neve, nem `"METHOD /path"`. |
| Kezelőfüggvény-minta | `enterprise-tools/handlers/http-api.ts` | `handlers/mcp.ts` ugyanígy: connector → kliens → hívás → méretkorlát. |
| Írás-jóváhagyás | `gateway-operation/` (`enqueueWrite`, jóváhagyás után végrehajtás a kérelmező nevében: `principalUserId` → `resolveActingUser`) | Felhasználónkénti tokennel is helyes: a jóváhagyott írás a kérelmező grantjével fut. |
| Felhasználónkénti grant | `connector-grant/connector-grant-service.ts` (generikus Authorization Code + PKCE S256, `config.oauth.authUrl/tokenUrl/clientId`), `ConnectorGrant`, `grant-token-vault.ts`, `resolveDelegatedToken`, `authorizationLinkFields` | A felderítés csak kitölti a `config.oauth`-t; a flow, a callback és a „hozzáférés megadása" link már működik. |
| Titok | `connector/connector-secret-store.ts`, `Connector.secretAlias` | `service` módú token. |

**Az egyetlen séma-változás:** `mcp` érték a `ConnectorType` enumba.

## 3. Architektúra

### 3.1 Eszközfelület a tenant-MCP-n

| Eszköz | Írás? | Argumentumok | Visszaad |
|---|---|---|---|
| `mcp_list_tools` | nem | `definitionId`, opcionális `connectorId`, opcionális `query` | Az agenthez kötött MCP-connectorok **jóváhagyott** eszközei: név, leírás, `inputSchema`, kockázat. `query` → szűrés névre/leírásra. |
| `mcp_call` | a besorolástól függ (§3.3) | `definitionId`, `connectorId`, `tool`, `arguments` (objektum) | A külső hívás eredménye, méretkorláttal. |

Az eszközkészlet így fix marad: az `ENTERPRISE_TOOLS`, az `authorizeToolCall`, a Hermes eszköz-katalógus (`client-policy/tool-catalog.ts`) és a `tools/call` allowlist két új névvel bővül, futásidőben nem változik.

### 3.2 Az eszközlista mint verziózott capability-set

Import és szinkron után egy `ConnectorSpecVersion` sor:

- `rawSnapshot` = a szerver `tools/list` válasza változatlanul, `rawHash` = tartalom-hash;
- `capabilitySet` = normalizált lista: `{ name, description, inputSchema, risk, approved }` — a `risk` és az `approved` az **admin** döntése (D2);
- `status`: `proposed` → (admin jóváhagyás) → aktív, `Connector.activeSpecVersionId` rá mutat.

**Futásidőben csak az aktív verzióban `approved: true` eszköz hívható.** Aktív verzió nélkül a connector nem hívható (fail-closed, nem üres lista).

### 3.3 Kapu-döntés `mcp_call`-ra

`resolveMcpToolRisk(activeVersion, toolName)`:

1. nincs az aktív verzióban, vagy `approved: false` → **elutasítás** `mcp_tool_not_approved` kóddal (nem kapuzott átengedés);
2. `risk: 'read'` → azonnali hívás;
3. `risk: 'write'` → `enqueueWrite` (jóváhagyási sor), kivéve ha az agent írási módja (`findAgentWriteModes` / `skipsWriteApproval`) ezt a connectort jóváhagyás nélkülire állította;
4. `risk: 'danger'` → **mindig** jóváhagyási sor, az agent írási módjától függetlenül.

Beépítés: ma az `isEnterpriseWriteTool` egy fix névlista. Az `mcp_call`-ra az `invokeEnterpriseTool` a fenti függvénnyel dönt az írás-ágról; a többi eszköz viselkedése nem változik.

### 3.4 Futás egy hívásra

```
kliens → /api/mcp/{tenant} tools/call mcp_call
  → definíció-pin, agent-hozzáférés (meglévő)
  → authorizeToolCall: agent–connector kötés, accessMode, grant (meglévő)
  → aktív capability-set + resolveMcpToolRisk (új)
  → hívás a connector hostjára pinelve? (D8)
  → token: service → secretAlias | user_delegated → resolveDelegatedToken (meglévő)
  → handlers/mcp.ts: SDK Client + guardEgressUrl-os fetch → tools/call (új)
  → eredmény: külső-adat jelölés + méretkorlát → audit_log (meglévő minta)
```

A kapcsolat hívásonként épül (`initialize` → `tools/call` → zárás). Kapcsolat-pool nincs.

### 3.5 Ami NEM változik

Tenant-izoláció, definíció-pin, agent-hozzáférés, connector-kötés, grant-kezelés, jóváhagyási sor, `audit_log` hash-lánc. **Új kikerülő út nem jön létre.**

## 4. Döntések

**D1 — Két fix eszköz (`mcp_list_tools` + `mcp_call`), nem szerverenkénti eszköznevek.**
*Miért:* a tenant-MCP `tools/list`-je és a `tools/call` allowlist így fix marad, az `authorizeToolCall`-nak és a Hermes katalógusnak nem kell futásidejű nevekkel dolgoznia, és a sok eszközt kínáló szerverek (több száz eszköz) sem fújják fel minden kliens eszközlistáját — a `query` keresés kezeli. *Ár:* a kliens modellje egy plusz `mcp_list_tools` hívás után látja a paramétereket. *Újranyitandó, ha* mérhetően sok rossz `mcp_call` argumentum jön emiatt.

**D2 — A kockázati besorolást az admin adja, nem a szerver.**
Új eszköz alapértelmezése `danger` és `approved: false`. A UI névből javasol (`get_*`/`list_*`/`search_*` → `read`; `create_*`/`update_*`/`send_*` → `write`; `delete_*`/`share_*` → `danger`), de **a javaslat nem alapértelmezés**. A szerver `annotations.readOnlyHint` / `destructiveHint` mezője csak a javaslatot befolyásolja.
Ha az admin egy írásra utaló nevű eszközt `read`-re sorol, az külön megerősítést kér és auditálódik.
*Miért:* a `risk` a mi kapunkat vezérli; ha a szerver adná meg, a saját írását `read`-nek jelölve megkerülné a jóváhagyást.

**D3 — Írás a meglévő jóváhagyási soron.**
Nincs MCP-specifikus jóváhagyási felület; a `GatewayOperation` kártyáján a connector neve, a belső eszköznév és az argumentumok látszanak (`pending-args-summary.ts` bővítése).
*Miért:* egyetlen jóváhagyási hely, egyetlen audit-minta.

**D4 — Az eszközlista befagy; a változás jóváhagyás-köteles.**
Háttérszinkron (és `list_changed` értesítés esetén azonnali lekérés) új `proposed` verziót készít, ha a `rawHash` eltér. A `spec-diff` kategorizál (új / eltűnt / séma változott / leírás változott), és megmutatja, melyik agent használja. Új eszköz `approved: false`-szal érkezik. Amíg az admin nem hagyja jóvá, a régi aktív verzió él; eltűnt eszköz hívása a szerveren úgyis hibát ad.
*Miért:* a jóváhagyás eszköznévre szól; automatikus átvétellel a szerver holnap betolhatna egy `delete_everything` eszközt.

**D5 — Felhasználónkénti bejelentkezés már az első kiadásban.**
`authMode = user_delegated` esetén minden felhasználó saját `ConnectorGrant`-tel hív. Létrehozáskor a platform a szerver `401 WWW-Authenticate` válaszából felderíti az authorization servert (RFC 9728 → RFC 8414), és kitölti a `config.oauth` mezőit (`authUrl`, `tokenUrl`, `scopes`, `resource`). A `clientId` két úton jön: az admin megadja (szállítónál regisztrált kliens), vagy — ha a szerver támogatja — a connector létrehozásakor egyszer, emberi megerősítéssel lefut a DCR.
A token-kérésben a `resource` paraméter a szerver kanonikus címe (MCP auth-spec követelmény), így a token csak erre a szerverre szól.
Hiányzó grant esetén a hívás a meglévő `authorizationLinkFields` választ adja („Add meg a hozzáférést: …"), nem néma hibát. Lejárt / visszavont grant ugyanígy.
**Acting user nélkül nem hívható, és nem esik vissza közös fiókra.**
*Miért:* felhasználónként eltérő adatot adó rendszernél (pl. ki mit lát a saját Jirájában) a közös fiók vagy túl sokat lát, vagy túl keveset.

**D6 — Az eredmény külső, nem megbízható adat.**
Az `mcp_call` válaszában a tartalom jelölve van mint külső szolgáltatótól származó adat (nem utasítás), és méretkorlátot kap (a `capHttpApiResultForModel` mintájára). Csak `text` és `structuredContent` megy tovább; `image`/`audio`/`resource` tartalom v1-ben típus- és méret-jelzéssel helyettesítve.
Nincs „megbízható MCP-szerver" kapcsoló.

**D7 — Az eszközleírás is külső szöveg.**
A leírást a kliens modellje olvassa az `mcp_list_tools` válaszában — ez prompt-injektálási felület. Ezért ugyanazt a külső-adat jelölést kapja, mint az eredmény (D6), hosszkorláttal; az admin az import-képernyőn **a teljes leírást** látja jóváhagyás előtt, és a leírás változása a D4 szerint újrajóváhagyás-köteles.

**D8 — A tenant-admin dönt a MCP-szerverről; a hívás a connector saját hostjára van pinelve.**
A connector létrehozása a tenant-admin engedélye — ugyanúgy, mint egy HTTP API kapcsolatnál. Platform-admin allowlist nincs. Futásidőben a kliens csak a connector `serverUrl` hostjára mehet; a felderített OAuth-végpontok a saját hostjukra pinelve, SSRF-őr mögött (D10). Visszavonás = a connector archiválása. Wildcard nincs.
*Miért:* egy új szerver a cég saját adatkimeneti döntése. A platform-admin kapu szűk keresztmetszet volt, és a HTTP API-nál sem volt.

**D9 — Sampling, elicitation, roots: fail-closed.**
A kliens-capability-k között nem hirdetjük; ha a szerver mégis kéri, hibával elutasítjuk és auditáljuk.
*Miért:* a sampling a mi modell-keretünket költené, és megkerülné a kapukat.

**D10 — Kötelező egress-őr.**
A connection-teszt, az OAuth-felderítés (a metadata-URL-ek is!), a token-csere és a futás minden HTTP-kérése a `guardEgressUrl`-on megy át, feloldás utáni privát-IP ellenőrzéssel, a connector (illetve a felderített OAuth-végpont) saját hostjára pinelve (D8). Átirányítás nem követhető automatikusan más hosztra.
*Miért:* a címet tenant-admin adja meg, a metadata-dokumentum pedig külső fél által írt URL-eket tartalmaz; enélkül vak SSRF. Ez a hiba a repóban már többször előfordult.

**D11 — Mellékhatásos hívás nem ismétlődik automatikusan.**
`write`/`danger` hívás timeoutja `failed` kimenetel „bizonytalan kimenetel" jelöléssel; nincs újrapróbálás. Olvasó hívás egyszer ismételhető.

## 5. Adatmodell

```prisma
enum ConnectorType {
  google_drive
  http_api
  gmail
  knowledge_base
  code_sandbox
  mcp            // ÚJ
}
```

`Connector.config` (`type = mcp`):

```ts
{
  serverUrl: string            // kanonikus MCP-cím, egyben az OAuth `resource`
  oauth?: {                    // csak user_delegated; a felderítés tölti
    authUrl, tokenUrl, scopes, clientId | clientIdRef, resource
  }
}
```

- `ConnectorSpecSource`: `specUrl = serverUrl`, `specFormat = 'mcp_tools'`.
- `ConnectorSpecVersion`: §3.2.
- `ConnectorGrant`: változatlan (D5).

**Invariánsok:** connectoronként legfeljebb egy aktív verzió; aktív verzió nélkül nincs hívás; a verzió jóváhagyója nem lehet azonos azzal, aki a szinkront agentként kezdeményezte (a self-update SoD-szabálya).

## 6. Admin-folyamat

Közérthető nyelven, minden lépésnél rövid magyarázattal:

1. **Szerver megadása.** Cím + „Kinek a nevében fusson?" (*Közös céges fiókkal* / *Mindenki a saját fiókjával*). Az „Ellenőrzés" gomb: *„A szerver 12 eszközt kínál."* Hibák emberi nyelven: *„A cím nem érhető el"*, *„A token nem érvényes"*, *„Ez a cím belső hálózatra mutat, ezért nem engedélyezett"*.
   - Saját fiókos módban az ellenőrzéshez az admin a saját fiókjával egyszer belép.
2. **Eszközök átnézése.** Táblázat: név, teljes leírás, paraméterek, javasolt kockázat. Az admin pipál és megerősít. Fejléc: *„A leírásokat a külső szolgáltató írta. Ezt fogja látni az AI munkatárs — olvasd át."*
3. **Kipróbálás.** Egy olvasó eszköz valódi futtatása, a válasz megjelenítésével, mielőtt bármely agent hozzáférne.
4. **Agenthez rendelés.** A meglévő agent–connector képernyő.
5. **(Saját fiókos mód)** A connector megjelenik a „Kapcsolt fiókok" oldalon; ahol a felhasználó még nem lépett be, az AI munkatárs a hívásnál linket ad, nem némán hibázik.

**Változás a szerveren (D4):** a connector kártyáján *„A szolgáltató 2 új eszközt adott hozzá és 1 leírást módosított — nézd át"*, eltérés-nézettel.
**Üres állapot:** mi ez és mire jó, egy-két példa szerverrel — nem üres táblázat.

## 7. Szeletek és munkacsomagok

Az 1–2. szelet együtt adja az első kiadást (mindkét auth-mód).

| Szelet | WP | Tartalom |
|---|---|---|
| **1 — Közös fiókos MCP** | WP-1 | `domain/connector/mcp-client.ts`: SDK `Client` + `StreamableHTTPClientTransport`, `guardEgressUrl`-os `fetch`, timeout, válaszméret-korlát, D9 elutasítás. Hálózat injektálva, egységtesztelve. |
| | WP-2 | Migráció: `ConnectorType.mcp`. `tools/list` → capability-set normalizáló + hash; import `ConnectorSpecSource`/`ConnectorSpecVersion`-be. |
| | WP-3 | `mcp_list_tools` + `mcp_call` az `ENTERPRISE_TOOLS`-ba, `tool-definitions.ts` sémák, `authorizeToolCall` követelmény (`connectorType: 'mcp'`), `handlers/mcp.ts`, `tools/call` allowlist, Hermes katalógus, `tool-ui-labels`. |
| | WP-4 | Kapu: `resolveMcpToolRisk`, írás-ág az `invokeEnterpriseTool`-ban, végrehajtó a `gateway-operation-service`-ben (`executeMcpTool`), jóváhagyó-kártya összefoglaló. |
| | WP-5 | D8: connector-host pin létrehozáskor és hívásonként; SSRF-őr (D10). |
| | WP-6 | Admin-UI §6 1–4. lépés, `service` mód (token a secret store-ba), kipróbálás, üres állapot, hu/en szövegek. |
| **2 — Saját fiókos MCP** | WP-7 | OAuth-felderítés (SDK `client/auth`, egress-őr mögött) → `config.oauth`; `clientId` admin-mezőből vagy domain-szintű DCR-ből; `resource` paraméter a `connector-grant-service` auth- és token-kérésében. |
| | WP-8 | `user_delegated` út: `resolveDelegatedToken` bekötése, acting user nélküli elutasítás, grant-hiány / lejárt grant link-válasz, „Kapcsolt fiókok" megjelenés. |
| **3 — Változáskezelés** | WP-9 | Háttérszinkron + `list_changed` → új `proposed` verzió; `spec-diff` tool-listára; eltérés-nézet + jóváhagyás; „ki használja". |
| mind | WP-10 | Tesztek (§8) + operátori doc (`docs/mcp-compatibility-runbook.md` bővítése). |

## 8. Elfogadási kritériumok

- [ ] Admin kód nélkül, a UI-ból csatol egy nyilvános MCP-szervert, és egy agent a Codexből / Claude-ból használja az egyik eszközét.
- [ ] Nem jóváhagyott vagy aktív verzióban nem szereplő eszköz `mcp_call`-ja **elutasítva** (nem jóváhagyási sorba téve) — regressziós teszt.
- [ ] Besorolatlan új eszköz `danger`, `approved: false` — regressziós teszt.
- [ ] `write` eszköz hívása jóváhagyási sorba kerül; jóváhagyás után a kérelmező nevében fut — regressziós teszt.
- [ ] `danger` eszköz az agent írási módjától függetlenül jóváhagyás-köteles — regressziós teszt.
- [ ] A szerver eszközlistájának változása jóváhagyás nélkül nem változtatja meg a hívható eszközöket — regressziós teszt.
- [ ] Belső IP-re / metadata-végpontra mutató szerver-cím, OAuth-metadata URL vagy átirányítás elutasítva, DNS-rebinding után is — regressziós teszt.
- [ ] Belső/tiltott hostokra connector nem hozható létre; a hívás a connector saját hostján kívülre nem mehet — regressziós teszt.
- [ ] `user_delegated` connector acting user nélkül nem hívható, és nem esik vissza közös fiókra — regressziós teszt.
- [ ] Két felhasználó ugyanazon a `user_delegated` connectoron a saját grantjével hív; egyikük tokenje sem jelenik meg a másik hívásában — regressziós teszt.
- [ ] Grant nélküli hívás „hozzáférés megadása" linket ad — regressziós teszt.
- [ ] `sampling/createMessage` kérés elutasítva és auditálva.
- [ ] Leírásba és eredménybe rejtett utasítás külső-adat jelöléssel, hosszkorláttal jut ki — regressziós teszt.
- [ ] `write`/`danger` timeout nem ismétlődik, „bizonytalan kimenetel" — regressziós teszt.
- [ ] Minden `mcp_call` `audit_log` sort hagy a connectorral és a belső eszköznévvel; egy tenant connectora más tenant agentjének nem elérhető.

## 9. Fennmaradó kockázatok

1. **A besorolás emberi ítélet.** Egy `update_record` lehet ártalmatlan vagy visszafordíthatatlan; a javaslat és a lefelé-módosítás megerősítése segít, a valódi alj a jóváhagyási sor.
2. **A tenant-admin választása a cég adatkimeneti döntése.** A platform nem bírálja felül; a SSRF-őr (D10) a belső hálózatot továbbra is zárva tartja.
3. **D1 ára:** a kliens modellje a belső sémát csak `mcp_list_tools` után látja. Ha ez sok hibás hívást okoz, mérjük és nyissuk újra.
4. **Hívásonkénti kapcsolat** (`initialize` minden hívásnál) lassabb; ha a késleltetés zavaró, session-újrahasznosítás jöhet — a `Mcp-Session-Id` felhasználónként külön kezelendő.
5. **DCR-kliensek életciklusa:** a domain-szintű regisztrált kliens lejárhat vagy visszavonódhat; ilyenkor az új grant-ok hibát adnak, amíg a tenant-admin újra nem hozza létre a kapcsolatot.

## 10. Kapcsolódás

- `docs/architecture.md` — MCP vezérlősík, `legacy/` szabály.
- **Önfrissítő connector** — `ConnectorSpecSource` / `ConnectorSpecVersion`, `spec-diff`, SoD.
- **#618** — write-megerősítés űrlap (MRTR): az `mcp_call` írás-ága ugyanezt a `confirm` utat használja.
- **#746** — Hermes Managed Client: az új eszközök a Hermes katalógusba is bekerülnek.
- **#97** — tool-eredmény trust-envelope: a D6/D7 jelölés ennek a megfelelője az MCP-felületen.
