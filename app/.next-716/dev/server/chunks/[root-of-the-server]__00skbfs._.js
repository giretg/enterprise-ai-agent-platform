module.exports = [
"[externals]/next/dist/build/adapter/setup-node-env.external.js [external] (next/dist/build/adapter/setup-node-env.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/build/adapter/setup-node-env.external.js", () => require("next/dist/build/adapter/setup-node-env.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/@opentelemetry/api [external] (next/dist/compiled/@opentelemetry/api, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/@opentelemetry/api", () => require("next/dist/compiled/@opentelemetry/api"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/lib/incremental-cache/tags-manifest.external.js [external] (next/dist/server/lib/incremental-cache/tags-manifest.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/lib/incremental-cache/tags-manifest.external.js", () => require("next/dist/server/lib/incremental-cache/tags-manifest.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/after-task-async-storage.external.js [external] (next/dist/server/app-render/after-task-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/after-task-async-storage.external.js", () => require("next/dist/server/app-render/after-task-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/node:async_hooks [external] (node:async_hooks, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:async_hooks", () => require("node:async_hooks"));

module.exports = mod;
}),
"[externals]/path [external] (path, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("path", () => require("path"));

module.exports = mod;
}),
"[externals]/next/dist/server/lib/incremental-cache/memory-cache.external.js [external] (next/dist/server/lib/incremental-cache/memory-cache.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/lib/incremental-cache/memory-cache.external.js", () => require("next/dist/server/lib/incremental-cache/memory-cache.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/lib/incremental-cache/shared-cache-controls.external.js [external] (next/dist/server/lib/incremental-cache/shared-cache-controls.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/lib/incremental-cache/shared-cache-controls.external.js", () => require("next/dist/server/lib/incremental-cache/shared-cache-controls.external.js"));

module.exports = mod;
}),
"[externals]/crypto [external] (crypto, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("crypto", () => require("crypto"));

module.exports = mod;
}),
"[externals]/node:crypto [external] (node:crypto, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:crypto", () => require("node:crypto"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/action-async-storage.external.js [external] (next/dist/server/app-render/action-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/action-async-storage.external.js", () => require("next/dist/server/app-render/action-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[project]/src/lib/clerk-config.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "isClerkEnabled",
    ()=>isClerkEnabled,
    "isClerkUiEnabled",
    ()=>isClerkUiEnabled,
    "isDevAuthAllowed",
    ()=>isDevAuthAllowed
]);
function isClerkUiEnabled() {
    return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}
