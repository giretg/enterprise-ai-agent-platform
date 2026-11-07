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

A segédek helye `@/lib/feature-flags`. A `proxy.ts` nem használhatja, mert nem ér el adatbázist. A böngészőbe
nem kerülhet flag-lista és `NEXT_PUBLIC_*` flag sem, mert az elárulná a kiadatlan funkciókat.

A gomb elrejtése nem védelem: a műveletet és az API-t akkor is kapuzni kell, ha a felület el sem jut odáig.

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
- Hosszú futások, a chat-worker és a Hermes kapuzása még nincs kész (WP-5, első igényre). A chat-worker kódja nem
  importálhat az appból, ezért ott `isFeatureEnabled` nem használható.
