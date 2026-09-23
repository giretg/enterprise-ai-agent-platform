# POSNavigator MCP próbajelentés — 2026-09-23

## Környezet és módszer

- Végpont: `https://ai.excellencepay.com/api/mcp/posnavigator`; OAuth, `tools/list`, `resources/list` és `resources/read` valódi MCP hívásokkal.
- Bejelentkezett szerep: tenant admin. A publikált „POSnavigator marketing” agent 10. verzióját használtam. Azonosítókat és OAuth URL-eket nem rögzítek itt.
- A 34 meghirdetett tool mindegyikét hívtam. Az olvasó toolokat érvényes adatokkal, a vissza nem vonható írásokat csak érvénytelen bemenettel vagy nem létező azonosítóval próbáltam. Egy munkafájlt ténylegesen létrehoztam, visszaolvastam, töröltem és a törlést ellenőriztem.
- A próbák a felhasználó által használt éles kapcsolatokon futottak. Egy érvénytelen bemenetes hívás **nem bizonyítja** a sikeres írási vagy jóváhagyási folyamatot.

## Eredmények felhasználói feladatok szerint

| Feladat | Toolok | Eredmény |
| --- | --- | --- |
| „Kihez kapcsolódtam, milyen agentek vannak?” | `platform.whoami`, `platform.agents.list`, `platform.agent.get_definition` | Sikeres; egy publikált agent, 14 hozzárendelt kapcsolat. |
| „Szinkronizáld az agentet a gépemre” | `platform.agent.checkout` | Sikeres; két generált fájlt és írási receptet adott, helyi fájlt nem módosítottam. |
| „Mutasd a szerkesztési állapotot” | `platform.agent.get_working_set` | Sikeres. |
| „Milyen skillek vannak?” | `platform.skills.list`, `platform.skills.read`, `resources/list`, `resources/read` | Sikeres; a `skill-keszito` közvetlen MCP resource-ként és tartalék toolon át is olvasható. |
| „Milyen projektmunkák vannak?” | `platform.projects.list`, `platform.work_file.list`, `platform.project_memory.read` | Sikeres; csak a beépített `__general__` projekt, üres fájl- és memóriajegyzék. |
| „Írj és törölj egy próba munkafájlt” | `platform.work_file.write`, `.read`, `.delete` | Sikeres; törlés után `.read` → `file_not_found`. Éles adat nem maradt hátra. |
| „Keress és olvass a Drive-ban” | `google_drive_search`, `google_drive_read_file` | Keresés sikeres, három fájlmetaadattal; olvasás `google_drive_auth_failed` / 403 és újraengedélyezési URL. |
| „Keress a postaládában” | `gmail_search`, `gmail_get_message` | Mindkettő `connector_grant_missing`; a Gmail fiók nincs összekötve ehhez a felhasználóhoz. |
| „Olvasd a tudástárat” | `kb_list_index`, `kb_get_page`, `kb_get_document`, `kb_search` | Sikeres. Négy forrás; a hosszú fájl alapból címlistát, megadott `section` esetén szöveget ad. |
| „Kérdezd le a céges és Meta API-kat” | `http_api_get` | 10 kapcsolatnál 200-as üzleti válasz; Kanban 401, mert a kulcs érvénytelen vagy visszavont. A Products lista a dokumentált kötelező `bankId` nélkül 400, valós bankazonosítóval 200. |
| „Olvasd az összes lapot” | `http_api_get_all` | A Banks végponton `{ok:false}`: nincs lapozási szerződés. A 10 HTTP kapcsolat publikált endpointjai között egyetlen `pagination` beállítás sincs, így a tool ezekhez jelenleg nem használható. |
| „Nézd meg egy jóváhagyás állapotát” | `platform.gateway_operation.get` | Nem létező azonosítóra helyesen `operation_not_found`. |

## Írási toolok biztonságos próbái

| Toolok | Próba és megfigyelés |
| --- | --- |
| `platform.agent.create_draft`, `platform.agent.publish`, `platform.projects.create`, `platform.project_memory.write` | Üres kötelező mező vagy nem létező agent: `invalid_args` / `definition_not_found`, módosítás nélkül. |
| `platform.skills.submit` | Üres név: `outcome: rejected`, „Semmi nem került tárolásra.” |
| `google_drive_create_folder`, `google_drive_upload_file`, `google_sheets_write_range`, `http_api_request`, `kb_ingest` | Kötelező mező hiánya vagy érvénytelen módszer: `invalid_args`, nem jött létre jóváhagyási kérés vagy külső módosítás. |

## Hibák és javítási javaslatok

1. **API hiba sikerként jelölve az MCP-ben.** A Kanban `http_api_get` eredménye `{ok:false,status:401}`, de `isError` hiányzott, és a napló `enterprise.tool.ok` eseményt kapott. Egy agent ezt könnyen sikeres lekérdezésnek veheti. A PR-ben a közös HTTP tool visszatérési pont a `{ok:false}` választ MCP hibává és audit hibává teszi. A regressziós próba az eredeti állapoton piros, a javítással zöld.
2. **Kanban kulcs érvénytelen vagy visszavont.** A Kanban tábla nem olvasható. A kapcsolat titkát és API jogosultságát tenant adminnak kell megújítania; kódból nem állítható helyre.
3. **Drive keresés után az olvasás 403.** A felhasználó lát fájlneveket, de a tartalmat nem tudja lekérni. A Drive engedélyt újra kell adni vagy a kapcsolat scope-ját ellenőrizni.
4. **A `http_api_get_all` használhatósága nem látszott előre.** A PosNavigator definícióban nincs lapozási szerződés, mégis a tool általános leírása nagy listákhoz ezt ajánlotta. A PR pontosítja az MCP utasítást és a tool leírását: csak `pagination`-nel konfigurált végponton használható. A connector snapshotok lapozását külön, végpontonként érdemes beállítani, ha tényleg lapozott listákat adnak.
5. **A képességlista nem azonos a hívható MCP toolokkal.** A publikált definícióban `gmail_send` és `gmail_create_draft` engedélyezett, de a 34 MCP tool között nem szerepelnek; `kb_get_document` viszont hívható anélkül, hogy külön képességként szerepelne. A PR utasítja az agentet, hogy a `tools/list` legyen a hívható toolok forrása. Később a definícióban külön MCP-elérhetőségi jelzés segítene, ha erre tényleg szükség lesz.
6. **Gmail nincs összekötve.** Olvasás sem lehetséges, amíg a felhasználó nem fejezi be a visszakapott OAuth folyamatot. Ez konfigurációs hiány, nem reprodukált kódhiba.

## Visszavonás és nyitott állapot

- Létrehozott munkafájl: `mcp-audit/308cac23-a145-4016-89d8-c204c33b6091.md` — törölve, a törlés utáni olvasás `file_not_found`.
- Más éles API módosítás, jóváhagyásra váró művelet, új projekt, agent, skill vagy tudástári dokumentum **nem keletkezett**.
- A gateway a toolhívásokról append-only auditbejegyzéseket írhatott; ezek a teszt nyomai, nem vonhatók vissza. A 34 tool próbája és a külön `resources/*` hívások ilyen bejegyzéseket hagyhattak.
- A kódváltozás külön worktree-ben van; éles telepítés nem történt, ezért az MCP szintű javítást a PR beolvasása és kiadása után kell újramérni.

Az újrafuttatható lépések: [posnavigator-mcp-regression-scenario.md](posnavigator-mcp-regression-scenario.md).