function isClerkEnabled() {
    if (process.env.AUTH_DISABLED === 'true') return false;
    return Boolean(process.env.CLERK_SECRET_KEY) && isClerkUiEnabled();
}
function isDevAuthAllowed() {
    return ("TURBOPACK compile-time value", "development") !== 'production';
}
}),
"[project]/src/lib/iam-policy.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PREPROVISIONED_AUTH_PREFIX",
    ()=>PREPROVISIONED_AUTH_PREFIX,
    "ROLE_RANK",
    ()=>ROLE_RANK,
    "checkInvitationRedeemable",
    ()=>checkInvitationRedeemable,
    "checkLastAdminLock",
    ()=>checkLastAdminLock,
    "decideAuthz",
    ()=>decideAuthz,
    "hasMinimumRole",
    ()=>hasMinimumRole,
    "isActiveWithRole",
    ()=>isActiveWithRole,
    "isEmailDomainAllowed",
    ()=>isEmailDomainAllowed,
    "isPreProvisionedAuthId",
    ()=>isPreProvisionedAuthId,
    "isSelfModification",
    ()=>isSelfModification,
    "makePreProvisionedAuthId",
    ()=>makePreProvisionedAuthId,
    "meetsMinRole",
    ()=>meetsMinRole
]);
const ROLE_RANK = {
    viewer: 0,
    operator: 1,
    approver: 2,
    admin: 3
};
const PREPROVISIONED_AUTH_PREFIX = 'preprovisioned:';
function isPreProvisionedAuthId(externalAuthId) {
    return externalAuthId.startsWith(PREPROVISIONED_AUTH_PREFIX);
}
function makePreProvisionedAuthId() {
    return `${PREPROVISIONED_AUTH_PREFIX}${globalThis.crypto.randomUUID()}`;
}
function meetsMinRole(role, minRole) {
    if (!role) return false;
    return ROLE_RANK[role] >= ROLE_RANK[minRole];
}
function hasMinimumRole(role, required) {
    if (!role) return false;
    const requiredRoles = Array.isArray(required) ? required : [
        required
    ];
    return requiredRoles.some((r)=>ROLE_RANK[role] >= ROLE_RANK[r]);
}
function isActiveWithRole(user) {
    return user.status === 'active' && user.role !== null;
}
function checkLastAdminLock(otherActiveAdminCount, isTargetCurrentlyActiveAdmin) {
    if (isTargetCurrentlyActiveAdmin && otherActiveAdminCount === 0) {
        return {
            blocked: true,
            reason: 'LAST_ADMIN_LOCK'
        };
    }
    return {
        blocked: false
    };
}
function isSelfModification(actorId, targetUserId) {
    return actorId === targetUserId;
}
function checkInvitationRedeemable(invitation, params) {
    if (invitation.status === 'redeemed') return {
        ok: false,
        reason: 'ALREADY_REDEEMED'
    };
    if (invitation.status === 'revoked') return {
        ok: false,
        reason: 'REVOKED'
    };
    if (invitation.status === 'expired' || params.now > invitation.expiresAt) {
        return {
            ok: false,
            reason: 'EXPIRED'
        };
    }
    if (invitation.email.trim().toLowerCase() !== params.email.trim().toLowerCase()) {
        return {
            ok: false,
            reason: 'EMAIL_MISMATCH'
        };
    }
    return {
        ok: true
    };
}
function isEmailDomainAllowed(email, allowlistCsv) {
    const allowlist = (allowlistCsv ?? '').split(',').map((d)=>d.trim().toLowerCase()).filter(Boolean);
    if (allowlist.length === 0) return true;
    const domain = email.trim().toLowerCase().split('@')[1];
    if (!domain) return false;
    return allowlist.includes(domain);
}
function decideAuthz(user, minRole) {
    if (user.status !== 'active') return {
        allow: false,
        reason: 'INACTIVE'
    };
    if (!user.role) return {
        allow: false,
        reason: 'NO_ROLE'
    };
    if (minRole === null) return {
        allow: false,
        reason: 'UNKNOWN_PERMISSION'
    };
    if (!meetsMinRole(user.role, minRole)) return {
        allow: false,
        reason: 'INSUFFICIENT_ROLE'
    };
    return {
        allow: true
    };
}
}),
"[project]/src/lib/tenant-policy.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PLATFORM_ROLE_RANK",
    ()=>PLATFORM_ROLE_RANK,
    "TENANT_AUDIT_ACTIONS",
    ()=>TENANT_AUDIT_ACTIONS,
    "checkLastTenantAdminLock",
    ()=>checkLastTenantAdminLock,
    "decideSwitch",
    ()=>decideSwitch,
    "hasMinimumPlatformRole",
    ()=>hasMinimumPlatformRole,
    "isSuperadmin",
    ()=>isSuperadmin,
    "isTenantDomainAllowed",
    ()=>isTenantDomainAllowed,
    "isValidTenantSlug",
    ()=>isValidTenantSlug,
    "normalizeTenantSlug",
    ()=>normalizeTenantSlug,
    "resolveActiveTenant",
    ()=>resolveActiveTenant,
    "tenantStatusAllowsLogin",
    ()=>tenantStatusAllowsLogin,
    "tenantStatusAllowsOperations",
    ()=>tenantStatusAllowsOperations
]);
const PLATFORM_ROLE_RANK = {
    platform_auditor: 1,
    platform_operator: 2,
    superadmin: 3
};
function hasMinimumPlatformRole(roles, required) {
    if (!roles || roles.length === 0) return false;
    const requiredRoles = Array.isArray(required) ? required : [
        required
    ];
    const best = Math.max(...roles.map((r)=>PLATFORM_ROLE_RANK[r]));
    // superadmin (rang 3) mindent lefed; egyébként az adott minimum rangot kell elérni.
    return requiredRoles.some((r)=>best >= PLATFORM_ROLE_RANK[r]);
}
function isSuperadmin(roles) {
    return !!roles?.includes('superadmin');
}
function tenantStatusAllowsOperations(status) {
    return status === 'active';
}
function tenantStatusAllowsLogin(status) {
    return status === 'active' || status === 'suspended';
}
function resolveActiveTenant(params) {
    const active = params.memberships.filter((m)=>m.status === 'active');
    if (params.requestedTenantId) {
        const match = active.find((m)=>m.tenantId === params.requestedTenantId);
        if (match) {
            return {
                kind: 'tenant',
                tenantId: match.tenantId,
                role: match.role,
                fromMembership: true
            };
        }
    // Érvénytelen/nem-active választás ⇒ nem dobunk, hanem a default-útra esünk vissza.
    }
    // Több `isDefault` előfordulhat (régi addMember nem vette le a korábbi
    // defaultot). A membership-lista createdAt szerint nő — az UTOLSÓ default
    // a frissebb tagság, ne a legrégebbi Demo nyelje el a cookie nélküli belépést.
    const defaults = active.filter((m)=>m.isDefault);
    const byDefault = defaults.length > 0 ? defaults[defaults.length - 1] : undefined;
    const chosen = byDefault ?? active[0];
    if (chosen) {
        return {
            kind: 'tenant',
            tenantId: chosen.tenantId,
            role: chosen.role,
            fromMembership: true
        };
    }
    if (params.platformRoles.length > 0) {
        return {
            kind: 'platform'
        };
    }
    return {
        kind: 'none'
    };
}
function decideSwitch(params) {
    const membership = params.memberships.find((m)=>m.tenantId === params.targetTenantId);
    if (membership) {
        if (membership.status !== 'active') return {
            allow: false,
            reason: 'MEMBERSHIP_NOT_ACTIVE'
        };
        return {
            allow: true,
            mode: 'member'
        };
    }
    if (isSuperadmin(params.platformRoles)) {
        return {
            allow: true,
            mode: 'assume'
        };
    }
    return {
        allow: false,
        reason: 'NOT_A_MEMBER'
    };
}
const TENANT_AUDIT_ACTIONS = {
    assume: 'tenant.assume',
    switch: 'tenant.switch',
    exit: 'tenant.exit',
    create: 'tenant.create',
    suspend: 'tenant.suspend',
    offboard: 'tenant.offboard',
    archive: 'tenant.archive',
    reactivate: 'tenant.reactivate'
};
function checkLastTenantAdminLock(params) {
    if (params.targetIsActiveAdmin && params.otherActiveAdminCount === 0) {
        return {
            blocked: true
        };
    }
    return {
        blocked: false
    };
}
function isTenantDomainAllowed(email, domainAllowlist) {
    if (!domainAllowlist || domainAllowlist.length === 0) return true;
    const domain = email.trim().toLowerCase().split('@')[1];
    if (!domain) return false;
    return domainAllowlist.map((d)=>d.trim().toLowerCase()).includes(domain);
}
function normalizeTenantSlug(raw) {
    return raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}
