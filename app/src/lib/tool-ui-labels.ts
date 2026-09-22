/**
 * UI-megjelenítés toolokhoz: rövid magyar név + hover leírás.
 * A technikai tool-azonosító (pl. `kb_search`) a zárójelben marad;
 * a modellek/broker továbbra is a technikai nevet használják.
 */

export type ToolUiLabel = {
  /** Rövid, érthető magyar név a UI-on. */
  label: string
  /** Hover / tooltip leírás (1–2 mondat). */
  description: string
}

export const TOOL_UI_LABELS: Record<string, ToolUiLabel> = {
  // Tudásbázis
  kb_search: {
    label: 'Tudásbázis-keresés',
    description: 'Kulcsszavas keresés, ha a katalógus nem nevezi meg a forrást. Rövid részleteket ad vissza.',
  },
  kb_list_index: {
    label: 'Tudásbázis-katalógus',
    description: 'Először a forrásokat listázza (fájlnév, mire való, méret). Oldalakat csak pathPrefix vagy artifactId mellett.',
  },
  kb_get_page: {
    label: 'Oldal megnyitása',
    description: 'Egy wiki-oldal teljes tartalmát nyitja meg. A tartalomjegyzék path-ja: index.md.',
  },
  kb_get_document: {
    label: 'Fájl megnyitása',
    description: 'Egy sima tudásbázis-fájlt nyit meg. Nagy fájlnál vázlatot ad, sectionnel egy fejezetet.',
  },
  kb_ingest: {
    label: 'Tudásbázis feltöltés',
    description: 'Fájl betöltése a tudásbázisba sima szövegként vagy wiki (OKF) oldalakra bontva.',
  },

  'platform.projects.list': {
    label: 'Projektek',
    description: 'A tenant projektjei, plusz a beépített Általános (__general__).',
  },
  'platform.projects.create': {
    label: 'Projekt létrehozása',
    description: 'Névvel ellátott projekt a közös munkafájlokhoz és a projektmemóriához.',
  },
  'platform.work_file.list': {
    label: 'Munkafájlok',
    description: 'A projekt tervei, jegyzetei, piszkozatai. Agentek között közös.',
  },
  'platform.work_file.read': {
    label: 'Munkafájl olvasása',
    description: 'Egy munkafájl tartalma a projekt prefixén.',
  },
  'platform.work_file.write': {
    label: 'Munkafájl írása',
    description: 'Terv vagy jegyzet mentése jóváhagyás nélkül, kvótával.',
  },
  'platform.work_file.delete': {
    label: 'Munkafájl törlése',
    description: 'Munkafájl törlése a projekt prefixén.',
  },
  'platform.project_memory.read': {
    label: 'Projektmemória',
    description: 'Döntések, nyitott feladatok, beszélgetőpartnerrel címkézve.',
  },
  'platform.project_memory.write': {
    label: 'Projektmemória írása',
    description: 'Folytonossági emlék. Jóváhagyásos agentnél javaslat, közvetlen módban azonnali írás.',
  },

  // Fájlkezelés / repo
  repo_prepare: {
    label: 'Repo előkészítése',
    description: 'GitHub repo előkészítése a munkaterületen — kódkeresés/módosítás előtt hívd.',
  },
  repo_open_pull_request: {
    label: 'Pull request nyitása',
    description: 'A workspace-módosításokból branch-et, commitot és PR-t készít a GitHubon.',
  },
  file_read: {
    label: 'Fájl olvasása',
    description: 'Munkaterületi fájl beolvasása (opcionális sor-tartománnyal).',
  },
  file_write: {
    label: 'Fájl írása',
    description: 'Munkaterületi fájl létrehozása vagy felülírása.',
  },
  file_edit: {
    label: 'Fájl szerkesztése',
    description: 'Pontos szövegcsere egy munkaterületi fájlban.',
  },
  file_list: {
    label: 'Fájlok listázása',
    description: 'Munkaterületi fájlok és mappák listázása.',
  },
  file_glob: {
    label: 'Fájlkeresés (mintával)',
    description: 'Fájlok keresése glob mintával (pl. **/*.csv).',
  },
  file_search: {
    label: 'Tartalomkeresés',
    description: 'Szövegkeresés regex mintával a munkaterületen.',
  },
  file_delete: {
    label: 'Fájl törlése',
    description: 'Munkaterületi fájl törlése.',
  },

  // Excel
  xlsx_read_sheet: {
    label: 'Munkalap olvasása',
    description: 'Egy Excel (XLSX) munkalap tartalmának beolvasása.',
  },
  xlsx_write_cells: {
    label: 'Cellák írása',
    description: 'Cellák írása és formázása egy Excel munkalapon.',
  },
  xlsx_append_rows: {
    label: 'Sorok hozzáfűzése',
    description: 'Új adatsorok hozzáfűzése egy Excel munkalaphoz.',
  },
  xlsx_create: {
    label: 'Excel létrehozása',
    description: 'Új Excel munkafüzet létrehozása egy vagy több munkalappal.',
  },
  xlsx_format_range: {
    label: 'Tartomány formázása',
    description: 'Cellatartomány formázása (betű, szín, igazítás) egyben.',
  },
  xlsx_layout: {
    label: 'Elrendezés',
    description: 'Munkalap-elrendezés: egyesítés, oszlopszélesség, rögzítés, szűrő.',
  },

  // PowerPoint
  pptx_create: {
    label: 'Prezentáció létrehozása',
    description: 'PowerPoint (.pptx) prezentáció létrehozása diákból.',
  },

  // Dokumentumok
  docx_read: {
    label: 'Word olvasása',
    description: 'Word (.docx) dokumentum szövegének beolvasása.',
  },
  docx_create: {
    label: 'Word létrehozása',
    description: 'Word (.docx) dokumentum létrehozása tartalomblokkokból.',
  },
  pdf_read: {
    label: 'PDF olvasása',
    description: 'PDF szövegének beolvasása (opcionális oldaltartománnyal).',
  },
  pdf_create: {
    label: 'PDF létrehozása',
    description: 'Táblázatos PDF dokumentum létrehozása.',
  },
  create_html: {
    label: 'HTML létrehozása',
    description: 'Önálló HTML fájl létrehozása a munkaterületen (letölthető weboldal).',
  },
  document_read: {
    label: 'Csatolmány olvasása',
    description: 'Feltöltött dokumentum célzott olvasása (oldal / keresés) documentId alapján.',
  },
  tulajdoni_lap_parse: {
    label: 'Tulajdoni lap feldolgozása',
    description:
      'Magyar e-hiteles tulajdoni lap (földhivatali PDF) strukturált kinyerése: hatályos ' +
      'tulajdonosok és hányadok, terhek, széljegyek — Document UUID vagy workspace path alapján.',
  },
  tulajdoni_lap_egyeztetes: {
    label: 'Tulajdoni lap egyeztetése',
    description:
      'Egy lépésben összeveti a tulajdoni lapot a nyilvántartás soraival, és kész Excel ' +
      'egyeztető táblát ír a munkaterületre (Rendben / Módosítás / Törlés / Új rekord).',
  },
  reconcile_records: {
    label: 'Rekordok egyeztetése',
    description:
      'Két JSON-lista determinisztikus párosítása kulcsmezőkkel; az egyesített lista fájlba kerül, ' +
      'a válasz csak összegzést és a bizonytalan párokat adja.',
  },

  // Mini-app
  'sandbox_app.create': {
    label: 'Mini-app létrehozása',
    description: 'Új, böngészőben megnyitható mini-app (HTML) draft létrehozása.',
  },
  'sandbox_app.update_artifact': {
    label: 'Tartalom frissítése',
    description: 'Mini-app HTML tartalmának feltöltése vagy cseréje (új verzió).',
  },
  'sandbox_app.preview': {
    label: 'Előnézet',
    description: 'Rövid életű, izolált előnézeti URL a mini-apphoz.',
  },
  'sandbox_app.export': {
    label: 'Exportálás',
    description: 'Mini-app verzió exportja letölthető .html fájlként.',
  },
  'sandbox_app.list': {
    label: 'Mini-appok listázása',
    description: 'Az agent saját mini-appjainak listázása név, státusz és verzió szerint.',
  },
  'sandbox_app.get': {
    label: 'Mini-app megnyitása',
    description: 'Egy meglévő mini-app HTML forrásának lekérése megtekintéshez vagy szerkesztéshez.',
  },

  // Sandbox verziókezelés
  'sandbox.commit': {
    label: 'Commit',
    description: 'Sandbox változások commitolása új verzióként.',
  },
  'sandbox.request_promotion': {
    label: 'Promóció kérése',
    description: 'Sandbox verzió productionbe emelésének kérelmezése.',
  },
  'sandbox.snapshot': {
    label: 'Pillanatkép',
    description: 'Pillanatkép készítése a sandbox aktuális állapotáról.',
  },

  // Email (Gmail)
  gmail_search: {
    label: 'Levélkeresés',
    description: 'Gmail keresés Gmail keresőszintaxissal (pl. is:unread newer_than:1d).',
  },
  gmail_get_message: {
    label: 'Levél megnyitása',
    description: 'Egy Gmail levél teljes tartalmának lekérése azonosító alapján.',
  },
  mailbox_count: {
    label: 'Postafiók-számláló',
    description: 'Postafiók üzenetszámának lekérdezése (monitor / összesítő).',
  },
  gmail_create_draft: {
    label: 'Piszkozat készítése',
    description: 'Gmail piszkozat létrehozása címzettel, tárggyal és törzzsel.',
  },
  gmail_send: {
    label: 'Levél küldése',
    description: 'Gmail küldés — jóváhagyott ticket mellett (piszkozatból vagy közvetlenül).',
  },

  // Google Drive
  google_drive_search: {
    label: 'Drive-keresés',
    description: 'Google Drive fájlok keresése és listázása a kapcsolt fiók jogaival.',
  },
  google_drive_get_file: {
    label: 'Drive-fájl adatai',
    description: 'Egy Google Drive fájl metaadatának lekérése azonosító alapján.',
  },
  google_drive_read_file: {
    label: 'Drive-fájl olvasása',
    description: 'Google Drive fájl tartalmának olvasása (Docs/Sheets export vagy letöltés).',
  },
  google_drive_list_drives: {
    label: 'Meghajtók listázása',
    description: 'Megosztott Google Drive meghajtók listázása.',
  },
  google_drive_create_folder: {
    label: 'Drive-mappa',
    description: 'Új mappa létrehozása a Google Drive-on.',
  },
  google_drive_upload_file: {
    label: 'Drive-feltöltés',
    description: 'Fájl feltöltése Google Drive-ra.',
  },
  google_drive_update_file: {
    label: 'Drive-fájl frissítése',
    description: 'Meglévő Google Drive fájl tartalmának frissítése.',
  },
  google_drive_rename_file: {
    label: 'Drive-átnevezés',
    description: 'Google Drive fájl átnevezése.',
  },
  google_drive_move_file: {
    label: 'Drive-áthelyezés',
    description: 'Google Drive fájl mozgatása másik mappába.',
  },
  google_drive_copy_file: {
    label: 'Drive-másolás',
    description: 'Google Drive fájl másolása.',
  },
  google_drive_trash_file: {
    label: 'Drive-kuka',
    description: 'Google Drive fájl kukába helyezése (visszaállítható).',
  },
  google_drive_restore_file: {
    label: 'Drive-visszaállítás',
    description: 'Google Drive fájl visszaállítása a kukából.',
  },
  google_drive_share_file: {
    label: 'Drive-megosztás',
    description: 'Google Drive fájl megosztása — mindig jóváhagyás-köteles.',
  },
  google_docs_apply_edits: {
    label: 'Docs szerkesztése',
    description: 'Google Docs tartalmának módosítása.',
  },
  google_sheets_write_range: {
    label: 'Sheets írása',
    description: 'Google Sheets cellatartomány írása.',
  },
  google_slides_apply_edits: {
    label: 'Slides szerkesztése',
    description: 'Google Slides tartalmának módosítása.',
  },

  // Agent együttműködés
  agent_catalog: {
    label: 'Agent-katalógus',
    description: 'Szervezeti agentek keresése név vagy azonosító alapján.',
  },
  agent_resolve: {
    label: 'Agent feloldása',
    description: 'Agent feloldása név/nicknév szerint UUID-re.',
  },
  user_directory: {
    label: 'Munkatársak keresése',
    description: 'Humán munkatársak célzott keresése név, szerep vagy leírás alapján (e-mail nélkül).',
  },
  agent_ask: {
    label: 'Kérdés agentnek',
    description: 'Kérdés küldése egy másik agentnek; csak completed válasz idézhető.',
  },
  ticket_create: {
    label: 'Ticket létrehozása',
    description: 'Új Kanban ticket létrehozása humán vagy agent felelősnek.',
  },
  board_write: {
    label: 'Táblaírás',
    description: 'Ticket eredményének / állapotának visszaírása a Kanban táblára.',
  },

  // Belső / meta eszközök (chat aktivitás)
  tool_result_read: {
    label: 'Eszköz-eredmény olvasása',
    description: 'Korábbi eszközhívás archivált eredményének beolvasása.',
  },
  tool_result_extract: {
    label: 'Eszköz-eredmény kivonatolása',
    description: 'Archívum vagy workspace JSON mezőkivonata fájlba, a teljes tartalom nélkül.',
  },
  load_skill: {
    label: 'Képesség betöltése',
    description: 'Hozzárendelt képesség promptjának betöltése a beszélgetésbe.',
  },

  // HTTP API
  http_api_get: {
    label: 'API olvasás (GET)',
    description: 'Olvasó (GET) hívás a hozzárendelt külső REST API-n.',
  },
  http_api_get_all: {
    label: 'API lista lapozva',
    description: 'Lapozott GET lista egy hívásban — oldalak összevonása szerveroldalon.',
  },
  http_api_request: {
    label: 'API írás',
    description: 'Író (POST/PUT/PATCH/DELETE) hívás a hozzárendelt külső REST API-n.',
  },
  sandbox_exec: {
    label: 'Kód futtatása',
    description: 'Izolált, hívásonként új sandbox futtatása kontrollált workspace inputtal és outputtal.',
  },

  // Webes kutatás
  web_search: {
    label: 'Webes keresés',
    description: 'Kontrollált webes keresés publikus, aktuális információhoz.',
  },
  web_research_request: {
    label: 'Webes kutatás',
    description: 'Strukturált web-kutatás kérése a Web-Egress workertől (tények + források).',
  },

  // Futás-elemzés / hibakeresés
  run_index: {
    label: 'Futás-lista',
    description: 'Futás-fejlécek lekérése szkóp alapján — a futás-elemzés első lépése.',
  },
  run_trace: {
    label: 'Futás-idővonal',
    description: 'Egy futás idővonala vagy folyamat-nézete — a futás-elemzés lefúrása.',
  },
  run_stats: {
    label: 'Futás-statisztika',
    description: 'Összesített mutatók a kiválasztott futásokról.',
  },
  get_debug_trace: {
    label: 'Hibakereső nyomvonal',
    description: 'Agent-forduló álnevesített debug-nyomvonala hibakereséshez.',
  },

  // Projektmemória
  memory_propose: {
    label: 'Memória-javaslat',
    description: 'Projektmemória-javaslat (jóváhagyás-köteles, nem azonnali írás).',
  },

  // Zárt szerep — provisioning
  'provisioning.catalog.read': {
    label: 'Katalógus olvasása',
    description: 'Provisioning connector-katalógus olvasása (zárt szerep).',
  },
  'provisioning.draft.create': {
    label: 'Draft létrehozása',
    description: 'Új connector-draft létrehozása a provisioning folyamatban.',
  },
  'provisioning.draft.validate': {
    label: 'Draft validálása',
    description: 'Connector-draft érvényességének ellenőrzése.',
  },
  'provisioning.discover.search': {
    label: 'Felfedezés – keresés',
    description: 'API/dokumentáció keresése webes felfedezés során.',
  },
  'provisioning.discover.fetch': {
    label: 'Felfedezés – letöltés',
    description: 'Felfedezett dokumentum / forrás letöltése.',
  },
  'provisioning.discover.draft': {
    label: 'Felfedezés – draft',
    description: 'Felfedezés eredményéből connector-draft összeállítása.',
  },

  // Zárt szerep — web-egress
  web_fetch: {
    label: 'Webes letöltés',
    description: 'Kontrollált tartalom-letöltés URL-ről (deny-by-default, allowlist).',
  },
  'web.research.serve': {
    label: 'Kutatás kiszolgálása',
    description: 'Web-kutatási eredmény kiszolgálása a Web-Egress szerep számára.',
  },
}

export function getToolUiLabel(toolName: string): ToolUiLabel {
  return (
    TOOL_UI_LABELS[toolName] ?? {
      label: toolName,
      description: '',
    }
  )
}

/** UI címke: „Magyar név (technical_id)”, ismeretlen toolnál csak az id. */
export function formatToolUiName(toolName: string): string {
  const meta = getToolUiLabel(toolName)
  if (meta.label === toolName) return toolName
  return `${meta.label} (${toolName})`
}
