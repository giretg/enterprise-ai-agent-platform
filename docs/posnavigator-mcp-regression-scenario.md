# PosNavigator MCP újrafuttatható próba

## Előkészítés

1. Kapcsolódj OAuth-val a `https://ai.excellencepay.com/api/mcp/posnavigator` Streamable HTTP végponthoz. A kliens az MCP `initialize`, `tools/list`, `resources/list` és `resources/read` műveleteket használja. A hozzáférési tokent és az `authorizationUrl` értékeket ne írd a jegyzőkönyvbe.
2. Hívd a `platform.whoami` és `platform.agents.list` toolokat. Ellenőrizd, hogy `tenantSlug=posnavigator`; válassz egy látható, aktív agentet. A további hívásokhoz `platform.agent.get_definition({agentId})` adja a `definitionId`-t. A hívható eszközöket mindig `tools/list` alapján válaszd.
3. Minden futáshoz képezz egy egyedi `runId`-t. A jegyzőkönyvbe a dátumot, agent verziót, toolnevet, MCP `isError` értéket, üzleti `ok/status/code` mezőt és a visszavonás eredményét írd. Személyes adatot, teljes levéltörzset, titkot ne másolj bele.

## Olvasó felhasználói feladatok

| Kérés az agenthez | Hívás | Elvárt ellenőrzés |
| --- | --- | --- |
| „Ki vagy és miben segítesz?” | `platform.whoami`, `platform.agents.list`, `platform.agent.get_definition` | Tenant, agent és publikált definíció egyezik. |
| „Készíts helyi agent munkaterületet” | `platform.agent.checkout({agentId,harness:"codex"})` | `files`, `suggestedRoot`, `writeRecipe` érkezik; a próbához nem kell kiírni a fájlokat. |
| „Mutasd a még nem publikált beállítást” | `platform.agent.get_working_set({agentId})` | Admin esetén a munkakészlet olvasható. |
| „Milyen skillek érhetők el?” | `platform.skills.list`, `platform.skills.read({uri})`, `resources/list`, `resources/read({uri})` | Ugyanaz a skill URI mindkét olvasási úton működik. |
| „Milyen projektek, munkafájlok és emlékek vannak?” | `platform.projects.list({definitionId})`, `platform.work_file.list({definitionId})`, `platform.project_memory.read({definitionId,mine:true})` | A `__general__` projekt elérhető; eredmények a kiválasztott tenantból. |
| „Olvasd el a marketing tudástár egy részét” | `kb_list_index({definitionId})`, `kb_get_page({definitionId,artifactId,path:"index.md"})`, `kb_get_document({definitionId,documentId})`, szükség esetén `kb_get_document({definitionId,documentId,section})`, `kb_search({definitionId,query})` | A forrásazonosító az indexből jön; a hosszú fájl szakasza szöveget ad. |
| „Keress a Drive-ban, majd nyisd meg a találatot” | `google_drive_search({definitionId,pageSize:3})`, majd `google_drive_read_file({definitionId,fileId})` | Olvasás sikeres, vagy `isError:true` és `authorizationUrl`. A keresés sikere önmagában nem bizonyítja az olvasási jogosultságot. |
| „Keress a leveleim között” | `gmail_search({definitionId,query:"newer_than:7d",maxResults:3})`, találat esetén `gmail_get_message({definitionId,id})` | Sikeres keresés/olvasás, vagy kapcsolatot kérő `connector_grant_missing`. |
| „Nézd meg a bankokat és termékeket” | `http_api_get({definitionId,path:"/api/v1/banks"})`; az első bank `_id` értékével `http_api_get({definitionId,path:"/api/v1/products",query:{bankId}})` | `ok:true,status:200`. |
| „Kérdezd le a marketing adatokat” | `http_api_get` az agent definíciójában szereplő hero, content, metrics, presetfilters, blogs, filters, versus, Meta és Kanban GET pathokon | Minden választ külön `ok/status` alapján minősíts. Kanban 401 esetén az MCP `isError:true` legyen a javítás kiadása után. |
| „Olvasd végig a lapozott listát” | `http_api_get_all` csak olyan publikált GET endpointon, amelyen `pagination` van | `ok:true`, teljes lapozás; ha nincs ilyen endpoint, jegyezd fel a konfigurációs hiányt. |

## Írási és hibakezelési próba

1. **Visszavonható írás:** `platform.work_file.write({definitionId,path:"mcp-audit/<runId>.md",content:"Ideiglenes MCP próba"})`; olvasd vissza `platform.work_file.read`-del; töröld `platform.work_file.delete`-tel; ellenőrizd, hogy az ismételt olvasás `file_not_found`. `finally` lépésként mindig próbáld a törlést, akkor is, ha egy korábbi hívás hibázott.
2. **Bevitel- és jogosultságellenőrzés módosítás nélkül:** hiányos/hibás kötelező mezővel hívd a `platform.agent.create_draft`, `platform.projects.create`, `platform.project_memory.write`, `google_drive_create_folder`, `google_drive_upload_file`, `google_sheets_write_range`, `http_api_request`, `kb_ingest` toolokat. Nem létező agenttel `platform.agent.publish`, üres névvel `platform.skills.submit`, nem létező művelettel `platform.gateway_operation.get`. Mindegyiknél ellenőrizd a visszautasítást és hogy nem jelent meg új rekord vagy jóváhagyási kérés.
3. **Éles jóváhagyási folyamat külön futásban:** ha van teszt tenant és jóváhagyó, próbáld a fenti írásokat érvényes bemenettel. A visszakapott `operationId`/`approvalUrl` és a `platform.gateway_operation.get` állapotát rögzítsd. Külső írás jóváhagyása után olvasd vissza és állítsd vissza az eredeti állapotot. Törlő/lemondó művelet nélküli projekt, agent, skill, memória és tudástári ingest próbát éles tenantban ne hozz létre pusztán teszteléshez; ha mégis létrejött, a pontos azonosítót és megmaradt állapotot listázd a jegyzőkönyvben.

## Elvárt hibajelzés a javítás után

Ha egy engedélyezett HTTP API GET upstream 401/400 választ ad `{ok:false}` törzzsel, a `tools/call` eredmény `isError:true` legyen, őrizze meg a `status` és `body` adatot, és az auditban `enterprise.tool.error` szerepeljen. A `tools/list` és a publikált definíció képességlistája közül a kliens a ténylegesen meghirdetett toolokat tekintse hívhatónak.
