module.exports = [
"[externals]/node:dns/promises [external] (node:dns/promises, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:dns/promises", () => require("node:dns/promises"));

module.exports = mod;
}),
"[project]/src/domain/net/cloud-run-auth.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "cloudRunJobRunEndpoint",
    ()=>cloudRunJobRunEndpoint,
    "fetchCloudRunExecutionStatus",
    ()=>fetchCloudRunExecutionStatus,
    "getCloudRunAccessToken",
    ()=>getCloudRunAccessToken,
    "waitForCloudRunExecution",
    ()=>waitForCloudRunExecution
]);
async function getCloudRunAccessToken(explicitToken) {
    if (explicitToken?.trim()) return explicitToken.trim();
    const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        headers: {
            'Metadata-Flavor': 'Google'
        }
    });
    if (!response.ok) {
        throw new Error(`Metadata server token request failed: ${response.status}`);
    }
    const data = await response.json();
    if (!data.access_token) throw new Error('Metadata server token response is missing access_token');
    return data.access_token;
}
function cloudRunJobRunEndpoint(projectId, location, jobName) {
    return [
        'https://run.googleapis.com/v2/projects',
        encodeURIComponent(projectId),
        'locations',
        encodeURIComponent(location),
        'jobs',
        encodeURIComponent(jobName)
    ].join('/');
}
async function fetchCloudRunExecutionStatus(executionName, token) {
    const response = await fetch(`https://run.googleapis.com/v2/${executionName}`, {
        headers: {
            authorization: `Bearer ${token}`
        }
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Cloud Run execution fetch failed: ${response.status} ${body.slice(0, 300)}`);
    }
    // A jobs:run egy long-running Operationt ad vissza (projects/…/operations/…),
    // ami a job futás befejezésekor lesz done. Ilyenkor az operation állapotát
    // értelmezzük, nem az Execution conditions-t.
    if (executionName.includes('/operations/')) {
        const op = await response.json();
        if (op.error) return {
            status: 'failed',
            detail: op.error.message
        };
        if (op.done) return {
            status: 'succeeded'
        };
        return {
            status: 'running'
        };
    }
    const data = await response.json();
    const completed = data.conditions?.find((condition)=>condition.type === 'Completed');
    if (completed?.state === 'CONDITION_SUCCEEDED') return {
        status: 'succeeded'
    };
    if (completed?.state === 'CONDITION_FAILED') {
        return {
            status: 'failed',
            detail: completed.message ?? data.completionStatus
        };
    }
    const started = data.conditions?.find((condition)=>condition.type === 'Started');
    if (started?.state === 'CONDITION_SUCCEEDED' || started?.state === 'CONDITION_PENDING') {
        return {
            status: 'running'
        };
    }
    return {
        status: 'unknown',
        detail: completed?.message
    };
}
async function waitForCloudRunExecution(executionName, token, timeoutMs, pollIntervalMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let last = {
        status: 'unknown'
    };
    while(Date.now() < deadline){
        last = await fetchCloudRunExecutionStatus(executionName, token);
        if (last.status === 'succeeded' || last.status === 'failed') return last;
        await new Promise((resolve)=>setTimeout(resolve, pollIntervalMs));
    }
    return {
        ...last,
        detail: last.detail ?? `timeout after ${timeoutMs}ms`
    };
}
}),
"[externals]/node:net [external] (node:net, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:net", () => require("node:net"));

module.exports = mod;
}),
"[project]/src/domain/net/egress-guard.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "FORBIDDEN_HOST_PATTERNS",
    ()=>FORBIDDEN_HOST_PATTERNS,
    "guardEgressUrl",
    ()=>guardEgressUrl,
    "isForbiddenHost",
    ()=>isForbiddenHost,
    "isPrivateOrReservedIp",
    ()=>isPrivateOrReservedIp,
    "matchForbiddenHost",
    ()=>matchForbiddenHost
]);
/**
 * Közös, determinisztikus egress-őr (Feature-spec — WebFetch-Egress §3.1 „A" réteg,
 * §7.1). Egy helyen a kimenő-hálózati védelem: SSRF-tiltott host-osztályok,
 * feloldás-utáni privát/reserved IP re-check (DNS-rebinding), és a deny-by-default
 * egress-allowlist. NEM az LLM-re bízott döntés — sima szerveroldali kód, ami
 * minden `web_fetch` (és a sandbox-connection-tester) hívásnál lefut.
 *
 * Iparági megfelelés: OWASP SSRF Prevention Cheat Sheet (privát IP-tartományok,
 * felhő-metadata host, DNS-rebinding, séma-korlát) + az Anthropic `web_fetch`
 * `allowed_domains`/`blocked_domains` modellje.
 *
 * A modul SZÁNDÉKOSAN nem végez maga hálózati hívást — a DNS-feloldó (`resolveHostIps`)
 * injektálható, így a determinisztikus tesztek hálózat nélkül futnak, élesben pedig a
 * node `dns` rétege köti be.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$net__$5b$external$5d$__$28$node$3a$net$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:net [external] (node:net, cjs)");
;
const FORBIDDEN_HOST_PATTERNS = [
    {
        name: 'localhost_host',
        pattern: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i
    },
    {
        name: 'metadata_host',
        pattern: /(169\.254\.169\.254|metadata\.google\.internal)/i
    },
    {
        name: 'known_exfil_sink',
        pattern: /(webhook\.site|requestbin|ngrok\.io|burpcollaborator)/i
    }
];
function normalizeIpLiteral(value) {
    return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
}
function isIpLiteralHost(host) {
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$net__$5b$external$5d$__$28$node$3a$net$2c$__cjs$29$__["isIP"])(normalizeIpLiteral(host)) !== 0;
}
function matchForbiddenHost(host) {
    const h = host.trim().toLowerCase();
    if (isIpLiteralHost(h)) return 'raw_ip_host';
    for (const rule of FORBIDDEN_HOST_PATTERNS){
        if (rule.pattern.test(h)) return rule.name;
    }
    return null;
}
function isForbiddenHost(host) {
    return matchForbiddenHost(host) !== null;
}
function isPrivateOrReservedIp(ip) {
    const addr = normalizeIpLiteral(ip);
    if (addr.includes(':')) {
        return isPrivateOrReservedIpv6(addr);
    }
    const ipv4 = parseIpv4ToInt(addr);
    if (ipv4 == null) return false;
    return isPrivateOrReservedIpv4Int(ipv4);
}
function parseIpv4ToInt(addr) {
    const octets = addr.split('.');
    if (octets.length !== 4) return null;
    const nums = octets.map((o)=>Number(o));
    if (nums.some((n)=>!Number.isInteger(n) || n < 0 || n > 255)) return null;
    return nums.reduce((acc, n)=>acc * 256 + n, 0) >>> 0;
}
function ipv4InCidr(ip, base, prefix) {
    const baseInt = parseIpv4ToInt(base);
    if (baseInt == null) return false;
    const mask = prefix === 0 ? 0 : 0xffffffff << 32 - prefix >>> 0;
    return (ip & mask) === (baseInt & mask);
}
function isPrivateOrReservedIpv4Int(ip) {
    return [
        [
            '0.0.0.0',
            8
        ],
        [
            '10.0.0.0',
            8
        ],
        [
            '100.64.0.0',
            10
        ],
        [
            '127.0.0.0',
            8
        ],
        [
            '169.254.0.0',
            16
        ],
        [
            '172.16.0.0',
            12
        ],
        [
            '192.0.0.0',
            24
        ],
        [
            '192.0.2.0',
            24
        ],
        [
            '192.168.0.0',
            16
        ],
        [
            '198.18.0.0',
            15
        ],
        [
            '198.51.100.0',
            24
        ],
        [
            '203.0.113.0',
            24
        ],
        [
            '224.0.0.0',
            4
        ],
        [
            '240.0.0.0',
            4
        ]
    ].some(([base, prefix])=>ipv4InCidr(ip, base, prefix));
}
function ipv4IntToDotted(ip) {
    return `${ip >>> 24 & 255}.${ip >>> 16 & 255}.${ip >>> 8 & 255}.${ip & 255}`;
}
function ipv4ToHextets(ip) {
    const parsed = parseIpv4ToInt(ip);
    if (parsed == null) return null;
    return [
        (parsed >>> 16 & 0xffff).toString(16),
        (parsed & 0xffff).toString(16)
    ];
}
function parseIpv6ToBigInt(addr) {
    const dotted = addr.match(/(.+:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) {
        const parts = ipv4ToHextets(dotted[2]);
        if (!parts) return null;
        addr = `${dotted[1]}${parts[0]}:${parts[1]}`;
    }
    const halves = addr.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
    if (missing < 0) return null;
    const groups = halves.length === 2 ? [
        ...left,
        ...Array(missing).fill('0'),
        ...right
    ] : left;
    if (groups.length !== 8) return null;
    let value = BigInt(0);
    for (const group of groups){
        if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
        value = (value << BigInt(16)) + BigInt(parseInt(group, 16));
    }
    return value;
}
function ipv6InCidr(ip, base, prefix) {
    const baseInt = parseIpv6ToBigInt(base);
    if (baseInt == null) return false;
    const shift = BigInt(128 - prefix);
    return ip >> shift === baseInt >> shift;
}
function embeddedIpv4FromIpv6(ip, prefixBase, prefix) {
    if (!ipv6InCidr(ip, prefixBase, prefix)) return null;
    const embedded = Number(ip & BigInt(0xffffffff)) >>> 0;
    return ipv4IntToDotted(embedded);
}
function isPrivateOrReservedIpv6(addr) {
    const ip = parseIpv6ToBigInt(addr);
    if (ip == null) return false;
    const mapped = embeddedIpv4FromIpv6(ip, '::ffff:0:0', 96);
    if (mapped) return isPrivateOrReservedIp(mapped);
    const compatible = embeddedIpv4FromIpv6(ip, '::', 96);
    if (compatible) return true;
    const nat64 = embeddedIpv4FromIpv6(ip, '64:ff9b::', 96);
    if (nat64 && isPrivateOrReservedIp(nat64)) return true;
    return [
        [
            '::',
            128
        ],
        [
            '::1',
            128
        ],
        [
            '64:ff9b:1::',
            48
        ],
        [
            '100::',
            64
        ],
        [
            '2001::',
            23
        ],
        [
            '2001:db8::',
            32
        ],
        [
            '2002::',
            16
        ],
        [
            'fc00::',
            7
        ],
        [
            'fe80::',
            10
        ],
        [
            'ff00::',
            8
        ]
    ].some(([base, prefix])=>ipv6InCidr(ip, base, prefix));
}
async function guardEgressUrl(input) {
    let parsed;
    try {
        parsed = new URL(input.url);
    } catch  {
        return {
            ok: false,
            reason: 'invalid_url'
        };
    }
    // (3) Séma: csak https. http/file:/data:/ftp: elutasítva.
    if (parsed.protocol !== 'https:') {
        return {
            ok: false,
            reason: 'scheme_blocked',
            detail: parsed.protocol.replace(':', '')
        };
    }
    const host = parsed.hostname.toLowerCase();
    // (4a) SSRF host-minta (nyers IP, localhost, metadata, exfil-sink).
    const forbidden = matchForbiddenHost(host);
    if (forbidden) {
        return {
            ok: false,
            reason: 'ssrf_blocked',
            detail: forbidden
        };
    }
    // (5) Egress deny-by-default: a hostnak a megadott allowliston kell lennie.
    const allow = new Set();
    for (const h of input.allowlistHosts)allow.add(h.toLowerCase());
    if (!allow.has(host)) {
        return {
            ok: false,
            reason: 'egress_not_allowlisted',
            detail: host
        };
    }
    // (4b) DNS-rebinding: feloldás-utáni privát/reserved IP re-check (ha van feloldó).
    if (input.resolveHostIps) {
        let ips;
        try {
            ips = await input.resolveHostIps(host);
        } catch  {
            return {
                ok: false,
                reason: 'ssrf_blocked',
                detail: 'dns_resolution_failed'
            };
        }
        if (ips.length === 0) {
            return {
                ok: false,
                reason: 'ssrf_blocked',
                detail: 'dns_no_address'
            };
        }
        for (const ip of ips){
            if (isPrivateOrReservedIp(ip)) {
                return {
                    ok: false,
                    reason: 'ssrf_blocked',
                    detail: 'resolved_private_ip'
                };
            }
        }
    }
    return {
        ok: true,
        host,
        url: parsed.toString()
    };
}
}),
"[project]/src/domain/connector/decode-github-contents-body.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "decodeGitHubContentsBody",
    ()=>decodeGitHubContentsBody,
    "isProbablyBinaryBuffer",
    ()=>isProbablyBinaryBuffer
]);
/**
 * GitHub Contents API válaszok modell-baráttá tétele.
 *
 * Két dolgot old meg, mert a nyers válaszból a modell egyiket sem tudja
 * megbízhatóan kihozni:
 *  1. FÁJL: a `encoding: "base64"` + `content` párost UTF-8 szöveggé dekódolja.
 *  2. KÖNYVTÁR: a listából kiveszi a bejegyzésenkénti 3 redundáns URL-t
 *     (`url`, `git_url`, `_links`) — ugyanaz a fa nagyjából feleannyi tokenből
 *     olvasható, és pont ez az a válasz, ami repo-böngészésnél túlcsordul.
 *
 * Minden más body érintetlenül megy tovább.
 */ const MAX_DECODE_BYTES = 2_000_000;
/**
 * A `Buffer.from(x, 'base64')` a nem base64 karaktereket NÉMÁN eldobja, így egy
 * véletlenül base64-nek címkézett szövegből olvashatatlan kását csinálna. Ezért
 * előbb a karakterkészletet ellenőrizzük.
 */ const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
/** A modellnek semmit nem adnak hozzá: a `download_url` és `html_url` marad. */ const REDUNDANT_ENTRY_FIELDS = [
    'url',
    'git_url',
    '_links'
];
const CONTENTS_ENTRY_TYPES = new Set([
    'file',
    'dir',
    'symlink',
    'submodule'
]);
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isGitHubFileContents(body) {
    if (!isRecord(body)) return false;
    if (body.encoding !== 'base64') return false;
    if (typeof body.content !== 'string' || body.content.length === 0) return false;
    // Contents file: type=file, vagy legalább download_url / path a GitHub alakból.
    if (body.type === 'file') return true;
    if (typeof body.download_url === 'string') return true;
    if (typeof body.path === 'string' && typeof body.sha === 'string') return true;
    return false;
}
/** GitHub Contents könyvtárlista: csupa `{ type, name, path }` alakú bejegyzés. */ function isGitHubContentsListing(body) {
    if (!Array.isArray(body) || body.length === 0) return false;
    return body.every((entry)=>isRecord(entry) && typeof entry.name === 'string' && typeof entry.path === 'string' && typeof entry.type === 'string' && CONTENTS_ENTRY_TYPES.has(entry.type));
}
function stripRedundantEntryFields(entry) {
    const trimmed = {};
    for (const [key, value] of Object.entries(entry)){
        if (REDUNDANT_ENTRY_FIELDS.includes(key)) continue;
        trimmed[key] = value;
    }
    return trimmed;
}
function isProbablyBinaryBuffer(buf) {
    if (buf.length === 0) return false;
    const sample = buf.subarray(0, Math.min(buf.length, 8192));
    if (sample.includes(0)) return true;
    let weird = 0;
    for (const b of sample){
        // TAB/LF/CR OK; többi C0 vezérlő gyanús.
        if (b < 9 || b > 13 && b < 32) weird++;
    }
    return weird / sample.length > 0.3;
}
function decodeGitHubContentsBody(body) {
    if (isGitHubContentsListing(body)) return body.map(stripRedundantEntryFields);
    if (!isGitHubFileContents(body)) return body;
    const rawB64 = body.content.replace(/\s+/g, '');
    if (!BASE64_PATTERN.test(rawB64)) return body;
    const decoded = Buffer.from(rawB64, 'base64');
    if (decoded.length === 0) return body;
    const trimmed = stripRedundantEntryFields(body);
    if (decoded.length > MAX_DECODE_BYTES) {
        return {
            ...trimmed,
            content: null,
            encoding: 'omitted',
            byteLength: decoded.length,
            decodeNote: `A fájl dekódolva ${decoded.length} bájt — ekkora tartalom a modell kontextusába nem fér be. ` + 'Kérd a fájl egy kisebb, konkrét részét (pl. másik útvonal / kisebb modul), vagy dolgozz a repo ' + 'fastruktúrájából; ezt a választ ne próbáld darabokban visszaolvasni.'
        };
    }
    if (isProbablyBinaryBuffer(decoded)) {
        return {
            ...trimmed,
            content: null,
            encoding: 'binary',
            byteLength: decoded.length,
            decodeNote: 'Bináris fájl — a tartalom nincs szövegként dekódolva. ' + 'Szöveges forrást (md/ts/json/html) kérj, vagy a download_url-t használd külső letöltéshez ha elérhető.'
        };
    }
    return {
        ...trimmed,
        content: decoded.toString('utf8'),
        encoding: 'utf-8',
        byteLength: decoded.length
    };
}
}),
"[project]/src/lib/http-api-pagination-signals.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/** Gyakori API pageSize értékek — ennyi sor gyakran EGY oldal, nem a teljes lista. */ __turbopack_context__.s([
    "COMMON_HTTP_PAGE_SIZES",
    ()=>COMMON_HTTP_PAGE_SIZES,
    "requiresHttpApiGetAll",
    ()=>requiresHttpApiGetAll
]);
const COMMON_HTTP_PAGE_SIZES = new Set([
    10,
    20,
    25,
    50,
    100
]);
const LIST_ENDPOINTS = new Set([
    'ownerships',
    'partners',
    'owners',
    'customers',
    'accounts'
]);
function requiresHttpApiGetAll(path) {
    const segments = (path ?? '').split('?')[0]?.split('/').filter(Boolean).map((segment)=>segment.toLocaleLowerCase('en-US'));
    const lastSegment = segments?.at(-1);
    return lastSegment != null && LIST_ENDPOINTS.has(lastSegment);
}
}),
"[project]/src/domain/connector/http-api-prompt.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "buildHttpApiClientErrorHint",
    ()=>buildHttpApiClientErrorHint,
    "buildHttpApiEfficiencyGuidance",
    ()=>buildHttpApiEfficiencyGuidance,
    "buildHttpApiLikelyPaginatedHint",
    ()=>buildHttpApiLikelyPaginatedHint,
    "buildHttpApiOversizedResponseHint",
    ()=>buildHttpApiOversizedResponseHint,
    "buildHttpApiTruncationBody",
    ()=>buildHttpApiTruncationBody,
    "formatHttpApiEndpointCatalogSuffix",
    ()=>formatHttpApiEndpointCatalogSuffix,
    "formatHttpApiPathParamsHint",
    ()=>formatHttpApiPathParamsHint,
    "formatHttpApiQueryParamsHint",
    ()=>formatHttpApiQueryParamsHint
]);
/**
 * HTTP API connector → modellnek szóló katalógus / hiba / hatékonysági szöveg.
 * Tiszta függvények — MCP enterprise tool hívások és a HttpApiClient ezeket hívja.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$http$2d$api$2d$pagination$2d$signals$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/http-api-pagination-signals.ts [app-rsc] (ecmascript)");
;
function formatHttpApiQueryParamsHint(params) {
    if (!params || params.length === 0) return '';
    const parts = params.map((p)=>{
        const type = p.type ? `:${p.type}` : '';
        const req = p.required ? ', kötelező' : '';
        const desc = p.description ? ` — ${p.description}` : '';
        return `${p.name}${type}${req}${desc}`;
    });
    return `query: ${parts.join('; ')}`;
}
function formatHttpApiPathParamsHint(params) {
    if (!params || params.length === 0) return '';
    const parts = params.map((p)=>{
        const type = p.type ? `:${p.type}` : '';
        return `${p.name}${type}`;
    });
    return `path: ${parts.join(', ')}`;
}
function formatHttpApiEndpointCatalogSuffix(endpoint) {
    const query = formatHttpApiQueryParamsHint(resolveQueryParams(endpoint)) || '';
    const pathParams = formatHttpApiPathParamsHint(resolvePathParams(endpoint));
    const headers = formatCallerHeaderHint(endpoint);
    const bits = [
        query,
        pathParams,
        headers
    ].filter(Boolean);
    return bits.length > 0 ? ` — ${bits.join(' | ')}` : '';
}
function buildHttpApiClientErrorHint(input) {
    if (input.status < 400 || input.status >= 500) return undefined;
    const allowed = resolveQueryParams(input.endpoint ?? undefined);
    if (!allowed || allowed.length === 0) {
        if (input.status === 422 || input.status === 400) {
            return 'A kérés elutasítva. Ne találj ki új query mezőneveket — csak a connector ' + 'endpoint-katalógusában szereplő paramétereket használd. Ha nincs dokumentált ' + 'szűrő, aggregált/report végpontot keress, ne dumpold a teljes listát.';
        }
        return undefined;
    }
    const allowedHint = formatHttpApiQueryParamsHint(allowed);
    const used = (input.usedQueryKeys ?? []).filter(Boolean);
    const unknown = used.filter((k)=>!allowed.some((p)=>p.name.toLowerCase() === k.toLowerCase()));
    const parts = [
        `Engedélyezett query paraméterek ezen az endpointon: ${allowedHint}.`,
        'Ne tippelj más mezőneveket.'
    ];
    if (unknown.length > 0) {
        parts.push(`Ismeretlen / nem dokumentált query kulcsok a hívásban: ${unknown.join(', ')}.`);
    }
    return parts.join(' ');
}
function buildHttpApiOversizedResponseHint(input) {
    return `A válasz nagy (${input.originalChars} karakter, soft limit ${input.maxChars}). ` + 'A teljes body megmaradt a tool-pipeline számára (get_all / archive). A modellnek: ' + 'ne dumpold a kontextusba — használd a dokumentált query/szűrőt, http_api_get_all-t, ' + 'vagy tool_result_extract-et a munkaterületi másolaton; ne chunkolt file_read-et.';
}
function buildHttpApiTruncationBody(input) {
    return {
        truncated: true,
        originalChars: input.originalChars,
        maxChars: input.maxChars,
        preview: input.preview,
        hint: `A válasz túl nagy (${input.originalChars} karakter, limit ${input.maxChars}), és nem sikerült ` + 'teljes JSON-ként megőrizni. Használj: (1) dokumentált query/szűrőt, ' + '(2) http_api_get_all kisebb pageSize-zal, (3) specifikusabb path-ot (egyedi rekord), ' + '(4) ha lista kell: tool_result_extract a munkaterületi másolaton.'
    };
}
function buildHttpApiEfficiencyGuidance() {
    return [
        'Hatékony HTTP API használat:',
        '- Először a connector endpoint-katalógus dokumentált query/path paramétereit használd — ne találj ki mezőneveket (422/400 után sem).',
        '- Lapozott nagy listához http_api_get_all (egy hívás), ne page=1,2,3… http_api_get sorozatot.',
        '- Ownership / partner / ownerships / nagy névsor: KÖTELEZŐEN http_api_get_all — a sima get gyakran csak az első oldalt (pl. 50 sort) adja.',
        '- Időszak / összehasonlítás / top-N analitika: aggregált vagy report/query végpont + period paramok; NE dumpold a teljes order/account listát, és NE helyettesíts más proxy-metrikával (pl. rolling health), ha a kért periódus-adat hiányzik — mondd ki.',
        '- Szűretlen listázás után ne húzz végig tucatnyi egyedi részlet-endpointot; előbb top-N / search / filter.',
        '- Nagy JSON archive után: tool_result_extract (arrayPath ha kell) → reconcile/xlsx; SOHA ne chunkold file_read-del ugyanazt a fájlt. Ownership egyeztetéshez a get_all tool-outputs path közvetlenül is jó.'
    ].join('\n');
}
function buildHttpApiLikelyPaginatedHint(input) {
    const path = (input.path ?? '').trim();
    if (!path) return null;
    let count = typeof input.itemCount === 'number' ? input.itemCount : null;
    if (count == null) {
        const items = extractRecordArray(input.body);
        count = items?.length ?? null;
    }
    if (count == null || count <= 0) return null;
    const listPath = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$http$2d$api$2d$pagination$2d$signals$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["requiresHttpApiGetAll"])(path);
    const roundPage = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$http$2d$api$2d$pagination$2d$signals$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["COMMON_HTTP_PAGE_SIZES"].has(count);
    if (!listPath && !roundPage) return null;
    if (!listPath && count < 20) return null;
    if (listPath || roundPage) {
        return `FIGYELEM: a(z) "${path}" válasz ${count} sort tartalmaz` + (roundPage ? ` (gyakori pageSize: ${count})` : '') + '. Ez gyakran CSAK az első oldal. Nagy névsor / ownership listához hívd ÚJRA ' + 'http_api_get_all-lal ugyanezzel a path-dal — ne tool_result_extract-eld ezt egyeztetéshez, ' + 'amíg a teljes lista nincs meg.';
    }
    return null;
}
function extractRecordArray(body) {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== 'object') return null;
    for (const key of [
        'data',
        'items',
        'results',
        'records',
        'rows',
        'ownerships',
        'body'
    ]){
        const value = body[key];
        if (Array.isArray(value)) return value;
    }
    const arrays = Object.values(body).filter(Array.isArray);
    return arrays.length === 1 ? arrays[0] : null;
}
function resolveQueryParams(endpoint) {
    if (!endpoint) return undefined;
    if (Array.isArray(endpoint.queryParams) && endpoint.queryParams.length > 0) {
        return endpoint.queryParams;
    }
    return paramsWithIn(endpoint, 'query');
}
function resolvePathParams(endpoint) {
    if (!endpoint) return undefined;
    if (Array.isArray(endpoint.pathParams) && endpoint.pathParams.length > 0) {
        return endpoint.pathParams;
    }
    return paramsWithIn(endpoint, 'path');
}
function paramsWithIn(endpoint, location) {
    if (!Array.isArray(endpoint.parameters)) return undefined;
    const out = [];
    for (const raw of endpoint.parameters){
        if (!raw || typeof raw.name !== 'string' || raw.in !== location) continue;
        out.push({
            name: raw.name,
            required: raw.required === true || location === 'path',
            ...typeof raw.type === 'string' ? {
                type: raw.type
            } : {},
            ...typeof raw.description === 'string' ? {
                description: raw.description
            } : {}
        });
    }
    return out.length > 0 ? out : undefined;
}
function formatCallerHeaderHint(endpoint) {
    const source = Array.isArray(endpoint.headerParams) ? endpoint.headerParams : Array.isArray(endpoint.parameters) ? endpoint.parameters.filter((p)=>p && p.in === 'header' && typeof p.name === 'string') : [];
    const headers = source.flatMap((param)=>{
        if (!param || typeof param.name !== 'string' || !param.name.trim()) return [];
        return [
            `${param.name}${param.required === true ? ' (kötelező)' : ' (opcionális)'}`
        ];
    });
    return headers.length > 0 ? `Hívói fejlécek: ${headers.join(', ')}` : '';
}
}),
"[externals]/node:zlib [external] (node:zlib, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:zlib", () => require("node:zlib"));

module.exports = mod;
}),
"[project]/src/domain/connector/xml-protocols.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ProtocolRequestError",
    ()=>ProtocolRequestError,
    "buildProtocolRequest",
    ()=>buildProtocolRequest,
    "parseProtocolResponse",
    ()=>parseProtocolResponse,
    "protocolProbe",
    ()=>protocolProbe,
    "xmlElement",
    ()=>xmlElement
]);
/**
 * XML-alapú magyar számlázási API-k adapterei a http_api connector mögött.
 *
 * A modell a szokásos http_api_get / http_api_request eszközzel hív egyszerű,
 * virtuális végpontokat (GET query-paraméterekkel, POST JSON body-val); az adapter
 * ebből építi a valódi kérést:
 *   - `szamlazz_agent`: Számlázz.hu Számla Agent — multipart XML, a kulcs az XML-ben.
 *   - `nav_online_invoice`: NAV Online Számla 3.0 lekérdezések — aláírt XML.
 * A titok itt kerül be a kérésbe, sosem a modell kezébe.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$crypto__$5b$external$5d$__$28$node$3a$crypto$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:crypto [external] (node:crypto, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$zlib__$5b$external$5d$__$28$node$3a$zlib$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:zlib [external] (node:zlib, cjs)");
;
;
class ProtocolRequestError extends Error {
    code;
    constructor(message, code = 'invalid_args'){
        super(message), this.code = code;
        this.name = 'ProtocolRequestError';
    }
}
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const XML_ESCAPES = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
};
function escapeXml(value) {
    return value.replace(/[<>&'"]/g, (c)=>XML_ESCAPES[c]);
}
function xmlElement(name, value, order = {}) {
    if (value === undefined || value === null || value === '') return '';
    if (!XML_NAME.test(name)) throw new ProtocolRequestError(`invalid XML element name: ${name}`);
    if (Array.isArray(value)) return value.map((item)=>xmlElement(name, item, order)).join('');
    if (typeof value === 'object') {
        const entries = Object.entries(value);
        const rank = order[name];
        if (rank) {
            const pos = (key)=>rank.includes(key) ? rank.indexOf(key) : rank.length;
            entries.sort(([a], [b])=>pos(a) - pos(b));
        }
        return `<${name}>${entries.map(([key, item])=>xmlElement(key, item, order)).join('')}</${name}>`;
    }
    return `<${name}>${escapeXml(String(value))}</${name}>`;
}
function xmlText(xml, tag) {
    const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`));
    return match?.[1]?.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
}
function asRecord(value, what) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ProtocolRequestError(`${what} must be a JSON object`);
    }
    return value;
}
function requiredParam(query, name) {
    const value = query?.[name];
    if (value === undefined || String(value).trim() === '') {
        throw new ProtocolRequestError(`missing query parameter: ${name}`);
    }
    return String(value).trim();
}
function operationKey(call) {
    const path = `/${call.path.split('?')[0].replace(/^\/+|\/+$/g, '')}`;
    return `${call.method.toUpperCase()} ${path}`;
}
// ── Számlázz.hu Számla Agent ─────────────────────────────────────────────────
/** Az xmlszamla / xmlszamlast / xmlszamlakifiz XSD-k kötött elem-sorrendje. */ const SZAMLAZZ_ORDER = {
    fejlec: [
        'szamlaszam',
        'keltDatum',
        'teljesitesDatum',
        'fizetesiHataridoDatum',
        'fizmod',
        'penznem',
        'szamlaNyelve',
        'megjegyzes',
        'arfolyamBank',
        'arfolyam',
        'rendelesSzam',
        'dijbekeroSzamlaszam',
        'elolegszamla',
        'vegszamla',
        'elolegSzamlaszam',
        'helyesbitoszamla',
        'helyesbitettSzamlaszam',
        'dijbekero',
        'szallitolevel',
        'logoExtra',
        'szamlaszamElotag',
        'fizetendoKorrekcio',
        'fizetve',
        'arresAfa',
        'eusAfa',
        'tipus',
        'szamlaSablon',
        'simpleItems',
        'elonezetpdf'
    ],
    elado: [
        'bank',
        'bankszamlaszam',
        'emailReplyto',
        'emailTargy',
        'emailSzoveg',
        'alairoNeve'
    ],
    vevo: [
        'nev',
        'orszag',
        'irsz',
        'telepules',
        'cim',
        'email',
        'sendEmail',
        'adoalany',
        'adoszam',
        'csoportazonosito',
        'adoszamEU',
        'postazasiNev',
        'postazasiOrszag',
        'postazasiIrsz',
        'postazasiTelepules',
        'postazasiCim',
        'vevoFokonyv',
        'azonosito',
        'alairoNeve',
        'telefonszam',
        'megjegyzes'
    ],
    tetel: [
        'megnevezes',
        'azonosito',
        'mennyiseg',
        'mennyisegiEgyseg',
        'nettoEgysegar',
        'afakulcs',
        'arresAfaAlap',
        'nettoErtek',
        'afaErtek',
        'bruttoErtek',
        'megjegyzes',
        'tetelFokonyv',
        'torloKod'
    ],
    kifizetes: [
        'datum',
        'jogcim',
        'osszeg',
        'leiras'
    ]
};
function szamlazzSettings(key, body) {
    const requested = typeof body.beallitasok === 'object' && body.beallitasok !== null ? body.beallitasok : {};
    // A modell csak az e-számla jelzőt és a külső azonosítót adhatja meg; a hitelesítést
    // és a válaszformát (XML, PDF nélkül) az adapter rögzíti.
    return {
        szamlaagentkulcs: key,
        eszamla: requested.eszamla ?? true,
        szamlaLetoltes: false,
        valaszVerzio: 2,
        szamlaKulsoAzon: requested.szamlaKulsoAzon
    };
}
const SZAMLAZZ_ACTIONS = {
    'GET /invoice': {
        field: 'action-szamla_agent_xml',
        root: 'xmlszamlaxml',
        build: (key, { query })=>{
            if (!query?.szamlaszam && !query?.rendelesSzam && !query?.szamlaKulsoAzon) {
                throw new ProtocolRequestError('szamlaszam, rendelesSzam vagy szamlaKulsoAzon query parameter is required');
            }
            return {
                szamlaagentkulcs: key,
                szamlaszam: query.szamlaszam,
                rendelesSzam: query.rendelesSzam,
                pdf: false,
                szamlaKulsoAzon: query.szamlaKulsoAzon
            };
        }
    },
    'GET /taxpayer': {
        field: 'action-szamla_agent_taxpayer',
        root: 'xmltaxpayer',
        build: (key, { query })=>({
                beallitasok: {
                    szamlaagentkulcs: key
                },
                torzsszam: requiredParam(query, 'torzsszam').replace(/\D/g, '').slice(0, 8)
            })
    },
    'POST /invoice': {
        field: 'action-xmlagentxmlfile',
        root: 'xmlszamla',
        build: (key, { body })=>{
            const b = asRecord(body, 'body');
            const items = Array.isArray(b.tetelek) ? b.tetelek : b.tetelek?.tetel;
            return {
                beallitasok: szamlazzSettings(key, b),
                fejlec: asRecord(b.fejlec, 'fejlec'),
                elado: b.elado ?? {},
                vevo: asRecord(b.vevo, 'vevo'),
                tetelek: {
                    tetel: items
                }
            };
        }
    },
    'POST /invoice/reverse': {
        field: 'action-szamla_agent_st',
        root: 'xmlszamlast',
        build: (key, { body })=>{
            const b = asRecord(body, 'body');
            return {
                beallitasok: szamlazzSettings(key, b),
                fejlec: {
                    ...asRecord(b.fejlec, 'fejlec'),
                    tipus: 'SS'
                },
                elado: b.elado,
                vevo: b.vevo
            };
        }
    },
    'POST /invoice/payment': {
        field: 'action-szamla_agent_kifiz',
        root: 'xmlszamlakifiz',
        build: (key, { body })=>{
            const b = asRecord(body, 'body');
            return {
                beallitasok: {
                    szamlaagentkulcs: key,
                    szamlaszam: b.szamlaszam,
                    additiv: b.additiv ?? true
                },
                kifizetes: b.kifizetes
            };
        }
    }
};
function buildSzamlazzRequest(baseUrl, call, key) {
    const action = SZAMLAZZ_ACTIONS[operationKey(call)];
    if (!action) throw new ProtocolRequestError(`unsupported Számlázz.hu operation: ${operationKey(call)}`);
    const children = Object.entries(action.build(key, call)).map(([name, value])=>xmlElement(name, value, SZAMLAZZ_ORDER)).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>` + `<${action.root} xmlns="http://www.szamlazz.hu/${action.root}">${children}</${action.root}>`;
    const form = new FormData();
    form.append(action.field, new Blob([
        xml
    ], {
        type: 'text/xml'
    }), 'request.xml');
    return {
        url: `${baseUrl}/`,
        init: {
            method: 'POST',
            body: form
        },
        xml
    };
}
function safeDecode(value) {
    if (!value) return undefined;
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch  {
        return value;
    }
}
async function parseSzamlazzResponse(res) {
    const text = await res.text();
    const errorCode = res.headers.get('szlahu_error_code') ?? xmlText(text, 'hibakod');
    const message = safeDecode(res.headers.get('szlahu_error')) ?? xmlText(text, 'hibauzenet');
    const failed = !res.ok || Boolean(errorCode) || /<sikeres>\s*false/.test(text) || text.startsWith('[ERR]');
    return {
        ok: !failed,
        body: text.replace(/<pdf>[\s\S]*?<\/pdf>/, '<pdf>[kihagyva]</pdf>'),
        ...errorCode ? {
            errorCode
        } : {},
        ...failed ? {
            hint: `Számlázz.hu hiba${errorCode ? ` (${errorCode})` : ''}: ${message ?? text.slice(0, 300)}`
        } : {}
    };
}
function parseNavCredentials(secret) {
    let parsed;
    try {
        parsed = JSON.parse(secret);
    } catch  {
        parsed = null;
    }
    const creds = parsed;
    if (!creds?.login?.trim() || !creds.password || !creds.signKey?.trim()) {
        throw new ProtocolRequestError('A NAV konnektor titka hiányos: aktiváld újra a technikai felhasználó nevével, jelszavával és XML aláírókulcsával.', 'nav_credentials_invalid');
    }
    return {
        login: creds.login.trim(),
        password: creds.password,
        signKey: creds.signKey.trim()
    };
}
function direction(query) {
    const value = String(query?.direction ?? 'OUTBOUND').toUpperCase();
    if (value !== 'OUTBOUND' && value !== 'INBOUND') {
        throw new ProtocolRequestError('direction must be OUTBOUND (kimenő) or INBOUND (bejövő)');
    }
    return value;
}
const NAV_OPERATIONS = {
    'GET /taxpayer': {
        op: 'queryTaxpayer',
        build: (q)=>({
                taxNumber: requiredParam(q, 'taxNumber').replace(/\D/g, '').slice(0, 8)
            })
    },
    'GET /invoices': {
        op: 'queryInvoiceDigest',
        build: (q)=>({
                page: q?.page ?? 1,
                invoiceDirection: direction(q),
                invoiceQueryParams: {
                    mandatoryQueryParams: {
                        invoiceIssueDate: {
                            dateFrom: requiredParam(q, 'dateFrom'),
                            dateTo: requiredParam(q, 'dateTo')
                        }
                    },
                    additionalQueryParams: q?.partnerTaxNumber || q?.partnerName ? {
                        taxNumber: q.partnerTaxNumber,
                        name: q.partnerName
                    } : undefined
                }
            })
    },
    'GET /invoice': {
        op: 'queryInvoiceData',
        build: (q)=>({
                invoiceNumberQuery: navInvoiceNumberQuery(q)
            })
    },
    'GET /invoice/check': {
        op: 'queryInvoiceCheck',
        build: (q)=>({
                invoiceNumberQuery: navInvoiceNumberQuery(q)
            })
    },
    'GET /invoice/chain': {
        op: 'queryInvoiceChainDigest',
        build: (q)=>({
                page: q?.page ?? 1,
                invoiceChainQuery: {
                    invoiceNumber: requiredParam(q, 'invoiceNumber'),
                    invoiceDirection: direction(q),
                    taxNumber: q?.taxNumber
                }
            })
    }
};
function navInvoiceNumberQuery(q) {
    return {
        invoiceNumber: requiredParam(q, 'invoiceNumber'),
        invoiceDirection: direction(q),
        batchIndex: q?.batchIndex,
        supplierTaxNumber: q?.supplierTaxNumber
    };
}
const sha = (algorithm, input)=>(0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$crypto__$5b$external$5d$__$28$node$3a$crypto$2c$__cjs$29$__["createHash"])(algorithm).update(input, 'utf8').digest('hex').toUpperCase();
async function defaultLoadNavSoftware() {
    const { loadNavSoftware } = await __turbopack_context__.A("[project]/src/lib/nav-online-invoice-software.ts [app-rsc] (ecmascript, async loader)");
    return loadNavSoftware();
}
async function buildNavRequest(baseUrl, call, secret, opts) {
    const operation = NAV_OPERATIONS[operationKey(call)];
    if (!operation) throw new ProtocolRequestError(`unsupported NAV operation: ${operationKey(call)}`);
    const taxNumber = opts.navTaxNumber?.trim();
    if (!taxNumber) throw new ProtocolRequestError('NAV connector has no taxpayer tax number (nav.taxNumber)');
    const creds = parseNavCredentials(secret);
    const software = await (opts.loadNavSoftware ?? defaultLoadNavSoftware)();
    if (!software) {
        throw new ProtocolRequestError('A NAV Online Számla szoftver-azonosító nincs beállítva: Platform · Beállítások → NAV Online Számla.', 'nav_software_missing');
    }
    const body = Object.entries(operation.build(call.query)).map(([name, value])=>xmlElement(name, value)).join('');
    // NAV 3.0 §1.5.2: lekérdezésnél requestSignature = SHA3-512(requestId + UTC yyyyMMddHHmmss + aláírókulcs).
    const requestId = `EXC${(0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$crypto__$5b$external$5d$__$28$node$3a$crypto$2c$__cjs$29$__["randomBytes"])(12).toString('hex')}`.slice(0, 30);
    const timestamp = (opts.now ?? new Date()).toISOString();
    const signatureTime = timestamp.slice(0, 19).replace(/[-:T]/g, '');
    const root = `${operation.op[0].toUpperCase()}${operation.op.slice(1)}Request`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>` + `<${root} xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">` + `<common:header><common:requestId>${requestId}</common:requestId><common:timestamp>${timestamp}</common:timestamp>` + `<common:requestVersion>3.0</common:requestVersion><common:headerVersion>1.0</common:headerVersion></common:header>` + `<common:user><common:login>${escapeXml(creds.login)}</common:login>` + `<common:passwordHash cryptoType="SHA-512">${sha('sha512', creds.password)}</common:passwordHash>` + `<common:taxNumber>${escapeXml(taxNumber)}</common:taxNumber>` + `<common:requestSignature cryptoType="SHA3-512">${sha('sha3-512', requestId + signatureTime + creds.signKey)}</common:requestSignature></common:user>` + xmlElement('software', {
        softwareId: software.softwareId,
        softwareName: software.softwareName,
        softwareOperation: 'ONLINE_SERVICE',
        softwareMainVersion: software.softwareMainVersion,
        softwareDevName: software.softwareDevName,
        softwareDevContact: software.softwareDevContact,
        softwareDevCountryCode: software.softwareDevCountryCode,
        softwareDevTaxNumber: software.softwareDevTaxNumber
    }) + `${body}</${root}>`;
    return {
        url: `${baseUrl}/${operation.op}`,
        init: {
            method: 'POST',
            headers: {
                'content-type': 'application/xml',
                accept: 'application/xml'
            },
            body: xml
        },
        xml
    };
}
async function parseNavResponse(res) {
    const text = await res.text();
    const funcCode = xmlText(text, 'funcCode');
    const errorCode = xmlText(text, 'errorCode');
    const ok = res.ok && funcCode !== 'ERROR';
    if (!ok) {
        return {
            ok,
            body: text,
            ...errorCode ? {
                errorCode
            } : {},
            hint: `NAV hiba${errorCode ? ` (${errorCode})` : ''}: ${xmlText(text, 'message') ?? `HTTP ${res.status}`}`
        };
    }
    const invoiceData = xmlText(text, 'invoiceData');
    if (!invoiceData) return {
        ok,
        body: text
    };
    const raw = Buffer.from(invoiceData, 'base64');
    const compressed = xmlText(text, 'compressedContentIndicator') === 'true';
    return {
        ok,
        body: {
            response: text.replace(invoiceData, '[dekódolva: invoiceXml]'),
            invoiceXml: (compressed ? (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$zlib__$5b$external$5d$__$28$node$3a$zlib$2c$__cjs$29$__["gunzipSync"])(raw) : raw).toString('utf8')
        }
    };
}
async function buildProtocolRequest(protocol, baseUrl, call, secret, opts = {}) {
    return protocol === 'szamlazz_agent' ? buildSzamlazzRequest(baseUrl, call, secret.trim()) : buildNavRequest(baseUrl, call, secret, opts);
}
function parseProtocolResponse(protocol, res) {
    return protocol === 'szamlazz_agent' ? parseSzamlazzResponse(res) : parseNavResponse(res);
}
function protocolProbe(protocol, navTaxNumber) {
    return protocol === 'szamlazz_agent' ? {
        call: {
            method: 'GET',
            path: '/invoice',
            query: {
                szamlaszam: 'EXC-PROBE-0'
            }
        },
        acceptErrorCodes: [
            '7'
        ]
    } : {
        call: {
            method: 'GET',
            path: '/taxpayer',
            query: {
                taxNumber: navTaxNumber ?? ''
            }
        },
        acceptErrorCodes: []
    };
}
}),
"[project]/src/domain/connector/http-api-client.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "HttpApiClient",
    ()=>HttpApiClient,
    "HttpApiError",
    ()=>HttpApiError,
    "explainHttpApiEndpointMiss",
    ()=>explainHttpApiEndpointMiss,
    "findHttpApiEndpoint",
    ()=>findHttpApiEndpoint,
    "findOverlappingHttpApiEndpoints",
    ()=>findOverlappingHttpApiEndpoints,
    "headerNameSet",
    ()=>headerNameSet,
    "httpApiPathMatches",
    ()=>httpApiPathMatches,
    "isRecord",
    ()=>isRecord,
    "parseHttpApiConfig",
    ()=>parseHttpApiConfig,
    "resolveConnectorApiKey",
    ()=>resolveConnectorApiKey,
    "resolveHttpApiEndpointRisk",
    ()=>resolveHttpApiEndpointRisk,
    "riskFromHttpMethod",
    ()=>riskFromHttpMethod,
    "summarizeHttpApiEndpoints",
    ()=>summarizeHttpApiEndpoints
]);
/**
 * Generikus HTTP/REST API connector — vékony adapter a Tool Broker mögött.
 *
 * Egy `http_api` típusú connector egy külső REST API-t ír le (baseUrl + auth +
 * endpoint-katalógus). A Broker oldja fel az API-kulcsot a connector
 * `secretAlias`-ából (env vagy Secret Manager), és injektálja a hitelesítő
 * fejlécbe — a kulcs SOHA nem kerül a promptba, az argumentumokba vagy a logba.
 *
 * A modell egy generikus `http_api_get` (olvasás) / `http_api_request` (írás)
 * eszközzel hív; az endpoint-katalógus (config.endpoints + config.description)
 * a tool loopban kerül a modell elé.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$crypto__$5b$external$5d$__$28$node$3a$crypto$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:crypto [external] (node:crypto, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$dns$2f$promises__$5b$external$5d$__$28$node$3a$dns$2f$promises$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:dns/promises [external] (node:dns/promises, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$net$2f$cloud$2d$run$2d$auth$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/net/cloud-run-auth.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$net$2f$egress$2d$guard$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/net/egress-guard.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$provisioning$2f$connector$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/provisioning/connector-config.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector/github-repository-access.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$decode$2d$github$2d$contents$2d$body$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector/decode-github-contents-body.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$http$2d$api$2d$prompt$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector/http-api-prompt.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$xml$2d$protocols$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector/xml-protocols.ts [app-rsc] (ecmascript)");
;
;
;
;
;
;
;
;
;
function summarizeHttpApiEndpoints(endpoints) {
    return (endpoints ?? []).map((endpoint)=>({
            method: endpoint.method,
            path: endpoint.path,
            ...endpoint.access ? {
                access: endpoint.access
            } : {},
            ...endpoint.description ? {
                description: endpoint.description
            } : {},
            ...endpoint.queryParams?.length ? {
                queryParams: endpoint.queryParams
            } : {},
            ...endpoint.pathParams?.length ? {
                pathParams: endpoint.pathParams
            } : {}
        }));
}
const HTTP_API_RISKS = new Set([
    'read',
    'write',
    'danger'
]);
function parseHttpApiRisk(raw) {
    return typeof raw === 'string' && HTTP_API_RISKS.has(raw) ? raw : undefined;
}
function resolveHttpApiEndpointRisk(endpoint, method, connectorDefaultRisk) {
    if (endpoint.risk) return endpoint.risk;
    if (endpoint.access === 'read') return 'read';
    if (endpoint.access === 'write') {
        // access=write mellett a DELETE továbbra is danger (visszafordíthatatlan).
        return method.toUpperCase() === 'DELETE' ? 'danger' : 'write';
    }
    if (connectorDefaultRisk) return connectorDefaultRisk;
    return riskFromHttpMethod(method);
}
function riskFromHttpMethod(method) {
    const m = method.toUpperCase();
    if (m === 'GET' || m === 'HEAD') return 'read';
    if (m === 'DELETE') return 'danger';
    return 'write';
}
const READ_METHODS = new Set([
    'GET',
    'HEAD'
]);
const WRITE_METHODS = new Set([
    'POST',
    'PUT',
    'PATCH',
    'DELETE'
]);
const DEFAULT_MAX_RESPONSE_CHARS = 20_000;
/** Runtime által injektált idempotencia-fejléc (kisbetűs egyeztetéshez). */ const IDEMPOTENCY_HEADER_LOWER = 'idempotency-key';
/**
 * Hány azonos-host átirányítás követhető egy connector-híváson belül (deny-by-default a
 * más hostra mutató redirectekre). Ugyanaz a szigor, mint a `web_fetch` útján — a redirect
 * nem viheti ki a hívást a connector konfigurált hostjáról (SSRF-védelem).
 */ const MAX_SAME_HOST_REDIRECTS = 3;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Az átalakított body mérete karakterben; körkörös/serializálhatatlan alaknál a nyers hossz. */ function safeJsonLength(value, fallback) {
    try {
        return JSON.stringify(value)?.length ?? fallback;
    } catch  {
        return fallback;
    }
}
function parseHttpApiConfig(raw, opts) {
    if (!isRecord(raw)) throw new Error('http_api connector config must be an object');
    const baseUrl = raw.baseUrl;
    if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
        throw new Error('http_api config.baseUrl must be an absolute http(s) URL');
    }
    const authRaw = raw.auth;
    if (!isRecord(authRaw)) throw new Error('http_api config.auth is required');
    let auth;
    if (authRaw.scheme === 'bearer') {
        auth = {
            scheme: 'bearer'
        };
    } else if (authRaw.scheme === 'header') {
        if (typeof authRaw.header !== 'string' || !authRaw.header.trim()) {
            throw new Error('http_api config.auth.header is required for scheme "header"');
        }
        auth = {
            scheme: 'header',
            header: authRaw.header.trim()
        };
    } else if (authRaw.scheme === 'basic' || authRaw.type === 'basic') {
        const username = typeof authRaw.username === 'string' ? authRaw.username.trim() : '';
        auth = username ? {
            scheme: 'basic',
            username
        } : {
            scheme: 'basic'
        };
    } else if (authRaw.scheme === 'oauth2' || authRaw.type === 'oauth2') {
        const tokenUrl = typeof authRaw.tokenUrl === 'string' ? authRaw.tokenUrl.trim() : '';
        if (!/^https?:\/\//i.test(tokenUrl)) {
            throw new Error('http_api config.auth.tokenUrl must be an absolute http(s) URL for scheme "oauth2"');
        }
        const clientId = typeof authRaw.clientId === 'string' ? authRaw.clientId.trim() : '';
        if (!clientId && !opts?.allowMissingOAuthClientId) {
            throw new Error('http_api config.auth.clientId is required for scheme "oauth2"');
        }
        const scope = typeof authRaw.scope === 'string' && authRaw.scope.trim() ? authRaw.scope.trim() : undefined;
        const authUrl = parseOptionalAbsoluteUrl(authRaw.authUrl, 'auth.authUrl');
        const userInfoUrl = parseOptionalAbsoluteUrl(authRaw.userInfoUrl, 'auth.userInfoUrl');
        const accountEmailField = typeof authRaw.accountEmailField === 'string' && authRaw.accountEmailField.trim() ? authRaw.accountEmailField.trim() : undefined;
        const offlineParams = parseStringRecord(authRaw.offlineParams, 'auth.offlineParams');
        const scopeTransform = authRaw.scopeTransform === 'gmailAlias' || authRaw.scopeTransform === 'none' ? authRaw.scopeTransform : undefined;
        auth = {
            scheme: 'oauth2',
            tokenUrl,
            clientId,
            ...scope ? {
                scope
            } : {},
            ...authUrl ? {
                authUrl
            } : {},
            ...userInfoUrl ? {
                userInfoUrl
            } : {},
            ...accountEmailField ? {
                accountEmailField
            } : {},
            ...offlineParams ? {
                offlineParams
            } : {},
            ...scopeTransform ? {
                scopeTransform
            } : {}
        };
    } else if (authRaw.type === 'bearer_token') {
        auth = {
            scheme: 'bearer'
        };
    } else if (authRaw.type === 'api_key_header') {
        const header = typeof authRaw.headerName === 'string' ? authRaw.headerName.trim() : '';
        if (!header) {
            throw new Error('http_api config.auth.headerName is required for type "api_key_header"');
        }
        auth = {
            scheme: 'header',
            header
        };
    } else if (authRaw.type === 'none' || authRaw.scheme === 'none') {
        auth = {
            scheme: 'none'
        };
    } else {
        throw new Error('http_api config.auth.scheme must be "header", "bearer", "basic", "none" or "oauth2"');
    }
    const requestHeaders = parseHeaderTemplates(raw.requestHeaders, 'requestHeaders');
    const writeHeaders = parseHeaderTemplates(raw.writeHeaders, 'writeHeaders');
    const endpointSource = Array.isArray(raw.endpoints) ? raw.endpoints : Array.isArray(raw.proposedTools) ? raw.proposedTools : undefined;
    const endpoints = Array.isArray(endpointSource) ? endpointSource.filter(isRecord).map((e)=>{
        const access = e.access === 'read' || e.access === 'write' ? e.access : undefined;
        const risk = parseHttpApiRisk(e.risk);
        const method = String(e.method ?? '').toUpperCase();
        const headers = parseHeaderTemplates(e.headers, 'endpoint.headers');
        const platformHeaders = headerNameSet(requestHeaders, !READ_METHODS.has(method) ? writeHeaders : undefined, headers);
        if (e.idempotent === true && !READ_METHODS.has(method)) {
            platformHeaders.add(IDEMPOTENCY_HEADER_LOWER);
        }
        const headerParams = parseEndpointHeaderParams(e, platformHeaders);
        const optionalPlatformHeaders = parseOptionalPlatformHeaders(e, platformHeaders);
        const queryParams = parseEndpointLocationParams(e, 'query');
        const pathParams = parseEndpointLocationParams(e, 'path');
        const paginationResult = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$provisioning$2f$connector$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["httpPaginationSchema"].safeParse(e.pagination);
        return {
            method,
            path: String(e.path ?? ''),
            description: typeof e.description === 'string' ? e.description : undefined,
            profile: typeof e.profile === 'string' && e.profile.trim() ? e.profile.trim() : undefined,
            idempotent: e.idempotent === true,
            ...risk ? {
                risk
            } : {},
            ...access ? {
                access
            } : {},
            headers,
            ...headerParams ? {
                headerParams
            } : {},
            ...optionalPlatformHeaders ? {
                optionalPlatformHeaders
            } : {},
            ...queryParams ? {
                queryParams
            } : {},
            ...pathParams ? {
                pathParams
            } : {},
            ...paginationResult.success ? {
                pagination: paginationResult.data
            } : {}
        };
    }).filter((e)=>e.method && e.path) : undefined;
    const authProfiles = parseAuthProfiles(raw.authProfiles);
    const githubRepositoryAccess = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseGitHubRepositoryAccessConfig"])(raw.githubRepositoryAccess);
    const defaultRisk = parseHttpApiRisk(raw.defaultRisk);
    const protocol = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$provisioning$2f$connector$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HTTP_API_PROTOCOLS"].find((p)=>p === raw.protocol);
    const navTaxNumber = isRecord(raw.nav) && typeof raw.nav.taxNumber === 'string' ? raw.nav.taxNumber.trim() : '';
    return {
        ...protocol ? {
            protocol
        } : {},
        ...navTaxNumber ? {
            nav: {
                taxNumber: navTaxNumber
            }
        } : {},
        baseUrl: baseUrl.replace(/\/+$/, ''),
        auth,
        ...authProfiles ? {
            authProfiles
        } : {},
        ...defaultRisk ? {
            defaultRisk
        } : {},
        defaultAuthProfile: typeof raw.defaultAuthProfile === 'string' && raw.defaultAuthProfile.trim() ? raw.defaultAuthProfile.trim() : undefined,
        requestHeaders,
        writeHeaders,
        defaultActingUserEmail: typeof raw.defaultActingUserEmail === 'string' && raw.defaultActingUserEmail.trim() ? raw.defaultActingUserEmail.trim() : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        endpoints,
        restrictToEndpoints: raw.restrictToEndpoints === true,
        ...githubRepositoryAccess ? {
            githubRepositoryAccess
        } : {},
        maxResponseChars: typeof raw.maxResponseChars === 'number' && raw.maxResponseChars > 0 ? raw.maxResponseChars : DEFAULT_MAX_RESPONSE_CHARS,
        selfUpdatingPinned: raw.selfUpdatingPinned === true
    };
}
function headerNameSet(...sources) {
    const names = new Set();
    for (const source of sources){
        if (!source) continue;
        if (source instanceof Set) {
            for (const name of source)names.add(name.toLowerCase());
            continue;
        }
        for (const name of Object.keys(source))names.add(name.toLowerCase());
    }
    return names;
}
/**
 * Query / path paramok OpenAPI `parameters` vagy kézi `queryParams`/`pathParams` mezőből.
 * A modell-katalógus és a 4xx hint ezekre épül — header-eket nem ide gyűjtjük.
 */ function parseEndpointLocationParams(endpoint, location) {
    const explicitKey = location === 'query' ? 'queryParams' : 'pathParams';
    const fromExplicit = Array.isArray(endpoint[explicitKey]) ? endpoint[explicitKey].filter((param)=>isRecord(param) && typeof param.name === 'string').map((param)=>toEndpointParam(param, location === 'path')) : [];
    const fromParameters = Array.isArray(endpoint.parameters) ? endpoint.parameters.filter((param)=>isRecord(param) && param.in === location && typeof param.name === 'string').map((param)=>toEndpointParam(param, location === 'path')) : [];
    const byName = new Map();
    for (const param of [
        ...fromParameters,
        ...fromExplicit
    ]){
        byName.set(param.name.toLowerCase(), param);
    }
    return byName.size > 0 ? [
        ...byName.values()
    ] : undefined;
}
function toEndpointParam(param, pathDefaultRequired) {
    const type = typeof param.type === 'string' && param.type.trim() ? param.type.trim() : isRecord(param.schema) && typeof param.schema.type === 'string' ? String(param.schema.type) : undefined;
    const description = typeof param.description === 'string' && param.description.trim() ? param.description.trim() : undefined;
    return {
        name: String(param.name),
        required: pathDefaultRequired || param.required === true,
        ...type ? {
            type
        } : {},
        ...description ? {
            description
        } : {}
    };
}
function parseEndpointHeaderParams(endpoint, platformHeaders) {
    const fromParameters = Array.isArray(endpoint.parameters) ? endpoint.parameters.filter((param)=>isRecord(param) && param.in === 'header' && typeof param.name === 'string').map((param)=>({
            name: String(param.name),
            required: param.required === true
        })) : [];
    const fromHeaderParams = Array.isArray(endpoint.headerParams) ? endpoint.headerParams.filter((param)=>isRecord(param) && typeof param.name === 'string').map((param)=>({
            name: String(param.name),
            required: param.required === true
        })) : [];
    const byName = new Map();
    for (const param of [
        ...fromParameters,
        ...fromHeaderParams
    ]){
        const lower = param.name.toLowerCase();
        if (platformHeaders.has(lower)) continue;
        byName.set(lower, param);
    }
    return byName.size > 0 ? [
        ...byName.values()
    ] : undefined;
}
/**
 * A platform-sablon fejlécek (X-Agent-Id, X-Acting-User, stb.) közül melyeket
 * jelöl EZ az endpoint `required: false`-nak a saját OpenAPI-jában. `parseEndpointHeaderParams`
 * pont ezeket zárja ki (azok a modellnek szóló, nem-platform fejlécek) — itt a
 * fordítottja kell: csak a platform-fejlécek, hogy tudjuk melyiket lehet kihagyni,
 * ha a sablon-értéke (pl. actingUser.email) nem áll rendelkezésre.
 */ function parseOptionalPlatformHeaders(endpoint, platformHeaders) {
    const params = Array.isArray(endpoint.parameters) ? endpoint.parameters.filter((param)=>isRecord(param) && param.in === 'header' && typeof param.name === 'string') : [];
    const optional = new Set();
    for (const param of params){
        const lower = String(param.name).toLowerCase();
        if (platformHeaders.has(lower) && param.required !== true) optional.add(lower);
    }
    return optional.size > 0 ? optional : undefined;
}
function parseOptionalAbsoluteUrl(raw, field) {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) {
        throw new Error(`http_api config.${field} must be an absolute http(s) URL`);
    }
    return raw.trim();
}
function parseStringRecord(raw, field) {
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) throw new Error(`http_api config.${field} must be an object`);
    const out = {};
    for (const [key, value] of Object.entries(raw)){
        if (!key.trim()) throw new Error(`http_api config.${field} has empty key`);
        if (typeof value !== 'string') {
            throw new Error(`http_api config.${field}.${key} must be a string`);
        }
        out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function parseAuthProfiles(raw) {
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) throw new Error('http_api config.authProfiles must be an object');
    const profiles = {};
    for (const [name, value] of Object.entries(raw)){
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            throw new Error(`http_api auth profile has invalid name: ${name}`);
        }
        if (!isRecord(value)) throw new Error(`http_api auth profile must be an object: ${name}`);
        if (typeof value.secretAlias !== 'string' || !value.secretAlias.trim()) {
            throw new Error(`http_api auth profile has no secretAlias: ${name}`);
        }
        let auth;
        if (value.auth !== undefined) {
            if (!isRecord(value.auth)) throw new Error(`http_api auth profile auth must be an object: ${name}`);
            if (value.auth.scheme === 'bearer') auth = {
                scheme: 'bearer'
            };
            else if (value.auth.scheme === 'header') {
                if (typeof value.auth.header !== 'string' || !value.auth.header.trim()) {
                    throw new Error(`http_api auth profile header is required: ${name}`);
                }
                auth = {
                    scheme: 'header',
                    header: value.auth.header.trim()
                };
            } else {
                throw new Error(`http_api auth profile scheme must be "header" or "bearer": ${name}`);
            }
        }
        profiles[name] = {
            secretAlias: value.secretAlias.trim(),
            ...auth ? {
                auth
            } : {}
        };
    }
    return Object.keys(profiles).length > 0 ? profiles : undefined;
}
function parseHeaderTemplates(raw, field) {
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) throw new Error(`http_api config.${field} must be an object`);
    const headers = {};
    for (const [name, template] of Object.entries(raw)){
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
            throw new Error(`http_api config.${field} has invalid header name: ${name}`);
        }
        if (name.toLowerCase() === 'authorization') {
            throw new Error(`http_api config.${field} must not override Authorization`);
        }
        if (typeof template !== 'string') {
            throw new Error(`http_api config.${field}.${name} must be a string`);
        }
        headers[name] = template;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}