function isValidTenantSlug(slug) {
    // Min. 2, max. 63 karakter; alfanumerikussal kezdődik/végződik, közötte kötőjel is.
    return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(slug);
}
}),
"[project]/src/lib/tenant-settings.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "settingsRecord",
    ()=>settingsRecord
]);
function settingsRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
}),
"[project]/src/lib/nav-visibility.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "NAV_KEYS_LOCKED_FOR_ADMIN",
    ()=>NAV_KEYS_LOCKED_FOR_ADMIN,
    "NAV_VISIBILITY_ROLES",
    ()=>NAV_VISIBILITY_ROLES,
    "NAV_VISIBILITY_ROLE_LABELS",
    ()=>NAV_VISIBILITY_ROLE_LABELS,
    "NAV_VISIBILITY_SETTING",
    ()=>NAV_VISIBILITY_SETTING,
    "emptyNavVisibilityPolicy",
    ()=>emptyNavVisibilityPolicy,
    "isNavKeyHiddenFor",
    ()=>isNavKeyHiddenFor,
    "isNavKeyLockedFor",
    ()=>isNavKeyLockedFor,
    "isNavVisibilityPolicyEmpty",
    ()=>isNavVisibilityPolicyEmpty,
    "readNavVisibilityPolicy",
    ()=>readNavVisibilityPolicy,
    "sanitizeNavVisibilityPolicy",
    ()=>sanitizeNavVisibilityPolicy,
    "withNavVisibilityPolicy",
    ()=>withNavVisibilityPolicy
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$settings$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/tenant-settings.ts [middleware] (ecmascript)");
;
const NAV_VISIBILITY_SETTING = 'navVisibility';
const NAV_VISIBILITY_ROLES = [
    'viewer',
    'operator',
    'approver',
    'admin'
];
const NAV_VISIBILITY_ROLE_LABELS = {
    viewer: 'Megfigyelő',
    operator: 'Operátor',
    approver: 'Jóváhagyó',
    admin: 'Adminisztrátor'
};
const NAV_KEYS_LOCKED_FOR_ADMIN = [
    'admin',
    'admin.menu-access'
];
function emptyNavVisibilityPolicy() {
    return {
        viewer: [],
        operator: [],
        approver: [],
        admin: []
    };
}
function toKeyList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    for (const item of value){
        if (typeof item !== 'string') continue;
        const key = item.trim();
        if (key) seen.add(key);
    }
    return [
        ...seen
    ].sort();
}
function sanitizeNavVisibilityPolicy(raw) {
    const record = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$settings$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["settingsRecord"])(raw);
    const policy = emptyNavVisibilityPolicy();
    for (const role of NAV_VISIBILITY_ROLES){
        const keys = toKeyList(record[role]);
        policy[role] = role === 'admin' ? keys.filter((key)=>!NAV_KEYS_LOCKED_FOR_ADMIN.includes(key)) : keys;
    }
    return policy;
}
function readNavVisibilityPolicy(settings) {
    return sanitizeNavVisibilityPolicy((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$settings$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["settingsRecord"])(settings)[NAV_VISIBILITY_SETTING]);
}
function withNavVisibilityPolicy(settings, policy) {
    return {
        ...(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$settings$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["settingsRecord"])(settings),
        [NAV_VISIBILITY_SETTING]: sanitizeNavVisibilityPolicy(policy)
    };
}
/**
 * Szerep nélküli hívó (pl. tisztán platform-szerepű superadmin) elől SOHA nem rejtünk:
 * a policy tenant-szerepkörökre szól, és a hiányzó szerep nem „nulladik szerepkör".
 */ const NAV_KEY_LEGACY_HIDDEN = {
    'admin.agent-access': [
        'admin.agent-access',
        'staff.access'
    ],
    // Fiókom / Fiókok / Adminisztráció.account → Kapcsolt fiókok (főmenü).
    account: [
        'account',
        'admin.account',
        'admin.connectors'
    ]
};
function isNavKeyHiddenFor(policy, role, key) {
    if (!role) return false;
    const keys = NAV_KEY_LEGACY_HIDDEN[key] ?? [
        key
    ];
    return keys.some((k)=>policy[role].includes(k));
}
function isNavVisibilityPolicyEmpty(policy) {
    return NAV_VISIBILITY_ROLES.every((role)=>policy[role].length === 0);
}
function isNavKeyLockedFor(role, key) {
    return role === 'admin' && NAV_KEYS_LOCKED_FOR_ADMIN.includes(key);
}
}),
"[project]/src/lib/control-plane-nav.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "CONTROL_PLANE_NAV_CATALOG",
    ()=>CONTROL_PLANE_NAV_CATALOG,
    "allNavKeys",
    ()=>allNavKeys,
    "buildControlPlaneNav",
    ()=>buildControlPlaneNav,
    "flattenNavHrefs",
    ()=>flattenNavHrefs
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/iam-policy.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$policy$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/tenant-policy.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/nav-visibility.ts [middleware] (ecmascript)");
;
;
;
const isCatalogGroup = (entry)=>'children' in entry;
const isGroup = (entry)=>'children' in entry;
const CONTROL_PLANE_NAV_CATALOG = [
    {
        key: 'get-started',
        href: '/control-plane/get-started',
        label: 'Első lépések',
        requires: {
            tenantRole: 'viewer'
        }
    },
    {
        key: 'agents',
        href: '/control-plane/agents',
        label: 'Munkatársak'
    },
    {
        key: 'projects',
        href: '/control-plane/projects',
        label: 'Projektek',
        requires: {
            tenantRole: 'viewer'
        }
    },
    {
        key: 'account',
        href: '/control-plane/account',
        label: 'Kapcsolt fiókok',
        requires: {
            tenantRole: 'viewer'
        }
    },
    // #618: everyone confirms their own pending writes here; the key predates the move
    // out of Adminisztráció and stays stable for stored nav-visibility policies.
    {
        key: 'admin.operations',
        href: '/control-plane/operations',
        label: 'Teendők',
        requires: {
            tenantRole: 'viewer'
        }
    },
    {
        key: 'staff',
        label: 'Katalógus',
        children: [
            {
                key: 'staff.skills',
                href: '/control-plane/skills',
                label: 'Képességek (skill-ek)'
            },
            {
                key: 'staff.knowledge',
                href: '/control-plane/knowledge',
                label: 'Tudásbázis'
            }
        ]
    },
    {
        key: 'admin',
        label: 'Adminisztráció',
        children: [
            {
                key: 'admin.audit',
                href: '/control-plane/audit',
                label: 'Audit',
                requires: {
                    tenantRole: 'approver'
                }
            },
            {
                key: 'admin.provisioning',
                href: '/control-plane/provisioning',
                label: 'Konnektorok',
                requires: {
                    tenantRole: 'admin'
                }
            },
            {
                key: 'admin.iam',
                href: '/control-plane/iam',
                label: 'IAM',
                requires: {
                    tenantRole: 'admin'
                }
            },
            {
                key: 'admin.settings',
                href: '/control-plane/settings',
                label: 'Beállítások',
                requires: {
                    tenantRole: 'admin'
                }
            },
            {
                key: 'admin.menu-access',
                href: '/control-plane/menu-access',
                label: 'Menü-hozzáférés',
                requires: {
                    tenantRole: 'admin'
                }
            },
            {
                key: 'admin.platform-tenants',
                href: '/control-plane/platform/tenants',
                label: 'Platform · Tenantok',
                requires: {
                    platformRole: 'platform_auditor'
                }
            },
            {
                key: 'admin.platform-iam',
                href: '/control-plane/platform/iam',
                label: 'Platform · IAM',
                requires: {
                    platformRole: 'platform_auditor'
                }
            },
            {
                key: 'admin.platform-settings',
                href: '/control-plane/platform/settings',
                label: 'Platform · Beállítások',
                requires: {
                    platformRole: 'platform_auditor'
                }
            }
        ]
    }
];
function meetsRequirement(ctx, requires) {
    if (!requires) return true;
    if (requires.tenantRole && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["hasMinimumRole"])(ctx.tenantRole, requires.tenantRole)) return false;
    if (requires.platformRole && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$policy$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["hasMinimumPlatformRole"])(ctx.platformRoles, requires.platformRole)) {
        return false;
    }
    return true;
}
function toLeaf(entry) {
    const leaf = {
        key: entry.key,
        href: entry.href,
        label: entry.label
    };
    if (entry.exact) leaf.exact = true;
    return leaf;
}
function buildControlPlaneNav(ctx) {
    const policy = ctx.navVisibility ?? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["emptyNavVisibilityPolicy"])();
    const visible = (key)=>!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isNavKeyHiddenFor"])(policy, ctx.tenantRole, key);
    const nav = [];
    for (const entry of CONTROL_PLANE_NAV_CATALOG){
        if (!visible(entry.key)) continue;
        if (!isCatalogGroup(entry)) {
            if (meetsRequirement(ctx, entry.requires)) nav.push(toLeaf(entry));
            continue;
        }
        const children = entry.children.filter((child)=>meetsRequirement(ctx, child.requires) && visible(child.key)).map(toLeaf);
        if (children.length > 0) nav.push({
            key: entry.key,
            label: entry.label,
            children
        });
    }
    return nav;
}
function flattenNavHrefs(nav) {
    return nav.flatMap((entry)=>isGroup(entry) ? entry.children.map((child)=>child.href) : [
            entry.href
        ]);
}
function allNavKeys() {
    return CONTROL_PLANE_NAV_CATALOG.flatMap((entry)=>isCatalogGroup(entry) ? [
            entry.key,
            ...entry.children.map((child)=>child.key)
        ] : [
            entry.key
        ]);
}
}),
"[project]/src/lib/control-plane-panels.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "CONTROL_PLANE_PANELS",
    ()=>CONTROL_PLANE_PANELS,
    "CONTROL_PLANE_PANEL_VIEWPORT_CLASS",
    ()=>CONTROL_PLANE_PANEL_VIEWPORT_CLASS,
    "panelDefForKey",
    ()=>panelDefForKey,
    "panelKeyForHref",
    ()=>panelKeyForHref
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$nav$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-nav.ts [middleware] (ecmascript)");
;
const EYEBROW = {
    board: 'Munkatábla',
    projects: 'Munka',
    account: 'Fiók',
    automation: 'Automatizálás',
    admin: 'Adminisztráció',
    staff: 'Munkatársak',
    'agent.new': 'Csapat',
    'get-started': 'Útmutató'
};
function eyebrowForKey(key) {
    if (EYEBROW[key]) return EYEBROW[key];
    const prefix = key.split('.')[0];
    return EYEBROW[prefix] ?? 'Menü';
}
function leafPanelsFromCatalog(entries) {
    const panels = [];
    for (const entry of entries){
        if ('children' in entry) {
            panels.push(...leafPanelsFromCatalog(entry.children));
            continue;
        }
        panels.push({
            key: entry.key,
            title: entry.label,
            eyebrow: eyebrowForKey(entry.key),
            href: entry.href
        });
    }
    return panels;
}
const EXTRA_PANELS = [
    {
        key: 'agent.new',
        title: 'Új munkatárs felvétele',
        eyebrow: 'Csapat',
        href: '/control-plane/agents/new'
    },
    {
        key: 'automation.scheduled-tasks',
        title: 'Ütemezett feladatok',
        eyebrow: 'Automatizálás',
        href: '/control-plane/board?scheduled=1'
    }
];
const CONTROL_PLANE_PANELS = Object.fromEntries([
    ...leafPanelsFromCatalog(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$nav$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["CONTROL_PLANE_NAV_CATALOG"]),
    ...EXTRA_PANELS
].map((p)=>[
        p.key,
        p
    ]));
