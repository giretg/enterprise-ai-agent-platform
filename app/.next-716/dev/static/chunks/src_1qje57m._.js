(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/app/actions/data:a854a7 [app-client] (ecmascript) <text/javascript>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "approveGatewayOperationAction",
    ()=>$$RSC_SERVER_ACTION_1
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/build/webpack/loaders/next-flight-loader/action-client-wrapper.js [app-client] (ecmascript)");
/* __next_internal_action_entry_do_not_use__ [{"401f240231df0d40a3c1867253e0a23454028c7155":{"name":"approveGatewayOperationAction"}},"src/app/actions/gateway-operation.ts",""] */ "use turbopack no side effects";
;
const $$RSC_SERVER_ACTION_1 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createServerReference"])("401f240231df0d40a3c1867253e0a23454028c7155", __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["callServer"], void 0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["findSourceMapURL"], "approveGatewayOperationAction");
;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/actions/data:ca19dd [app-client] (ecmascript) <text/javascript>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "rejectGatewayOperationAction",
    ()=>$$RSC_SERVER_ACTION_2
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/build/webpack/loaders/next-flight-loader/action-client-wrapper.js [app-client] (ecmascript)");
/* __next_internal_action_entry_do_not_use__ [{"4017c9061292d86b2fb7310a64ad27ee132493e413":{"name":"rejectGatewayOperationAction"}},"src/app/actions/gateway-operation.ts",""] */ "use turbopack no side effects";
;
const $$RSC_SERVER_ACTION_2 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createServerReference"])("4017c9061292d86b2fb7310a64ad27ee132493e413", __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["callServer"], void 0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["findSourceMapURL"], "rejectGatewayOperationAction");
;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/domain/gateway-operation/pending-args-summary.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "formatScalarQuery",
    ()=>formatScalarQuery,
    "pendingArgsSummary",
    ()=>pendingArgsSummary
]);
/**
 * Human-readable summary of a pending GatewayOperation's args for HITL approval.
 * Must surface every field execute will use — otherwise the approver can rubber-stamp
 * a decoy (benign title/body) while replaceIds, query params, or Gmail recipients run.
 */ const CONTENT_PREVIEW = 800;
