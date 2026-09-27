module.exports = [
"[externals]/node:fs/promises [external] (node:fs/promises, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:fs/promises", () => require("node:fs/promises"));

module.exports = mod;
}),
"[externals]/node:path [external] (node:path, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:path", () => require("node:path"));

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
"[project]/src/domain/connector/connector-secret-store.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ConnectorApiKeyMissingError",
    ()=>ConnectorApiKeyMissingError,
    "buildConnectorSecretRef",
    ()=>buildConnectorSecretRef,
    "deleteConnectorApiKey",
    ()=>deleteConnectorApiKey,
    "isConnectorSecretRef",
    ()=>isConnectorSecretRef,
    "loadConnectorApiKeyByRef",
    ()=>loadConnectorApiKeyByRef,
    "saveConnectorApiKey",
    ()=>saveConnectorApiKey
]);
/**
 * Service-módú connector API-kulcs tároló (http_api).
 *
 * A UI-ból bevitt API-kulcs SOHA nem kerül a DB-be: titkosítva/elkülönítve
 * tárolódik (Secret Manager prod, lokális fájl dev), a `connectors.secret_alias`
 * csak egy `secret-ref:<connectorId>` referenciát tart. A feloldást a Tool Broker
 * végzi szerveroldalon (lásd resolveConnectorApiKey).
 *
 * Ugyanaz a build-vs-adopt cserepont, mint a grant-token-vaultnál: a tároló a
 * `secretAlias` mögött van, később kiváltható.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:fs/promises [external] (node:fs/promises, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:path [external] (node:path, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$net$2f$cloud$2d$run$2d$auth$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/net/cloud-run-auth.ts [app-rsc] (ecmascript)");
;
;
;
const SECRET_REF_PREFIX = 'secret-ref:';
class ConnectorApiKeyMissingError extends Error {
    secretId;
    reason;
    constructor(secretId, reason){
        super(`Connector API key not configured (${secretId}, ${reason})`), this.secretId = secretId, this.reason = reason;
        this.name = 'ConnectorApiKeyMissingError';
    }
}
function buildConnectorSecretRef(connectorId) {
    return `${SECRET_REF_PREFIX}${connectorId}`;
}
function isConnectorSecretRef(alias) {
    return alias.startsWith(SECRET_REF_PREFIX);
}
function secretIdFromRef(ref) {
    return ref.slice(SECRET_REF_PREFIX.length).trim();
}
function smResource(secretId) {
    const prefix = process.env.CONNECTOR_SECRET_PREFIX.replace(/\/+$/, '');
    return `${prefix}/connector-key-${secretId}`;
}
function devFilePath(secretId) {
    const root = process.env.CONNECTOR_SECRET_DIR?.trim() || (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["join"])(process.cwd(), '.connector-secrets');
    const safe = secretId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["join"])(root, `${safe}.key`);
}
async function smAccessToken() {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$net$2f$cloud$2d$run$2d$auth$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["getCloudRunAccessToken"])(process.env.SECRET_MANAGER_ACCESS_TOKEN);
}
async function smCreateIfMissing(resource, token) {
    const match = resource.match(/^(.+\/secrets)\/([^/]+)$/);
    if (!match) throw new Error('CONNECTOR_SECRET_PREFIX must look like projects/<p>/secrets');
    const res = await fetch(`https://secretmanager.googleapis.com/v1/${match[1]}?secretId=${encodeURIComponent(match[2])}`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            replication: {
                automatic: {}
            }
        })
    });
    if (res.ok || res.status === 409) return;
    throw new Error(`Secret Manager create failed: ${res.status}`);
}
async function saveConnectorApiKey(connectorId, apiKey) {
    if (!apiKey.trim()) throw new Error('API key must not be empty');
    if (process.env.CONNECTOR_SECRET_PREFIX?.trim()) {
        const resource = smResource(connectorId);
        const token = await smAccessToken();
        const payload = Buffer.from(apiKey, 'utf8').toString('base64');
        const add = ()=>fetch(`https://secretmanager.googleapis.com/v1/${resource}:addVersion`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    payload: {
                        data: payload
                    }
                })
            });
        let res = await add();
        if (res.status === 404) {
            await smCreateIfMissing(resource, token);
            res = await add();
        }
        if (!res.ok) throw new Error(`Secret Manager addVersion failed: ${res.status}`);
        return;
    }
    const filePath = devFilePath(connectorId);
    await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["mkdir"])(filePath.slice(0, filePath.lastIndexOf('/')), {
        recursive: true
    });
    await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["writeFile"])(filePath, apiKey, {
        mode: 0o600
    });
}
async function loadConnectorApiKeyByRef(ref) {
    const secretId = secretIdFromRef(ref);
    if (process.env.CONNECTOR_SECRET_PREFIX?.trim()) {
        const token = await smAccessToken();
        const res = await fetch(`https://secretmanager.googleapis.com/v1/${smResource(secretId)}/versions/latest:access`, {
            headers: {
                authorization: `Bearer ${token}`
            }
        });
        // 404 = a titok (vagy a `latest` verzió) nincs beállítva → tipizált „hiányzó kulcs" hiba,
        // hogy a hívó felhasználóbarát üzenetet adhasson. Más státusz (401/403/5xx) valódi
        // hozzáférési/hálózati hiba marad.
        if (res.status === 404) throw new ConnectorApiKeyMissingError(secretId, 'not_found');
        if (!res.ok) throw new Error(`Secret Manager access failed: ${res.status}`);
        const data = await res.json();
        if (!data.payload?.data) throw new ConnectorApiKeyMissingError(secretId, 'empty');
        return Buffer.from(data.payload.data, 'base64').toString('utf8').trim();
    }
    try {
        const raw = await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["readFile"])(devFilePath(secretId), 'utf8');
        return raw.trim();
    } catch (e) {
        // Dev: a lokális kulcs-fájl nem létezik → ugyanaz a „hiányzó kulcs" eset, mint prod 404.
        if (e?.code === 'ENOENT') {
            throw new ConnectorApiKeyMissingError(secretId, 'not_found');
        }
        throw e;
    }
}
async function deleteConnectorApiKey(connectorId) {
    if (process.env.CONNECTOR_SECRET_PREFIX?.trim()) {
        // Secret Manager: a verziók destroy-olása opcionális; itt csak best-effort.
        const token = await smAccessToken().catch(()=>null);
        if (!token) return;
        await fetch(`https://secretmanager.googleapis.com/v1/${smResource(connectorId)}`, {
            method: 'DELETE',
            headers: {
                authorization: `Bearer ${token}`
            }
        }).catch(()=>null);
        return;
    }
    await (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs$2f$promises__$5b$external$5d$__$28$node$3a$fs$2f$promises$2c$__cjs$29$__["unlink"])(devFilePath(connectorId)).catch(()=>{});
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__0_8kjlr._.js.map