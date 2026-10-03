# 7. Utómunka (jelentés után — az API-ra kötelező)

Sorrend számít: előbb proposal (ha van), aztán run (mindig), aztán opcionális playbook/lesson.

Minden írás (`http_api_request`, Drive-feltöltés/-felülírás) jóváhagyást kér: a hívás `awaiting_approval`-lal tér vissza,
az `approvalUrl`-t add át a felhasználónak, ne pollozz. A jóváhagyás után az eredményt a
`platform.gateway_operation.get` `result` mezője adja. **Egyszerre egy írást kezdeményezz**, és
a következőt csak az előző eredménye után: a run-nak kell a proposal `data.id`-ja, a
playbook-nak az újabb `version`.

## 7.1. ChangeProposal — csak ha van adatváltozás

Lásd `03-proposal-payload.md`. Ready proposal után az admin itt nézi:

- Inbox: `{POSnavigator alap URL}/hu/admin/banks/data-freshness`
- Compare: `{POSnavigator alap URL}/hu/admin/banks/edit/{BANK_ID}/compare?proposalId={PROPOSAL_ID}`

Az alap URL a POSnavigator connector baseUrl-jének gazdagépe (`https://posnavigator.eu`);
nem a `/api/v1`-es része.

## 7.2. ResearchRun — mindig, még ha unchanged / failed / blocked

Ez lépteti a `last_data_verification_ai_at` és `last_research_outcome` mezőket. **Nincs run =
a bank "nem volt vizsgálva"**, akkor is, ha a jelentés kész.

`outcome` — pontosan egy:

| outcome | Mikor |
|---|---|
| `unchanged` | Végigcsináltad, az élő adat stimmel, nincs proposal |
| `proposal_created` | Van proposal; **kötelező** `proposal_id` (a jóváhagyott proposal-POST eredményéből) |
| `needs_human` | Végeztél, de nem dönthető el biztonságosan, vagy platform-akadály miatt nem küldhető a proposal; a `summary` mondja meg, mi a kérdés |
| `failed` | Technikai ok (404, olvashatatlan PDF); később retry-olható |
| `blocked` | Paywall, login, captcha, geo, robots, vagy hiányzó webes eszköz — ember nélkül nem megy |

Ha a proposal-POST jóváhagyása elmaradt vagy elutasították, a run nem lehet
`proposal_created`: `needs_human`, és a `summary` mondja el, mi történt.

`http_api_request`:

```json
{
  "definitionId": "…",
  "method": "POST",
  "path": "/banks/{BANK_ID}/research/runs",
  "idempotencyKey": "pdr-run-{BANK_ID}-{YYYYMMDD}-1",
  "body": "{\"outcome\":\"proposal_created\",\"summary\":\"Kondíciós lista 4. oldal: POS havi díj 2990→3490. Proposal a cost_fixed mezőre.\",\"started_at\":\"2026-08-25T08:00:00.000Z\",\"completed_at\":\"2026-08-25T10:00:00.000Z\",\"agent_id\":\"{az agent neve}\",\"visited_urls\":[\"https://szolgaltato.hu/arak\"],\"documents_found\":[{\"url\":\"https://szolgaltato.hu/kondiciok.pdf\",\"title\":\"Kereskedői kondíciós lista\",\"media_type\":\"application/pdf\",\"note\":\"2026 Q3 lista\"}],\"proposal_id\":\"66b0a1c2d3e4f5060708090a\"}"
}
```

- `body` **JSON string**; sablon: `templates/run-body.json`.
- `completed_at` kötelező, ISO-8601, és legfeljebb 300 mp-cel lehet a szerveridő előtt. Az
  időt a kliens órájából vedd; ha nincs megbízható időd, kérdezd meg a felhasználót, ne találd ki.
  A `started_at` elhagyható.
- `summary` 1–8000 karakter; az adminnak szól: mit néztél, mit találtál, mit nem tudtál igazolni.
- `visited_urls` (max. 100) a **ténylegesen megnyitott** oldalak; `documents_found` (max. 50)
  `content_hash`-e csak akkor mehet, ha tényleg ki tudtad számolni (`sha256:<64 hex>`).
- `agent_id` szabad szöveg (max. 128), nem azonosító: az agent neve a `get_definition`-ből.
- **Ne** PATCH-eld a `last_data_verification_ai_at`-et a legacy freshness API-n. A run a forrás.
- A run POST-ja is jóváhagyást kér. A kör akkor teljes, ha a felhasználó jóváhagyta; ezt a
  jelentés végén ("API utómunka státusz") rögzítsd.

## 7.3. Playbook PATCH — ha tartós receptet tanultál

Jobb URL, pontosabb hunt step, javított pdf_map, tisztább notes.

**Mi az `If-Match`, és miért kell?** A POSnavigator a Playbookot verziózza. A PATCH-nek meg kell
mondanod, melyik verziót olvastad (az `If-Match` fejléc), hogy ne írd felül egy ember közben
végzett módosítását. Ha közben változott, `412` jön és semmi nem íródik; ilyenkor újraolvasol.

