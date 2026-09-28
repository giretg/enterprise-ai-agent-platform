(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/i18n/config.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
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
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/i18n/locale-cookie.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
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
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/i18n/routing.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "routing",
    ()=>routing
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$routing$2f$defineRouting$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__defineRouting$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/routing/defineRouting.js [app-client] (ecmascript) <export default as defineRouting>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/config.ts [app-client] (ecmascript)");
;
;
const routing = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$routing$2f$defineRouting$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__defineRouting$3e$__["defineRouting"])({
    locales: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["locales"],
    defaultLocale: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["defaultLocale"],
    localePrefix: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["localePrefix"],
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
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/i18n/navigation.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Link",
    ()=>Link,
    "getPathname",
    ()=>getPathname,
    "redirect",
    ()=>redirect,
    "usePathname",
    ()=>usePathname,
    "useRouter",
    ()=>useRouter
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$navigation$2f$react$2d$client$2f$createNavigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__createNavigation$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/navigation/react-client/createNavigation.js [app-client] (ecmascript) <export default as createNavigation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$routing$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/routing.ts [app-client] (ecmascript)");
;
;
const { Link, redirect, usePathname, useRouter, getPathname } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$navigation$2f$react$2d$client$2f$createNavigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__createNavigation$3e$__["createNavigation"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$routing$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["routing"]);
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/public-site/locale-switcher.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "LocaleSwitcher",
    ()=>LocaleSwitcher
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/use-intl/dist/esm/development/react.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-client/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/navigation.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/config.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$locale$2d$cookie$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/locale-cookie.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$navigation$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/navigation.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
const TITLE = {
    hu: 'Magyar',
    en: 'English'
};
function switcherClass(active) {
    return `rounded-sm px-2.5 py-1 font-mono text-xs font-semibold tracking-wide transition-colors ${active ? 'bg-ink text-white' : 'text-ink-soft hover:text-ink'}`;
}
function LocaleSwitcher() {
    _s();
    const locale = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useLocale"])();
    const pathname = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$navigation$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["usePathname"])();
    const nextPathname = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["usePathname"])();
    const router = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRouter"])();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('LocaleSwitcher');
    const prefixed = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isPublicBrandingPath"])(nextPathname);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        role: "navigation",
        "aria-label": t('label'),
        className: "inline-flex rounded border border-ink bg-card p-0.5",
        children: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$config$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["locales"].map((code)=>{
            const active = code === locale;
            if (prefixed) {
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$navigation$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Link"], {
                    href: pathname,
                    locale: code,
                    hrefLang: code,
                    title: TITLE[code],
                    className: switcherClass(active),
                    "aria-current": active ? 'true' : undefined,
                    children: t(code)
                }, code, false, {
                    fileName: "[project]/src/components/public-site/locale-switcher.tsx",
                    lineNumber: 35,
                    columnNumber: 13
                }, this);
            }
            return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                type: "button",
                title: TITLE[code],
                className: switcherClass(active),
                "aria-current": active ? 'true' : undefined,
                onClick: ()=>{
                    if (active) return;
                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$locale$2d$cookie$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["writeLocaleCookie"])(code);
                    router.refresh();
                },
                children: t(code)
            }, code, false, {
                fileName: "[project]/src/components/public-site/locale-switcher.tsx",
                lineNumber: 49,
                columnNumber: 11
            }, this);
        })
    }, void 0, false, {
        fileName: "[project]/src/components/public-site/locale-switcher.tsx",
        lineNumber: 26,
        columnNumber: 5
    }, this);
}
_s(LocaleSwitcher, "gdMUWOAHFzTHHLXVRsSldXrqBeE=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$use$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useLocale"],
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$navigation$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["usePathname"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["usePathname"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRouter"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"]
    ];
});
_c = LocaleSwitcher;
var _c;
__turbopack_context__.k.register(_c, "LocaleSwitcher");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/public-site/signal-motion.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ChatSequence",
    ()=>ChatSequence,
    "ScrollEffects",
    ()=>ScrollEffects
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
function ScrollEffects() {
    _s();
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "ScrollEffects.useEffect": ()=>{
            const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
            const reveals = document.querySelectorAll('[data-reveal]');
            const draws = document.querySelectorAll('[data-draw]');
            const steps = [
                ...document.querySelectorAll('[data-step]')
            ];
            const screens = [
                ...document.querySelectorAll('[data-screen]')
            ];
            const progress = document.querySelector('[data-progress]');
            if (reduced) {
                reveals.forEach({
                    "ScrollEffects.useEffect": (el)=>el.classList.add('is-in')
                }["ScrollEffects.useEffect"]);
                draws.forEach({
                    "ScrollEffects.useEffect": (el)=>{
                        el.style.setProperty('--draw', '1');
                        el.classList.add('is-drawn');
                    }
                }["ScrollEffects.useEffect"]);
            }
            const io = new IntersectionObserver({
                "ScrollEffects.useEffect": (entries)=>entries.forEach({
                        "ScrollEffects.useEffect": (e)=>{
                            if (!e.isIntersecting) return;
                            e.target.classList.add('is-in');
                            io.unobserve(e.target);
                        }
                    }["ScrollEffects.useEffect"])
            }["ScrollEffects.useEffect"], {
                threshold: 0.15
            });
            if (!reduced) reveals.forEach({
                "ScrollEffects.useEffect": (el)=>io.observe(el)
            }["ScrollEffects.useEffect"]);
            const onScroll = {
                "ScrollEffects.useEffect.onScroll": ()=>{
                    const h = document.documentElement;
                    if (progress) progress.style.width = `${h.scrollTop / Math.max(h.scrollHeight - h.clientHeight, 1) * 100}%`;
                    if (!reduced) {
                        draws.forEach({
                            "ScrollEffects.useEffect.onScroll": (svg)=>{
                                const r = svg.getBoundingClientRect();
                                const p = Math.min(Math.max((innerHeight - r.top) / (innerHeight * 0.7), 0), 1);
                                svg.style.setProperty('--draw', String(p));
                                if (p >= 1) svg.classList.add('is-drawn');
                            }
                        }["ScrollEffects.useEffect.onScroll"]);
                    }
                    let active = 0;
                    steps.forEach({
                        "ScrollEffects.useEffect.onScroll": (s, i)=>{
                            if (s.getBoundingClientRect().top < innerHeight * 0.55) active = i;
                        }
                    }["ScrollEffects.useEffect.onScroll"]);
                    steps.forEach({
                        "ScrollEffects.useEffect.onScroll": (s, i)=>s.classList.toggle('is-on', i === active)
                    }["ScrollEffects.useEffect.onScroll"]);
                    screens.forEach({
                        "ScrollEffects.useEffect.onScroll": (s, i)=>s.classList.toggle('is-on', i === active)
                    }["ScrollEffects.useEffect.onScroll"]);
                }
            }["ScrollEffects.useEffect.onScroll"];
            addEventListener('scroll', onScroll, {
                passive: true
            });
            onScroll();
            return ({
                "ScrollEffects.useEffect": ()=>{
                    io.disconnect();
                    removeEventListener('scroll', onScroll);
                }
            })["ScrollEffects.useEffect"];
        }
    }["ScrollEffects.useEffect"], []);
    return null;
}
_s(ScrollEffects, "OD7bBpZva5O2jO+Puf00hKivP7c=");
_c = ScrollEffects;
function ChatSequence({ frames, delays }) {
    _s1();
    const last = delays.length;
    const [step, setStep] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(0);
    const endRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "ChatSequence.useEffect": ()=>{
            const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reduced && step === last) return;
            const next = {
                "ChatSequence.useEffect.next": ()=>setStep({
                        "ChatSequence.useEffect.next": (s)=>reduced ? last : s >= last ? 0 : s + 1
                    }["ChatSequence.useEffect.next"])
            }["ChatSequence.useEffect.next"];
            const timer = setTimeout(next, reduced ? 0 : step >= last ? 5000 : delays[step]);
            return ({
                "ChatSequence.useEffect": ()=>clearTimeout(timer)
            })["ChatSequence.useEffect"];
        }
    }["ChatSequence.useEffect"], [
        step,
        last,
        delays
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "ChatSequence.useEffect": ()=>{
            const anchor = endRef.current;
            const panel = anchor?.closest('[data-chat-scroll]');
            if (!panel) return;
            const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
            const behavior = reduced ? 'auto' : 'smooth';
            panel.scrollTo({
                top: step === 0 ? 0 : panel.scrollHeight,
                behavior
            });
        }
    }["ChatSequence.useEffect"], [
        step
    ]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Fragment"], {
        children: [
            frames.map((f, i)=>f.from <= step && (f.to === undefined || step < f.to) ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "animate-rise",
                    children: f.node
                }, `${i}-${f.from}`, false, {
                    fileName: "[project]/src/components/public-site/signal-motion.tsx",
                    lineNumber: 103,
                    columnNumber: 11
                }, this) : null),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                ref: endRef,
                "aria-hidden": true,
                className: "h-px shrink-0"
            }, void 0, false, {
                fileName: "[project]/src/components/public-site/signal-motion.tsx",
                lineNumber: 108,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true);
}
_s1(ChatSequence, "+5LmHp3zrscPx4OA41+9N/D81hE=");
_c1 = ChatSequence;
var _c, _c1;
__turbopack_context__.k.register(_c, "ScrollEffects");
__turbopack_context__.k.register(_c1, "ChatSequence");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=src_1m5oeui._.js.map