module.exports = [
"[project]/src/i18n/config.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
"[project]/src/i18n/locale-cookie.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "LOCALE_COOKIE",
    ()=>LOCALE_COOKIE,
    "localeCookieHeader",
    ()=>localeCookieHeader,
    "writeLocaleCookie",
    ()=>writeLocaleCookie
]);
const LOCALE_COOKIE = 'NEXT_LOCALE';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
function localeCookieHeader(locale) {
    return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}
function writeLocaleCookie(locale) {
    document.cookie = localeCookieHeader(locale);
}
}),
"[project]/src/i18n/routing.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "routing",
    ()=>routing
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$routing$2f$defineRouting$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__defineRouting$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/routing/defineRouting.js [app-rsc] (ecmascript) <export default as defineRouting>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/config.ts [app-rsc] (ecmascript)");
;
;
const routing = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$routing$2f$defineRouting$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__defineRouting$3e$__["defineRouting"])({
    locales: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["locales"],
    defaultLocale: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["defaultLocale"],
    localePrefix: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["localePrefix"],
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
"[project]/src/i18n/request.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$core$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/use-intl/dist/esm/development/core.js [app-rsc] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$server$2f$react$2d$server$2f$getRequestConfig$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__getRequestConfig$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/server/react-server/getRequestConfig.js [app-rsc] (ecmascript) <export default as getRequestConfig>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/headers.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/config.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$locale$2d$cookie$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/locale-cookie.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$routing$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/routing.ts [app-rsc] (ecmascript)");
;
;
;
;
;
;
;
const __TURBOPACK__default__export__ = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$server$2f$react$2d$server$2f$getRequestConfig$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__getRequestConfig$3e$__["getRequestConfig"])(async ({ requestLocale, locale: explicitLocale })=>{
    let requested = explicitLocale ?? await requestLocale;
    if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$core$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasLocale"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$routing$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["routing"].locales, requested)) {
        try {
            requested = (await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["cookies"])()).get(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$locale$2d$cookie$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["LOCALE_COOKIE"])?.value;
        } catch  {
            requested = undefined;
        }
    }
    const locale = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$core$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__["hasLocale"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$routing$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["routing"].locales, requested) ? requested : __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["defaultLocale"];
    return {
        locale,
        messages: (await __turbopack_context__.f({
            "../messages/en.json": {
                id: ()=>"[project]/src/messages/en.json.[json].cjs [app-rsc] (ecmascript, async loader)",
                module: ()=>__turbopack_context__.A("[project]/src/messages/en.json.[json].cjs [app-rsc] (ecmascript, async loader)")
            },
            "../messages/hu.json": {
                id: ()=>"[project]/src/messages/hu.json.[json].cjs [app-rsc] (ecmascript, async loader)",
                module: ()=>__turbopack_context__.A("[project]/src/messages/hu.json.[json].cjs [app-rsc] (ecmascript, async loader)")
            }
        }).import(`../messages/${locale}.json`)).default
    };
});
}),
"[project]/src/components/auth/providers.tsx [app-rsc] (client reference proxy) <module evaluation>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "AuthProviders",
    ()=>AuthProviders,
    "useClerkEnabled",
    ()=>useClerkEnabled
]);
// This file is generated by next-core EcmascriptClientReferenceModule.
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-server-dom-turbopack-server.js [app-rsc] (ecmascript)");
;
const AuthProviders = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call AuthProviders() from the server but AuthProviders is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/src/components/auth/providers.tsx <module evaluation>", "AuthProviders");
const useClerkEnabled = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call useClerkEnabled() from the server but useClerkEnabled is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/src/components/auth/providers.tsx <module evaluation>", "useClerkEnabled");
}),
"[project]/src/components/auth/providers.tsx [app-rsc] (client reference proxy)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "AuthProviders",
    ()=>AuthProviders,
    "useClerkEnabled",
    ()=>useClerkEnabled
]);
// This file is generated by next-core EcmascriptClientReferenceModule.
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-server-dom-turbopack-server.js [app-rsc] (ecmascript)");
;
const AuthProviders = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call AuthProviders() from the server but AuthProviders is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/src/components/auth/providers.tsx", "AuthProviders");
const useClerkEnabled = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call useClerkEnabled() from the server but useClerkEnabled is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/src/components/auth/providers.tsx", "useClerkEnabled");
}),
"[project]/src/components/auth/providers.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$providers$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__$3c$module__evaluation$3e$__ = __turbopack_context__.i("[project]/src/components/auth/providers.tsx [app-rsc] (client reference proxy) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$providers$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__ = __turbopack_context__.i("[project]/src/components/auth/providers.tsx [app-rsc] (client reference proxy)");
;
__turbopack_context__.n(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$providers$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__);
}),
"[project]/src/lib/clerk-config.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
"[project]/src/lib/iam-policy.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
"[project]/src/lib/tenant-policy.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
"[project]/src/lib/tenant-settings.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "settingsRecord",
    ()=>settingsRecord
]);
function settingsRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
}),
"[project]/src/lib/nav-visibility.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$settings$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/tenant-settings.ts [app-rsc] (ecmascript)");
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
    const record = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$settings$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["settingsRecord"])(raw);
    const policy = emptyNavVisibilityPolicy();
    for (const role of NAV_VISIBILITY_ROLES){
        const keys = toKeyList(record[role]);
        policy[role] = role === 'admin' ? keys.filter((key)=>!NAV_KEYS_LOCKED_FOR_ADMIN.includes(key)) : keys;
    }
    return policy;
}
function readNavVisibilityPolicy(settings) {
    return sanitizeNavVisibilityPolicy((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$settings$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["settingsRecord"])(settings)[NAV_VISIBILITY_SETTING]);
}
function withNavVisibilityPolicy(settings, policy) {
    return {
        ...(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$settings$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["settingsRecord"])(settings),
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
"[project]/src/lib/control-plane-nav.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/iam-policy.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/tenant-policy.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/nav-visibility.ts [app-rsc] (ecmascript)");
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
    if (requires.tenantRole && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["hasMinimumRole"])(ctx.tenantRole, requires.tenantRole)) return false;
    if (requires.platformRole && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["hasMinimumPlatformRole"])(ctx.platformRoles, requires.platformRole)) {
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
    const policy = ctx.navVisibility ?? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["emptyNavVisibilityPolicy"])();
    const visible = (key)=>!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isNavKeyHiddenFor"])(policy, ctx.tenantRole, key);
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
"[project]/src/lib/control-plane-panels.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$nav$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-nav.ts [app-rsc] (ecmascript)");
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
    ...leafPanelsFromCatalog(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$nav$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["CONTROL_PLANE_NAV_CATALOG"]),
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
"[project]/src/lib/control-plane-embed.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
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
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/clerk-config.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$panels$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-panels.ts [app-rsc] (ecmascript)");
;
;
const EMBED_PANEL_HREFS = Object.fromEntries(Object.entries(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$panels$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["CONTROL_PLANE_PANELS"]).map(([key, def])=>[
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
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isClerkEnabled"])() && !isControlPlaneEmbedRequest(h);
}
}),
"[project]/src/app/layout.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>RootLayout,
    "metadata",
    ()=>metadata
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/headers.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$server$2f$NextIntlClientProviderServer$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__NextIntlClientProvider$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-server/NextIntlClientProviderServer.js [app-rsc] (ecmascript) <export default as NextIntlClientProvider>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$server$2f$react$2d$server$2f$getLocale$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__getLocale$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/server/react-server/getLocale.js [app-rsc] (ecmascript) <export default as getLocale>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$server$2f$react$2d$server$2f$getMessages$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__getMessages$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/server/react-server/getMessages.js [app-rsc] (ecmascript) <export default as getMessages>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$providers$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/auth/providers.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/config.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-embed.ts [app-rsc] (ecmascript)");
;
;
;
;
;
;
;
;
const metadata = {
    title: {
        default: 'Excellence AI',
        template: '%s · Excellence AI'
    },
    description: "Excellence AI is a secure enterprise MCP server that connects your team's AI tools to company systems — with governed access, a full audit trail, and human approval."
};
async function documentLocale() {
    const fromHeader = (await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["headers"])()).get('x-next-intl-locale');
    if (fromHeader && (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isAppLocale"])(fromHeader)) return fromHeader;
    try {
        const locale = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$server$2f$react$2d$server$2f$getLocale$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__getLocale$3e$__["getLocale"])();
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isAppLocale"])(locale) ? locale : __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["defaultLocale"];
    } catch  {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["defaultLocale"];
    }
}
async function RootLayout({ children }) {
    const headerList = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["headers"])();
    const clerkEnabled = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isClerkClientEnabledForRequest"])(headerList);
    const locale = await documentLocale();
    const messages = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$server$2f$react$2d$server$2f$getMessages$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__getMessages$3e$__["getMessages"])();
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("html", {
        lang: locale,
        suppressHydrationWarning: true,
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("body", {
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$server$2f$NextIntlClientProviderServer$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__NextIntlClientProvider$3e$__["NextIntlClientProvider"], {
                locale: locale,
                messages: messages,
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$providers$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AuthProviders"], {
                    clerkEnabled: clerkEnabled,
                    locale: locale,
                    children: children
                }, void 0, false, {
                    fileName: "[project]/src/app/layout.tsx",
                    lineNumber: 40,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/app/layout.tsx",
                lineNumber: 39,
                columnNumber: 9
            }, this)
        }, void 0, false, {
            fileName: "[project]/src/app/layout.tsx",
            lineNumber: 38,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/app/layout.tsx",
        lineNumber: 37,
        columnNumber: 5
    }, this);
}
}),
"[project]/src/app/layout.tsx [app-rsc] (ecmascript, Next.js Server Component)", ((__turbopack_context__) => {

__turbopack_context__.n(__turbopack_context__.i("[project]/src/app/layout.tsx [app-rsc] (ecmascript)"));
}),
];

//# sourceMappingURL=src_0_ee7s-._.js.map