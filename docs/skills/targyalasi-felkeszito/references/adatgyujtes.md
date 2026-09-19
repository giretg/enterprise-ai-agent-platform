# CRM- és webes adatgyűjtés (egyszerűsített)

## API alapok

Az OpenAPI-szerződés és a rendszerüzenet connector-katalógusa a forrás. Minden lekérés csak olvasás. A válasz payloadja jellemzően a `data` mezőben van. Nagy listához `http_api_get_all` — ne lapozz kézzel több `http_api_get`-tel.

## Kizárt CRM-végpontok

Ne hívd: `/quotes`, `listQuotes`, `/opportunities`, `listOpportunities` — a platformon nem használtak.

## Kötelező lekérdezési sor (max 4 CRM-hívás)

Számítsd ki az utolsó 12 **lezárt** naptári hónap `from` / `to` dátumát (`YYYY-MM-DD`).

| # | Művelet | Mikor | Mit ad |
|---|---------|-------|--------|
| 1 | `listAccounts` | Partner feloldás | `account.id`, cégnév, adószám |
| 2 | `getAccount360` `view=summary` | Mindig | Törzs, owner, kapcsolat, health, utolsó aktivitások, teendők, riasztások, havi forgalom összefoglaló |
| 3 | `postReportsQuery` | Mindig | `preset: partner-turnover`, `accountId`, 12 hó, `compare: yoy` — havi forgalom, YoY, trend |
| 4 | `http_api_get_all` `listOrderLines` | Csak ha #2–3 nem ad elég mix/top termék adatot | Termékmix, top tételek |

**Ne hívd** külön: `getReportsPresets`, `getReportsMetadata`, `listOrders` több oldalon, `interactions` teljes lapozása — az Account 360 + riport fedje a brief 80%-át.

## Adatleltár (kötelező mezők)

| Terület | Mit várunk |
|---------|------------|
| Azonosítás | cégnév, CRM-id, adószám |
| Törzs | típus, régió, csatorna, owner |
| Egészség | health score, utolsó rendelés, next best action |
| Forgalom | 12 havi nettó összeg, rendelésszám, YoY % |
| Mix | top 3 termék/brand (ha elérhető) |
| Kapcsolat | utolsó 3–5 kommunikáció (Account 360-ból) |
| Teendő/riasztás | nyitott elemek (Account 360-ból) |
| Web | tevékenység, boros kapcsolat, 1–3 releváns esemény/akció URL-lel |

Hiányzó sor → `Nincs adat` az adathiányok blokkban, ne találj ki.

## Webes kutatás (max 2 keresés)

A partner feloldása után **azonnal**, a CRM-hívásokkal párhuzamosan:

1. `"<cégnév>" bor` vagy `site:<domain> bor`
2. `"<cégnév>" akció` vagy `"<cégnév>" Ostorosbor`

Forrásprioritás: hivatalos weboldal → cégnyilvántartás → sajtó/szakmai média. Aggregátor csak nyomként, jól jelölve.

Keresési snippet nem tény — a briefbe csak megnyitott/ellenőrzött URL és cím kerül. „Nem találtam” = a keresés eredménye, nem a nemlétezés bizonyítéka.
