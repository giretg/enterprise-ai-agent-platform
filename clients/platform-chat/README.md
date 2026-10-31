# Platform-chat worker (#1004)

A platformba épített beszélgetés háttér-szolgáltatása. **Szigorúan külső MCP-kliens**: a tool-okat a
platform nyilvános `/api/mcp/<tenant>` végpontján, a modellt a Model Gatewayen
(`/api/model-gateway/v1/chat/completions`) éri el. Az `app/` kódjából semmit nem importál — ezt a
`scripts/check-import-boundary.ts` (CI) tartja.

```
böngésző (platform UI)  ──1. POST /api/chat/session──▶  platform  → chat-token (10 perc)
        │ 2. API + SSE a worker run.app címére (Bearer chat-token, CORS: csak a platform)
        ▼
worker (Cloud Run, request-based, min=0)
  ├─ POST /api/chat/continuation  → fordulóra szűkített folytatási token (háttérfutás)
  ├─ MCP                          → /api/mcp/<tenant>  (folytatási tokennel, x-excellence-agent-id)
  ├─ modell                       → /api/model-gateway/token + /v1/chat/completions
  ├─ Cloud Tasks                  → saját /internal/step (lépésenként egy kérés, OIDC)
  └─ Postgres                     → csak a platform_chat séma (platform_chat_worker szerep)
```

## Forduló-futás

Minden lépés (`llm` vagy `tool`) külön Cloud Tasks-kérés; az állapot a `turn_steps`-ben van.
A kész lépés nem fut újra, az író tool idempotencia-kulcsot kap (`hash(turnId, seq, toolName)`).
Író tool jóváhagyása MRTR-űrlappal: a forduló `awaiting_approval`-ra áll és **leáll** (nincs futó
feladat); a „Jóváhagyom / Elvetem” új lépést indít. 15 perc után a kérés a platform jóváhagyási
listáján marad, a forduló zárószöveggel lezárul. Korlátok: 25 lépés, 40 perc, lépésenként 3 próba,
ismétlődő-hurok (azonos tool + argumentum 3×) → leállás.

## Letöltés-kártya (#1024)

- A tool-eredmény `resource_link` tartalma (pl. `document_export`) és az ismert letöltési mező
  (`warehouse.export_dataset` → `exportUrl`) a válasz-üzenet `files` mezőjébe kerül (`messages.files`, 002-es migráció).
  Csak a platform saját címére (`PLATFORM_ORIGIN`) mutató link lesz kártya.
- A kártya a beszélgetés újranyitásakor is látszik; lejárt fájlnál a teendőt mutatja, letöltés-gomb nélkül.
- „Mentés a Drive-ra”: csak `exportId`-s fájlnál és csak ha a munkatárs eléri a `google_drive_upload_file`-t;
  a gomb egy rövid kérést küld, a modell az előzményben látja az `exportId`-t, a feltöltés a szokásos jóváhagyással megy.

## Halasztott eszköz-betöltés (#1022)

A modell nem kapja meg minden lépésben az összes MCP-eszköz teljes sémáját:

- **Mag** (`tools[]`, teljes sémával): `PLATFORM_CHAT_CORE_TOOLS` (vesszővel elválasztva; alapértelmezés
  `platform.project_memory.read,platform.promise.list,platform.work_file.list,kb_search,web_search`) ∪ a definíció opcionális `preloadTools` listája.
- **Eszköz-index** (system prompt, a definíció/memória előtt): minden más eszköz neve + egysoros leírása,
  csoportosítva, kódpont-sorrendben. Csak a mag-listától függ, így fordulók között is bájt-azonos (prompt-cache).
- **`tool_describe(names[])`**: harness-eszköz, a worker helyben válaszol (nem MCP-hívás). A kért eszközök a
  `turns.context.loaded` halmazba kerülnek, és a következő lépéstől a `tools[]` részei. A modell a saját
  nevükön hívja őket — az idempotencia-kulcs, a jóváhagyás (MRTR) és az audit változatlan.
