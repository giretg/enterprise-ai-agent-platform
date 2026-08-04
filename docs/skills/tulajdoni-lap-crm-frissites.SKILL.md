---
name: tulajdoni-lap-crm-frissites
title: Tulajdoni lap → Ostoros Föld frissítés
description: Tulajdoni lap összevetése az Ostoros Föld nyilvántartással, majd a különbségek közvetlen végrehajtása a Föld API-n (ownership létrehozás/módosítás/törlés). Használd, ha tulajdoni lap alapján kell frissíteni az Ostoros Föld rendszert, ha „írd át a tulajdonosokat a rendszerben", vagy ha hrsz-re kérnek Föld-szinkront — nem Excel egyeztető táblát.
max-wall-clock-ms: 900000
max-tool-calls: 150
preferred-mode: task
attachment-description: Csatolj egy tulajdoni lapot!
allowed-tools: tulajdoni_lap_egyeztetes, http_api_get_all, http_api_get, http_api_request, file_write, reconcile_records, tulajdoni_lap_parse
---

# Mi a feladat

Kiolvasni a tulajdoni lapból a valós tulajdonosi összetételt, összevetni az
Ostoros Föld nyilvántartással, majd a különbségeket **a Föld API-n végrehajtani**
(ownership létrehozás / módosítás / törlés). Egy futás = egy tulajdoni lap =
egy parcel = **egy proposal-csomag**.

Ez **nem** az Excel-egyeztető skill. **Ne készíts / ígérj Excel-táblát** — a
deliverable a Föld draft + szöveges összefoglaló. Excelhez: `tulajdoni-lap-egyeztetes`.

# Kemény szabályok

**Írj a Föld-be** egyeztetés után, minden eltérésre. `http_api_request` engedett
és kötelező; platform HITL / consequence gate OK — ne kerülgesd.

**A Föld draft = Excel szerep:** Ownership POST/PATCH/DELETE csak draftot hoz;
véglegesítés Föld UI emberi jóváhagyás. Draftold az összes eltérést.

**Egy föld = egy csomag.** `proposalId` nélkül minden írás új egytételes csomagot
nyithat. `X-Proposal-Id` + `body.proposalId` kötelező. A `proposalId` **CSAK** a
Föld `POST /proposals` válasz `id`-je (cuid) — TILOS kliens UUID / placeholder
(404: *„Javaslatcsomag nem található”*). Előbb `POST /proposals`, kapd meg az
`id`-t, **azután** Ownership írások.

**Záró menet (kötelező):** Ownership írások → platform coverage →
`POST /proposals/{id}/validate` → `valid:false`? javíts + validate újra → csak
`valid:true` után `POST /proposals/{id}/submit`. Validate nélkül **TILOS**
submit. (A submit ugyanezt a dry-runt futtatja; hibánál 422, nem lesz `BEKULDVE`.)

Ne állj meg „kockázatos / bizonytalan párosítás / emberi ellenőrzés” indokkal.
Kimeneti formátumot ne kérdezd. Nagy listát NE chunkold a kontextusba — egyeztető
eszköz + `fold_muveletek.json`.

# Tiltott anti-minta

- `tulajdoni_lap_parse` / ownership lista lapozása a kontextusba
- `http_api_get` ownerships-re (helyette `http_api_get_all`); page=1,2,3…
- csonka extract → egyeztetés; Excel deliverable / `kimenet: ….xlsx`
- Föld-írás megtagadása „kockázat” miatt; írás egyeztetés nélkül / „Rendben” sorokra
- Ownership `proposalId` nélkül; kitalált proposalId; proposals+Ownership ugyanabban
  a kapu-batchben előre generált ID-vel
- mezőnevek tippelése 400/422 után
- `submit` validate nélkül / `valid:false` mellett
- validate minden egyes írás után (csak a kész csomagra)

# Menet: gyűjtés → egyeztetés → írás → coverage → validate → submit

## 0. Checkpoint — `fold_frissites_progress.json`

```json
{
  "hrsz": "043/15",
  "parcelId": "…",
  "proposalId": null,
  "nyilvantartasPath": "nyilvantartas.json",
  "pagesFetched": "all",
  "muveletekPath": "fold_muveletek.json",
  "status": "nyilvantartas_ready"
}
```

`proposalId` = Föld `body.id`. Megszakadás után EBBŐL folytasd.

## 1. Nyilvántartás — EGY `http_api_get_all`

1. Parcel (hrsz) → `parcelId`.
2. Ownerships: **kötelező** `http_api_get_all` `/parcels/{id}/ownerships` — TILOS
   sima get (csonka oldal → hamis „Új rekord”).
3. Tool-output path → `nyilvantartasPath` az egyeztetőnek (aliasok OK).
4. Teljes listát NE olvasd vissza.

Üres lista ≠ minden új — ellenőrizd a hrsz formátumot. Csonka-lista figyelmeztetés
→ újra get_all; `confirmNyilvantartasComplete=true` csak ha get_all után is ennyi.

## 2. Egyeztetés — EGY hívás

```
tulajdoni_lap_egyeztetes({
  documentId: "…",
  nyilvantartasPath: "tool-outputs/…http_api_get_all….json",
  parcelId: "…"
})
```

**Ne** add `kimenet`-et (nincs Excel). A tool írja:
- `egyeztetes-eltero.json`
- `fold_muveletek.json` — determinisztikus terv, teljes `items[]`,
  sorrend **DELETE → PATCH → POST**

