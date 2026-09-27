(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/components/auth/shell-auth.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ShellAuth",
    ()=>ShellAuth
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/@clerk/nextjs/dist/esm/index.js [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$react$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/@clerk/react/dist/index.mjs [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$react$2f$dist$2f$hooks$2d$BiY5Zgpp$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__$3c$export__I__as__UserButton$3e$__ = __turbopack_context__.i("[project]/node_modules/@clerk/react/dist/hooks-BiY5Zgpp.mjs [app-client] (ecmascript) <locals> <export I as UserButton>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-client/index.js [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
const authButtonClass = 'rounded-full border border-line bg-card px-4 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep';
function ShellAuth({ clerkEnabled }) {
    _s();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('Auth');
    if (!clerkEnabled) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
            className: "rounded-full border border-honey/30 bg-honey/10 px-3 py-1.5 text-xs font-medium text-honey",
            children: t('devAuth')
        }, void 0, false, {
            fileName: "[project]/src/components/auth/shell-auth.tsx",
            lineNumber: 13,
            columnNumber: 7
        }, this);
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Fragment"], {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["Show"], {
                when: "signed-out",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$react$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["SignInButton"], {
                        mode: "modal",
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                            type: "button",
                            className: authButtonClass,
                            children: t('signIn')
                        }, void 0, false, {
                            fileName: "[project]/src/components/auth/shell-auth.tsx",
                            lineNumber: 23,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/auth/shell-auth.tsx",
                        lineNumber: 22,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$react$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["SignUpButton"], {
                        mode: "modal",
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                            type: "button",
                            className: `${authButtonClass} border-coral/30 bg-coral/10 text-coral-deep hover:border-coral/50`,
                            children: t('signUp')
                        }, void 0, false, {
                            fileName: "[project]/src/components/auth/shell-auth.tsx",
                            lineNumber: 28,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/auth/shell-auth.tsx",
                        lineNumber: 27,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/auth/shell-auth.tsx",
                lineNumber: 21,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["Show"], {
                when: "signed-in",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$react$2f$dist$2f$hooks$2d$BiY5Zgpp$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__$3c$export__I__as__UserButton$3e$__["UserButton"], {
                    appearance: {
                        elements: {
                            avatarBox: 'h-9 w-9'
                        }
                    }
                }, void 0, false, {
                    fileName: "[project]/src/components/auth/shell-auth.tsx",
                    lineNumber: 37,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/auth/shell-auth.tsx",
                lineNumber: 36,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true);
}
_s(ShellAuth, "h6+q2O3NJKPY5uL0BIJGLIanww8=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"]
    ];
});
_c = ShellAuth;
var _c;
__turbopack_context__.k.register(_c, "ShellAuth");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/ui/shell.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "AppShell",
    ()=>AppShell,
    "Badge",
    ()=>Badge,
    "Card",
    ()=>Card,
    "IconButton",
    ()=>IconButton
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$image$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/image.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/client/app-dir/link.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-client/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$shell$2d$auth$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/auth/shell-auth.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$providers$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/auth/providers.tsx [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
;
const isGroup = (entry)=>'children' in entry;
const linkClass = (active)=>`relative rounded-full px-4 py-1.5 text-sm font-medium tracking-wide transition-all duration-200 ${active ? 'text-coral-deep' : 'text-ink-soft hover:bg-coral/8 hover:text-ink'}`;
function AppShell({ appName, appSubtitle, navItems, children, switchLink, pathname, headerExtra, layout = 'default' }) {
    _s();
    const isActive = (href, exact)=>{
        if (exact) return pathname === href;
        return pathname.startsWith(href);
    };
    const isGroupActive = (group)=>group.children.some((child)=>isActive(child.href, child.exact));
    const clerkEnabled = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$providers$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useClerkEnabled"])();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('ControlPlane.shell');
    const [mobileMenuOpen, setMobileMenuOpen] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [openGroup, setOpenGroup] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "AppShell.useEffect": ()=>{
            if (!openGroup) return;
            const onMouseDown = {
                "AppShell.useEffect.onMouseDown": (e)=>{
                    const target = e.target;
                    const openEl = document.querySelector('[data-open-group]');
                    if (openEl && !openEl.contains(target)) setOpenGroup(null);
                }
            }["AppShell.useEffect.onMouseDown"];
            const onKeyDown = {
                "AppShell.useEffect.onKeyDown": (e)=>{
                    if (e.key === 'Escape') setOpenGroup(null);
                }
            }["AppShell.useEffect.onKeyDown"];
            document.addEventListener('mousedown', onMouseDown);
            document.addEventListener('keydown', onKeyDown);
            return ({
                "AppShell.useEffect": ()=>{
                    document.removeEventListener('mousedown', onMouseDown);
                    document.removeEventListener('keydown', onKeyDown);
                }
            })["AppShell.useEffect"];
        }
    }["AppShell.useEffect"], [
        openGroup
    ]);
    const renderNavLeaf = (child, childActive, onPick, compact = false)=>{
        const baseClass = compact ? `${linkClass(childActive)} block` : `block rounded-xl px-3 py-2 text-sm font-medium tracking-wide transition-colors ${childActive ? 'bg-coral/10 text-coral-deep' : 'text-ink-soft hover:bg-coral/8 hover:text-ink'}`;
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
            href: child.href,
            role: compact ? 'menuitem' : undefined,
            onClick: onPick,
            className: baseClass,
            children: [
                child.label,
                childActive && compact ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: "absolute -bottom-px left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-coral"
                }, void 0, false, {
                    fileName: "[project]/src/components/ui/shell.tsx",
                    lineNumber: 91,
                    columnNumber: 11
                }, this) : null
            ]
        }, child.href, true, {
            fileName: "[project]/src/components/ui/shell.tsx",
            lineNumber: 82,
            columnNumber: 7
        }, this);
    };
    const renderTopLeaf = (item)=>{
        const active = isActive(item.href, item.exact);
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
            href: item.href,
            className: linkClass(active),
            children: [
                item.label,
                active && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: "absolute -bottom-px left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-coral"
                }, void 0, false, {
                    fileName: "[project]/src/components/ui/shell.tsx",
                    lineNumber: 103,
                    columnNumber: 11
                }, this)
            ]
        }, item.href, true, {
            fileName: "[project]/src/components/ui/shell.tsx",
            lineNumber: 100,
            columnNumber: 7
        }, this);
    };
    const railLayout = layout === 'rail';
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: railLayout ? 'flex h-dvh flex-col overflow-hidden text-ink' : 'min-h-screen text-ink',
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("header", {
                className: `z-20 shrink-0 border-b border-line bg-night/80 backdrop-blur-xl ${railLayout ? '' : 'sticky top-0'}`,
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "w-full px-3 py-2.5 sm:px-5 sm:py-3.5",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "flex items-center justify-between gap-1.5 sm:gap-3",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex min-w-0 shrink-0 items-center gap-2 sm:gap-3",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$image$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                                            src: "/excellence-ai-logo.png",
                                            alt: "Excellence AI",
                                            width: 44,
                                            height: 44,
                                            className: "h-9 w-9 shrink-0 rounded-xl object-cover sm:h-11 sm:w-11 sm:rounded-2xl"
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/ui/shell.tsx",
                                            lineNumber: 127,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                            className: "hidden min-w-0 sm:block",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                    className: "truncate font-display text-[1.2rem] font-semibold leading-none tracking-tight sm:text-[1.35rem]",
                                                    children: appName
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/ui/shell.tsx",
                                                    lineNumber: 135,
                                                    columnNumber: 17
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                    className: "mt-1 hidden text-[11px] uppercase tracking-[0.16em] text-ink-faint sm:block",
                                                    children: appSubtitle
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/ui/shell.tsx",
                                                    lineNumber: 138,
                                                    columnNumber: 17
                                                }, this)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/ui/shell.tsx",
                                            lineNumber: 134,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/ui/shell.tsx",
                                    lineNumber: 126,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("nav", {
                                    "aria-label": t('navAria'),
                                    className: "hidden items-center gap-1 lg:flex",
                                    children: navItems.map((item)=>{
                                        if (isGroup(item)) {
                                            const active = isGroupActive(item);
                                            const open = openGroup === item.label;
                                            return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: "relative",
                                                ...open ? {
                                                    'data-open-group': ''
                                                } : {},
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                                        type: "button",
                                                        "aria-haspopup": "menu",
                                                        "aria-expanded": open,
                                                        onClick: ()=>setOpenGroup((cur)=>cur === item.label ? null : item.label),
                                                        className: `${linkClass(active)} inline-flex items-center gap-1`,
                                                        children: [
                                                            item.label,
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
                                                                "aria-hidden": true,
                                                                viewBox: "0 0 12 12",
                                                                className: `h-2.5 w-2.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`,
                                                                fill: "none",
                                                                stroke: "currentColor",
                                                                strokeWidth: "1.6",
                                                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                                                                    d: "M2.5 4.5 6 8l3.5-3.5",
                                                                    strokeLinecap: "round",
                                                                    strokeLinejoin: "round"
                                                                }, void 0, false, {
                                                                    fileName: "[project]/src/components/ui/shell.tsx",
                                                                    lineNumber: 171,
                                                                    columnNumber: 27
                                                                }, this)
                                                            }, void 0, false, {
                                                                fileName: "[project]/src/components/ui/shell.tsx",
                                                                lineNumber: 163,
                                                                columnNumber: 25
                                                            }, this),
                                                            active && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                                className: "absolute -bottom-px left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-coral"
                                                            }, void 0, false, {
                                                                fileName: "[project]/src/components/ui/shell.tsx",
                                                                lineNumber: 174,
                                                                columnNumber: 27
                                                            }, this)
                                                        ]
                                                    }, void 0, true, {
                                                        fileName: "[project]/src/components/ui/shell.tsx",
                                                        lineNumber: 155,
                                                        columnNumber: 23
                                                    }, this),
                                                    open && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                        role: "menu",
                                                        className: "absolute right-0 top-full z-40 mt-2 min-w-[12rem] rounded-2xl border border-line bg-night/95 p-1.5 shadow-xl backdrop-blur-xl",
                                                        children: item.children.map((child)=>{
                                                            const childActive = isActive(child.href, child.exact);
                                                            return renderNavLeaf(child, childActive, ()=>setOpenGroup(null), false);
                                                        })
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/ui/shell.tsx",
                                                        lineNumber: 178,
                                                        columnNumber: 25
                                                    }, this)
                                                ]
                                            }, item.label, true, {
                                                fileName: "[project]/src/components/ui/shell.tsx",
                                                lineNumber: 150,
                                                columnNumber: 21
                                            }, this);
                                        }
                                        return renderTopLeaf(item);
                                    })
                                }, void 0, false, {
                                    fileName: "[project]/src/components/ui/shell.tsx",
                                    lineNumber: 144,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex shrink-0 items-center gap-1.5 sm:gap-2",
                                    children: [
                                        headerExtra,
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$shell$2d$auth$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ShellAuth"], {
                                            clerkEnabled: clerkEnabled
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/ui/shell.tsx",
                                            lineNumber: 197,
                                            columnNumber: 15
                                        }, this),
                                        switchLink && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                                            href: switchLink.href,
                                            className: "hidden rounded-full border border-line bg-card px-3 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep sm:inline-flex sm:px-4",
                                            children: switchLink.label
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/ui/shell.tsx",
                                            lineNumber: 199,
                                            columnNumber: 17
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                            type: "button",
                                            "aria-label": mobileMenuOpen ? t('menuClose') : t('menuOpen'),
                                            "aria-expanded": mobileMenuOpen,
                                            "aria-controls": "mobile-main-navigation",
                                            onClick: ()=>setMobileMenuOpen((open)=>!open),
                                            className: "inline-flex h-9 w-9 items-center justify-center rounded-full border border-line bg-card text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep sm:h-10 sm:w-10 lg:hidden",
                                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "flex w-4 flex-col gap-1",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "h-0.5 rounded-full bg-current"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/ui/shell.tsx",
                                                        lineNumber: 215,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "h-0.5 rounded-full bg-current"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/ui/shell.tsx",
                                                        lineNumber: 216,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "h-0.5 rounded-full bg-current"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/components/ui/shell.tsx",
                                                        lineNumber: 217,
                                                        columnNumber: 19
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/components/ui/shell.tsx",
                                                lineNumber: 214,
                                                columnNumber: 17
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/ui/shell.tsx",
                                            lineNumber: 206,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/components/ui/shell.tsx",
                                    lineNumber: 195,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/ui/shell.tsx",
                            lineNumber: 125,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("nav", {
                            id: "mobile-main-navigation",
                            "aria-label": t('mobileNavAria'),
                            className: `-mx-4 mt-3 border-t border-line/70 px-4 pt-3 lg:hidden ${mobileMenuOpen ? 'grid gap-1' : 'hidden'}`,
                            children: [
                                navItems.map((item)=>{
                                    if (isGroup(item)) {
                                        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                            className: "mt-2 first:mt-0",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                    className: "px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint",
                                                    children: item.label
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/ui/shell.tsx",
                                                    lineNumber: 234,
                                                    columnNumber: 21
                                                }, this),
                                                item.children.map((child)=>{
                                                    const childActive = isActive(child.href, child.exact);
                                                    return renderNavLeaf(child, childActive, ()=>setMobileMenuOpen(false), true);
                                                })
                                            ]
                                        }, item.label, true, {
                                            fileName: "[project]/src/components/ui/shell.tsx",
                                            lineNumber: 233,
                                            columnNumber: 19
                                        }, this);
                                    }
                                    return renderTopLeaf(item);
                                }),
                                switchLink && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                                    href: switchLink.href,
                                    onClick: ()=>setMobileMenuOpen(false),
                                    className: "mt-1 rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep",
                                    children: switchLink.label
                                }, void 0, false, {
                                    fileName: "[project]/src/components/ui/shell.tsx",
                                    lineNumber: 247,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/components/ui/shell.tsx",
                            lineNumber: 223,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/components/ui/shell.tsx",
                    lineNumber: 124,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/components/ui/shell.tsx",
                lineNumber: 119,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("main", {
                className: railLayout ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'mx-auto max-w-7xl px-5 py-9',
                children: children
            }, void 0, false, {
                fileName: "[project]/src/components/ui/shell.tsx",
                lineNumber: 258,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/ui/shell.tsx",
        lineNumber: 112,
        columnNumber: 5
    }, this);
}
_s(AppShell, "O0iswkRSGRlj9naqZe0W+Ao6Q1w=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$auth$2f$providers$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useClerkEnabled"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"]
    ];
});
_c = AppShell;
function Card({ title, children, className = '' }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
        className: `atelier-card p-4 sm:p-5 ${className}`,
        children: [
            title ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                className: "mb-4 font-display text-lg font-semibold tracking-tight",
                children: title
            }, void 0, false, {
                fileName: "[project]/src/components/ui/shell.tsx",
                lineNumber: 283,
                columnNumber: 9
            }, this) : null,
            children
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/ui/shell.tsx",
        lineNumber: 281,
        columnNumber: 5
    }, this);
}
_c1 = Card;
function Badge({ children, tone = 'neutral', title }) {
    const tones = {
        neutral: 'bg-ink/8 text-ink-soft',
        success: 'bg-sage/15 text-sage',
        warning: 'bg-honey/15 text-honey',
        danger: 'bg-coral/15 text-coral'
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
        title: title,
        className: `rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`,
        children: children
    }, void 0, false, {
        fileName: "[project]/src/components/ui/shell.tsx",
        lineNumber: 306,
        columnNumber: 5
    }, this);
}
_c2 = Badge;
const ICON_PATHS = {
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v5M12 7.5h.01',
    refresh: 'M20.5 12a8.5 8.5 0 1 1-2.2-5.8M20.5 3.5V9h-5.5',
    power: 'M12 3v9M17 6.6a7.5 7.5 0 1 1-10 0',
    trash: 'M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7',
    chevron: 'm6 9.5 6 6 6-6'
};
function IconButton({ icon, label, tone = 'neutral', active = false, disabled = false, onClick }) {
    const tones = {
        neutral: active ? 'border-ink/30 bg-ink/8 text-ink' : 'border-ink/20 text-ink-soft hover:border-ink/40 hover:text-ink',
        danger: 'border-coral/40 bg-coral/10 text-coral hover:bg-coral/20'
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
        type: "button",
        title: label,
        "aria-label": label,
        "aria-pressed": active || undefined,
        disabled: disabled,
        onClick: onClick,
        className: `flex h-8 w-8 items-center justify-center rounded-md border transition disabled:opacity-40 ${tones[tone]}`,
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
            viewBox: "0 0 24 24",
            className: "h-4 w-4",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.8,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true",
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: ICON_PATHS[icon]
            }, void 0, false, {
                fileName: "[project]/src/components/ui/shell.tsx",
                lineNumber: 364,
                columnNumber: 9
            }, this)
        }, void 0, false, {
            fileName: "[project]/src/components/ui/shell.tsx",
            lineNumber: 354,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/components/ui/shell.tsx",
        lineNumber: 345,
        columnNumber: 5
    }, this);
}
_c3 = IconButton;
var _c, _c1, _c2, _c3;
__turbopack_context__.k.register(_c, "AppShell");
__turbopack_context__.k.register(_c1, "Card");
__turbopack_context__.k.register(_c2, "Badge");
__turbopack_context__.k.register(_c3, "IconButton");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
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
"[project]/src/app/actions/data:6ba00f [app-client] (ecmascript) <text/javascript>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "getTenantSwitcherState",
    ()=>$$RSC_SERVER_ACTION_2
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/build/webpack/loaders/next-flight-loader/action-client-wrapper.js [app-client] (ecmascript)");
/* __next_internal_action_entry_do_not_use__ [{"00e4e5e81f7c6d141fc058d1364205b035bf2d4596":{"name":"getTenantSwitcherState"}},"src/app/actions/tenant.ts",""] */ "use turbopack no side effects";
;
const $$RSC_SERVER_ACTION_2 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createServerReference"])("00e4e5e81f7c6d141fc058d1364205b035bf2d4596", __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["callServer"], void 0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["findSourceMapURL"], "getTenantSwitcherState");
;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/actions/data:1a70ad [app-client] (ecmascript) <text/javascript>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "switchTenant",
    ()=>$$RSC_SERVER_ACTION_0
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/build/webpack/loaders/next-flight-loader/action-client-wrapper.js [app-client] (ecmascript)");
/* __next_internal_action_entry_do_not_use__ [{"40c7482725289150a683e3fb77ceb0b50e11483f05":{"name":"switchTenant"}},"src/app/actions/tenant.ts",""] */ "use turbopack no side effects";
;
const $$RSC_SERVER_ACTION_0 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createServerReference"])("40c7482725289150a683e3fb77ceb0b50e11483f05", __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["callServer"], void 0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["findSourceMapURL"], "switchTenant");
;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/actions/data:c12f1c [app-client] (ecmascript) <text/javascript>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "exitTenant",
    ()=>$$RSC_SERVER_ACTION_1
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/build/webpack/loaders/next-flight-loader/action-client-wrapper.js [app-client] (ecmascript)");
/* __next_internal_action_entry_do_not_use__ [{"007458bc559ac7493ba8d2ea619f46d092f2f5aa30":{"name":"exitTenant"}},"src/app/actions/tenant.ts",""] */ "use turbopack no side effects";
;
const $$RSC_SERVER_ACTION_1 = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createServerReference"])("007458bc559ac7493ba8d2ea619f46d092f2f5aa30", __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["callServer"], void 0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["findSourceMapURL"], "exitTenant");
;
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/components/tenant/tenant-switcher.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "TenantSwitcher",
    ()=>TenantSwitcher
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/navigation.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-client/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$6ba00f__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__ = __turbopack_context__.i("[project]/src/app/actions/data:6ba00f [app-client] (ecmascript) <text/javascript>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$1a70ad__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__ = __turbopack_context__.i("[project]/src/app/actions/data:1a70ad [app-client] (ecmascript) <text/javascript>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$c12f1c__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__ = __turbopack_context__.i("[project]/src/app/actions/data:c12f1c [app-client] (ecmascript) <text/javascript>");
;
var _s = __turbopack_context__.k.signature();
'use client';
;
;
;
;
const statusTone = {
    active: 'text-sage',
    suspended: 'text-honey',
    offboarding: 'text-honey',
    archived: 'text-ink-faint'
};
function TenantSwitcher() {
    _s();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('TenantSwitcher');
    const router = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRouter"])();
    const [state, setState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [open, setOpen] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [pending, startTransition] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransition"])();
    const refreshState = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "TenantSwitcher.useCallback[refreshState]": async ()=>{
            const res = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$6ba00f__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__["getTenantSwitcherState"])();
            if (res.success) setState(res.data);
        }
    }["TenantSwitcher.useCallback[refreshState]"], []);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "TenantSwitcher.useEffect": ()=>{
            let cancelled = false;
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$6ba00f__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__["getTenantSwitcherState"])().then({
                "TenantSwitcher.useEffect": (res)=>{
                    if (!cancelled && res.success) setState(res.data);
                }
            }["TenantSwitcher.useEffect"]);
            return ({
                "TenantSwitcher.useEffect": ()=>{
                    cancelled = true;
                }
            })["TenantSwitcher.useEffect"];
        }
    }["TenantSwitcher.useEffect"], []);
    if (!state) return null;
    const active = state.tenants.find((t)=>t.id === state.activeTenantId) ?? null;
    const label = active?.displayName ?? (state.kind === 'platform' ? t('platform') : t('noTenant'));
    // A tenant selector only adds value when there is actually another tenant
    // to switch to. Keep the header quiet for the common single-tenant case.
    if (state.tenants.length < 2) return null;
    const interactive = state.isSuperadmin || state.tenants.length > 1 || state.assumed;
    const doSwitch = (tenantId)=>{
        if (tenantId === state.activeTenantId && !state.assumed) {
            setOpen(false);
            return;
        }
        startTransition(async ()=>{
            setOpen(false);
            const res = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$1a70ad__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__["switchTenant"])({
                tenantId
            });
            if (res.success) {
                // A switcher saját state-jét a szerverről töltjük újra (az új cookie-t
                // olvasva) — a reload nem megbízhatóan frissítette a legördülő feliratot,
                // és a stale state miatt a visszaváltás no-op lett. A tartalmat a
                // router.refresh() (+ az action revalidatePath-je) frissíti.
                await refreshState();
                router.refresh();
            }
        });
    };
    const doExit = ()=>{
        startTransition(async ()=>{
            setOpen(false);
            const res = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$actions$2f$data$3a$c12f1c__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$text$2f$javascript$3e$__["exitTenant"])();
            if (res.success) {
                await refreshState();
                router.refresh();
            }
        });
    };
    if (!interactive) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
            className: "hidden items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft sm:inline-flex",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    "aria-hidden": true,
                    children: "🏢"
                }, void 0, false, {
                    fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                    lineNumber: 103,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                    className: "max-w-[10rem] truncate",
                    children: label
                }, void 0, false, {
                    fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                    lineNumber: 104,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
            lineNumber: 102,
            columnNumber: 7
        }, this);
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "relative hidden sm:block",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                type: "button",
                "aria-haspopup": "menu",
                "aria-expanded": open,
                disabled: pending,
                onClick: ()=>setOpen((o)=>!o),
                className: "inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep disabled:opacity-60",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        "aria-hidden": true,
                        children: state.assumed ? '🕵️' : '🏢'
                    }, void 0, false, {
                        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                        lineNumber: 119,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "max-w-[10rem] truncate",
                        children: label
                    }, void 0, false, {
                        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                        lineNumber: 120,
                        columnNumber: 9
                    }, this),
                    state.assumed && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "rounded-full bg-honey/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-honey",
                        children: "assumed"
                    }, void 0, false, {
                        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                        lineNumber: 122,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
                        "aria-hidden": true,
                        viewBox: "0 0 12 12",
                        className: `h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`,
                        fill: "none",
                        stroke: "currentColor",
                        strokeWidth: "1.6",
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                            d: "M2.5 4.5 6 8l3.5-3.5",
                            strokeLinecap: "round",
                            strokeLinejoin: "round"
                        }, void 0, false, {
                            fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                            lineNumber: 127,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                        lineNumber: 126,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                lineNumber: 111,
                columnNumber: 7
            }, this),
            open && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Fragment"], {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                        type: "button",
                        "aria-hidden": true,
                        tabIndex: -1,
                        onClick: ()=>setOpen(false),
                        className: "fixed inset-0 z-30 cursor-default"
                    }, void 0, false, {
                        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                        lineNumber: 133,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        role: "menu",
                        className: "absolute right-0 top-full z-40 mt-2 min-w-[15rem] rounded-2xl border border-line bg-night/95 p-1.5 shadow-xl backdrop-blur-xl",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint",
                                children: t('pick')
                            }, void 0, false, {
                                fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                lineNumber: 135,
                                columnNumber: 13
                            }, this),
                            state.tenants.length === 0 && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "px-3 py-2 text-xs text-ink-faint",
                                children: t('empty')
                            }, void 0, false, {
                                fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                lineNumber: 139,
                                columnNumber: 15
                            }, this),
                            state.tenants.map((t)=>{
                                const isActive = t.id === state.activeTenantId && !state.assumed;
                                const isAssumedActive = t.id === state.activeTenantId && state.assumed;
                                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    type: "button",
                                    role: "menuitem",
                                    disabled: pending,
                                    onClick: ()=>doSwitch(t.id),
                                    className: `flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-60 ${isActive || isAssumedActive ? 'bg-coral/10 text-coral-deep' : 'text-ink-soft hover:bg-coral/8 hover:text-ink'}`,
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "min-w-0",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "block truncate",
                                                    children: t.displayName
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                                    lineNumber: 156,
                                                    columnNumber: 21
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "block truncate text-[11px] text-ink-faint",
                                                    children: t.slug
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                                    lineNumber: 157,
                                                    columnNumber: 21
                                                }, this)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                            lineNumber: 155,
                                            columnNumber: 19
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "flex shrink-0 items-center gap-1.5",
                                            children: [
                                                !t.isMembership && state.isSuperadmin && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "rounded-full bg-honey/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-honey",
                                                    children: "assume"
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                                    lineNumber: 161,
                                                    columnNumber: 23
                                                }, this),
                                                t.status !== 'active' && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: `text-[10px] font-bold uppercase ${statusTone[t.status] ?? 'text-ink-faint'}`,
                                                    children: t.status
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                                    lineNumber: 166,
                                                    columnNumber: 23
                                                }, this),
                                                (isActive || isAssumedActive) && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    "aria-hidden": true,
                                                    className: "text-coral",
                                                    children: "✓"
                                                }, void 0, false, {
                                                    fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                                    lineNumber: 170,
                                                    columnNumber: 55
                                                }, this)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                            lineNumber: 159,
                                            columnNumber: 19
                                        }, this)
                                    ]
                                }, t.id, true, {
                                    fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                    lineNumber: 145,
                                    columnNumber: 17
                                }, this);
                            }),
                            (state.assumed || state.kind === 'platform') && state.isSuperadmin && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Fragment"], {
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "my-1 border-t border-line/60"
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                        lineNumber: 178,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                        type: "button",
                                        role: "menuitem",
                                        disabled: pending,
                                        onClick: doExit,
                                        className: "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-ink-soft transition-colors hover:bg-coral/8 hover:text-ink disabled:opacity-60",
                                        children: t('exitPlatform')
                                    }, void 0, false, {
                                        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                                        lineNumber: 179,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, void 0, true)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
                        lineNumber: 134,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/tenant/tenant-switcher.tsx",
        lineNumber: 110,
        columnNumber: 5
    }, this);
}
_s(TenantSwitcher, "K3kRo0P792W2hFQL5XwetQ4UJgQ=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRouter"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTransition"]
    ];
});
_c = TenantSwitcher;
var _c;
__turbopack_context__.k.register(_c, "TenantSwitcher");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
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
"[project]/src/lib/control-plane-embed-bridge.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ControlPlaneEmbedBridge",
    ()=>ControlPlaneEmbedBridge,
    "useEmbedLoading",
    ()=>useEmbedLoading
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2d$messages$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-embed-messages.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
;
const EmbedBridgeContext = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createContext"])(null);
function postEmbedReady() {
    if (window.parent === window) return;
    window.parent.postMessage(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2d$messages$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["CP_EMBED_READY_MESSAGE"], window.location.origin);
}
function ControlPlaneEmbedBridge({ children }) {
    _s();
    const pendingRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(0);
    const readySentRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(false);
    const maybeNotifyReady = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "ControlPlaneEmbedBridge.useCallback[maybeNotifyReady]": ()=>{
            if (pendingRef.current > 0 || readySentRef.current) return;
            readySentRef.current = true;
            postEmbedReady();
        }
    }["ControlPlaneEmbedBridge.useCallback[maybeNotifyReady]"], []);
    const setLoading = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "ControlPlaneEmbedBridge.useCallback[setLoading]": (loading)=>{
            if (loading) {
                pendingRef.current += 1;
                readySentRef.current = false;
                return;
            }
            pendingRef.current = Math.max(0, pendingRef.current - 1);
            if (pendingRef.current === 0) {
                maybeNotifyReady();
            }
        }
    }["ControlPlaneEmbedBridge.useCallback[setLoading]"], [
        maybeNotifyReady
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "ControlPlaneEmbedBridge.useEffect": ()=>{
            const id = window.requestAnimationFrame({
                "ControlPlaneEmbedBridge.useEffect.id": ()=>{
                    maybeNotifyReady();
                }
            }["ControlPlaneEmbedBridge.useEffect.id"]);
            return ({
                "ControlPlaneEmbedBridge.useEffect": ()=>window.cancelAnimationFrame(id)
            })["ControlPlaneEmbedBridge.useEffect"];
        }
    }["ControlPlaneEmbedBridge.useEffect"], [
        maybeNotifyReady
    ]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(EmbedBridgeContext.Provider, {
        value: {
            setLoading
        },
        children: children
    }, void 0, false, {
        fileName: "[project]/src/lib/control-plane-embed-bridge.tsx",
        lineNumber: 50,
        columnNumber: 10
    }, this);
}
_s(ControlPlaneEmbedBridge, "D9FzRq6jlfBhEWc3nuhh9XuGXbY=");
_c = ControlPlaneEmbedBridge;
function useEmbedLoading(loading) {
    _s1();
    const ctx = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useContext"])(EmbedBridgeContext);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useEmbedLoading.useEffect": ()=>{
            if (!ctx || !loading) return;
            ctx.setLoading(true);
            return ({
                "useEmbedLoading.useEffect": ()=>ctx.setLoading(false)
            })["useEmbedLoading.useEffect"];
        }
    }["useEmbedLoading.useEffect"], [
        ctx,
        loading
    ]);
}
_s1(useEmbedLoading, "tJQtUCnOfpeQOsuC4fjNnBqBIQE=");
var _c;
__turbopack_context__.k.register(_c, "ControlPlaneEmbedBridge");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/control-plane/control-plane-shell.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ControlPlaneRoot",
    ()=>ControlPlaneRoot,
    "ControlPlaneShell",
    ()=>ControlPlaneShell
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/navigation.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/react-client/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$shell$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/shell.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$public$2d$site$2f$locale$2d$switcher$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/public-site/locale-switcher.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$tenant$2f$tenant$2d$switcher$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/tenant/tenant-switcher.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2d$bridge$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-embed-bridge.tsx [app-client] (ecmascript)");
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
function subscribeNever() {
    return ()=>{};
}
function readInIframe() {
    return window.parent !== window;
}
function readClientMounted() {
    return true;
}
function ControlPlaneRoot({ embedFromServer, navItems = [], children }) {
    _s();
    const hydrated = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useSyncExternalStore"])(subscribeNever, readClientMounted, {
        "ControlPlaneRoot.useSyncExternalStore[hydrated]": ()=>false
    }["ControlPlaneRoot.useSyncExternalStore[hydrated]"]);
    // A szerver csak fejlécből tud embedet — preview/iframe-ben a kliens is látja.
    // Hydration előtt ne váltsunk ágakat, különben Shell ↔ EmbedBridge fiber újrahasználat
    // → „Rendered more hooks than during the previous render”.
    const inIframeLive = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useSyncExternalStore"])(subscribeNever, readInIframe, {
        "ControlPlaneRoot.useSyncExternalStore[inIframeLive]": ()=>false
    }["ControlPlaneRoot.useSyncExternalStore[inIframeLive]"]);
    const embed = embedFromServer || hydrated && inIframeLive;
    if (embed) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2d$bridge$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ControlPlaneEmbedBridge"], {
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "min-h-full bg-night px-4 py-6 text-ink sm:px-6",
                children: children
            }, void 0, false, {
                fileName: "[project]/src/app/control-plane/control-plane-shell.tsx",
                lineNumber: 45,
                columnNumber: 9
            }, this)
        }, "embed", false, {
            fileName: "[project]/src/app/control-plane/control-plane-shell.tsx",
            lineNumber: 44,
            columnNumber: 7
        }, this);
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(ControlPlaneShell, {
        navItems: navItems,
        children: children
    }, "shell", false, {
        fileName: "[project]/src/app/control-plane/control-plane-shell.tsx",
        lineNumber: 50,
        columnNumber: 5
    }, this);
}
_s(ControlPlaneRoot, "VId/yCMTX2BaP68aJB0l3Dfdm9o=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useSyncExternalStore"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useSyncExternalStore"]
    ];
});
_c = ControlPlaneRoot;
function ControlPlaneShell({ navItems, children }) {
    _s1();
    const pathname = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["usePathname"])();
    const t = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"])('ControlPlane.shell');
    // TenantSwitcher useRouter()-t hív — loading.tsx + RSC redirect közben ez Router hook-hibát dob.
    const headerReady = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useSyncExternalStore"])(subscribeNever, readClientMounted, {
        "ControlPlaneShell.useSyncExternalStore[headerReady]": ()=>false
    }["ControlPlaneShell.useSyncExternalStore[headerReady]"]);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$shell$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["AppShell"], {
        appName: t('appName'),
        appSubtitle: t('appSubtitle'),
        navItems: navItems,
        accentColor: "slate",
        pathname: pathname,
        headerExtra: headerReady ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "flex items-center gap-1.5 sm:gap-2",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$public$2d$site$2f$locale$2d$switcher$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["LocaleSwitcher"], {}, void 0, false, {
                    fileName: "[project]/src/app/control-plane/control-plane-shell.tsx",
                    lineNumber: 78,
                    columnNumber: 13
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$tenant$2f$tenant$2d$switcher$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["TenantSwitcher"], {}, void 0, false, {
                    fileName: "[project]/src/app/control-plane/control-plane-shell.tsx",
                    lineNumber: 79,
                    columnNumber: 13
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/app/control-plane/control-plane-shell.tsx",
            lineNumber: 77,
            columnNumber: 11
        }, this) : null,
        children: children
    }, void 0, false, {
        fileName: "[project]/src/app/control-plane/control-plane-shell.tsx",
        lineNumber: 69,
        columnNumber: 5
    }, this);
}
_s1(ControlPlaneShell, "czSH1ZGc2g7bdRz9AbgqjpwMNbM=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["usePathname"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$react$2d$client$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useTranslations"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useSyncExternalStore"]
    ];
});
_c1 = ControlPlaneShell;
var _c, _c1;
__turbopack_context__.k.register(_c, "ControlPlaneRoot");
__turbopack_context__.k.register(_c1, "ControlPlaneShell");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=src_1k88rc9._.js.map