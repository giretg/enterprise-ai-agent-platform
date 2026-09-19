---
name: targyalasi-felkeszito
description: Ügyféltárgyalási felkészítő készítése az Ostorosbor CRM Connector API-jának ügyfél-, kommunikációs és rendelési adataiból, valamint friss nyilvános webes forrásokból, egyetlen nyomtatható HTML-ben. Használd, ha a felhasználó meeting briefet, tárgyalási anyagot vagy ügyfélfelkészítőt kér egy partnerhez.
allowed-tools: http_api_get, http_api_get_all, web_search, create_html
preferred-mode: chat
max-wall-clock-ms: 1200000
max-tool-calls: 50
allow-attachments: false
---
# Tárgyalási felkészítő

Készíts döntéstámogató, belső használatú briefet egy ügyféllel való tárgyaláshoz. A kész eredmény egy önálló, statikus, magyar nyelvű HTML-fájl; a tárgyaló fél öt perc alatt értse meg belőle, kivel ül le, mi változott és mit érdemes elérnie.

## Bemenet

A partner neve vagy CRM-azonosítója kötelező. A tárgyalás dátuma, résztvevői és célja opcionális; hiányuk ne állítsa meg az adatgyűjtést. Azonos nevű vagy nem egyértelmű találatnál mutasd meg röviden a jelölteket, és kérj választást. Partnerazonosságot ne találj ki.

## Platform-szabályok

- Az **Ostoros CRM Autorefresh** connectort használd. A connectorId-t a rendszerüzenet hozzárendelt connector-listájából vedd.
- Ne kérj base URL-t, API-kulcsot vagy agent ID-t: a platform injektálja a hitelesítést.
- A mellékleteket (`references/…`, `assets/…`) **legfeljebb egyszer** olvasd be. Folytatáskor ne olvasd újra őket, és ne ismételd meg a már sikeres API-hívásokat; használd a `tool-outputs/` alatt megőrzött eredményt.
- Nagy API-válasz a `tool-outputs/` alatt marad — ne olvasd vissza chunkolva ugyanazt a fájlt. **Ne** hívd a `sandbox_exec`-et. Aggregált riportot preferálj (`postReportsQuery`) a nyers lista helyett.
- A kész fájlt a `create_html` eszközzel hozd létre; ne a `file_write`-ot használd, és ne add vissza több tízezer karakteres kódblokkban.
- Ne kérd le a reports preset/metadata katalógust — a szükséges pathok a `references/adatgyujtes.md` mellékletben szerepelnek.

## Munkamenet (4 fázis)

### 1. Felkészülés (max 3 lépés)

Olvasd be egyszer (`load_skill_attachment`): `references/adatgyujtes.md`, `references/ertekeles-es-forraskezeles.md`, `assets/targyalasi-felkeszito-sablon.html`. Minta: `assets/minta-targyalasi-felkeszito.html`.

### 2. Partner feloldása (1 CRM-hívás)

`listAccounts` név szerint. Rögzítsd az `account.id` és a cégnevet. Több jelölt → kérdezz, ne találj ki.

### 3. Adatgyűjtés (max 5 hívás összesen)

A partner azonosítása után **azonnal** indíts webes kutatást (max **2** `web_search`), miközben a CRM-adatot is lekéred — ne várj a webre a CRM végéig.

**CRM (max 3 hívás):**

1. `getAccount360` — `view=summary` (kommunikáció, teendő, riasztás, health, havi forgalom).
2. `postReportsQuery` — `preset: partner-turnover`, utolsó 12 lezárt hónap, `compare: yoy`, `accountId` szűrő.
3. Csak ha a forgalmi/mix kép így is hiányos: **egy** `http_api_get_all` rendeléstételekre (`listOrderLines`).

**Web (max 2 keresés):**

- `"<cégnév>" bor` vagy `site:<domain> bor`
- `"<cégnév>" akció` vagy `"<cégnév>" Ostoros`

Tényt keresési snippetből ne állíts; a találatok közül a releváns oldal címét és URL-jét rögzítsd. Tulajdonost csak ellenőrizhető forrásból nevezz meg.

### 4. Összerakás és mentés

Az értékelési szabályok szerint következtess, majd töltsd ki a sablon `{{…}}` helyőrzőit kész HTML markupkal. Mentsd `create_html`-lel:

`targyalasi-felkeszito-<slug>-<YYYY-MM-DD>.html`

A `<slug>` kisbetűs, ékezet nélküli rövid név (pl. `spar`, `bortarsasag`; max 40 karakter, csak `[a-z0-9-]`). A válaszodban a `create_html` által visszaadott `path` mezőt szó szerint, backtickben idézd.

Ha az időkeret szűkül: **előbb** adj használható HTML-t a meglévő adatokból, utána finomíts — ne gyűjts új forrást a lezárási szakaszban.

## Tartalmi sorrend

Az első képernyőn pontosan **öt**, egyenként egy mondatos vezetői sor:

1. ki a cég és mivel foglalkozik;
2. tulajdonos(ok), vagy hogy ez nyilvános forrásból nem igazolható;
3. mekkora és milyen jellegű partner az Ostorosbor számára;
4. mi változott az elmúlt 12 hónapban;
5. mi legyen a tárgyalás fő célja.

Ezután a sablon sorrendjében: iránytű, ügyfélkép, forgalmi trend, kommunikáció/teendők, webes cégkép, hatás/lehetőségek/kockázatok, forrásjegyzék és adathiányok.

## Minőségi kapuk

- A `/quotes` és `/opportunities` végpontokat ne hívd.
- Forgalmi trend: utolsó 12 lezárt hónap; webes eseményablak: előző 12 hónap a készítés napjáig.
- Minden tény: `[CRM-n]` vagy `[WEB-n]`; következtetés: `Következtetés` / `Javaslat` címke.
- Hiányzó adat: `Nincs adat` vagy `Nem volt elérhető` — becslés tilos.
- A HTML-ben nincs JavaScript, külső CSS/betűkészlet; nem marad `{{`; mobilon olvasható, A4-re nyomtatható.
- A HTML-t ne publikáld és ne küldd el az ügyfélnek.

Ha a CRM vagy a web nem elérhető, készítsd el a rendelkezésre álló részt jól látható adatminőségi figyelmeztetéssel, és sorold fel, mi hiányzott.