const PANEL_KEY_ALIASES = {
    'admin.account': 'account',
    'admin.connectors': 'account'
};
function panelDefForKey(key) {
    if (!key) return null;
    const resolved = PANEL_KEY_ALIASES[key] ?? key;
    return CONTROL_PLANE_PANELS[resolved] ?? null;
}
const CONTROL_PLANE_PANEL_VIEWPORT_CLASS = 'h-[90vh] w-[90vw] max-h-[90vh] max-w-[90vw]';
function panelKeyForHref(href) {
    const match = Object.values(CONTROL_PLANE_PANELS).find((p)=>p.href === href);
    return match?.key ?? null;
}
}),
"[project]/src/lib/control-plane-embed.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "EMBED_PANEL_HREFS",
    ()=>EMBED_PANEL_HREFS,
    "embedHrefForPanel",
    ()=>embedHrefForPanel,
    "isClerkClientEnabledForRequest",
    ()=>isClerkClientEnabledForRequest,
    "isControlPlaneEmbedRequest",
    ()=>isControlPlaneEmbedRequest
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/clerk-config.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$panels$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-panels.ts [middleware] (ecmascript)");
;
;
const EMBED_PANEL_HREFS = Object.fromEntries(Object.entries(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$panels$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["CONTROL_PLANE_PANELS"]).map(([key, def])=>[
        key,
        def.href
    ]));