function str(value) {
    return typeof value === 'string' ? value : '';
}
function clip(text) {
    if (text.length <= CONTENT_PREVIEW) return text;
    return `${text.slice(0, CONTENT_PREVIEW)}\n…(${text.length} chars)`;
}
function formatScalarQuery(query) {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return '';
    return Object.entries(query).filter(([, value])=>value !== undefined && value !== null && value !== '').sort(([a], [b])=>a.localeCompare(b)).map(([key, value])=>`${key}=${String(value)}`).join('&');
}
function gmailComposeLines(args) {
    const lines = [];
    if (str(args.draftId)) {
        lines.push(`draftId: ${str(args.draftId)}`);
        return lines;
    }
    if (str(args.replyToMessageId)) {
        lines.push(`replyTo: ${str(args.replyToMessageId)}${args.replyAll === true ? ' (replyAll)' : ''}`);
    } else {
        lines.push('new message');
    }
    if (str(args.to)) lines.push(`to: ${str(args.to)}`);
    if (str(args.cc)) lines.push(`cc: ${str(args.cc)}`);
    if (str(args.bcc)) lines.push(`bcc: ${str(args.bcc)}`);
    if (str(args.subject)) lines.push(`subject: ${str(args.subject)}`);
    if (str(args.body)) lines.push(clip(str(args.body)));
    return lines;
}
function gmailItemLines(args) {
    const lines = [];
    if (str(args.threadId)) lines.push(`threadId: ${str(args.threadId)}`);
    if (str(args.messageId)) lines.push(`messageId: ${str(args.messageId)}`);
    return lines;
}
function pendingArgsSummary(toolName, args, labels) {
    if (toolName === 'http_api_request') {
        const query = formatScalarQuery(args.query);
        const lines = [
            `${str(args.method)} ${str(args.path)}${query ? `?${query}` : ''}`
        ];
        if (str(args.body)) lines.push(clip(str(args.body)));
        return lines.join('\n');
    }
    if (toolName === 'gmail_send' || toolName === 'gmail_create_draft') {
        return gmailComposeLines(args).join('\n');
    }
    if (toolName === 'gmail_modify_labels') {
        const lines = gmailItemLines(args);
        if (str(args.addLabelIds)) lines.push(`add: ${str(args.addLabelIds)}`);
        if (str(args.removeLabelIds)) lines.push(`remove: ${str(args.removeLabelIds)}`);
        return lines.join('\n');
    }
    if (toolName === 'gmail_trash') {
        return [
            ...gmailItemLines(args),
            '→ trash'
        ].join('\n');
    }
    if (toolName === 'platform.project_memory.write') {
        const kind = str(args.kind) || labels.memoryKind;
        const project = str(args.projectKey) || '__general__';
        const lines = [
            `${kind}: ${str(args.title)} (${project})`
        ];
        if (str(args.body)) lines.push(clip(str(args.body)));
        if (str(args.replaceId)) lines.push(`replaceId: ${str(args.replaceId)}`);
        if (str(args.mergeIds)) lines.push(`mergeIds: ${str(args.mergeIds)}`);
        if (str(args.artifactPath)) lines.push(`artifact: ${str(args.artifactPath)}`);
        return lines.join('\n');
    }
    if (toolName === 'google_sheets_write_range' || typeof args.range === 'string') {
        const lines = [
            `${str(args.fileId) || '—'} · ${str(args.range)}`
        ];
        if (str(args.values)) lines.push(clip(str(args.values)));
        if (str(args.mode)) lines.push(`mode: ${str(args.mode)}`);
        return lines.join('\n');
    }
    if (toolName === 'google_drive_upload_file') {
        const parent = str(args.parentFolderId) ? labels.parentFolder(str(args.parentFolderId)) : labels.parentRoot;
        const lines = [
            `${str(args.name) || '—'} (${parent})`
        ];
        if (str(args.textContent)) lines.push(clip(str(args.textContent)));
        if (str(args.contentBase64)) lines.push(`[base64 tartalom, ${str(args.contentBase64).length} karakter]`);
        return lines.join('\n');
    }
    if (toolName === 'google_drive_create_folder' || typeof args.name === 'string') {
        const parent = str(args.parentFolderId) ? labels.parentFolder(str(args.parentFolderId)) : labels.parentRoot;
        return `${str(args.name) || '—'} (${parent})`;
    }
    // Last resort: never invent Drive-root chrome for unknown tools.
    if (str(args.path)) return str(args.path);
    if (str(args.title)) {
        const kind = str(args.kind) || labels.memoryKind;
        return `${kind}: ${str(args.title)}`;
    }
    return Object.entries(args).filter(([key])=>key !== 'definitionId' && key !== 'idempotencyKey' && key !== 'withUserId').slice(0, 8).map(([key, value])=>`${key}: ${typeof value === 'string' ? clip(value) : JSON.stringify(value)}`).join('\n');
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/i18n/translate.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/** Loose translator for dynamic keys (error codes, nav keys). */ __turbopack_context__.s([
    "asTranslate",
    ()=>asTranslate
]);
function asTranslate(t) {
    return t;
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/tool-ui-labels.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * UI-megjelenítés toolokhoz: rövid magyar név + hover leírás.
 * A technikai tool-azonosító (pl. `kb_search`) a zárójelben marad;
 * a modellek/broker továbbra is a technikai nevet használják.
 */ __turbopack_context__.s([
    "TOOL_UI_LABELS",
    ()=>TOOL_UI_LABELS,
    "formatToolUiName",
    ()=>formatToolUiName,
    "getToolUiLabel",
    ()=>getToolUiLabel
]);
const TOOL_UI_LABELS = {
    // Tudásbázis
    kb_search: {
        label: 'Tudásbázis-keresés',
        description: 'Kulcsszavas keresés, ha a katalógus nem nevezi meg a forrást. Rövid részleteket ad vissza.'
    },
    kb_list_index: {
        label: 'Tudásbázis-katalógus',
        description: 'Először a forrásokat listázza (fájlnév, mire való, méret). Oldalakat csak pathPrefix vagy artifactId mellett.'
    },
    kb_get_page: {
        label: 'Oldal megnyitása',
        description: 'Egy wiki-oldal teljes tartalmát nyitja meg. A tartalomjegyzék path-ja: index.md.'
    },
    kb_get_document: {
        label: 'Fájl megnyitása',
        description: 'Egy sima tudásbázis-fájlt nyit meg. Nagy fájlnál vázlatot ad, sectionnel egy fejezetet.'
    },
    kb_ingest: {
        label: 'Tudásbázis feltöltés',
        description: 'Fájl betöltése a tudásbázisba sima szövegként vagy wiki (OKF) oldalakra bontva.'
    },
    'platform.projects.list': {
        label: 'Projektek',
        description: 'A tenant projektjei, plusz a beépített Általános (__general__).'
    },
    'platform.projects.create': {
        label: 'Projekt létrehozása',
        description: 'Névvel ellátott projekt a közös munkafájlokhoz és a projektmemóriához.'
    },
    'platform.work_file.list': {
        label: 'Munkafájlok',
        description: 'A projekt tervei, jegyzetei, piszkozatai. Agentek között közös.'
    },
    'platform.work_file.read': {
        label: 'Munkafájl olvasása',
        description: 'Egy munkafájl tartalma a projekt prefixén.'
    },
    'platform.work_file.write': {
        label: 'Munkafájl írása',
        description: 'Terv vagy jegyzet mentése jóváhagyás nélkül, kvótával.'
    },
    'platform.work_file.append': {
        label: 'Munkafájl bővítése',
        description: 'Szöveg hozzáfűzése munkafájl végéhez jóváhagyás nélkül, kvótával.'
    },
    'platform.work_file.delete': {
        label: 'Munkafájl törlése',
        description: 'Munkafájl törlése a projekt prefixén.'
    },
    'platform.project_memory.read': {
        label: 'Projektmemória',
        description: 'Döntések, nyitott feladatok, beszélgetőpartnerrel címkézve.'
    },
    'platform.project_memory.write': {
        label: 'Projektmemória írása',
        description: 'Folytonossági emlék. Jóváhagyásos agentnél javaslat, közvetlen módban azonnali írás.'
    },
    // Fájlkezelés / repo
    repo_prepare: {
        label: 'Repo előkészítése',
        description: 'GitHub repo előkészítése a munkaterületen — kódkeresés/módosítás előtt hívd.'
    },
    repo_open_pull_request: {
        label: 'Pull request nyitása',
        description: 'A workspace-módosításokból branch-et, commitot és PR-t készít a GitHubon.'
    },
    file_read: {
        label: 'Fájl olvasása',
        description: 'Munkaterületi fájl beolvasása (opcionális sor-tartománnyal).'
    },
    file_write: {
        label: 'Fájl írása',
        description: 'Munkaterületi fájl létrehozása vagy felülírása.'
    },
    file_edit: {
        label: 'Fájl szerkesztése',
        description: 'Pontos szövegcsere egy munkaterületi fájlban.'
    },
    file_list: {
        label: 'Fájlok listázása',
        description: 'Munkaterületi fájlok és mappák listázása.'
    },
    file_glob: {
        label: 'Fájlkeresés (mintával)',
        description: 'Fájlok keresése glob mintával (pl. **/*.csv).'
    },
    file_search: {
        label: 'Tartalomkeresés',
        description: 'Szövegkeresés regex mintával a munkaterületen.'
    },
    file_delete: {
        label: 'Fájl törlése',
        description: 'Munkaterületi fájl törlése.'
    },
    // Excel
    xlsx_read_sheet: {
        label: 'Munkalap olvasása',
        description: 'Egy Excel (XLSX) munkalap tartalmának beolvasása.'
    },
    xlsx_write_cells: {
        label: 'Cellák írása',
        description: 'Cellák írása és formázása egy Excel munkalapon.'
    },
    xlsx_append_rows: {
        label: 'Sorok hozzáfűzése',
        description: 'Új adatsorok hozzáfűzése egy Excel munkalaphoz.'
    },
    xlsx_create: {
        label: 'Excel létrehozása',
        description: 'Új Excel munkafüzet létrehozása egy vagy több munkalappal.'
    },
    xlsx_format_range: {
        label: 'Tartomány formázása',
        description: 'Cellatartomány formázása (betű, szín, igazítás) egyben.'
    },
    xlsx_layout: {
        label: 'Elrendezés',
        description: 'Munkalap-elrendezés: egyesítés, oszlopszélesség, rögzítés, szűrő.'
    },
    // PowerPoint
    pptx_create: {
        label: 'Prezentáció létrehozása',
        description: 'PowerPoint (.pptx) prezentáció létrehozása diákból.'
    },
    // Dokumentumok
    docx_read: {
        label: 'Word olvasása',
        description: 'Word (.docx) dokumentum szövegének beolvasása.'
    },
    docx_create: {
        label: 'Word létrehozása',
        description: 'Word (.docx) dokumentum létrehozása tartalomblokkokból.'
    },
    pdf_read: {
        label: 'PDF olvasása',
        description: 'PDF szövegének beolvasása (opcionális oldaltartománnyal).'
    },
    pdf_create: {
        label: 'PDF létrehozása',
        description: 'Táblázatos PDF dokumentum létrehozása.'
    },
    create_html: {
        label: 'HTML létrehozása',
        description: 'Önálló HTML fájl létrehozása a munkaterületen (letölthető weboldal).'
    },
    document_read: {
        label: 'Csatolmány olvasása',
        description: 'Feltöltött dokumentum célzott olvasása (oldal / keresés) documentId alapján.'
    },
    tulajdoni_lap_parse: {
        label: 'Tulajdoni lap feldolgozása',
        description: 'Magyar e-hiteles tulajdoni lap (földhivatali PDF) strukturált kinyerése: hatályos ' + 'tulajdonosok és hányadok, terhek, széljegyek — Document UUID vagy workspace path alapján.'
    },
    tulajdoni_lap_egyeztetes: {
        label: 'Tulajdoni lap egyeztetése',
        description: 'Egy lépésben összeveti a tulajdoni lapot a nyilvántartás soraival, és kész Excel ' + 'egyeztető táblát ír a munkaterületre (Rendben / Módosítás / Törlés / Új rekord).'
    },
    reconcile_records: {
        label: 'Rekordok egyeztetése',
        description: 'Két JSON-lista determinisztikus párosítása kulcsmezőkkel; az egyesített lista fájlba kerül, ' + 'a válasz csak összegzést és a bizonytalan párokat adja.'
    },
    // Mini-app
    'sandbox_app.create': {
        label: 'Mini-app létrehozása',
        description: 'Új, böngészőben megnyitható mini-app (HTML) draft létrehozása.'
    },
    'sandbox_app.update_artifact': {
        label: 'Tartalom frissítése',
        description: 'Mini-app HTML tartalmának feltöltése vagy cseréje (új verzió).'
    },
    'sandbox_app.preview': {
        label: 'Előnézet',
        description: 'Rövid életű, izolált előnézeti URL a mini-apphoz.'
    },
    'sandbox_app.export': {
        label: 'Exportálás',
        description: 'Mini-app verzió exportja letölthető .html fájlként.'
    },
    'sandbox_app.list': {
        label: 'Mini-appok listázása',
        description: 'Az agent saját mini-appjainak listázása név, státusz és verzió szerint.'
    },
    'sandbox_app.get': {
        label: 'Mini-app megnyitása',
        description: 'Egy meglévő mini-app HTML forrásának lekérése megtekintéshez vagy szerkesztéshez.'
    },
    // Sandbox verziókezelés
    'sandbox.commit': {
        label: 'Commit',
        description: 'Sandbox változások commitolása új verzióként.'
    },
    'sandbox.request_promotion': {
        label: 'Promóció kérése',
        description: 'Sandbox verzió productionbe emelésének kérelmezése.'
    },
    'sandbox.snapshot': {
        label: 'Pillanatkép',
        description: 'Pillanatkép készítése a sandbox aktuális állapotáról.'
    },
    // Email (Gmail)
    gmail_search: {
        label: 'Levélkeresés',
        description: 'Gmail keresés Gmail keresőszintaxissal (pl. is:unread newer_than:1d).'
    },
    gmail_get_message: {
        label: 'Levél megnyitása',
        description: 'Egy Gmail levél teljes tartalmának lekérése azonosító alapján.'
    },
    mailbox_count: {
        label: 'Postafiók-számláló',
        description: 'Postafiók üzenetszámának lekérdezése (monitor / összesítő).'
    },
    gmail_get_thread: {
        label: 'Levélváltás megnyitása',
        description: 'Egy Gmail levélváltás (szál) összes levelének lekérése.'
    },
    gmail_list_labels: {
        label: 'Címkék listázása',
        description: 'A postafiók címkéinek (mappáinak) listája.'
    },
    gmail_list_drafts: {
        label: 'Piszkozatok listázása',
        description: 'A postafiók mentett piszkozatainak listája.'
    },
    gmail_create_draft: {
        label: 'Piszkozat készítése',
        description: 'Gmail piszkozat (új levél vagy válasz) — jóváhagyás után jön létre, nem küldi el.'
    },
    gmail_send: {
        label: 'Levél küldése',
        description: 'Új levél, válasz egy levélre (ugyanabban a levélváltásban) vagy piszkozat elküldése — emberi jóváhagyás után.'
    },
    gmail_modify_labels: {
        label: 'Címkézés / archiválás',
        description: 'Olvasottnak jelölés, archiválás, csillagozás, címke hozzáadása vagy levétele — jóváhagyás után.'
    },
    gmail_trash: {
        label: 'Kukába helyezés',
        description: 'Levél vagy levélváltás kukába helyezése (30 napig visszaállítható) — jóváhagyás után.'
    },
    // Google Drive
    google_drive_search: {
        label: 'Drive-keresés',
        description: 'Google Drive fájlok keresése és listázása a kapcsolt fiók jogaival.'
    },
    google_drive_get_file: {
        label: 'Drive-fájl adatai',
        description: 'Egy Google Drive fájl metaadatának lekérése azonosító alapján.'
    },
    google_drive_read_file: {
        label: 'Drive-fájl olvasása',
        description: 'Google Drive fájl tartalmának olvasása (Docs/Sheets export vagy letöltés).'
    },
    google_drive_list_drives: {
        label: 'Meghajtók listázása',
        description: 'Megosztott Google Drive meghajtók listázása.'
    },
    google_drive_create_folder: {
        label: 'Drive-mappa',
        description: 'Új mappa létrehozása a Google Drive-on.'
    },
    google_drive_upload_file: {
        label: 'Drive-feltöltés',
        description: 'Fájl feltöltése Google Drive-ra.'
    },
    google_drive_update_file: {
        label: 'Drive-fájl frissítése',
        description: 'Meglévő Google Drive fájl tartalmának frissítése.'
    },
    google_drive_rename_file: {
        label: 'Drive-átnevezés',
        description: 'Google Drive fájl átnevezése.'
    },
    google_drive_move_file: {
        label: 'Drive-áthelyezés',
        description: 'Google Drive fájl mozgatása másik mappába.'
    },
    google_drive_copy_file: {
        label: 'Drive-másolás',
        description: 'Google Drive fájl másolása.'
    },
    google_drive_trash_file: {
        label: 'Drive-kuka',
        description: 'Google Drive fájl kukába helyezése (visszaállítható).'
    },
    google_drive_restore_file: {
        label: 'Drive-visszaállítás',
        description: 'Google Drive fájl visszaállítása a kukából.'
    },
    google_drive_share_file: {
        label: 'Drive-megosztás',
        description: 'Google Drive fájl megosztása — mindig jóváhagyás-köteles.'
    },
    google_docs_apply_edits: {
        label: 'Docs szerkesztése',
        description: 'Google Docs tartalmának módosítása.'
    },
    google_sheets_write_range: {
        label: 'Sheets írása',
        description: 'Google Sheets cellatartomány írása.'
    },
    google_slides_apply_edits: {
        label: 'Slides szerkesztése',
        description: 'Google Slides tartalmának módosítása.'
    },
    // Agent együttműködés
    agent_catalog: {
        label: 'Agent-katalógus',
        description: 'Szervezeti agentek keresése név vagy azonosító alapján.'
    },
    agent_resolve: {
        label: 'Agent feloldása',
        description: 'Agent feloldása név/nicknév szerint UUID-re.'
    },
    user_directory: {
        label: 'Munkatársak keresése',
        description: 'Humán munkatársak célzott keresése név, szerep vagy leírás alapján (e-mail nélkül).'
    },
    agent_ask: {
        label: 'Kérdés agentnek',
        description: 'Kérdés küldése egy másik agentnek; csak completed válasz idézhető.'
    },
    ticket_create: {
        label: 'Ticket létrehozása',
        description: 'Új Kanban ticket létrehozása humán vagy agent felelősnek.'
    },
    board_write: {
        label: 'Táblaírás',
        description: 'Ticket eredményének / állapotának visszaírása a Kanban táblára.'
    },
    // Belső / meta eszközök (chat aktivitás)
    tool_result_read: {
        label: 'Eszköz-eredmény olvasása',
        description: 'Korábbi eszközhívás archivált eredményének beolvasása.'
    },
    tool_result_extract: {
        label: 'Eszköz-eredmény kivonatolása',
        description: 'Archívum vagy workspace JSON mezőkivonata fájlba, a teljes tartalom nélkül.'
    },
    load_skill: {
        label: 'Képesség betöltése',
        description: 'Hozzárendelt képesség promptjának betöltése a beszélgetésbe.'
    },
    // HTTP API
    http_api_get: {
        label: 'API olvasás (GET)',
        description: 'Olvasó (GET) hívás a hozzárendelt külső REST API-n.'
    },
    http_api_get_all: {
        label: 'API lista lapozva',
        description: 'Lapozott GET lista egy hívásban — oldalak összevonása szerveroldalon.'
    },
    http_api_request: {
        label: 'API írás',
        description: 'Író (POST/PUT/PATCH/DELETE) hívás a hozzárendelt külső REST API-n.'
    },
    sandbox_exec: {
        label: 'Kód futtatása',
        description: 'Izolált, hívásonként új sandbox futtatása kontrollált workspace inputtal és outputtal.'
    },
    // Webes kutatás
    web_search: {
        label: 'Webes keresés',
        description: 'Kontrollált webes keresés publikus, aktuális információhoz.'
    },
    web_research_request: {
        label: 'Webes kutatás',
        description: 'Strukturált web-kutatás kérése a Web-Egress workertől (tények + források).'
    },
    // Futás-elemzés / hibakeresés
    run_index: {
        label: 'Futás-lista',
        description: 'Futás-fejlécek lekérése szkóp alapján — a futás-elemzés első lépése.'
    },
    run_trace: {
        label: 'Futás-idővonal',
        description: 'Egy futás idővonala vagy folyamat-nézete — a futás-elemzés lefúrása.'
    },
    run_stats: {
        label: 'Futás-statisztika',
        description: 'Összesített mutatók a kiválasztott futásokról.'
    },
    get_debug_trace: {
        label: 'Hibakereső nyomvonal',
        description: 'Agent-forduló álnevesített debug-nyomvonala hibakereséshez.'
    },
    // Projektmemória
    memory_propose: {
        label: 'Memória-javaslat',
        description: 'Projektmemória-javaslat (jóváhagyás-köteles, nem azonnali írás).'
    },
    // Zárt szerep — provisioning
    'provisioning.catalog.read': {
        label: 'Katalógus olvasása',
        description: 'Provisioning connector-katalógus olvasása (zárt szerep).'
    },
    'provisioning.draft.create': {
        label: 'Draft létrehozása',
        description: 'Új connector-draft létrehozása a provisioning folyamatban.'
    },
    'provisioning.draft.validate': {
        label: 'Draft validálása',
        description: 'Connector-draft érvényességének ellenőrzése.'
    },
    'provisioning.discover.search': {
        label: 'Felfedezés – keresés',
        description: 'API/dokumentáció keresése webes felfedezés során.'
    },
    'provisioning.discover.fetch': {
        label: 'Felfedezés – letöltés',
        description: 'Felfedezett dokumentum / forrás letöltése.'
    },
    'provisioning.discover.draft': {
        label: 'Felfedezés – draft',
        description: 'Felfedezés eredményéből connector-draft összeállítása.'
    },
    // Zárt szerep — web-egress
    web_fetch: {
        label: 'Webes letöltés',
        description: 'Kontrollált tartalom-letöltés URL-ről (deny-by-default, allowlist).'
    },
    'web.research.serve': {
        label: 'Kutatás kiszolgálása',
        description: 'Web-kutatási eredmény kiszolgálása a Web-Egress szerep számára.'
    }
};
function getToolUiLabel(toolName) {
    return TOOL_UI_LABELS[toolName] ?? {
        label: toolName,
        description: ''
    };
}
function formatToolUiName(toolName) {
    const meta = getToolUiLabel(toolName);
    if (meta.label === toolName) return toolName;
    return `${meta.label} (${toolName})`;
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/control-plane/operations/labels.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "OPERATION_ERROR_LABELS",
    ()=>OPERATION_ERROR_LABELS,
    "operationErrorLabel",
    ()=>operationErrorLabel
]);
const OPERATION_ERROR_LABELS = {
    approver_not_authorized: 'Nincs jogod jóváhagyni vagy elutasítani ezt a műveletet.',
    operation_not_found: 'A művelet nem található.',
    operation_not_awaiting_approval: 'Ez a művelet már nem vár jóváhagyásra.',
    approval_already_decided: 'Erről a műveletről már döntöttek.',
    drive_write_not_allowed: 'A Google Drive írás ehhez a mappához nem engedélyezett.',
    google_drive_auth_failed: 'A Google Drive bejelentkezés sikertelen.',
    google_drive_api_error: 'A Google Drive kérés sikertelen.',
    tool_execution_failed: 'A művelet végrehajtása sikertelen.',
    http_api_error: 'A célrendszer elutasította a kérést.',
    missing_api_key: 'A connectorhoz nincs beállítva API-kulcs.',
    agent_access_denied: 'Ehhez a munkatárshoz már nincs működési jogod.',
    invalid_args: 'Érvénytelen kérés.',
    schema_mismatch: 'Az adatbázis séma nem a Core MVP. A jóváhagyási sor a gateway_operations táblát igényli.'
};
function operationErrorLabel(code, t) {
    if (t) {
        const key = `errors.${code}`;
        return code in OPERATION_ERROR_LABELS ? t(key) : t('errors.fallback');
    }
    return OPERATION_ERROR_LABELS[code] ?? 'A művelet nem sikerült.';
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/control-plane/operations/operations-panel.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "OperationsPanel",
    ()=>OperationsPanel
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/use-intl/dist/esm/development/react.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-client/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$a854a7__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__ = __turbopack_context__.i("[project]/src/app/actions/data:a854a7 [app-client] (ecmascript) <text/javascript>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$ca19dd__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__ = __turbopack_context__.i("[project]/src/app/actions/data:ca19dd [app-client] (ecmascript) <text/javascript>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$gateway$2d$operation$2f$pending$2d$args$2d$summary$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/gateway-operation/pending-args-summary.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$translate$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/translate.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tool$2d$ui$2d$labels$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/tool-ui-labels.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$operations$2f$labels$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/app/control-plane/operations/labels.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
;
;
function agentDefinitionLabel(row) {
    if (row.definitionLabel && row.definitionLabel !== row.agentName) {
        return `${row.agentName} · ${row.definitionLabel}`;
    }
    return row.agentName;
}
function argsSummary(toolName, args, t) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$gateway$2d$operation$2f$pending$2d$args$2d$summary$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["pendingArgsSummary"])(toolName, args, {
        memoryKind: t('memoryKind'),
        parentRoot: t('parentRoot'),
        parentFolder: (id)=>t('parentFolder', {
                id
            })
    });
}
function formatWhen(iso, locale) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(locale === 'en' ? 'en-GB' : 'hu-HU');
}
function OperationsPanel({ operations }) {
    _s();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$translate$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["asTranslate"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('ControlPlane.operations'));
    const locale = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useLocale"])();
    const [message, setMessage] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [messageKind, setMessageKind] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('info');
    const [busyId, setBusyId] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [reason, setReason] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({});
    async function onApprove(operationId) {
        setBusyId(operationId);
        setMessage(null);
        const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$a854a7__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__["approveGatewayOperationAction"])({
            operationId
        });
        setBusyId(null);
        if (!result.success) {
            setMessageKind('error');
            setMessage((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$operations$2f$labels$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["operationErrorLabel"])(result.error, t));
            return;
        }
        // Approve executes the write synchronously — the operation can come back
        // 'failed' (e.g. the target API rejected the payload) even though the
        // approve call itself succeeded. Surface that here instead of only in
        // the operation's own status text, or a failed write looks identical to
        // a successful one.
        if (result.data.status === 'failed') {
            setMessageKind('error');
            setMessage(t('approvedFailed', {
                error: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$operations$2f$labels$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["operationErrorLabel"])(result.data.errorCode ?? 'tool_execution_failed', t)
            }));
            return;
        }
        const fileId = result.data.result && typeof result.data.result === 'object' ? result.data.result.file?.id : undefined;
        setMessageKind('info');
        setMessage(fileId ? t('approvedFile', {
            fileId
        }) : t('approvedStatus', {
            status: result.data.status
        }));
    }
    async function onReject(operationId) {
        setBusyId(operationId);
        setMessage(null);
        const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$ca19dd__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__["rejectGatewayOperationAction"])({
            operationId,
            reason: reason[operationId]?.trim() || undefined
        });
        setBusyId(null);
        if (!result.success) {
            setMessageKind('error');
            setMessage((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$operations$2f$labels$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["operationErrorLabel"])(result.error, t));
            return;
        }
        setMessageKind('info');
        setMessage(t('rejected'));
    }
    if (operations.length === 0) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
            className: "text-sm text-ink-soft",
            children: t('empty')
        }, void 0, false, {
            fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
            lineNumber: 98,
            columnNumber: 12
        }, this);
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "space-y-4",
        children: [
            message ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: messageKind === 'error' ? 'rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800' : 'rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink',
                children: message
            }, void 0, false, {
                fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                lineNumber: 104,
                columnNumber: 9
            }, this) : null,
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                className: "space-y-3",
                children: operations.map((row)=>{
                    const busy = busyId === row.operationId;
                    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                        id: row.operationId,
                        className: "rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm target:ring-2 target:ring-coral",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "flex flex-wrap items-baseline justify-between gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "font-medium text-ink",
                                        children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tool$2d$ui$2d$labels$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["formatToolUiName"])(row.toolName)
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                        lineNumber: 124,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "text-xs text-ink-faint",
                                        children: formatWhen(row.createdAt, locale)
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                        lineNumber: 125,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                lineNumber: 123,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "mt-1 text-sm text-ink-soft",
                                children: [
                                    agentDefinitionLabel(row),
                                    " · ",
                                    row.requesterName
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                lineNumber: 127,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "mt-1 whitespace-pre-wrap break-words text-sm text-ink",
                                children: argsSummary(row.toolName, row.args, t)
                            }, void 0, false, {
                                fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                lineNumber: 130,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                                className: "mt-3 block text-xs text-ink-soft",
                                children: [
                                    t('rejectReason'),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("textarea", {
                                        className: "mt-1 w-full rounded-md border border-ink/15 bg-white px-2 py-1 text-sm text-ink",
                                        rows: 2,
                                        value: reason[row.operationId] ?? '',
                                        onChange: (event)=>setReason((current)=>({
                                                    ...current,
                                                    [row.operationId]: event.target.value
                                                }))
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                        lineNumber: 135,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                lineNumber: 133,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "mt-3 flex flex-wrap gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                        type: "button",
                                        disabled: busy,
                                        onClick: ()=>void onApprove(row.operationId),
                                        className: "rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50",
                                        children: t('approve')
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                        lineNumber: 145,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                        type: "button",
                                        disabled: busy,
                                        onClick: ()=>void onReject(row.operationId),
                                        className: "rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50",
                                        children: t('reject')
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                        lineNumber: 153,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                                lineNumber: 144,
                                columnNumber: 15
                            }, this)
                        ]
                    }, row.operationId, true, {
                        fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                        lineNumber: 118,
                        columnNumber: 13
                    }, this);
                })
            }, void 0, false, {
                fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
                lineNumber: 114,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/control-plane/operations/operations-panel.tsx",
        lineNumber: 102,
        columnNumber: 5
    }, this);
}
_s(OperationsPanel, "AAgX82YPvJokjebYcE9PQfat0uI=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useLocale"]
    ];
});
_c = OperationsPanel;
var _c;
__turbopack_context__.k.register(_c, "OperationsPanel");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/actions/data:ec9c29 [app-client] (ecmascript) <text/javascript>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "decideHandoffAction",
    ()=>$$RSC_SERVER_ACTION_1
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/build/webpack/loaders/next-flight-loader/action-client-wrapper.js [app-client] (ecmascript)");
/* __next_internal_action_entry_do_not_use__ [{"40704b5606468b46b657548459abb7c1fa7e7a3001":{"name":"decideHandoffAction"}},"src/app/actions/handoff.ts",""] */ "use turbopack no side effects";
;
const $$RSC_SERVER_ACTION_1 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createServerReference"])("40704b5606468b46b657548459abb7c1fa7e7a3001", __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["callServer"], void 0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["findSourceMapURL"], "decideHandoffAction");
;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/work-project.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "GENERAL_WORK_PROJECT_KEY",
    ()=>GENERAL_WORK_PROJECT_KEY,
    "GENERAL_WORK_PROJECT_NAME",
    ()=>GENERAL_WORK_PROJECT_NAME,
    "effectiveWorkProjectKey",
    ()=>effectiveWorkProjectKey,
    "isReservedWorkProjectKey",
    ()=>isReservedWorkProjectKey,
    "isValidProjectKey",
    ()=>isValidProjectKey,
    "normalizeNamedProjectKey",
    ()=>normalizeNamedProjectKey,
    "normalizeWorkFilePath",
    ()=>normalizeWorkFilePath,
    "slugifyWorkProjectKey",
    ()=>slugifyWorkProjectKey
]);
const GENERAL_WORK_PROJECT_KEY = '__general__';
const GENERAL_WORK_PROJECT_NAME = 'Általános';
const HUNGARIAN_FOLD = {
    á: 'a',
    é: 'e',
    í: 'i',
    ó: 'o',
    ö: 'o',
    ő: 'o',
    ú: 'u',
    ü: 'u',
    ű: 'u',
    Á: 'a',
    É: 'e',
    Í: 'i',
    Ó: 'o',
    Ö: 'o',
    Ő: 'o',
    Ú: 'u',
    Ü: 'u',
    Ű: 'u'
};
const KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;
function isReservedWorkProjectKey(key) {
    return key.trim() === GENERAL_WORK_PROJECT_KEY;
}
function isValidProjectKey(key) {
    return KEY_RE.test(key);
}
function slugifyWorkProjectKey(name) {
    const folded = name.replace(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, (ch)=>HUNGARIAN_FOLD[ch] ?? ch);
    return folded.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_.:-]+/g, '').replace(/-+/g, '-').replace(/^[._:-]+|[._:-]+$/g, '').slice(0, 120);
}
function effectiveWorkProjectKey(raw) {
    const key = (raw ?? '').trim();
    return key || GENERAL_WORK_PROJECT_KEY;
}
function normalizeNamedProjectKey(raw) {
    const key = raw.trim();
    if (!key || isReservedWorkProjectKey(key) || !isValidProjectKey(key)) return null;
    return key;
}
function normalizeWorkFilePath(raw) {
    const trimmed = raw.trim().replace(/\\/g, '/');
    if (!trimmed || trimmed.startsWith('/') || trimmed.length > 240) return null;
    const parts = trimmed.split('/').filter((part)=>part.length > 0 && part !== '.');
    if (parts.length === 0) return null;
    if (parts.some((part)=>part === '..' || part === '~')) return null;
    return parts.join('/');
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/domain/handoff/handoff-service.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "HANDOFF_LINKS_MAX",
    ()=>HANDOFF_LINKS_MAX,
    "HANDOFF_SUMMARY_MAX",
    ()=>HANDOFF_SUMMARY_MAX,
    "HANDOFF_TITLE_MAX",
    ()=>HANDOFF_TITLE_MAX,
    "formatHandoffMemoryBody",
    ()=>formatHandoffMemoryBody,
    "handoffHeadline",
    ()=>handoffHeadline,
    "normalizeHandoffProjectKey",
    ()=>normalizeHandoffProjectKey,
    "parseHandoffLinks",
    ()=>parseHandoffLinks,
    "validateHandoffInput",
    ()=>validateHandoffInput
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$work$2d$project$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/work-project.ts [app-client] (ecmascript)");
;
const HANDOFF_TITLE_MAX = 200;
const HANDOFF_SUMMARY_MAX = 8_000;
const HANDOFF_LINKS_MAX = 2_000;
function normalizeHandoffProjectKey(value) {
    const key = typeof value === 'string' && value.trim() ? value.trim() : __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$work$2d$project$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["GENERAL_WORK_PROJECT_KEY"];
    return key.slice(0, 120);
}
function validateHandoffInput(input) {
    const toAgent = typeof input.toAgentId === 'string' && input.toAgentId.trim() ? input.toAgentId.trim() : null;
    const toUser = typeof input.toUserId === 'string' && input.toUserId.trim() ? input.toUserId.trim() : null;
    if (Boolean(toAgent) === Boolean(toUser)) return {
        ok: false,
        code: 'handoff_target_required'
    };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (toAgent && !uuid.test(toAgent) || toUser && !uuid.test(toUser)) return {
        ok: false,
        code: 'invalid_args'
    };
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!title || title.length > HANDOFF_TITLE_MAX) return {
        ok: false,
        code: 'invalid_args'
    };
    if (!summary || summary.length > HANDOFF_SUMMARY_MAX) return {
        ok: false,
        code: 'invalid_args'
    };
    const links = typeof input.links === 'string' && input.links.trim() ? input.links.trim() : null;
    if (links && links.length > HANDOFF_LINKS_MAX) return {
        ok: false,
        code: 'invalid_args'
    };
    return {
        ok: true,
        title,
        summary,
        links
    };
}
function formatHandoffMemoryBody(input) {
    const linksLine = input.links ? `\nLinks: ${input.links}` : '';
    return `[átadás innen: ${input.fromAgentName}]\n${input.summary}${linksLine}\n(handoffId: ${input.handoffId})`;
}
function parseHandoffLinks(links) {
    if (!links) return [];
    const parts = links.split(',').map((part)=>part.trim()).filter(Boolean);
    return parts.flatMap((part)=>{
        const sep = part.indexOf('|');
        const label = (sep >= 0 ? part.slice(0, sep) : part).trim();
        const href = (sep >= 0 ? part.slice(sep + 1) : part).trim();
        if (!label && !href) return [];
        const target = href || label;
        const kind = /^https?:\/\//i.test(target) ? 'url' : target.startsWith('work_file:') ? 'work_file' : 'other';
        return [
            {
                label: label || target,
                href: target,
                kind
            }
        ];
    });
}
function handoffHeadline(row) {
    return {
        id: row.id,
        title: row.title,
        projectKey: row.projectKey,
        createdAt: row.createdAt.toISOString(),
        fromAgentName: row.fromAgentName ?? null
    };
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/control-plane/operations/handoffs-panel.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "HandoffsPanel",
    ()=>HandoffsPanel
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/client/app-dir/link.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/navigation.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/use-intl/dist/esm/development/react.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-client/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$ec9c29__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__ = __turbopack_context__.i("[project]/src/app/actions/data:ec9c29 [app-client] (ecmascript) <text/javascript>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$handoff$2f$handoff$2d$service$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/handoff/handoff-service.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$translate$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/translate.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$work$2d$project$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/work-project.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$shell$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/shell.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$operations$2f$labels$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/app/control-plane/operations/labels.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
;
;
;
;
;
function formatWhen(iso, locale) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(locale === 'en' ? 'en-GB' : 'hu-HU');
}
function decisionsFor(status) {
    if (status === 'accepted') return [
        'done',
        'rejected'
    ];
    return [
        'accepted',
        'done',
        'rejected'
    ];
}
function statusTone(status) {
    if (status === 'accepted') return 'success';
    if (status === 'open') return 'warning';
    return 'neutral';
}
function HandoffLinks({ raw }) {
    _s();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$translate$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["asTranslate"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('ControlPlane.operations'));
    const items = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$handoff$2f$handoff$2d$service$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["parseHandoffLinks"])(raw);
    if (items.length === 0) return null;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
        className: "mt-2 space-y-1 text-sm",
        children: items.map((item)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                children: item.kind === 'url' ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("a", {
                    href: item.href,
                    target: "_blank",
                    rel: "noreferrer",
                    className: "text-coral-deep underline decoration-coral/40 underline-offset-2 hover:decoration-coral",
                    children: item.label
                }, void 0, false, {
                    fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                    lineNumber: 42,
                    columnNumber: 13
                }, this) : item.kind === 'work_file' ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                    href: "/control-plane/projects",
                    className: "text-coral-deep underline decoration-coral/40 underline-offset-2 hover:decoration-coral",
                    title: item.href.replace(/^work_file:/, ''),
                    children: [
                        item.label,
                        " · ",
                        t('handoffWorkFile')
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                    lineNumber: 51,
                    columnNumber: 13
                }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: "text-ink-soft",
                    children: item.label
                }, void 0, false, {
                    fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                    lineNumber: 59,
                    columnNumber: 13
                }, this)
            }, `${item.label}:${item.href}`, false, {
                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                lineNumber: 40,
                columnNumber: 9
            }, this))
    }, void 0, false, {
        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
        lineNumber: 38,
        columnNumber: 5
    }, this);
}
_s(HandoffLinks, "jckdEge3m4P9VL0IU27V39qspMs=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"]
    ];
});
_c = HandoffLinks;
function HandoffsPanel({ handoffs }) {
    _s1();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$translate$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["asTranslate"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('ControlPlane.operations'));
    const locale = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useLocale"])();
    const router = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRouter"])();
    const [message, setMessage] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [messageKind, setMessageKind] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])('info');
    const [busyId, setBusyId] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [hidden, setHidden] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({});
    const [statusById, setStatusById] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({});
    const visible = handoffs.filter((row)=>!hidden[row.id]);
    async function onDecide(handoffId, decision) {
        setBusyId(handoffId);
        setMessage(null);
        const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$ec9c29__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__["decideHandoffAction"])({
            handoffId,
            decision
        });
        setBusyId(null);
        if (!result.success) {
            setMessageKind('error');
            setMessage((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$operations$2f$labels$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["operationErrorLabel"])(result.error, t));
            return;
        }
        setMessageKind('info');
        setMessage(t(`handoffDecided_${decision}`));
        if (decision === 'done' || decision === 'rejected') {
            setHidden((current)=>({
                    ...current,
                    [handoffId]: true
                }));
        } else {
            setStatusById((current)=>({
                    ...current,
                    [handoffId]: decision
                }));
        }
        router.refresh();
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
        className: "space-y-4",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                        className: "font-display text-xl font-semibold",
                        children: t('handoffsTitle')
                    }, void 0, false, {
                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                        lineNumber: 102,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "mt-1 max-w-2xl text-sm text-ink-soft",
                        children: t('handoffsBody')
                    }, void 0, false, {
                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                        lineNumber: 103,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                lineNumber: 101,
                columnNumber: 7
            }, this),
            message ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: messageKind === 'error' ? 'rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800' : 'rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink',
                children: message
            }, void 0, false, {
                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                lineNumber: 106,
                columnNumber: 9
            }, this) : null,
            visible.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: "text-sm text-ink-soft",
                children: t('handoffsEmpty')
            }, void 0, false, {
                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                lineNumber: 117,
                columnNumber: 9
            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                className: "space-y-3",
                children: visible.map((row)=>{
                    const status = statusById[row.id] ?? row.status;
                    const busy = busyId === row.id;
                    const projectLabel = row.projectKey === __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$work$2d$project$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["GENERAL_WORK_PROJECT_KEY"] ? t('handoffGeneralProject') : row.projectKey;
                    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                        className: "rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "flex flex-wrap items-baseline justify-between gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "font-medium text-ink",
                                        children: row.title
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                        lineNumber: 128,
                                        columnNumber: 19
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "text-xs text-ink-faint",
                                        children: formatWhen(row.createdAt, locale)
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                        lineNumber: 129,
                                        columnNumber: 19
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                lineNumber: 127,
                                columnNumber: 17
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$shell$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Badge"], {
                                        tone: statusTone(status),
                                        title: t(`handoffStatusHint_${status}`),
                                        children: t(`handoffStatus_${status}`)
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                        lineNumber: 132,
                                        columnNumber: 19
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        children: t('handoffFrom', {
                                            name: row.fromAgentName
                                        })
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                        lineNumber: 135,
                                        columnNumber: 19
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        "aria-hidden": "true",
                                        children: "·"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                        lineNumber: 136,
                                        columnNumber: 19
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        children: t('handoffProject', {
                                            name: projectLabel
                                        })
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                        lineNumber: 137,
                                        columnNumber: 19
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                lineNumber: 131,
                                columnNumber: 17
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "mt-2 whitespace-pre-wrap break-words text-sm text-ink",
                                children: row.summary
                            }, void 0, false, {
                                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                lineNumber: 139,
                                columnNumber: 17
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(HandoffLinks, {
                                raw: row.links
                            }, void 0, false, {
                                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                lineNumber: 140,
                                columnNumber: 17
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "mt-3 flex flex-wrap gap-2",
                                children: decisionsFor(status).map((decision)=>{
                                    const primary = decision === 'accepted' || status === 'accepted' && decision === 'done';
                                    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                        type: "button",
                                        disabled: busy,
                                        title: t(`handoffHint_${decision}`),
                                        onClick: ()=>void onDecide(row.id, decision),
                                        className: primary ? 'rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50' : 'rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50',
                                        children: t(`handoff_${decision}`)
                                    }, decision, false, {
                                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                        lineNumber: 145,
                                        columnNumber: 23
                                    }, this);
                                })
                            }, void 0, false, {
                                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                                lineNumber: 141,
                                columnNumber: 17
                            }, this)
                        ]
                    }, row.id, true, {
                        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                        lineNumber: 126,
                        columnNumber: 15
                    }, this);
                })
            }, void 0, false, {
                fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
                lineNumber: 119,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/control-plane/operations/handoffs-panel.tsx",
        lineNumber: 100,
        columnNumber: 5
    }, this);
}
_s1(HandoffsPanel, "twdKfWsinAE92B5B0SnOCU3Ba88=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useLocale"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRouter"]
    ];
});
_c1 = HandoffsPanel;
var _c, _c1;
__turbopack_context__.k.register(_c, "HandoffLinks");
__turbopack_context__.k.register(_c1, "HandoffsPanel");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=src_1qje57m._.js.map