(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/lib/control-plane-embed-messages.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "CONTROL_PLANE_EMBED_SOURCE",
    ()=>CONTROL_PLANE_EMBED_SOURCE,
    "CP_EMBED_READY_MESSAGE",
    ()=>CP_EMBED_READY_MESSAGE,
    "isControlPlaneEmbedReadyMessage",
    ()=>isControlPlaneEmbedReadyMessage
]);
const CONTROL_PLANE_EMBED_SOURCE = 'enterprise-ai-control-plane';
const CP_EMBED_READY_MESSAGE = {
    source: CONTROL_PLANE_EMBED_SOURCE,
    type: 'ready'
};
function isControlPlaneEmbedReadyMessage(value) {
    if (!value || typeof value !== 'object') return false;
    const rec = value;
    return rec.source === CONTROL_PLANE_EMBED_SOURCE && rec.type === 'ready';
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/observability/logger.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * WP-6 (O2) — Strukturált naplózó.
 *
 * Zéró-függőségű, determinisztikus JSON-logger (pino-kompatibilis felület:
 * `logger.info(fields, msg)` / `logger.child(bindings)`), hogy a boot fail-closed
 * maradjon és ne bővítsük a supply-chain felületet. Ha később `pino`-ra váltunk,
 * a hívói felület változatlan marad.
 *
 * Kulcs-elv (az audit-lánccal egyezően): a logban SOHA nincs nyers prompt / PII /
 * titok — a mezők kulcs-név alapján redaktálódnak (`REDACT_KEYS`).
 */ __turbopack_context__.s([
    "Logger",
    ()=>Logger,
    "REDACT_KEYS",
    ()=>REDACT_KEYS,
    "logger",
    ()=>logger,
    "redact",
    ()=>redact,
    "requestLogger",
    ()=>requestLogger,
    "stdoutSink",
    ()=>stdoutSink
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = /*#__PURE__*/ __turbopack_context__.i("[project]/node_modules/next/dist/build/polyfills/process.js [app-client] (ecmascript)");
const LEVEL_WEIGHT = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};
const REDACT_KEYS = [
    'secret',
    'token',
    'apikey',
    'authorization',
    'password',
    'cookie',
    'prompt',
    'content',
    'messages'
];
const REDACTED = '[redacted]';
function shouldRedact(key) {
    const k = key.toLowerCase();
    return REDACT_KEYS.some((needle)=>k.includes(needle));
}
function redact(value, depth = 0, seen = new WeakSet()) {
    if (depth > 6) return '[depth-limit]';
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((v)=>redact(v, depth + 1, seen));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)){
        out[k] = shouldRedact(k) ? REDACTED : redact(v, depth + 1, seen);
    }
    return out;
}
function envLevel() {
    const raw = (__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"].env.LOG_LEVEL ?? '').toLowerCase();
    if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
    return 'info';
}
const stdoutSink = (record)=>{
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"].stdout.write(JSON.stringify(record) + '\n');
};
class Logger {
    bindings;
    sink;
    minLevel;
    constructor(bindings = {}, sink = stdoutSink, minLevel = envLevel()){
        this.bindings = bindings;
        this.sink = sink;
        this.minLevel = minLevel;
    }
    /** Korrelációs mezőkkel bővített gyerek-logger (requestId/tenantId/ticketId). */ child(bindings) {
        return new Logger({
            ...this.bindings,
            ...bindings
        }, this.sink, this.minLevel);
    }
    emit(level, fieldsOrMsg, maybeMsg) {
        if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
        let fields = {};
        let msg;
        if (typeof fieldsOrMsg === 'string') {
            msg = fieldsOrMsg;
        } else if (fieldsOrMsg) {
            fields = fieldsOrMsg;
            msg = maybeMsg;
        }
        const merged = {
            ...this.bindings,
            ...fields
        };
        const safe = redact(merged);
        const record = {
            level,
            time: new Date().toISOString(),
            ...safe,
            ...msg !== undefined ? {
                msg
            } : {}
        };
        this.sink(record);
    }
    debug(fields, msg) {
        this.emit('debug', fields, msg);
    }
    info(fields, msg) {
        this.emit('info', fields, msg);
    }
    warn(fields, msg) {
        this.emit('warn', fields, msg);
    }
    error(fields, msg) {
        this.emit('error', fields, msg);
    }
}
const logger = new Logger();
function requestLogger(ctx) {
    return logger.child(ctx);
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/observability/metrics.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * WP-6 (O2) — Metrikák.
 *
 * Zéró-függőségű, in-process metrika-regiszter Prometheus szöveges
 * exposition-formátummal (a `/api/metrics` route szolgálja ki). GCP-n a
 * Cloud Run log-based metrics VAGY egy Prometheus-scrape egyaránt fogyaszthatja.
 *
 * Kulcs-jelek (6.2): gateway hívásszám & latency, broker deny-arány,
 * budget-kimerülés, dispatch-lag, 5xx-arány.
 */ __turbopack_context__.s([
    "Counter",
    ()=>Counter,
    "Gauge",
    ()=>Gauge,
    "Histogram",
    ()=>Histogram,
    "Registry",
    ()=>Registry,
    "agentInternalToolCallsTotal",
    ()=>agentInternalToolCallsTotal,
    "agentTurnCostAlertsTotal",
    ()=>agentTurnCostAlertsTotal,
    "agentTurnRereadRatio",
    ()=>agentTurnRereadRatio,
    "capturedExceptionsTotal",
    ()=>capturedExceptionsTotal,
    "contractEvaluationsTotal",
    ()=>contractEvaluationsTotal,
    "contractRepairCostEur",
    ()=>contractRepairCostEur,
    "dispatchLagMs",
    ()=>dispatchLagMs,
    "dispatchTotal",
    ()=>dispatchTotal,
    "httpResponsesTotal",
    ()=>httpResponsesTotal,
    "memoryCandidatesTotal",
    ()=>memoryCandidatesTotal,
    "memoryChunksActive",
    ()=>memoryChunksActive,
    "memoryConflictsTotal",
    ()=>memoryConflictsTotal,
    "memoryInlineApprovalsTotal",
    ()=>memoryInlineApprovalsTotal,
    "memoryRetrievalLatencyMs",
    ()=>memoryRetrievalLatencyMs,
    "memoryRetrieveTokens",
    ()=>memoryRetrieveTokens,
    "memoryTicketedTotal",
    ()=>memoryTicketedTotal,
    "modelCallLatencyMs",
    ()=>modelCallLatencyMs,
    "modelCallsTotal",
    ()=>modelCallsTotal,
    "modelFallbackTotal",
    ()=>modelFallbackTotal,
    "modelPromptCacheTokensTotal",
    ()=>modelPromptCacheTokensTotal,
    "privacyTransformDurationMs",
    ()=>privacyTransformDurationMs,
    "registry",
    ()=>registry,
    "toolBrokerCallsTotal",
    ()=>toolBrokerCallsTotal,
    "toolBrokerOutcomesTotal",
    ()=>toolBrokerOutcomesTotal,
    "toolResultReadbackTotal",
    ()=>toolResultReadbackTotal
]);
const DEFAULT_BUCKETS = [
    5,
    25,
    50,
    100,
    250,
    500,
    1000,
    2500,
    5000,
    10000
];
function labelKey(labels) {
    const keys = Object.keys(labels).sort();
    return keys.map((k)=>`${k}=${labels[k]}`).join(',');
}
function renderLabels(labels) {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return '';
    const inner = keys.map((k)=>`${k}="${escapeLabelValue(labels[k])}"`).join(',');
    return `{${inner}}`;
}
function escapeLabelValue(v) {
    return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
class Counter {
    name;
    help;
    series;
    constructor(name, help){
        this.name = name;
        this.help = help;
        this.series = new Map();
    }
    inc(labels = {}, delta = 1) {
        const key = labelKey(labels);
        const existing = this.series.get(key);
        if (existing) existing.value += delta;
        else this.series.set(key, {
            labels,
            value: delta
        });
    }
    render() {
        const lines = [
            `# HELP ${this.name} ${this.help}`,
            `# TYPE ${this.name} counter`
        ];
        for (const { labels, value } of this.series.values()){
            lines.push(`${this.name}${renderLabels(labels)} ${value}`);
        }
        return lines.join('\n');
    }
    reset() {
        this.series.clear();
    }
}
class Histogram {
    name;
    help;
    buckets;
    series;
    constructor(name, help, buckets = DEFAULT_BUCKETS){
        this.name = name;
        this.help = help;
        this.buckets = buckets;
        this.series = new Map();
    }
    observe(value, labels = {}) {
        const key = labelKey(labels);
        let s = this.series.get(key);
        if (!s) {
            s = {
                labels,
                buckets: new Array(this.buckets.length).fill(0),
                sum: 0,
                count: 0
            };
            this.series.set(key, s);
        }
        s.sum += value;
        s.count += 1;
        for(let i = 0; i < this.buckets.length; i++){
            if (value <= this.buckets[i]) s.buckets[i] += 1;
        }
    }
    render() {
        const lines = [
            `# HELP ${this.name} ${this.help}`,
            `# TYPE ${this.name} histogram`
        ];
        for (const s of this.series.values()){
            // s.buckets[i] már az adott `le`-küszöb alatti kumulatív darabszám (observe-ban
            // minden illeszkedo bucket no) → itt NEM kell újra összegezni.
            for(let i = 0; i < this.buckets.length; i++){
                const le = {
                    ...s.labels,
                    le: String(this.buckets[i])
                };
                lines.push(`${this.name}_bucket${renderLabels(le)} ${s.buckets[i]}`);
            }
            lines.push(`${this.name}_bucket${renderLabels({
                ...s.labels,
                le: '+Inf'
            })} ${s.count}`);
            lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
            lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
        }
        return lines.join('\n');
    }
    reset() {
        this.series.clear();
    }
}
/** Utolsó ismert érték, cimkénként (pl. `memory_chunks_active{projectKey}`). */ class Gauge {
    name;
    help;
    series;
    constructor(name, help){
        this.name = name;
        this.help = help;
        this.series = new Map();
    }
    set(value, labels = {}) {
        this.series.set(labelKey(labels), {
            labels,
            value
        });
    }
    render() {
        const lines = [
            `# HELP ${this.name} ${this.help}`,
            `# TYPE ${this.name} gauge`
        ];
        for (const { labels, value } of this.series.values()){
            lines.push(`${this.name}${renderLabels(labels)} ${value}`);
        }
        return lines.join('\n');
    }
    reset() {
        this.series.clear();
    }
}
class Registry {
    counters = new Map();
    histograms = new Map();
    gauges = new Map();
    counter(name, help) {
        let c = this.counters.get(name);
        if (!c) {
            c = new Counter(name, help);
            this.counters.set(name, c);
        }
        return c;
    }
    histogram(name, help, buckets) {
        let h = this.histograms.get(name);
        if (!h) {
            h = new Histogram(name, help, buckets);
            this.histograms.set(name, h);
        }
        return h;
    }
    gauge(name, help) {
        let g = this.gauges.get(name);
        if (!g) {
            g = new Gauge(name, help);
            this.gauges.set(name, g);
        }
        return g;
    }
    /** Prometheus text exposition — a `/api/metrics` route ezt adja vissza. */ render() {
        const blocks = [];
        for (const c of this.counters.values())blocks.push(c.render());
        for (const h of this.histograms.values())blocks.push(h.render());
        for (const g of this.gauges.values())blocks.push(g.render());
        return blocks.join('\n\n') + '\n';
    }
    /** Csak teszthez — a globális állapot visszaállítása. */ resetAll() {
        for (const c of this.counters.values())c.reset();
        for (const h of this.histograms.values())h.reset();
        for (const g of this.gauges.values())g.reset();
    }
}
const registry = new Registry();
const modelCallsTotal = registry.counter('model_gateway_calls_total', 'Model gateway calls by provider and status');
const modelCallLatencyMs = registry.histogram('model_gateway_latency_ms', 'Model gateway call latency in milliseconds');
const modelFallbackTotal = registry.counter('model_gateway_fallback_total', 'Model gateway fallback switches by from/to provider and reason');
const modelPromptCacheTokensTotal = registry.counter('model_gateway_prompt_cache_tokens_total', 'Model gateway prompt-cache tokens by provider and kind (read/write)');
const toolBrokerCallsTotal = registry.counter('tool_broker_calls_total', 'Tool broker invocations by tool, status and policy decision');
const toolBrokerOutcomesTotal = registry.counter('tool_broker_outcomes_total', 'Tool broker invocation outcomes by tool (ok/empty/partial/failed)');
const toolResultReadbackTotal = registry.counter('tool_result_readback_total', 'Archived tool-result readbacks by phase (allowed/blocked)');
const agentTurnRereadRatio = registry.histogram('agent_turn_source_reread_ratio', 'Share of a turn tool calls that re-read an already ingested source (0..1)', [
    0.1,
    0.25,
    0.5,
    0.75,
    0.9,
    1
]);
const agentTurnCostAlertsTotal = registry.counter('agent_turn_cost_alerts_total', 'Agent turn cost alerts by reason');
const agentInternalToolCallsTotal = registry.counter('agent_internal_tool_calls_total', 'Loop-internal (non-broker) tool invocations by tool and status');
const dispatchTotal = registry.counter('dispatcher_events_total', 'Dispatcher outcomes by result');
const dispatchLagMs = registry.histogram('dispatcher_lag_ms', 'Time from ticket readiness to dispatch in milliseconds');
const httpResponsesTotal = registry.counter('http_responses_total', 'HTTP responses by status class');
const capturedExceptionsTotal = registry.counter('captured_exceptions_total', 'Exceptions captured by the error tracker, by source');
const memoryCandidatesTotal = registry.counter('memory_candidates_total', 'Memory candidates by status');
const memoryInlineApprovalsTotal = registry.counter('memory_inline_approvals_total', 'Memory candidates approved via the inline write-gate path');
const memoryTicketedTotal = registry.counter('memory_ticketed_total', 'Memory candidates routed to a training ticket');
const memoryRetrieveTokens = registry.histogram('memory_retrieve_tokens', 'Prompt tokens spent on the project memory context block per retrieval', [
    50,
    100,
    250,
    500,
    1000,
    2000,
    4000,
    8000
]);
const memoryRetrievalLatencyMs = registry.histogram('memory_retrieval_latency_ms', 'Memory retrieval latency in milliseconds');
const memoryChunksActive = registry.gauge('memory_chunks_active', 'Active memory chunk count by project');
const memoryConflictsTotal = registry.counter('memory_conflicts_total', 'Memory conflicts detected, by resolution');
const contractEvaluationsTotal = registry.counter('contract_evaluations_total', 'Structured output contract evaluations by outcome');
const contractRepairCostEur = registry.counter('contract_repair_cost_eur_total', 'Estimated EUR cost of contract repair model calls');
const privacyTransformDurationMs = registry.histogram('privacy_transform_duration_ms', 'Privacy gateway transform duration in milliseconds', [
    5,
    10,
    25,
    50,
    80,
    100,
    250,
    500,
    1000
]);
;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/observability/error-tracking.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "captureException",
    ()=>captureException,
    "setErrorSink",
    ()=>setErrorSink
]);
/**
 * WP-6 (O2) — Error-tracking absztrakció.
 *
 * Pluggable kivétel-nyelő: alapból strukturált `error`-logot ír + számlálót növel,
 * de bekötheto egy külső sink (pl. Sentry `@sentry/nextjs` vagy GCP Error Reporting)
 * a `setErrorSink`-kel — a hívói felület (`captureException`) változatlan marad.
 * A kontextusba a WP-6 korrelációs mezők (requestId/tenantId/ticketId) kerülnek.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/logger.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$metrics$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/metrics.ts [app-client] (ecmascript)");
;
;
let externalSink = null;
function setErrorSink(sink) {
    externalSink = sink;
}
function captureException(error, context = {}) {
    const err = error instanceof Error ? error : new Error(String(error));
    const source = context.source ?? 'unknown';
    __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$metrics$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["capturedExceptionsTotal"].inc({
        source
    });
    __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["logger"].error({
        ...context,
        source,
        err: {
            name: err.name,
            message: err.message,
            stack: err.stack
        }
    }, 'captured exception');
    if (externalSink) {
        try {
            externalSink(err, context);
        } catch (sinkError) {
            __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["logger"].error({
                source: 'error-sink',
                err: String(sinkError)
            }, 'external error sink failed');
        }
    }
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/observability/request-context.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * WP-6 (O2) — Kérés-korreláció.
 *
 * Minden HTTP-kérés kap egy `requestId`-t (a middleware állítja be a bejövo
 * `x-request-id` fejlécbol, vagy generál egyet). A downstream logok/hibák ezzel
 * korrelálhatók.
 */ __turbopack_context__.s([
    "REQUEST_ID_HEADER",
    ()=>REQUEST_ID_HEADER,
    "resolveRequestId",
    ()=>resolveRequestId
]);
const REQUEST_ID_HEADER = 'x-request-id';
function resolveRequestId(incoming) {
    if (incoming && incoming.length > 0 && incoming.length <= 200) {
        // Csak biztonságos karakterek — a fejléc-érték nem szennyezheti a logot.
        if (/^[A-Za-z0-9._-]+$/.test(incoming)) return incoming;
    }
    return globalThis.crypto.randomUUID();
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/observability/index.ts [app-client] (ecmascript) <locals>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([]);
/**
 * WP-6 (O2) — Observability barrel.
 * Strukturált log + metrika + error-tracking + kérés-korreláció egy helyen.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/logger.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$metrics$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/metrics.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$error$2d$tracking$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/error-tracking.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$request$2d$context$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/request-context.ts [app-client] (ecmascript)");
;
;
;
;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/error.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>Error
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
/**
 * WP-7 (O4) — App Router route-szintu hibahatár.
 *
 * A renderelés közben dobott hibát elkapja, strukturáltan jelenti a WP-6
 * error-trackingbe (a `digest` a szerver-oldali log-sorral korrelálható), és
 * kulturált, márka-illesztett UI-t ad `reset()`-tel újrapróbálkozáshoz.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-client/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2d$messages$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-embed-messages.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$index$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/src/lib/observability/index.ts [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$error$2d$tracking$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/error-tracking.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
function Error({ error, reset }) {
    _s();
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Error.useEffect": ()=>{
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$error$2d$tracking$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["captureException"])(error, {
                source: 'app-error-boundary',
                digest: error.digest ?? null
            });
            // Modal-iframe: a szülő overlay addig nem tűnik el, amíg cp-embed-ready nem jön —
            // hiba esetén is jelezzünk, hogy a felhasználó lássa a hibaüzenetet, ne csak „Betöltés…”.
            if (window.parent !== window) {
                window.parent.postMessage(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2d$messages$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["CP_EMBED_READY_MESSAGE"], window.location.origin);
            }
        }
    }["Error.useEffect"], [
        error
    ]);
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('Errors');
    const common = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('Common');
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "flex min-h-[60vh] items-center justify-center px-6",
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "w-full max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-sm",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                    className: "text-sm font-medium uppercase tracking-[0.2em] text-coral",
                    children: t('errorKicker')
                }, void 0, false, {
                    fileName: "[project]/src/app/error.tsx",
                    lineNumber: 36,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                    className: "mt-2 font-display text-2xl font-semibold text-ink",
                    children: t('errorTitle')
                }, void 0, false, {
                    fileName: "[project]/src/app/error.tsx",
                    lineNumber: 37,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                    className: "mt-3 text-sm text-ink-soft",
                    children: t('errorBody')
                }, void 0, false, {
                    fileName: "[project]/src/app/error.tsx",
                    lineNumber: 38,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                    className: "mt-4 font-mono text-xs text-ink-faint",
                    children: t('errorRef', {
                        digest: error.digest ?? '—'
                    })
                }, void 0, false, {
                    fileName: "[project]/src/app/error.tsx",
                    lineNumber: 39,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                    onClick: reset,
                    className: "mt-6 rounded-lg bg-coral px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-coral-deep",
                    children: common('retry')
                }, void 0, false, {
                    fileName: "[project]/src/app/error.tsx",
                    lineNumber: 42,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/app/error.tsx",
            lineNumber: 35,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/app/error.tsx",
        lineNumber: 34,
        columnNumber: 5
    }, this);
}
_s(Error, "MtrYCHoH4gkKIT6q02FxP8j02Wg=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"]
    ];
});
_c = Error;
var _c;
__turbopack_context__.k.register(_c, "Error");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=src_1lp3qkr._.js.map