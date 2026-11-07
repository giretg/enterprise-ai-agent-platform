# Fokozatos bevezetés (feature flag)

Egy új, kockázatos működés úgy kerül élesbe, hogy kezdetben senkinél nem változik semmi. A platform admin
cégenként kapcsolja be, lépésenként bővíti a kört, és hiba esetén új kiadás nélkül leállítja. Spec: #1126.

A flag **ideiglenes**: a bevezetés után törlendő. Nem cégbeállítás (`Tenant.settings`), nem szabályzat
(`ClientPolicy`) és nem környezeti kapcsoló. Ezek tartós döntések, és maradnak a helyükön.

## Mi nem kerülhet flag mögé

Hibajavítás, biztonsági javítás, belépés, tenant-elkülönítés és audit. Kikapcsolva a hiba élne tovább, vagy
egy védelem válna kikapcsolhatóvá.

## Új flag felvétele

1. Vegyél fel egy bejegyzést az `app/src/domain/feature-flags/registry.ts` listájába. A kulcs formája
   `terület.funkció`, a szövegek hétköznapi nyelven, magyarul és angolul készülnek.
2. Kapuzd a belépési pontokat (lásd lent). Adatbázis-módosítás nem kell: a sor nélküli flag állapota **Ki**.
3. Írj tesztet mindkét állapotra a `createStaticFeatureFlags` kiértékelővel.
4. Élesben a **Platform · Fokozatos bevezetés** oldalon kapcsold be: előbb a saját cégeken, aztán egy
   ügyfélnél, végül mindenkinek.

```ts
'chat.resumable_pause': {
  title: { hu: 'Folytatható szünet', en: 'Resumable pause' },
  whatChanges: { hu: 'A chat szünet után ott folytatja a munkát, ahol abbahagyta.', en: '…' },
  whenOff: { hu: 'A chat elölről indítja a munkát. A mentett szüneteket a régi kód is olvassa.', en: '…' },
  owner: 'Név',
  issue: 1055,
  reviewBy: '2027-02-01',
},
```

## Belépési pontok

A döntés mindig a szerveren, a cégre vonatkoztatva születik. A tenant kötelező paraméter.

