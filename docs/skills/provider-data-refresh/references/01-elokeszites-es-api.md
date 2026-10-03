# 0–1. Szerződés, auth, előkészítés, briefing, export

## 0.1. Hol van a szerződés

Platformon nincs közvetlen HTTP-hozzáférésed a POSnavigatorhoz, csak a hozzád rendelt
**connectoron** át. A szerződés (engedélyezett path-ok, paraméterek, fejlécek) a
`platform.agent.get_definition` válaszában van: `connectors[].endpoints`.

- Hívásonként add meg a `definitionId`-t. Több HTTP connector esetén a `connectorName`-et is
  (a POSnavigator connector `connectors[].name` értéke).
- A path a connector baseUrl-jéhez képest relatív. Ha a baseUrl `…/api/v1`-ig tart, a path
  `/banks/research`. Ha az endpoint-lista mást mutat, az nyer.
- Nem szereplő path → `endpoint_not_allowed` az engedett listával. Ne találgass.
- A skill a **hogyan kutass** és **hogyan kapcsold a workflow-t az API-hoz** leírása. Nem
  másolja az OpenAPI sémáit. Eltérésnél a connector szerződése a mérvadó.

## 0.2. Auth

A hitelesítést a connector adja (`X-Api-Key`, trace fejlécek). **Ne** add meg kulcsot, `X-Agent-Id`,
`X-Acting-User`, `X-Connector-Call-Id` fejlécet — a platform elutasítja (`platform_injected_header`).

A connector kulcsának **adminnak** kell lennie. Bank-scoped kulccsal az export még 200-at
adhat, a briefing/proposal/run viszont `403 FORBIDDEN` — ilyenkor ne erőltesd, jelezd, hogy
admin kulcsú connector kell (ezt a tenant admin tudja megújítani; kódból nem javítható).

**Soha ne írj API kulcsot a jelentésbe, wikibe, work file-ba vagy a kérés testébe.**

## 0.3. Kötelező HTTP szokások

- **Olvasás:** `http_api_get`, `path`, opcionálisan `query` (skalár értékek). Az API-hibát
  (`ok: false`, `status` ≥ 400) soha ne kezeld sikerként.
- **POST** (run, proposal, lesson): `http_api_request` `method: "POST"`, `body` = **JSON
  string** (kompakt, legfeljebb 200 000 karakter), `idempotencyKey` kötelező. A kulcs 1–128 karakter,
  a hatóköre (kulcs, bank, művelet-fajta). Képezz olvashatót: `pdr-run-{bankId}-{YYYYMMDD}-1`.
  Ugyanazt a kulcsot **csak** azonos body újrapróbálására használd. Javított body → új kulcs
  (növeld a végszámot), különben `409 IDEMPOTENCY_CONFLICT`.
- **PATCH** (playbook, draft proposal): `If-Match` kell. A `headers` argumentumban csak az
  endpoint által deklarált fejléc mehet (`{"If-Match": "\"3\""}`). Az érték az előző válasz
  `etag` mezője. Hiányzó fejléc → `428`, stale → `412` (írás nélkül): újraolvas, újraalkalmaz,
  új hívás. Ha az endpoint nem listázza az `If-Match`-et a `get_definition`-ben, a PATCH nem
  hívható — használj Lessont (`05-utomunka-api.md` 7.4).
- Minden írás jóváhagyást kér: az eredmény `awaiting_approval` + `approvalUrl`; az
  eredményt a `platform.gateway_operation.get` adja a jóváhagyás után. Ne pollozz.
- Hibánál az `error.code` alapján ágazz, ne az `error.message` szövegére. A `details[]`
  mutatja a hibás mezőt.
- Csak `429` és `500` retry. Az `X-RateLimit-Remaining` fejléc nem látszik: lassú, soros
  hívásokkal dolgozz, ne párhuzamosíts.
- A válasz `etag` mezője a verzió (briefing, proposal, playbook írás). A PATCH-hez szó szerint
  (idézőjelekkel) add vissza; `412` esetén olvasd újra a briefinget.