- **Ragadós**: a beszélgetés következő fordulója az előző forduló betöltött halmazával indul.
- **Be nem töltött eszköz hívása**: a worker betölti a sémát, és rövid hibával visszadobja („hívd újra”);
  ez a lépés nem számít az ismétlődő-hurok őrbe.

A stream (`GET /turns/:id/events`) a `turn_events` táblát pollozza, `Last-Event-ID`-vel folytatható,
és a forduló végén vagy 2 perc csend után zár (nyitva felejtett kapcsolat nem számlázódik).

## Csatolmányok (#1023)

A promptba fájlleírás és az első kérésnél legfeljebb 3000 karakter / 20 táblázatsor kerül.
A korábbi csatolmányok szövege és képei nem ismétlődnek. PDF, DOCX, PPTX, JSON,
CSV, XLSX, TXT/MD és PNG/JPG tölthető fel (20 MB/fájl, 5 fájl/üzenet).

- `attachment_read`: `id`, PDF/PPTX esetén `pages: [első, utolsó]`, táblázatnál `sheet`,
  `rows: [első, utolsó]`; 1-től számozva. `offset` és `limit` a kijelölt rész szövegét lapozza.
- `attachment_search`: teljes fájlban keres, oldal-/sorszámot ad; `offset` a találatokat lapozza.
- `attachment_view`: PDF-oldalt vagy képet küld a Model Gateway-en át; képet nem fogadó modellnél jelzés.
- Az `attachment://<id>` hivatkozást csak a worker oldja fel: Drive `contentBase64`/`textContent`,
  adattárház `fileBase64`, tudástár `contentBase64`/`content`, sandbox `inputs`.
  A sandbox elérési útját a manifest `sandboxPath` mezője adja; továbbra is csak publikált,
  hozzárendelt skill futtatható. Összesítéshez az eredeti fájlt kell átadni, nem a kezdőrészletet.

A cél jelenlegi méretkorlátja érvényes: Drive/adattárház 10 MB, tudástár 2 MB,
sandbox fájlonként 5 MB. A mérethatárt meghaladó fájlhoz az eszköz saját feltöltőoldalát kell használni.
A jogosultság, az MRTR-jóváhagyás és az idempotencia változatlan; base64 nem kerül a modellkontextusba.
A meglévő `extracted_text` mező csak a manifestet és a kezdőrészletet tárolja, migráció nem szükséges.

## Helyi futtatás

```bash
npm install
# séma (a tulajdonos szerepével, ideiglenes helyi DB-n):
PLATFORM_CHAT_MIGRATE_URL=postgres://owner@localhost:55432/chat npm run migrate
PLATFORM_ORIGIN=http://localhost:3001 \
PLATFORM_CHAT_SELF_URL=http://localhost:8787 \
PLATFORM_CHAT_TOKEN_SECRET=<ugyanaz, mint a platformé, ≥32 karakter> \
PLATFORM_CHAT_DATABASE_URL=postgres://platform_chat_worker:…@localhost:55432/chat \
PORT=8787 npm run dev        # PLATFORM_CHAT_QUEUE=inline: Cloud Tasks nélkül, egy folyamatban
```

A platform oldalán: `PLATFORM_CHAT_WORKER_URL=http://localhost:8787` és ugyanaz a
`PLATFORM_CHAT_TOKEN_SECRET`; a tenantnál Beállítások → Beszélgetés a platformon → Bekapcsolás.

## Éles telepítés

`ops/platform-chat/deploy.sh` (Cloud Run, Cloud Tasks sor, GCS bucket, service accountok, riasztás),
előtte `npm run migrate` a séma-tulajdonossal és `ops/platform-chat/db-role.sql` a szűk szereppel.

## Tesztek

```bash
npm test                     # motor, auth, HTTP-API, import-határ (DB nélkül)
PLATFORM_CHAT_TEST_DATABASE_URL=postgres://platform_chat_worker:…@localhost/chat npm run test:pg
```