function embedHrefForPanel(panel) {
    return EMBED_PANEL_HREFS[panel] ?? null;
}
function isControlPlaneEmbedRequest(h) {
    return h.get('x-cp-embed') === '1' || h.get('sec-fetch-dest') === 'iframe';
}
function isClerkClientEnabledForRequest(h) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isClerkEnabled"])() && !isControlPlaneEmbedRequest(h);
}
}),
"[project]/src/lib/observability/request-context.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
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
}),
"[project]/src/i18n/config.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Locale catalog.
 *
 * Public marketing pages (`/`, `/privacy`, `/gtc`) are locale-prefixed
 * (`/hu`, `/en/privacy`). The control plane and auth stay unprefixed; their
 * UI language follows the `NEXT_LOCALE` cookie (same HU/EN switcher). To add
 * a public page later, append it to `publicPathnames` and add
 * `app/[locale]/…/page.tsx` plus matching keys in `src/messages/{hu,en}.json`.
 */ __turbopack_context__.s([
    "PUBLIC_SITE_ORIGIN",
    ()=>PUBLIC_SITE_ORIGIN,
    "allPublicBrandingPaths",
    ()=>allPublicBrandingPaths,
    "defaultLocale",
    ()=>defaultLocale,
    "isAppLocale",
    ()=>isAppLocale,
    "isPublicBrandingPath",
    ()=>isPublicBrandingPath,
    "localePrefix",
    ()=>localePrefix,
    "locales",
    ()=>locales,
    "localizedPublicPath",
    ()=>localizedPublicPath,
    "normalizePublicPathname",
    ()=>normalizePublicPathname,
    "publicBrandingRoutePatterns",
    ()=>publicBrandingRoutePatterns,
    "publicPathnames",
    ()=>publicPathnames,
    "robotsAllowRules",
    ()=>robotsAllowRules,
    "unprefixedAliasLocale",
    ()=>unprefixedAliasLocale,
    "unprefixedPublicAliases",
    ()=>unprefixedPublicAliases
]);
const locales = [
    'hu',
    'en'
];
const defaultLocale = 'hu';
const localePrefix = 'always';
const publicPathnames = [
    '/',
    '/privacy',
    '/gtc'
];
const PUBLIC_SITE_ORIGIN = 'https://ai.excellencepay.com';
const unprefixedPublicAliases = {
    '/privacy': 'en',
    '/gtc': 'hu'
};
function isAppLocale(value) {
    return locales.includes(value);
}
function normalizePublicPathname(pathname) {
    if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
    return pathname;
}
function localizedPublicPath(pathname, locale) {
    if (pathname === '/') return `/${locale}`;
    return `/${locale}${pathname}`;
}
function allPublicBrandingPaths() {
    const paths = new Set(publicPathnames);
    for (const locale of locales){
        for (const path of publicPathnames){
            paths.add(localizedPublicPath(path, locale));
        }
    }
    return [
        ...paths
    ];
}
function isPublicBrandingPath(pathname) {
    return allPublicBrandingPaths().includes(normalizePublicPathname(pathname));
}
function publicBrandingRoutePatterns() {
    const patterns = [];
    for (const path of allPublicBrandingPaths()){
        patterns.push(path);
        const isLocaleHome = locales.some((locale)=>path === `/${locale}`);
        if (path !== '/' && !isLocaleHome) {
            patterns.push(`${path}/(.*)`);
        }
    }
    return patterns;
}
function unprefixedAliasLocale(pathname) {
    const normalized = normalizePublicPathname(pathname);
    if (normalized === '/privacy' || normalized === '/gtc') {
        return unprefixedPublicAliases[normalized];
    }
    return null;
}
function robotsAllowRules() {
    return [
        '/$',
        ...locales.map((locale)=>`/${locale}$`),
        ...publicPathnames.filter((path)=>path !== '/'),
        ...locales.map((locale)=>`/${locale}/`)
    ];
}
}),
"[project]/src/lib/auth/public-branding.ts [middleware] (ecmascript) <locals>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PUBLIC_BRANDING_PATHS",
    ()=>PUBLIC_BRANDING_PATHS,
    "PUBLIC_BRANDING_ROUTE_PATTERNS",
    ()=>PUBLIC_BRANDING_ROUTE_PATTERNS,
    "isPublicBrandingPath",
    ()=>isPublicBrandingPath
]);
/**
 * Nyilvános branding-oldalak — a Google OAuth consent-képernyő verifikációja
 * ezeket olvassa: honlap, adatvédelmi tájékoztató, ÁSZF.
 *
 * A locale-katalógus az `src/i18n/config.ts`-ben lakik, hogy a next-intl
 * routing, a Clerk-allowlist, a crawler-allowlist és a robots.txt ugyanazt a
 * listát lássa. A minták SZŰKEK: a `/` csak a gyökeret jelenti, a `/hu` nem
 * nyitja ki a control-plane-t.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/config.ts [middleware] (ecmascript)");
;
;
const PUBLIC_BRANDING_PATHS = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["allPublicBrandingPaths"])();
const PUBLIC_BRANDING_ROUTE_PATTERNS = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["publicBrandingRoutePatterns"])();
function isPublicBrandingPath(pathname) {
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isPublicBrandingPath"])(pathname);
}
}),
"[project]/src/lib/auth/public-routes.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PUBLIC_ROUTE_PATTERNS",
    ()=>PUBLIC_ROUTE_PATTERNS
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$branding$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/src/lib/auth/public-branding.ts [middleware] (ecmascript) <locals>");
;
const PUBLIC_ROUTE_PATTERNS = [
    // Google OAuth branding: honlap, adatvédelem, ÁSZF — belépés nélkül olvasható.
    ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$branding$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__$3c$locals$3e$__["PUBLIC_BRANDING_ROUTE_PATTERNS"],
    '/sign-in(.*)',
    '/sign-up(.*)',
    // Beágyazott agent-chat (#481 D5): az oldal MAGA ellenőrzi a sessiont, és session
    // nélkül a saját „jelentkezz be" állapotát mutatja (nem a Clerk-átirányítást) —
    // minden adat-elérése (agent, beszélgetés, server-actionök) külön hitelesített.
    '/embed/agents',
    '/embed/agents/(.*)',
    '/api/v1/agent(.*)',
    '/api/v1/gateway(.*)',
    '/api/v1/harness(.*)',
    // Cloud Scheduler → token auth a route handlerben (x-dispatcher-token), nem Clerk.
    '/api/v1/internal/dispatch-cycle(.*)',
    '/api/webhooks(.*)',
    // Bejövő csatorna-webhook (Telegram): a Clerk-munkamenet HELYETT a route saját, konstans
    // idejű megosztott-titok fejléce hitelesít (`x-telegram-bot-api-secret-token`).
    // SZŰKEN a `.../webhook` végpontra (és annak alútjaira) — így egy jövőbeli
    // `.../webhook-admin` vagy `.../config` csatorna-route NEM válik véletlenül publikussá.
    '/api/channels/(.*)/webhook',
    '/api/channels/(.*)/webhook/(.*)',
    // WP-6/WP-7: operatív endpointok auth nélkül (uptime-monitor / scrape).
    '/api/healthz(.*)',
    '/api/readyz(.*)',
    '/api/metrics(.*)',
    // Kereső-/bot-vezérlő fájlok: szándékosan nyilvánosak, tartalmuk nem érzékeny.
    // Enélkül a Clerk `auth.protect()` 404-et adna a `/robots.txt`-re, amit a
    // Googlebot „mindent szabad crawlolni"-ként értelmez (l. `src/app/robots.ts`).
    '/robots.txt',
    '/sitemap.xml',
    // MCP resource server (Clerk OAuth bearer in the handler, RFC 9728 discovery).
    // If these stay protected, Codex/Claude Code get an HTML login redirect instead
    // of 401 + WWW-Authenticate — the same failure class as the Telegram webhook.
    '/api/mcp',
    '/api/mcp/(.*)',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/(.*)',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/(.*)',
    // Delegált OAuth callback: a Google ide redirectel. MCP-consentnél nincs
    // Clerk-süti — a handler a signed OAuth state-tel hitelesít (lásd route).
    '/api/connectors/oauth/callback',
    '/connectors/oauth/done'
];
}),
"[project]/src/i18n/routing.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "routing",
    ()=>routing
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$routing$2f$defineRouting$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__$3c$export__default__as__defineRouting$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/routing/defineRouting.js [middleware] (ecmascript) <export default as defineRouting>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/config.ts [middleware] (ecmascript)");
;
;
const routing = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$routing$2f$defineRouting$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__$3c$export__default__as__defineRouting$3e$__["defineRouting"])({
    locales: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["locales"],
    defaultLocale: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["defaultLocale"],
    localePrefix: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["localePrefix"],
    localeCookie: {
        name: 'NEXT_LOCALE',
        maxAge: 60 * 60 * 24 * 365
    },
    pathnames: {
        '/': '/',
        '/privacy': '/privacy',
        '/gtc': '/gtc'
    }
});
}),
"[project]/src/lib/security/crawler-block.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "CRAWLER_ALWAYS_ALLOWED_PATHS",
    ()=>CRAWLER_ALWAYS_ALLOWED_PATHS,
    "crawlerBlockUserAgent",
    ()=>crawlerBlockUserAgent,
    "isCrawlerAllowedPath",
    ()=>isCrawlerAllowedPath,
    "isCrawlerBlockEnabled",
    ()=>isCrawlerBlockEnabled,
    "isCrawlerUserAgentBlockEnabled",
    ()=>isCrawlerUserAgentBlockEnabled,
    "isKnownCrawlerRequest",
    ()=>isKnownCrawlerRequest
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$branding$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/src/lib/auth/public-branding.ts [middleware] (ecmascript) <locals>");
;
/**
 * Ismert kereső-/előnézet-crawlerek felismerése és korai elutasítása.
 *
 * MIÉRT (#426): a deployolt platform Clerk **development instance** kulcsokkal
 * fut, ezért a bejelentkezett munkamenet az URL-ben utazik
 * (`__clerk_handshake` / `__clerk_db_jwt`). A Googlebot beindexelt egy ilyen
 * hitelesített linket, és azóta rendszeresen VISSZAJÁTSSZA a benne lévő élő
 * munkamenetet — hitelesített operátorként futtatva a control-plane-t
 * (agent-chat, workspace-fájl olvasás, `board_write` írás).
 *
 * A `robots.txt` (`Disallow: /`, #420) ezt NEM fogja meg: az csak az ÚJ
 * crawlolást tiltja, a már beindexelt, tokent tartalmazó URL-t a bot
 * továbbra is újra lekéri, és amíg a session él, a válasz 200 marad — ezt a
 * #426 09-06-i utómérése bizonyította (a robots.txt élesítése után is
 * emelkedett a bot-forgalom és folytatódtak az authentikált írások).
 *
 * Ez a szűrő a Clerk-kulcsváltástól (a tényleges gyökér-ok javításától)
 * FÜGGETLEN, azonnal élesíthető védelmi réteg: minden magát bejelentő
 * kereső-/előnézet-botot elutasítunk, mielőtt a Clerk-munkamenet
 * egyáltalán kiértékelődne — így a visszajátszott token sem ér célba.
 * Mellékhatásként ez a tartós 4xx a deindexelést is felgyorsítja (a Google a
 * tartós hibaválaszt törlési jelként kezeli), és valódi böngésző-forgalmat
 * nem érint.
 *
 * KORLÁT: ez UA-alapú, tehát a SZÁNDÉKOS UA-hamisítással érkező visszajátszást
 * nem fogja meg — csak a ténylegesen magát bejelentő crawlert (jelen
 * incidensben pontosan ez történt: a kérések UA-ja "Google" / Googlebot volt).
 * A gyökér-ok javítása (Clerk production instance + session-revoke) emberi
 * lépés marad, lásd #426.
 */ // FIGYELEM (#436 utóélet): a minta SOSEM tartalmazhat csupasz `google` ágat.