## 0.4. Mit nem csinál a POSnavigator

A research API **nem** böngész, nem scrape-el, nem parse-ol PDF-et, nem cron-oz, nem oszt ki
feladatot. Te végzed a kutatást kívül, és **utólag** jelented az eredményt.

---

## 1.1. Work file könyvtárak

- `platform.work_file.list` `prefix: "provider-data-refresh/"` → melyik szolgáltatónak van már
  anyaga (`{slug}/snapshots/…`, `{slug}/…_export_….json`).
- Ha a kiválasztott szolgáltatónak még nincs, nem kell semmit létrehozni: a work file az
  első `write`-tal jön létre. Útvonalak:
  - `provider-data-refresh/{slug}/snapshots/YYYY-MM-DD.md`
  - `provider-data-refresh/{slug}/{slug}_export_YYYY-MM-DD.json` (ha ≤ 200 000 karakter)
  - `provider-data-refresh/{slug}/{slug}_frissitett_YYYY-MM-DD.json`
  - `provider-data-refresh/{slug}/{Szolgáltató}_elemzés_YYYY-MM-DD.md`
- Ugyanazt a `projectKey`-t add meg minden hívásban. A work file csak szöveg; PDF-et ne
  próbálj tárolni (a `snapshots` jegyzetben a PDF URL-je, hatálydátuma és `content_hash`-e
  elég).

## 1.2. Munka kiválasztása az API-n

```json
{ "definitionId": "…", "path": "/banks/research", "query": { "limit": 100 } }
```

(`http_api_get`.) A lista alapból lapozott (alapérték 25), ezért add meg a `limit=100`-at;
ha 100 elemet kapsz, kérd a következő oldalt is. Az `http_api_get_all` csak lapozási
szerződéssel konfigurált endpointon működik — itt ne használd.

A lista **nincs rangsorolva és nincs dispatch**. Te választasz. Jelek:

- `last_run_completed_at` / `last_run_outcome` — mikor nézték utoljára, milyen eredménnyel
- `open_proposal_count` — van-e már draft vagy ready proposal
- `playbook_updated_at` / `playbook_version`

**Választási heurisztika:**

1. Először a legrégebben futtatott / soha nem futtatott szolgáltatók.
2. Ha `open_proposal_count > 0`, **ne gyárts vakon másodikat.** Előbb olvasd a briefinget: ha
   van nem-stale `ready_for_review`, ezt a kört hagyd ki, vagy csak Lesson/Playbook-javítást
   végezz. Új ready proposal **supersede-eli** az előző readyt.
3. Globális inbox (duplikátum-ellenőrzéshez):
   `/banks/research/proposals` `query: { "status": "ready_for_review" }`.
4. Üzleti súly: egyenlő korú adatnál a nagyobb forgalmú/fontosabb szolgáltató előnyt élvez
   (a saját prioritási listád szerint). Ha a felhasználó megnevezett szolgáltatót, azt vedd.

A régi `GET /banks/data-freshness` **legacy**; a munka kiválasztásához a research lista a helyes.

Jegyezd fel a kiválasztott `bank_id`-t (24 hex karakter).

## 1.3. Briefing — ezt olvasd, mielőtt bármit megnyitsz

`http_api_get` `path: "/banks/{BANK_ID}/research"`.

Jegyezd fel a válasz `etag` mezőjét (és a `playbook.version`-t) — a Playbook PATCH `If-Match`-éhez kell.

A válasz `data`-ja:

