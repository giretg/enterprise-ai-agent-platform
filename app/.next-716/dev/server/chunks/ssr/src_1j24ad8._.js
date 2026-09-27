module.exports = [
"[project]/src/lib/nav-online-invoice-software.ts [app-rsc] (ecmascript, async loader)", ((__turbopack_context__) => {

__turbopack_context__.v((parentImport) => {
    return Promise.all([
  "server/chunks/ssr/src_lib_db_ts_0ti5n-f._.js",
  "server/chunks/ssr/src_lib_nav-online-invoice-software_ts_00yhpeg._.js"
].map((chunk) => __turbopack_context__.l(chunk))).then(() => {
        return parentImport("[project]/src/lib/nav-online-invoice-software.ts [app-rsc] (ecmascript)");
    });
});
}),
"[project]/src/domain/connector/connector-secret-store.ts [app-rsc] (ecmascript, async loader)", ((__turbopack_context__) => {

__turbopack_context__.v((parentImport) => {
    return Promise.all([
  "server/chunks/ssr/[root-of-the-server]__0_8kjlr._.js"
].map((chunk) => __turbopack_context__.l(chunk))).then(() => {
        return parentImport("[project]/src/domain/connector/connector-secret-store.ts [app-rsc] (ecmascript)");
    });
});
}),
];