| Felület | Használat |
|---|---|
| Szerverkomponens | `await isFeatureEnabled(key, { tenantId })`, a kliens csak a logikai értéket kapja propként |
| Oldal | `await requireFeatureForPage(key, { tenantId })` (letiltva 404) |
| Szerverművelet | `await requireFeature(key, { tenantId })` a szokásos `try/catch` + `fail(e.message)` szerkezetben |
| API | `const denied = await featureGuardResponse(key, { tenantId }); if (denied) return denied` |
| MCP-eszköz | Egy sor a `domain/feature-flags/tool-flags.ts` listájában. A listázást és a hívást is ez kapuzza, a tiltott hívás `mcp.tools.call.deny` eseményt ír |
| Ütemezett és háttérfutás | `isFeatureEnabled` az érintett tenantra, soronként |
| Chat-worker és Hermes | Lásd a [Külső kliensek](#külső-kliensek-chat-worker-hermes) részt |

A segédek helye `@/lib/feature-flags`. A `proxy.ts` nem használhatja, mert nem ér el adatbázist. A böngészőbe
nem kerülhet flag-lista és `NEXT_PUBLIC_*` flag sem, mert az elárulná a kiadatlan funkciókat.

A gomb elrejtése nem védelem: a műveletet és az API-t akkor is kapuzni kell, ha a felület el sem jut odáig.

## Külső kliensek (chat-worker, Hermes)

Ezek a kliensek nem érik el a kiértékelőt, ezért a szerver adja át nekik a döntést. Csak az a flag jut el hozzájuk,
amelynek a bejegyzése ezt kéri, és csak akkor, ha a cégnél aktív, így a kiadatlan funkciók nem derülnek ki:

```ts
externalClients: {
  clients: ['platform_chat'],   // vagy 'hermes', vagy mindkettő
  onStop: 'old_path',           // mi a biztonságos, ha futás közben leállítják
},
```

| `onStop` | Mikor válaszd | Mi történik leállításkor |
|---|---|---|
| `old_path` | A régi út félbehagyott munkánál is helyesen fut | A futás a régi úton megy tovább |
| `finish_run` | A félbehagyott munka csak az új úton értelmes | A következő lépésnél érthető üzenettel lezárul, az eredmények megmaradnak |

**Chat-worker.** A flagek a `/api/chat/continuation` válaszában érkeznek, a futás elején a `turns.context`-be
kerülnek, és a `platform_chat.continuation_issued` audit is megőrzi őket. A kapu a workerben
`isTurnFeatureActive(context, kulcs)`. A futás közben nem vált működést: a később bekapcsolt flag a következő
fordulótól hat, a leállított pedig a futás végéig Ki marad, akkor is, ha közben újra bekapcsolják. A worker minden
lépés előtt ellenőrzi a leállítást a `/api/chat/feature-flags` végponton, de csak akkor, ha van rögzített flagje. Ha a
végpont nem válaszol, az utolsó ismert állapot marad. A leállítás a következő lépésnél ér célt, a futó modellhívást
vagy eszközhívást nem szakítja meg.

**Hermes.** A flagek a `client-policy/snapshot` válasz `featureFlags` mezőjében érkeznek, és beleszámítanak a
`policyVersion`-be, így a változás a heartbeatben és a gateway-tokenben is látszik. A Guard 15 másodpercenként frissít,
offline állapotban a tartalék snapshotban nincs flag, tehát minden Ki. A Guard ma még nem olvassa a mezőt: az olvasó
az első Hermes-flaggel együtt készül el, a Guard verziójának emelésével, mert a kapu ott fut a telepített gépen. A régi
Guard a mezőt figyelmen kívül hagyja, így ott a régi működés fut.

A worker és a Guard frissítése a platformtól függetlenül érkezik. Új flagnél számolj azzal, hogy egy régi kliens a régi
úton marad, és a régi útnak addig működnie kell.

## Állapotok és jogosultságok

| Állapot | Kinél aktív | Új cég |
|---|---|---|
| Ki | Senkinél | Nem aktív |
| Kiválasztott cégeknél | A felvett cégeknél | Nem aktív |
| Mindenkinek | Mindenkinél, a kizárt cégek kivételével | Aktív |

| Művelet | Minimum szerep |
|---|---|
| Megtekintés | `platform_auditor` |
| Cég felvétele, kizárása, „Kiválasztott cégeknél”, leállítás, határidő-hosszabbítás | `platform_operator` |
| „Mindenkinek” bekapcsolása | `superadmin` |

Leállításkor a cégek listája megmarad, így a bevezetés onnan folytatható. A leállítás a mentő példányon azonnal,
a többin legfeljebb kb. 30 másodperc alatt érvényesül.

## Szállítási szabályok piros PR-hoz

1. **A migráció nem flagelhető**, mert a build előtt lefut. A sorrend: bővítő migráció működésváltozás nélkül,
   flag mögötti kód, teljes bevezetés, végül külön PR-ban a régi út és a régi séma törlése.
2. **A bekapcsolva írt adatot a régi kódnak is olvasnia kell**, különben a leállítás maga okoz hibát. Ha ez nem
   teljesíthető, a PR leírása mondja ki, mi történik az adatokkal a leállítás után.
3. **Mindkét állapot tesztelt:** a flag mögötti és a régi út is kap tesztet.
4. **A külső mellékhatásokat nem vonja vissza a flag:** az elküldött levél vagy a külső rendszerbe írt adat megmarad.

## Törlés

A törlési határidő az első „Mindenkinek” állapottól számított 60 nap, indoklással hosszabbítható, és lejárva
pirosan látszik az admin oldalon. A CI nem lát az éles adatbázisba, ezért a kódbeli `reviewBy` lejártára
figyelmeztet, de nem blokkol.

Törléskor vedd ki a bejegyzést a listából, és tedd a kulcsot a `RETIRED_FEATURE_FLAG_KEYS` listába, mert törölt
kulcs nem használható újra. A típushibák megmutatják az összes használati helyet; ezeket a régi úttal együtt
külön PR takarítja. A kódból törölt flag adatbázis-sora nem hat semmire és nem is jelenik meg.

## Migráció-őr

A `test:migration-guard` megbuktatja az új migrációt `DROP`, `RENAME`, `SET NOT NULL`, oszloptípus-váltás vagy
alapérték nélküli `NOT NULL` oszlop esetén. Ha a törlés szándékos, a migráció elejére kerüljön jelölés:

```sql
-- destructive-ok: #1234
```

A meglévő migrációkra az őr nem fut (`LAST_UNGUARDED_MIGRATION`).

## Ismert korlátok

- A már kiosztott, gyorsítótárazott MCP-eszközlista a kliensnél addig látszik, amíg a kliens nem frissít. A hívást
  ettől függetlenül a szerver tiltja.
- A chat-worker kódja nem importálhat az appból, ezért ott `isFeatureEnabled` nem használható, csak az
  `isTurnFeatureActive`.
- Külső mellékhatást a leállítás itt sem von vissza, és a már futó lépést sem szakítja meg.
