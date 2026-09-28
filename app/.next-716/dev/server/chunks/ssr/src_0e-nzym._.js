module.exports = [
"[project]/src/lib/work-project.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
}),
"[project]/src/domain/handoff/handoff-service.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$work$2d$project$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/work-project.ts [app-rsc] (ecmascript)");
;
const HANDOFF_TITLE_MAX = 200;
const HANDOFF_SUMMARY_MAX = 8_000;
const HANDOFF_LINKS_MAX = 2_000;
function normalizeHandoffProjectKey(value) {
    const key = typeof value === 'string' && value.trim() ? value.trim() : __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$work$2d$project$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["GENERAL_WORK_PROJECT_KEY"];
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
}),
];

//# sourceMappingURL=src_0e-nzym._.js.map