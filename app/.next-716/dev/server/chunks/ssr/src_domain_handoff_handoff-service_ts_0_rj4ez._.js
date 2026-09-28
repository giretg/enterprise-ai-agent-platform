module.exports = [
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

//# sourceMappingURL=src_domain_handoff_handoff-service_ts_0_rj4ez._.js.map