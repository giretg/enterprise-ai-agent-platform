module.exports = [
"[project]/src/lib/nav-online-invoice-software.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "NAV_SOFTWARE_PLATFORM_KEY",
    ()=>NAV_SOFTWARE_PLATFORM_KEY,
    "loadNavSoftware",
    ()=>loadNavSoftware,
    "navSoftwareSchema",
    ()=>navSoftwareSchema,
    "parseNavSoftware",
    ()=>parseNavSoftware
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__ = __turbopack_context__.i("[project]/node_modules/zod/v4/classic/external.js [app-rsc] (ecmascript) <export * as z>");
;
const NAV_SOFTWARE_PLATFORM_KEY = 'nav.online_invoice.software';
const navSoftwareSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    softwareId: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().trim().regex(/^[0-9A-Z-]{18}$/, 'A szoftver-azonosító pontosan 18 karakter (nagybetű, szám, kötőjel).'),
    softwareName: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().trim().min(1, 'Add meg a szoftver nevét.').max(50),
    softwareMainVersion: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().trim().min(1, 'Add meg a szoftver verzióját.').max(15),
    softwareDevName: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().trim().min(1, 'Add meg a fejlesztő nevét.').max(512),
    softwareDevContact: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().trim().min(1, 'Add meg a fejlesztő elérhetőségét (e-mail).').max(200),
    softwareDevCountryCode: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().trim().regex(/^[A-Z]{2}$/, 'Az országkód két nagybetű (pl. HU).').default('HU'),
    softwareDevTaxNumber: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().trim().min(1, 'Add meg a fejlesztő adószámát.').max(50)
});
function parseNavSoftware(raw) {
    const parsed = navSoftwareSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
async function loadNavSoftware() {
    const { prisma } = await __turbopack_context__.A("[project]/src/lib/db.ts [app-rsc] (ecmascript, async loader)");
    const row = await prisma.platformSetting.findUnique({
        where: {
            key: NAV_SOFTWARE_PLATFORM_KEY
        }
    });
    return parseNavSoftware(row?.value);
}
}),
];

//# sourceMappingURL=src_lib_nav-online-invoice-software_ts_00yhpeg._.js.map