async function resolveConnectorApiKey(secretAlias) {
    if (process.env.HTTP_API_STUB === 'true') return 'stub-api-key';
    if (!secretAlias?.trim()) throw new Error('http_api connector has no secretAlias');
    const alias = secretAlias.trim();
    if (alias.startsWith('secret-ref:')) {
        const { loadConnectorApiKeyByRef } = await __turbopack_context__.A("[project]/src/domain/connector/connector-secret-store.ts [app-rsc] (ecmascript, async loader)");
        return loadConnectorApiKeyByRef(alias);
    }
    const envMatch = alias.match(/^env:(.+)$/);
    if (envMatch) {
        const value = process.env[envMatch[1].trim()];
        if (!value) throw new Error(`http_api API key env var not set: ${envMatch[1].trim()}`);
        return value;
    }
    const smMatch = alias.match(/^secret-manager:(.+)$/);
    if (smMatch) {
        const resource = smMatch[1].trim();
        const token = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$net$2f$cloud$2d$run$2d$auth$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["getCloudRunAccessToken"])(process.env.SECRET_MANAGER_ACCESS_TOKEN);
        const res = await fetch(`https://secretmanager.googleapis.com/v1/${resource}/versions/latest:access`, {
            headers: {
                authorization: `Bearer ${token}`
            }
        });
        if (!res.ok) {
            throw new Error(`Secret Manager access failed: ${res.status}`);
        }
        const data = await res.json();
        if (!data.payload?.data) throw new Error('Secret Manager version payload empty');
        return Buffer.from(data.payload.data, 'base64').toString('utf8').trim();
    }
    throw new Error('http_api secretAlias must be "env:NAME" or "secret-manager:projects/.../secrets/<id>"');
}
class HttpApiError extends Error {
    code;
    allowedEndpoints;
    reason;
    constructor(message, code, /** `endpoint_not_allowed`-nál a valódi engedélyezett katalógus (reaktív felfedezés). */ allowedEndpoints, /** `endpoint_not_allowed`-nál: miért nem illeszkedett (modellnek, titok nélkül). */ reason){
        super(message), this.code = code, this.allowedEndpoints = allowedEndpoints, this.reason = reason;
        this.name = 'HttpApiError';
    }
}
function sleep(ms) {
    return new Promise((resolve)=>setTimeout(resolve, ms));
}
class HttpApiClient {
    config;
    defaultApiKey;
    resolveProfileApiKey;
    constructor(config, credentials){
        this.config = config;
        if (typeof credentials === 'string') {
            this.defaultApiKey = credentials;
        } else {
            this.defaultApiKey = credentials.defaultApiKey;
            this.resolveProfileApiKey = credentials.resolveProfileApiKey;
        }
    }
    isStub() {
        return process.env.HTTP_API_STUB === 'true' || Boolean(this.defaultApiKey?.startsWith('stub-'));
    }
    selectEndpoint(method, path, continuationOf) {
        if (/:\/\//.test(path)) {
            // SSRF-védelem: a path nem írhatja felül a connector hostját.
            throw new HttpApiError('path must be relative to the connector baseUrl', 'invalid_path');
        }
        this.assertGitHubRepositoryAllowed(path);
        const endpoint = findHttpApiEndpoint(this.config, method, path);
        const continuationEndpoint = continuationOf ? findHttpApiEndpoint(this.config, method, continuationOf) : undefined;
        if (this.config.restrictToEndpoints) {
            if (!endpoint) {
                if (method === 'GET' && continuationEndpoint?.pagination?.kind === 'next_link' && continuationEndpoint.pagination.continuationPathTemplate && httpApiPathMatches(continuationEndpoint.pagination.continuationPathTemplate, path)) {
                    return continuationEndpoint;
                }
                const reason = explainHttpApiEndpointMiss(this.config, method, path);
                throw new HttpApiError(`endpoint not allowed: ${method} ${path} — ${reason}`, 'endpoint_not_allowed', summarizeHttpApiEndpoints(this.config.endpoints), reason);
            }
        }
        return endpoint;
    }
    assertGitHubRepositoryAllowed(path) {
        const access = this.config.githubRepositoryAccess;
        if (!access || access.mode === 'any') return;
        let normalized;
        try {
            normalized = this.buildUrl(path).pathname;
        } catch  {
            throw new HttpApiError('GitHub repository path is invalid', 'invalid_path');
        }
        const match = normalized.match(/^\/?repos\/([^/]+)\/([^/]+)(?:\/|$)/i);
        if (!match) {
            throw new HttpApiError(`GitHub path requires a selected owner/repo scope: ${path}`, 'github_repository_scope_required');
        }
        let repository;
        try {
            repository = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase();
        } catch  {
            throw new HttpApiError('GitHub repository path is invalid', 'invalid_path');
        }
        if (!__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["GITHUB_REPOSITORY_PATTERN"].test(repository)) {
            throw new HttpApiError('GitHub repository path is invalid', 'invalid_path');
        }
        if (!access.repositories.includes(repository)) {
            throw new HttpApiError(`GitHub repository not allowed: ${repository}`, 'github_repository_not_allowed');
        }
    }
    buildUrl(path, query) {
        const rel = path.startsWith('/') ? path : `/${path}`;
        const url = new URL(`${this.config.baseUrl}${rel}`);
        if (query) {
            for (const [k, v] of Object.entries(query)){
                url.searchParams.set(k, String(v));
            }
        }
        return url;
    }
    async authHeaders(endpoint) {
        const profileName = endpoint?.profile ?? this.config.defaultAuthProfile;
        if (profileName) {
            const profile = this.config.authProfiles?.[profileName];
            if (!profile) throw new HttpApiError(`auth profile not found: ${profileName}`, 'auth_profile_not_found');
            const key = this.resolveProfileApiKey ? await this.resolveProfileApiKey(profileName, profile.secretAlias) : await resolveConnectorApiKey(profile.secretAlias);
            return buildAuthHeaders(profile.auth ?? this.config.auth, key);
        }
        if (this.config.auth.scheme === 'none') return {};
        if (!this.defaultApiKey) {
            throw new HttpApiError('http_api connector has no default API key', 'missing_api_key');
        }
        return buildAuthHeaders(this.config.auth, this.defaultApiKey);
    }
    platformInjectedHeaderNames(method, endpoint) {
        const names = headerNameSet(this.config.requestHeaders, !READ_METHODS.has(method) ? this.config.writeHeaders : undefined, endpoint?.headers);
        if (endpoint?.idempotent && !READ_METHODS.has(method)) {
            names.add(IDEMPOTENCY_HEADER_LOWER);
        }
        return names;
    }
    buildTemplateHeaders(method, endpoint, context) {
        const headers = {};
        const optional = endpoint?.optionalPlatformHeaders;
        applyHeaderTemplates(headers, this.config.requestHeaders, context, optional);
        if (!READ_METHODS.has(method)) applyHeaderTemplates(headers, this.config.writeHeaders, context, optional);
        applyHeaderTemplates(headers, endpoint?.headers, context, optional);
        if (endpoint?.idempotent && !READ_METHODS.has(method) && !hasHeader(headers, IDEMPOTENCY_HEADER_LOWER)) {
            if (!context) throw new HttpApiError('idempotent endpoint requires call context', 'missing_context');
            headers['Idempotency-Key'] = context.call.idempotencyKey;
        }
        return headers;
    }
    buildParameterHeaders(endpoint, provided, platformInjected) {
        const declared = new Map((endpoint?.headerParams ?? []).map((param)=>[
                param.name.toLowerCase(),
                param
            ]));
        const values = new Map();
        const authHeader = this.config.auth.scheme === 'header' ? this.config.auth.header.toLowerCase() : 'authorization';
        for (const [name, value] of Object.entries(provided ?? {})){
            const normalized = name.toLowerCase();
            if (platformInjected.has(normalized)) {
                throw new HttpApiError(`platform-injected header cannot be supplied by the caller: ${name} — omit it from headers; the platform injects it`, 'platform_injected_header');
            }
            const param = declared.get(normalized);
            if (!param) throw new HttpApiError(`header not allowed by active snapshot: ${name}`, 'header_not_allowed');
            if (normalized === authHeader || [
                'authorization',
                'host',
                'content-length',
                'content-type'
            ].includes(normalized)) {
                throw new HttpApiError(`protected header cannot be supplied by the caller: ${name}`, 'header_not_allowed');
            }
            values.set(normalized, value);
        }
        for (const param of declared.values()){
            const normalized = param.name.toLowerCase();
            // A hitelesítési fejlécet mindig a platform injektálja a Secret Store-ból.
            if (normalized === authHeader || normalized === 'authorization') continue;
            // Sablonból fedett fejlécek: a runtime küldi, a hívónak nem kell megadnia.
            if (platformInjected.has(normalized)) continue;
            if (param.required && !values.has(normalized)) {
                throw new HttpApiError(`required header missing: ${param.name}`, 'required_header_missing');
            }
        }
        return Object.fromEntries([
            ...values
        ].map(([name, value])=>[
                declared.get(name).name,
                value
            ]));
    }
    async request(params) {
        const method = params.method.toUpperCase();
        if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) {
            throw new HttpApiError(`unsupported HTTP method: ${method}`, 'invalid_method');
        }
        const endpoint = this.selectEndpoint(method, params.path, params.continuationOf);
        const platformInjected = this.platformInjectedHeaderNames(method, endpoint);
        const parameterHeaders = this.buildParameterHeaders(endpoint, params.headers, platformInjected);
        if (this.isStub()) {
            return {
                status: 200,
                ok: true,
                body: {
                    stub: true,
                    method,
                    path: params.path,
                    query: params.query ?? null
                }
            };
        }
        if (this.config.protocol) return this.requestViaProtocol(this.config.protocol, method, params);
        const url = this.buildUrl(params.path, params.query);
        const hasBody = params.body !== undefined && !READ_METHODS.has(method);
        // Sorrend: caller paraméterek → platform sablon → auth. A sablon/auth soha
        // nem írható felül a modell által beadott headers-szel.
        const init = {
            method,
            headers: {
                accept: 'application/json',
                ...parameterHeaders,
                ...this.buildTemplateHeaders(method, endpoint, params.context),
                ...await this.authHeaders(endpoint),
                ...hasBody ? {
                    'content-type': 'application/json'
                } : {}
            },
            ...hasBody ? {
                body: JSON.stringify(params.body)
            } : {}
        };
        const res = await this.fetchWithBackoff(url, init);
        const text = await res.text();
        const max = this.config.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
        const overLimit = text.length > max;
        const previewText = overLimit ? `${text.slice(0, max)}…[truncated]` : text;
        let body = previewText;
        let truncated = false;
        let oversizedSoftHint;
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            // Sikeres / parse-olható JSON: a teljes body megmarad (get_all + archive + extract).
            // A maxResponseChars soft jelzés: ne dumpold a modell kontextusába.
            try {
                const parsed = JSON.parse(text);
                body = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$decode$2d$github$2d$contents$2d$body$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["decodeGitHubContentsBody"])(parsed);
                // A méret-kaput a TÉNYLEGESEN visszaadott alakra mérjük. A GitHub base64
                // fájltartalma ~33%-kal nagyobb a dekódolt szövegnél, a könyvtárlistából
                // pedig URL-mezőket hagytunk el — a nyers hosszal mérve egy hiánytalanul
                // átadott forrásfájl is „túl nagynak”, a szerződés felé `partial`-nak
                // látszana, és a modell csonkoltnak hinné, amit egészben megkapott.
                const effectiveChars = body === parsed ? text.length : safeJsonLength(body, text.length);
                if (effectiveChars > max) {
                    truncated = true;
                    oversizedSoftHint = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$http$2d$api$2d$prompt$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["buildHttpApiOversizedResponseHint"])({
                        originalChars: effectiveChars,
                        maxChars: max
                    });
                }
            } catch  {
                if (overLimit) {
                    truncated = true;
                    body = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$http$2d$api$2d$prompt$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["buildHttpApiTruncationBody"])({
                        originalChars: text.length,
                        maxChars: max,
                        preview: text.slice(0, max)
                    });
                } else {
                    body = previewText;
                }
            }
        } else if (overLimit) {
            truncated = true;
        }
        const errorHint = !res.ok ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$http$2d$api$2d$prompt$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["buildHttpApiClientErrorHint"])({
            status: res.status,
            endpoint: endpoint ?? null,
            usedQueryKeys: params.query ? Object.keys(params.query) : []
        }) : undefined;
        const truncationHint = truncated && typeof body === 'object' && body && 'hint' in body ? String(body.hint) : oversizedSoftHint ? oversizedSoftHint : truncated ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$http$2d$api$2d$prompt$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["buildHttpApiTruncationBody"])({
            originalChars: text.length,
            maxChars: max,
            preview: text.slice(0, Math.min(max, text.length))
        }).hint : undefined;
        return {
            status: res.status,
            ok: res.ok,
            body,
            ...res.headers.get('link') ? {
                linkHeader: res.headers.get('link')
            } : {},
            ...truncated ? {
                truncated: true
            } : {},
            ...errorHint || truncationHint ? {
                hint: [
                    errorHint,
                    truncationHint
                ].filter(Boolean).join(' ')
            } : {}
        };
    }
    async requestViaProtocol(protocol, method, params) {
        if (!this.defaultApiKey) {
            throw new HttpApiError('http_api connector has no default API key', 'missing_api_key');
        }
        let request;
        try {
            request = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$xml$2d$protocols$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["buildProtocolRequest"])(protocol, this.config.baseUrl, {
                method,
                path: params.path,
                query: params.query,
                body: params.body
            }, this.defaultApiKey, {
                navTaxNumber: this.config.nav?.taxNumber
            });
        } catch (e) {
            const code = e.code;
            throw new HttpApiError(e instanceof Error ? e.message : String(e), typeof code === 'string' ? code : 'invalid_args');
        }
        // Író hívás (pl. számla-kiállítás) 5xx után sem ismételhető: kettős bizonylatot okozhatna.
        const res = await this.fetchWithBackoff(new URL(request.url), request.init, READ_METHODS.has(method));
        const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$xml$2d$protocols$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseProtocolResponse"])(protocol, res);
        return {
            status: res.status,
            ok: result.ok,
            body: result.body,
            ...result.errorCode ? {
                errorCode: result.errorCode
            } : {},
            ...result.hint ? {
                hint: result.hint
            } : {}
        };
    }
    async fetchWithBackoff(input, init, retry = true) {
        const connectorUrl = new URL(this.config.baseUrl);
        const connectorHost = connectorUrl.hostname.toLowerCase();
        // A redirect-pinning ORIGIN-szinten köt (séma + host + port), nem csak hostname-en: egy
        // azonos-hostnevű, de más PORTRA mutató (pl. `:2375` belső admin/docker) vagy `https→http`
        // downgrade átirányítás különben átcsúszna a puszta hostname-egyezésen.
        const connectorOrigin = connectorUrl.origin;
        if (this.config.selfUpdatingPinned) {
            const guard = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$net$2f$egress$2d$guard$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["guardEgressUrl"])({
                url: input.toString(),
                allowlistHosts: [
                    connectorHost
                ],
                resolveHostIps: async (host)=>(await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$dns$2f$promises__$5b$external$5d$__$28$node$3a$dns$2f$promises$2c$__cjs$29$__["lookup"])(host, {
                        all: true
                    })).map((entry)=>entry.address)
            });
            if (!guard.ok || guard.host !== connectorHost) {
                throw new HttpApiError(`runtime egress blocked: ${guard.ok ? 'host_mismatch' : guard.reason}`, 'egress_blocked');
            }
        }
        // Host-pinning a redirecteken is: a `fetch` alapból KÖVETI a 3xx-eket, ezért egy
        // allowlistolt host egyetlen átirányítással kivihetné a hívást egy belső szolgáltatásra
        // vagy a felhő-metadata hostra (169.254.169.254) — ez SSRF, és a path/query az agent
        // kezében van (nyílt-redirect végponton is kiváltható). Ezért MINDEN connectornál
        // `redirect: 'manual'`, és a redirecteket kézzel, a connector SAJÁT hostjára pinnelve
        // követjük; idegen hostra mutató átirányítás → blokk.
        const guardedInit = {
            ...init,
            redirect: 'manual'
        };
        const delays = retry ? [
            250,
            750
        ] : [];
        for(let attempt = 0; attempt <= delays.length; attempt += 1){
            const res = await this.fetchFollowingSameOriginRedirects(input, guardedInit, connectorOrigin);
            // 429 / 5xx → korlátozott backoff; minden mást (a 4xx-eket is) felfelé adunk
            // strukturált válaszként, hogy a modell reagálhasson rá.
            if (![
                429,
                500,
                502,
                503,
                504
            ].includes(res.status) || attempt === delays.length) {
                return res;
            }
            await sleep(delays[attempt]);
        }
        throw new HttpApiError('request failed before response', 'network_error');
    }
    /**
   * A redirecteket kézzel, a connector KONFIGURÁLT ORIGIN-jére (séma + host + port) pinnelve
   * követi (deny-by-default a más originre mutató átirányításokra). Pin-elt (önfrissítő)
   * connectornál MINDEN 3xx tilos — ez a korábbi, szigorúbb viselkedés. Nem-pin-elt connectornál
   * az azonos-origin redirect legfeljebb `MAX_SAME_HOST_REDIRECTS`-szer követhető; a Location
   * nélküli 3xx-et és minden nem-3xx választ változatlanul visszaadja. Így a host-pinning
   * invariáns a redirect-láncon is áll, és az SSRF-út (allowlistolt host → 3xx → belső/metadata,
   * vagy azonos hostnév más porton / `https→http` downgrade) zárva marad.
   */ async fetchFollowingSameOriginRedirects(input, init, connectorOrigin) {
        let currentUrl = input;
        for(let hop = 0;; hop += 1){
            const res = await fetch(currentUrl, init);
            if (res.status < 300 || res.status >= 400) return res;
            if (this.config.selfUpdatingPinned) {
                throw new HttpApiError('runtime redirect blocked for pinned connector', 'egress_blocked');
            }
            const location = res.headers.get('location');
            // Location nélküli 3xx: nincs mit követni — adjuk vissza strukturáltan a modellnek.
            if (!location) return res;
            if (hop >= MAX_SAME_HOST_REDIRECTS) {
                throw new HttpApiError('runtime redirect blocked: too many redirects', 'egress_blocked');
            }
            let target;
            try {
                target = new URL(location, currentUrl);
            } catch  {
                throw new HttpApiError('runtime redirect blocked: invalid redirect target', 'egress_blocked');
            }
            // A redirect csak a connector SAJÁT originjén maradhat (séma+host+port); bármi más (belső
            // szolgáltatás, felhő-metadata, azonos hostnév más porton, https→http downgrade, idegen
            // exfil-host) SSRF → blokk. A connector-kliens szándékosan nem ismeri a tágabb
            // egress-allowlistet, ezért a self-contained szabály a same-origin-only.
            if (target.origin !== connectorOrigin) {
                throw new HttpApiError('runtime redirect blocked: cross-origin redirect', 'egress_blocked');
            }
            currentUrl = target;
        }
    }
}
/**
 * Az oauth2 séma esetén a connector secretAlias-a mögött NEM egy nyers kulcs,
 * hanem egy JSON blob áll: `{"clientSecret":"...","refreshToken":"..."}`
 * (a client_id nem titok, az a configban van). Rossz alakzat → tiszta hiba,
 * SOSEM próbáljuk a nyers stringet access tokenként felhasználni.
 */ function parseOAuth2Credentials(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch  {
        parsed = undefined;
    }
    if (!isRecord(parsed) || typeof parsed.clientSecret !== 'string' || !parsed.clientSecret.trim() || typeof parsed.refreshToken !== 'string' || !parsed.refreshToken.trim()) {
        throw new HttpApiError('oauth2 secret must be a JSON string {"clientSecret","refreshToken"}', 'oauth2_credentials_invalid');
    }
    return {
        clientSecret: parsed.clientSecret.trim(),
        refreshToken: parsed.refreshToken.trim()
    };
}
/** Folyamaton belüli access-token cache — SOSEM perzisztált, SOSEM naplózott. */ const oauth2TokenCache = new Map();
const OAUTH2_EXPIRY_SKEW_MS = 60_000;
function oauth2CacheKey(auth, refreshToken) {
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$crypto__$5b$external$5d$__$28$node$3a$crypto$2c$__cjs$29$__["createHash"])('sha256').update(`${auth.tokenUrl}::${auth.clientId}::${refreshToken}`).digest('hex');
}
/**
 * OAuth2 refresh_token grant (RFC 6749 §6) — access token beszerzése/frissítése
 * a tárolt refresh_token-ből. Lejárat előtt a cache-elt tokent adja vissza;
 * a client_secret/refresh_token SOSEM kerül hibaüzenetbe vagy naplóba.
 */ async function resolveOAuth2AccessToken(auth, credentialsJson) {
    const { clientSecret, refreshToken } = parseOAuth2Credentials(credentialsJson);
    const cacheKey = oauth2CacheKey(auth, refreshToken);
    const cached = oauth2TokenCache.get(cacheKey);
    if (cached && cached.expiresAt - OAUTH2_EXPIRY_SKEW_MS > Date.now()) {
        return cached.accessToken;
    }
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: auth.clientId,
        client_secret: clientSecret,
        ...auth.scope ? {
            scope: auth.scope
        } : {}
    });
    const res = await fetch(auth.tokenUrl, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
    });
    if (!res.ok) {
        // Az OAuth-szerver error/error_description mezői NEM titkosak (RFC 6749 §5.2) —
        // ezek a diagnózishoz kellenek; a client_secret/refresh_token SOSEM kerül ide.
        let reason = `status ${res.status}`;
        try {
            const errBody = await res.json();
            if (errBody.error) reason = `${errBody.error}${errBody.error_description ? `: ${errBody.error_description}` : ''}`;
        } catch  {
        // nem JSON válasz — marad a status kód
        }
        throw new HttpApiError(`oauth2 token refresh failed (${reason})`, 'oauth2_refresh_failed');
    }
    const data = await res.json();
    if (!data.access_token) {
        throw new HttpApiError('oauth2 token endpoint returned no access_token', 'oauth2_refresh_failed');
    }
    const expiresInMs = (typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600) * 1000;
    oauth2TokenCache.set(cacheKey, {
        accessToken: data.access_token,
        expiresAt: Date.now() + expiresInMs
    });
    return data.access_token;
}
async function buildAuthHeaders(auth, apiKey) {
    if (auth.scheme === 'none') return {};
    if (auth.scheme === 'bearer') return {
        authorization: `Bearer ${apiKey}`
    };
    if (auth.scheme === 'basic') {
        const token = auth.username ? Buffer.from(`${auth.username}:${apiKey}`).toString('base64') : apiKey;
        return {
            authorization: `Basic ${token}`
        };
    }
    if (auth.scheme === 'oauth2') {
        const accessToken = await resolveOAuth2AccessToken(auth, apiKey);
        return {
            authorization: `Bearer ${accessToken}`
        };
    }
    return {
        [auth.header]: apiKey
    };
}
function hasHeader(headers, lowerName) {
    return Object.keys(headers).some((name)=>name.toLowerCase() === lowerName);
}
function applyHeaderTemplates(target, templates, context, optionalHeaders) {
    if (!templates) return;
    if (!context) throw new HttpApiError('header templates require call context', 'missing_context');
    for (const [name, template] of Object.entries(templates)){
        try {
            target[name] = renderTemplate(template, context);
        } catch (error) {
            // Az endpoint saját OpenAPI-ja szerint opcionális fejléc (pl. X-Acting-User
            // actingUser nélküli MCP-hívásnál) — kihagyjuk, nem buktatjuk a hívást.
            if (error instanceof HttpApiError && error.code === 'template_variable_missing' && optionalHeaders?.has(name.toLowerCase())) {
                continue;
            }
            throw error;
        }
    }
}
function renderTemplate(template, context) {
    return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key)=>{
        const value = templateValue(key, context);
        if (value === undefined || value === null) {
            throw new HttpApiError(`template variable not available: ${key}`, 'template_variable_missing');
        }
        return String(value);
    });
}
function templateValue(key, context) {
    const values = {
        'agent.id': context.agent.id,
        'agent.version': context.agent.version,
        'connector.id': context.connector.id,
        'connector.name': context.connector.name,
        'actingUser.id': context.actingUser?.id,
        'actingUser.email': context.actingUser?.email ?? context.defaultActingUserEmail,
        'actingUser.tenantId': context.actingUser?.tenantId,
        'tenant.id': context.tenant?.id,
        'call.id': context.call.id,
        'call.idempotencyKey': context.call.idempotencyKey,
        'now.iso': context.now.iso
    };
    return values[key];
}
function httpApiPathMatches(template, actual) {
    const t = template.split('/').filter(Boolean);
    const a = actual.split('/').filter(Boolean);
    if (t.length !== a.length) return false;
    return t.every((seg, i)=>segmentMatches(seg, a[i]));
}
function findHttpApiEndpoint(config, method, path) {
    const normalized = path.split('?')[0];
    const upperMethod = method.toUpperCase();
    // Több illeszkedő sablonnál a legspecifikusabb nyer (a `/act_{id}` a `/{id}` előtt),
    // különben a tágabb sablon kockázati/lapozási beállítása érvényesülne.
    let best;
    let bestScore = -1;
    for (const endpoint of config.endpoints ?? []){
        if (endpoint.method !== upperMethod || !httpApiPathMatches(endpoint.path, normalized)) continue;
        const score = templateLiteralLength(endpoint.path);
        if (score > bestScore) {
            best = endpoint;
            bestScore = score;
        }
    }
    return best;
}
function explainHttpApiEndpointMiss(config, method, path) {
    const normalized = path.split('?')[0];
    const otherMethods = [
        ...new Set((config.endpoints ?? []).filter((endpoint)=>httpApiPathMatches(endpoint.path, normalized)).map((endpoint)=>endpoint.method))
    ];
    if (otherMethods.length > 0) {
        return `path matches an allowed endpoint, but method ${method.toUpperCase()} is not allowed there (allowed: ${otherMethods.join(', ')})`;
    }
    return 'no allowed endpoint template matches this path — substitute {param} placeholders only, keep every literal segment and prefix (e.g. act_{id} → act_123)';
}
function findOverlappingHttpApiEndpoints(endpoints) {
    const pairs = [];
    for(let i = 0; i < endpoints.length; i++){
        for(let j = i + 1; j < endpoints.length; j++){
            const a = endpoints[i];
            const b = endpoints[j];
            if (a.method.toUpperCase() !== b.method.toUpperCase() || a.path === b.path) continue;
            if (templatesOverlap(a.path, b.path)) {
                pairs.push([
                    `${a.method.toUpperCase()} ${a.path}`,
                    `${b.method.toUpperCase()} ${b.path}`
                ]);
            }
        }
    }
    return pairs;
}
function templatesOverlap(left, right) {
    const l = left.split('/').filter(Boolean);
    const r = right.split('/').filter(Boolean);
    if (l.length !== r.length) return false;
    return l.every((seg, i)=>{
        const other = r[i];
        if (!hasPathParam(seg)) return segmentMatches(other, seg);
        if (!hasPathParam(other)) return segmentMatches(seg, other);
        // ponytail: két vegyes szegmens (pl. act_{a} vs cmp_{b}) átfedését nem bizonyítjuk,
        // átfedőnek vesszük — legfeljebb egy fölösleges figyelmeztetés.
        return true;
    });
}
const BRACE_PARAM = /\{[^{}/]+\}/g;
function isPathParamSegment(segment) {
    return segment.startsWith(':') || segment.startsWith('{') && segment.endsWith('}');
}
function hasPathParam(segment) {
    return segment.startsWith(':') || /\{[^{}/]+\}/.test(segment);
}
function segmentMatches(templateSegment, actual) {
    if (isPathParamSegment(templateSegment)) return actual.length > 0;
    if (!templateSegment.includes('{')) return templateSegment === actual;
    const pattern = templateSegment.split(BRACE_PARAM).map((literal)=>literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+');
    return new RegExp(`^${pattern}$`).test(actual);
}
function templateLiteralLength(template) {
    return template.split('/').filter(Boolean).reduce((sum, seg)=>sum + (seg.startsWith(':') ? 0 : seg.replace(BRACE_PARAM, '').length), 0);
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__040oe-b._.js.map