**Honnan van az érték?** A briefing (`GET /banks/{id}/research`) válaszában az `etag` mező.
A PATCH `headers` argumentumában add vissza, szó szerint, idézőjelekkel együtt. Csak az
endpoint által deklarált fejléc mehet (`get_definition` → endpoints → headers). Ha a briefing
válaszában nincs `etag`, vagy az endpoint nem deklarálja az `If-Match`-et, ne próbálkozz: a
tanultat Lessonként küld el (7.4) `playbook_patch` javaslattal.

```json
{
  "definitionId": "…",
  "method": "PATCH",
  "path": "/banks/{BANK_ID}/research/playbook",
  "idempotencyKey": "pdr-playbook-{BANK_ID}-{YYYYMMDD}-1",
  "headers": { "If-Match": "\"3\"" },
  "body": "{\"notes\":\"A 2026-os kereskedői PDF 4. oldalán a POS havi díj, 5. oldalon az acquiring tábla.\",\"sources\":[ … a briefing teljes listája + új tétel … ]}"
}
```

- Csak a küldött kulcsok cserélődnek. `sources` / `hunt_steps` / `pdf_maps` küldése a
  **teljes** tömb cseréje (nem append).
- Az `id`-ket küldd vissza, hogy stabilak maradjanak.
- Sikeres írás tükrözi a source-okat a Bank freshness mezőibe, és **nem** avítja el a nyitott
  proposalokat. A válasz új `etag`-et ad.
- `412`: újra GET briefing, új `etag`, újrapróbál.
- A `materialized: false` Playbookot az első értelmes PATCH materializálja — ha tanultál
  receptet, ne hagyd szintetizáltan (vagy javasold Lessonnel).

A legacy `PATCH /banks/{id}/data-freshness` ugyanezt a modult hívja, de **csak** URL-eket és
notes-t tud; új munkához ne használd.

## 7.4. Lesson — ha emberi ítélet kell (vagy a Playbook PATCH nem hívható)

`kind`: `wrong_source` | `missed_pdf` | `bad_field_mapping` | `false_positive` | `procedure`.

Agent Lesson mindig `pending`. A csatolt `playbook_patch` csak javaslat; acceptkor az admin
alkalmazhatja.

```json
{
  "definitionId": "…",
  "method": "POST",
  "path": "/banks/{BANK_ID}/research/lessons",
  "idempotencyKey": "pdr-lesson-{BANK_ID}-{YYYYMMDD}-1",
  "body": "{\"kind\":\"procedure\",\"body\":\"Mindig a tárgyévi kereskedői PDF-et nyisd, ne a marketing oldalt.\",\"run_id\":\"<a 7.2-ben kapott run id>\",\"proposal_id\":\"<ha van>\"}"
}
```

- `body` 1–10 000 karakter. `run_id`/`proposal_id` opcionális: a run jóváhagyása utáni
  `data.id`.
- **Lesson vs Playbook:** mechanikus, magabiztos tudás → Playbook PATCH (ha hívható). Ítélet /
  vitatott forrás / rossz map / nem hívható PATCH → Lesson (`pending`), `playbook_patch`
  javaslattal; a szerver **nem** alkalmazza magától.

## 7.5. Work file-ok és Drive

Work file-ok (`platform.work_file.*`, jóváhagyás nélkül):

- `provider-data-refresh/{slug}/{Szolgáltató}_elemzés_{YYYY-MM-DD}.md` (+ Drive-példány, 04-jelentes)
- `provider-data-refresh/{slug}/{slug}_frissitett_{YYYY-MM-DD}.json` (a proposal payload másolata, ha belefér)
- `provider-data-refresh/{slug}/snapshots/YYYY-MM-DD.md`
- `provider-data-refresh/_gyujto/kereskedo-kerdesek.md`
- `provider-data-refresh/_gyujto/dij-valtozasok-YYYY-Qn.md` (ha volt díjmozgás)

A wiki és a riport a Google Drive-on van (7.6, 04-jelentes). A PDF-fájlt nem tudod work file-ban
tárolni (szöveg); a snapshot rögzítse az URL-t, a hatálydátumot és a hash-t, ha van.

## 7.6. Wiki ingest (kötelező, ha van csapat-wiki)

A jóváhagyónak átadás **előtt**. A wiki a Google Drive-on él: `Posnavigator AI alapadatok/Wiki`
(`Szolgáltatók/{Szolgáltató}.md`, `log.md`, `index.md`). Minden Drive-írás jóváhagyást kér, ezért
**gyűjtsd a wiki-írásokat a végére**, és mondd meg a felhasználónak, hány jóváhagyást kérsz
(lap + log + új lapnál index).

1. **Megkeresés:** `google_drive_search` (`nameContains`) a wiki mappában / névvel. Mappa-azonosítót
   a keresés ad; ha a `Wiki` mappa nem található, kérdezd meg a felhasználót.