A terv forrása a `muveletekPath`. **NE** építsd újra, **NE** írd felül az
`items`-t, **NE** találj ki ownership id-t. Tipikusan két kapu-kör: (1)
`POST /proposals`, (2) Ownership írások. A „Mind jóváhagyom” után a feladat
magától folytatódik.

`partial` / emberi ellenőrzés **nem** tiltja a draftot. Checkpoint:
`egyeztetes_done` + path-ok.

## 3. Terv — `fold_muveletek.json`

| Egyeztető | action | method |
| --- | --- | --- |
| Törlés szükséges | delete | DELETE |
| Módosítás szükséges | patch | PATCH |
| Új rekord | post | POST |

1. Minden `items` elem kötelező. Összevonásnál sibling **DELETE kötelező**
   (kihagyás → hányad > 1 / `sum_exceeds_one`).
2. Id csak a tervből — hiányzik → állj meg.
3. Sorrend: DELETE → PATCH → POST (Föld approve/validate is így).
4. Új sornál `partnerId`: keress `/partners` — tippelni tilos.
5. Body: katalógus / meglévő rekord / terv `body.hanyad`.
6. `Idempotency-Key`-t a platform küldi; `X-Proposal-Id` + `body.proposalId` te.

## 4. Írás egy csomagban

Hívd az összes `items` elemet a fájl sorrendjében, ugyanazzal a `proposalId`-vel.

1. Folytatás: érvényes Föld `proposalId` → használd. UUID/404 → új `POST /proposals`.
2. Új csomag: külön kapu-körben csak `POST /proposals` `{ "cim": "<hrsz> …" }` →
   `body.id` → checkpoint; **azután** Ownership írások.
3. Minden Ownership: `X-Proposal-Id` + `body.proposalId`.
4. Connector: `POST/GET /proposals`, `…/validate`, `…/submit`, Ownership írók.

400/422: ne tippelj body-t. 404 proposal → rossz id. 404 ownership → hallucinált
id, ne ismételd.

**Platform coverage** (Ownershipok után; proposal extract a workspace-re):

```
tulajdoni_lap_egyeztetes({
  coverageAppliedPath: "proposal_items_extract.json",
  coverageMuveletekPath: "fold_muveletek.json"
})
```

`coverage.ok !== true` → NE validate/submit/fold_done; pótold a missing
DELETE/PATCH-eket a tervből, extra id-ket hagyd.

## 4b. Föld validate — submit előtt

Csak a **kész** csomagra (minden együtt érvényesülő tétel + coverage OK).

```
POST /proposals/{proposalId}/validate
```

Body `{}` / üres. **Nincs** `Idempotency-Key` (nem ír). HTTP **200** ha a
csomag a tiéd. Válasz: `{ "valid": true|false, "proposalId", "issues": [...] }`.

Issue mezők: `itemId`, `entityType`, `entityId`, `muvelet`, `code`, `message`,
`details` (pl. `parcelId`, `actual` hányadösszeg).

- `valid: true` → submit.
- `valid: false` → **NE submitolj**; javíts `issues` alapján → validate újra.

Dry-run = approve szabály írások nélkül: entitás-rang; Ownership-on
**DELETE → UPDATE → CREATE**; hányad ≤ 1, draft-referencia, `proposal_base_conflict`,
patch formátum.

```
írások → coverage → POST …/validate
  → false? javít → validate
  → true → POST …/submit
```

| code | Teendő |
| --- | --- |
| `sum_exceeds_one` | Sibling **DELETE**-ek a tervből; ne UPDATE teljes hányadra testvérsorok nélkül |
| `draft_reference` | Partner/LandParcel CREATE ugyanebben a csomagban, vagy élő sor |
| `proposal_base_conflict` | Újra get_all ownerships; friss patch / új elem |
| `invalid_format` | Javítsd a hányad/patch mezőket |
| `not_found` | Hibás / törölt entityId |

## 4c. Submit

`valid: true` után: `POST /proposals/{proposalId}/submit`. Ember bírál a Föld
UI-n — **approve/reject tilos** agentnek.

Menet: proposals → Ownership (DELETE→PATCH→POST) → coverage → **validate** →
(javítás loop) → submit → ember.

`fold_done` csak: Ownershipok OK + coverage OK + `valid: true` + submit OK
(vagy beküldve / submitra vár).

## 5. Válasz

- rendben / draft darabszám, proposalId, fő tételek
- validate (`valid` + rövid issues)
- Föld UI emberi jóváhagyás még kell
- bizonytalan tételek; lap `meta.kelt`
- bukás / `valid:false` esetén őszintén: mi a hiba, mi a következő lépés

Hányadokat %-kal. Ne ígérj végleges Föld állapotot függő draftnál. Ne zárd Excellel.

# Ha a lap ellenőrzés bukik

Egyeztető `ok: false` (hányad ≠ 1) → **ne írj**. Mondd az összeget; kérdezz.
Szemle → teljes másolat kell.

# Domain

- Hatályos vs. törölt: csak hatályos.
- Egy személy = több Föld-sor: PATCH összesített hányadra + sibling **DELETE**.
- Joggyakorló ≠ tulajdonos — draftold a törlést, jelezd.
- Terhek nem ownership (külön `/encumbrances` ha kérik).

# Folytatás

Checkpointból: ne kezdd elölről. Meglévő nyilvántartás / `fold_muveletek` /
`proposalId` → folytasd. TILOS: újra teljes parse, felesleges get_all, chunkolt
újraolvasás.