| Mező | Mire való |
|---|---|
| `playbook` | Kutatási recept. Ha `materialized: false` / `version: 0`, szintetizált default (website + social + verification URL-ek), **még nincs elmentve**. |
| `playbook.sources` | Mit kell megnyitni (`pricing_page`, `fee_pdf`, `social`, `press`, `other`). `content_hash` ha van: összevethető az új letöltéssel. |
| `playbook.hunt_steps` | Sorszámozott eljárás (`order` 1-alapú). Ezt kövesd, ne találj ki új sorrendet, hacsak a lépések üresek. |
| `playbook.pdf_maps` | PDF kinyerési utasítások (1-alapú oldal, regex group 0-alapú). |
| `playbook.notes` | Szabadszöveges instrukció (a régi `data_verification_instructions` tükre). |
| `last_run` | Előző vizsgálat; ne ismételd vakon ugyanazt, ha friss és `unchanged`. |
| `open_proposals` | Draft / ready összefoglalók, payload nélkül. |
| `lessons.accepted` | Ember által jóváhagyott tudás — **olvasd el a kutatás előtt.** |
| `lessons.pending` | Még nem bírált visszajelzés; ne tedd fel ugyanazt újra. |
| `freshness` | Legacy tükör (URL-ek, instrukció, időbélyegek, `last_research_outcome`). |

**Kötelező szabály:** a kutatás során a Playbook `sources` + `hunt_steps` + `notes` +
`pdf_maps` a vezérlő, nem csak a legacy `data_verification_urls`. Ha a Playbook üres
(`hunt_steps: []`, nincs `pdf_maps`), a weboldal/PDF/social módszertant követed
(`02-kutatas.md`), és a kör végén rögzítsd a tanult receptet (Playbook PATCH, ha lehet, különben
Lesson — `05-utomunka-api.md`).

## 1.4. Kanonikus export — ez lesz a proposal alapja

**JSON (proposal payload, kötelező):** `http_api_get`
`path: "/banks/{BANK_ID}/export"`, `query: { "format": "json" }`.

A JSON válasz: `{ "success": true, "data": { exportMetadata, bank, mainservices, summary } }`.

- A **`data` objektum** a round-trip alapja (nem a teljes envelope).
- Jegyezd fel az `exportMetadata.revision` értékét (`sha256:…`). Ez a `base_revision`.
- A `revision` **nem** változik Playbook/freshness PATCH-től, és nem tartalmazza az
  `exportedAt` / üres justification / research meta mezőket.
- **Méret:** a válasz `truncated: true`-t jelezhet (a connector válaszméret-korlátja fölött). Csonkolt
  exportból **soha** ne építs proposalt: hiányzó ág = törlés. Ilyenkor a `03-proposal-payload.md`
  "Nagy export" szakasza szerint járj el.
- Ha belefér a work file-ba (≤ 200 000 karakter), mentsd
  `provider-data-refresh/{slug}/{slug}_export_{YYYY-MM-DD}.json` néven — ez a következő kör
  kiindulópontja.

**Markdown (emberi olvasáshoz, nem round-tripelhető):** ugyanaz `format=md`; a MD a `content`
mezőben van. Javaslat payloadnak **ne** használd, és csak akkor kérd le, ha kell: a JSON is elég.

A `mainserviceIds` query csak a visszaadott fát szűkíti; a `revision` mindig a teljes
hierarchia ujjlenyomata. Proposalhoz a **teljes, szűretlen** JSON-t használd — hiányzó
mainservice törlésnek számít.

## Gyors API térkép

| Lépés | Eszköz | Path |
|---|---|---|
| 1 | `platform.agent.get_definition` | — (szerződés, `definitionId`) |
| 2 | `http_api_get` | `/banks/research` |
| 3 | `http_api_get` | `/banks/{id}/research` (recept + `playbook.version`) |
| 4 | `http_api_get` | `/banks/{id}/export?format=json` (élő állapot + revision) |
| 5 | kutatás kívül | Playbook + `02-kutatas.md` |
| 6 | `http_api_request` POST | `/banks/{id}/research/proposals` (ha van változás) |
| 7 | `http_api_request` POST | `/banks/{id}/research/runs` (**mindig**) |
| 8a | `http_api_request` PATCH | `/banks/{id}/research/playbook` (tartós recept, `If-Match`) |
| 8b | `http_api_request` POST | `/banks/{id}/research/lessons` (emberi ítélet) |

Proposal részletek / stale: `http_api_get` `/banks/{id}/research/proposals/{proposalId}`.
Draft → ready: `PATCH` ugyanott, `If-Match`-csel.