2. **Meglévő lap frissítése:** `google_drive_read_file` → a teljes szöveg és a `file.modifiedTime`.
   Készítsd el a **teljes új szöveget** (a régi tartalmat vidd át, ne veszítsd el), majd
   `google_drive_update_file` `fileId`, `textContent`, **`expectedModifiedTime` = a kiolvasott
   `modifiedTime`**, `idempotencyKey`. Ha a művelet `drive_file_modified` hibával áll meg, valaki
   közben szerkesztette: olvasd be újra, vezesd át a változást, és próbáld újra.
3. **Új lap:** `google_drive_upload_file` `name: "{Szolgáltató}.md"`, `mimeType: "text/markdown"`,
   `parentFolderId` = a `Szolgáltatók` mappa (sablon: `templates/wiki-szolgaltato-lap.md`).
4. **Tartalom:**
   - `utolso_frissites` = a vizsgálat napja.
   - `forrasok`: elemzés fájl, snapshot, díjjegyzék, **proposal_id / run_id**.
   - `Frissítési előzmények`: mi változott, vagy ha nem, mi lett ellenőrizve.
   - Ellentmondás a régivel → `> ⚠️ FRISSÍTVE: [dátum] — korábbi adat: X, új adat: Y`.
5. **Log (append-only):** `log.md` → olvasd, fűzd a végére: `## [YYYY-MM-DD] ingest | [Forrás neve] | [N] lap frissítve`,
   majd `google_drive_update_file` az `expectedModifiedTime`-mal.
6. **Új lapnál** az `index.md` katalógus is: ugyanígy olvasd, egészítsd ki, írd vissza.

Ha `drive_write_not_allowed` jön, a Drive-kapcsolatban a Wiki mappa nincs az írható kiválasztások
között: az adminnak kell kiválasztania (Kapcsolt fiókok → Google Drive). Ha nincs wiki vagy a
felhasználó nem hagyja jóvá, a lépést jelöld "kihagyva"-ként a jelentésben.

A run `proposal_id` / `run_id` mezőit csak akkor írd be, ha már megvan; különben "függőben
(jóváhagyásra vár)".

## 7.7. Értesítés a jóváhagyónak

- Címzett: Csilla — `csilla.szabo@excellencepay.com` (vagy a beállított jóváhagyó).
- Kérd, hogy **a proposal inboxban / compare oldalon** ellenőrizze és approve-olja (ne
  "JSON-t töltsön fel").
- Add meg: szolgáltató, `bank_id`, `proposal_id` (ha van), compare URL, run outcome, a riport
  (Drive link vagy work file útvonal) és a wiki lap hivatkozása, és az érintett éles felületek
  (Aréna, landing, widget, Saját Ajánlatok, POS eszközvásárlás).
- Ha `unchanged`: röviden jelezd, hogy a run lefutott, nincs teendő az adatlapon.

**Csatorna (az első, ami működik):**

1. **Handoff, ha a cím a platform felhasználója:** `platform.work.handoff` `toUserEmail:
   "csilla.szabo@excellencepay.com"`, `title`, `summary`, `links` (`riport | https://…`,
   `compare | https://…`), `idempotencyKey`. A szerver az e-mail címet a tenant aktív tagjára
   oldja fel; a feladat Csilla Control Plane inboxában jelenik meg, jóváhagyás nélkül. Ha a
   hívás `agent_access_denied`-et ad, a cím nem a tenant tagja: menj a 2. pontra.
2. **AgentMail e-mail:** `http_api_request` az AgentMail connectoron (`connectorName`),
   `method: "POST"`, `path: "/messages/send"`, `body`:
   `{"to":["csilla.szabo@excellencepay.com"],"subject":"…","text":"…"}`, `idempotencyKey`.
   A levél jóváhagyás után megy ki a posnavigator-ai AgentMail címről, Zoli aláírással.
   Ez a szervezet jóváhagyott kimenő csatornája; ne használd a felhasználó Gmail-jét.
3. Ha egyik sem elérhető: írd le az összefoglalót a felhasználónak a végső válaszban, hogy
   továbbíthassa.

Ha van feladatkezelő connector (kanban/Jira) hozzárendelve, ezen felül: összefoglaló komment +
`review` státusz a jóváhagyónak (a frissítési feladat ne `done` legyen). Ez `http_api_request`,
tehát jóváhagyást kér.

Mindig tedd be a végső chat-válaszba is az összefoglalót.

## 8. Blog publikálási workflow (ha a frissítésből blog is készül)

1. Draft feltöltés: `http_api_request` POST `/blogs` (ha a blog szerződés a connectorban
   engedélyezett; különben jelezd, hogy nincs bekötve)
2. Értesítsd a jóváhagyót (7.7): ellenőrizze és publikálja
3. A jóváhagyó publikál (te nem)

## 9. Distill.io trigger (tervezett)

Distill.io figyeli a szolgáltatói oldalakat; változás → ez a folyamat indul az adott
`bank_id`-re, briefinggel kezdve. Még nincs teljesen bekötve.