// A #426-os naplóban látott, szó szerint `Google` UA NEM a Googlebot volt, hanem a
// Firebase App Hosting CDN / Google-frontend origin-lekérése: az élesben a Cloud Run
// origin ezt látja MINDEN valódi felhasználói kérésnél is. A csupasz `google` ág ezért
// 100%-ban kizárta a böngészőket (az egész host 403 lett, üres UA-val is), miközben
// lokálisan — CDN nélkül, ahol a kliens UA-ja ér be — a szűrő helyesen viselkedett.
// Google-crawlereket csak a konkrét termék-tokenekkel szabad felismerni (lentebb),
// ezek egyikét sem küldi sem a böngésző, sem a Google saját infrastruktúrája.
const CRAWLER_USER_AGENT_PATTERN = /bot|crawler|spider|slurp|facebookexternalhit|embedly|quora link preview|showyoubot|outbrain|pinterest\/|pingdom|ia_archiver|whatsapp|telegrambot|bytespider|ccbot|google-inspectiontool|googleother|google-extended|apis-google|mediapartners-google|feedfetcher-google|google-read-aloud|google favicon|googleweblight/i;
const CRAWLER_ALWAYS_ALLOWED_PATHS = [
    '/robots.txt',
    '/sitemap.xml',
    '/api/healthz',
    '/api/readyz'
];
function isCrawlerAllowedPath(pathname) {
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$branding$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__$3c$locals$3e$__["isPublicBrandingPath"])(pathname)) return true;
    return CRAWLER_ALWAYS_ALLOWED_PATHS.some((allowed)=>pathname === allowed || pathname.startsWith(`${allowed}/`));
}
function crawlerBlockUserAgent(req) {
    return req.headers.get('user-agent') ?? '';
}
function isKnownCrawlerRequest(req) {
    return CRAWLER_USER_AGENT_PATTERN.test(crawlerBlockUserAgent(req));
}
function isCrawlerBlockEnabled() {
    return process.env.ALLOW_SEARCH_INDEXING !== 'true';
}
function isCrawlerUserAgentBlockEnabled() {
    return isCrawlerBlockEnabled() && process.env.DISABLE_CRAWLER_UA_BLOCK !== 'true';
}
}),
"[project]/src/proxy.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "config",
    ()=>config,
    "proxy",
    ()=>proxy
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$server$2f$clerkMiddleware$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@clerk/nextjs/dist/esm/server/clerkMiddleware.js [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$server$2f$routeMatcher$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@clerk/nextjs/dist/esm/server/routeMatcher.js [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/server.js [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$middleware$2f$middleware$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/middleware/middleware.js [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/clerk-config.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-embed.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$request$2d$context$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/request-context.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$branding$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/src/lib/auth/public-branding.ts [middleware] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$routes$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/auth/public-routes.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/config.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$routing$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/routing.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$security$2f$crawler$2d$block$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/security/crawler-block.ts [middleware] (ecmascript)");
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
;
const intlMiddleware = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$middleware$2f$middleware$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["default"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$routing$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["routing"]);
// A minták (és a felvételük szabálya) a `public-routes.ts`-ben laknak, hogy regressziós
// teszt rögzíthesse őket — a proxy-fájl maga egyetlen függvényt exportálhat.
const isPublicRoute = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$server$2f$routeMatcher$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["createRouteMatcher"])([
    ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$routes$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["PUBLIC_ROUTE_PATTERNS"]
]);
const ROBOTS_TAG_HEADER = 'X-Robots-Tag';
const ROBOTS_TAG_VALUE = 'noindex, nofollow, noarchive';
/**
 * WP-6 (O2): minden kérés kap `x-request-id`-t (a bejövot átvesszük, vagy
 * generálunk), és tovább is adjuk a válaszban, hogy a kliens/monitor korrelálhasson.
 *
 * #426: amíg az indexelés nincs szándékosan engedélyezve (`ALLOW_SEARCH_INDEXING`,
 * l. `crawler-block.ts` / `robots.ts`), minden válasz `X-Robots-Tag: noindex`-et
 * is kap — védőháló arra az esetre, ha egy útvonal a lenti UA-alapú bot-szűrőt
 * elkerülné (pl. egy magát nem bejelentő renderelő), a `robots.txt` mellett.
 */ function finishResponse(req, res) {
    const requestId = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$request$2d$context$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["resolveRequestId"])(req.headers.get(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$request$2d$context$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["REQUEST_ID_HEADER"]));
    res.headers.set(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$request$2d$context$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["REQUEST_ID_HEADER"], requestId);
    // A Google OAuth-verifikáció a honlapot és a privacy/ÁSZF oldalt olvassa —
    // ezeken a noindex-címke és a 403-as crawler-tiltás egyaránt elbukna.
    const pathname = new URL(req.url).pathname;
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$security$2f$crawler$2d$block$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isCrawlerBlockEnabled"])() && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$branding$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__$3c$locals$3e$__["isPublicBrandingPath"])(pathname)) {
        res.headers.set(ROBOTS_TAG_HEADER, ROBOTS_TAG_VALUE);
    }
    // Beágyazott agent-chat (#481 D1): a route csak külön ablakban él, sosem iframe-ben —
    // idegen domain semmiképp ne tudja keretezni.
    if (pathname === '/embed/agents' || pathname.startsWith('/embed/agents/')) {
        res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    }
    return res;
}
const proxy = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$server$2f$clerkMiddleware$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["clerkMiddleware"])(async (auth, req)=>{
    const { pathname } = req.nextUrl;
    // #426: a Clerk dev-instance URL-ben szállított munkamenetét a Googlebot
    // visszajátssza — a robots.txt (#420) ezt nem fogja meg, mert nem hozzáférés-
    // vezérlés. Ez a réteg a Clerk-kulcsváltástól függetlenül, azonnal leállítja
    // a magukat bejelentő crawlerek/renderelők hozzáférését — MIELŐTT a Clerk-
    // munkamenet (és a benne visszajátszott token) egyáltalán kiértékelődne.
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$security$2f$crawler$2d$block$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isCrawlerUserAgentBlockEnabled"])() && (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$security$2f$crawler$2d$block$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isKnownCrawlerRequest"])(req) && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$security$2f$crawler$2d$block$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isCrawlerAllowedPath"])(pathname)) {
        const blocked = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].json({
            error: 'Crawlers are not allowed on this host'
        }, {
            status: 403
        });
        // #436: a kiesés azért volt nehezen behatárolható, mert a válaszból nem derült ki,
        // MILYEN UA-t látott az origin (a CDN mögött ez nem a kliens UA-ja). A saját UA
        // visszatükrözése nem szivárogtat semmit, viszont egy curl-lel diagnosztizálhatóvá teszi.
        blocked.headers.set('x-crawler-block-ua', (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$security$2f$crawler$2d$block$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["crawlerBlockUserAgent"])(req).slice(0, 120));
        return finishResponse(req, blocked);
    }
    const aliasLocale = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["unprefixedAliasLocale"])(pathname);
    if (aliasLocale) {
        const url = req.nextUrl.clone();
        url.pathname = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["localizedPublicPath"])(pathname.replace(/\/$/, ''), aliasLocale);
        const requestHeaders = new Headers(req.headers);
        requestHeaders.set('x-next-intl-locale', aliasLocale);
        return finishResponse(req, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].rewrite(url, {
            request: {
                headers: requestHeaders
            }
        }));
    }
    if (pathname.startsWith('/embed/control-plane/')) {
        const panel = decodeURIComponent(pathname.slice('/embed/control-plane/'.length).split('/')[0] ?? '');
        const href = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["embedHrefForPanel"])(panel);
        if (href) {
            const url = req.nextUrl.clone();
            url.pathname = href;
            const requestHeaders = new Headers(req.headers);
            requestHeaders.set('x-cp-embed', '1');
            return finishResponse(req, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].rewrite(url, {
                request: {
                    headers: requestHeaders
                }
            }));
        }
    }
    if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isClerkEnabled"])()) {
        if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["isDevAuthAllowed"])()) {
            return finishResponse(req, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].json({
                error: 'Authentication is not configured'
            }, {
                status: 503
            }));
        }
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$branding$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__$3c$locals$3e$__["isPublicBrandingPath"])(pathname)) {
            return finishResponse(req, intlMiddleware(req));
        }
        return finishResponse(req, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].next());
    }
    if (!isPublicRoute(req)) {
        await auth.protect();
    }
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$auth$2f$public$2d$branding$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__$3c$locals$3e$__["isPublicBrandingPath"])(pathname)) {
        return finishResponse(req, intlMiddleware(req));
    }
    return finishResponse(req, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].next());
});
const config = {
    matcher: [
        '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
        '/(api|trpc)(.*)'
    ]
};
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__00skbfs._.js.map