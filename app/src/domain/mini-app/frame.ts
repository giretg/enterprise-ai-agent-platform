/**
 * Mini app megnyitás (#967 §5.3): platform-tulajdonú keretoldal információs sávval
 * (D13), alatta sandboxolt iframe az agent HTML-jével; lejárt-oldal (410); a
 * letöltéshez statikus sáv. Az agent JS-e a keretoldalt nem éri el, így a sávot
 * nem tudja eltüntetni.
 */

import { inlineScriptBodies, MINI_APP_DATA_ELEMENT_ID, scriptHashSource } from './data-binding'

export const MINI_APP_TIME_ZONE = 'Europe/Budapest'

/**
 * Az agent HTML-je: hálózat nélkül, saját opaque originben (CSP `sandbox allow-scripts`).
 * A `frame-ancestors` a teljes ős-láncot nézi (Control Plane / MCP-kliens → keretoldal
 * → tartalom), és a sandboxolt keretoldal originje opaque — ezért `'self'` itt mindig
 * blokkolna. A tartalmat az aláírt token védi, nem a beágyazó.
 */
export function miniAppContentCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    'frame-ancestors *',
    "base-uri 'none'",
    'sandbox allow-scripts',
    "require-trusted-types-for 'script'",
  ].join('; ')
}

/**
 * Kötött verzió (#1083 §5): a beszúrt eseménykezelő és szkript nem fut, csak a platform
 * és az agent mentett szkriptje, tartalmuk hash-e alapján. Azért nem nonce, mert a nonce a
 * dinamikusan betöltött kódra is öröklődik. Minden más irányelv a statikus appéval azonos.
 */
export function miniAppBoundContentCsp(scriptSources: string[]): string {
  return miniAppContentCsp().replace("script-src 'unsafe-inline'", `script-src ${scriptSources.join(' ')}`)
}

/**
 * A letöltött fájlt nem védi válaszfejléc, ezért ugyanez `<meta>`-ban utazik vele. A `sandbox`
 * és a `frame-ancestors` meta-ban nem érvényes, a többi igen.
 */
function miniAppDownloadCsp(scriptSources: string[]): string {
  return miniAppBoundContentCsp(scriptSources)
    .split('; ')
    .filter((directive) => !directive.startsWith('sandbox') && !directive.startsWith('frame-ancestors'))
    .join('; ')
}

/** A tartalom-válasz további hálózati korlátja: üres lista, a dokumentum sehova nem kapcsolódhat. */
export const MINI_APP_CONTENT_HEADERS: Record<string, string> = {
  'Connection-Allowlist': '()',
}

/**
 * A platform saját indítószkriptje: az agent kódja előtt fut, és szűkíti a
 * böngésző-API-kat. ES5, hogy minden böngészőben lefusson; a végén eltávolítja
 * magát a DOM-ból, így az agent kódja ugyanazt a dokumentumot látja.
 */
const MINI_APP_HARDENING_JS = `(function(w,d){
Object.getOwnPropertyNames(w).forEach(function(n){if(/RTC/.test(n))try{delete w[n]}catch(e){}});
try{delete w.XSLTProcessor}catch(e){}
var t=w.trustedTypes;
if(t){
var tail='',P=Object.getPrototypeOf(t),same=function(s){return s};
var clean=function(s,_,sink){
s=String(s);sink=String(sink);
if(/srcdoc/i.test(sink))return '';
if(/write/.test(sink)){var j=tail+s;tail=s.slice(-5);if(/srcdoc/i.test(j)&&!/srcdoc/i.test(s))return null}
return s.replace(/srcdoc/gi,'data-blocked')};
t.createPolicy('default',{createHTML:clean,createScript:same,createScriptURL:same});
P.createPolicy=function(n,r){r=r||{};var f=function(k){return function(){if(!r[k])throw new TypeError(k);return String(r[k].apply(r,arguments))}};return{name:n,createHTML:f('createHTML'),createScript:f('createScript'),createScriptURL:f('createScriptURL')}};
}
d.currentScript.remove();
})(window,document)`

/**
 * Az indítószkript a válasz legelső szkriptje lesz, bármi is van az agent HTML-jében.
 * Ha az eredeti dokumentum doctype-pal kezdődik, azt előrevesszük, hogy a megjelenítési
 * mód ne változzon. Itt tévedni nem biztonsági hiba: a doctype az első `>`-ig tart, utána
 * mindenképp a mi szkriptünk jön. (Lineáris bejárás: az agent HTML-je nem lassíthatja.)
 */
export function withMiniAppHardening(html: string): string {
  const { doctype, source } = splitDoctype(html)
  return `${doctype}<script>${MINI_APP_HARDENING_JS}</script>${source}`
}

function splitDoctype(html: string): { doctype: string; source: string } {
  const source = html.charCodeAt(0) === 0xfeff ? html.slice(1) : html
  let at = 0
  for (;;) {
    while (at < source.length && /\s/.test(source[at]!)) at += 1
    if (!source.startsWith('<!--', at)) break
    const end = source.indexOf('-->', at + 4)
    if (end < 0) break
    at = end + 3
  }
  return { doctype: /^<!doctype[^>]*>/i.exec(source.slice(at, at + 1024))?.[0] ?? '', source }
}

/**
 * Kötött verzió indítószkriptje. A statikus keményítésen túl: szkript-URL nem állítható be,
 * és HTML-szövegből nem jöhet létre szkript. A kaput a CSP adja, ez a D5 szerinti csökkentés.
 */
const MINI_APP_BOUND_HARDENING_JS = MINI_APP_HARDENING_JS
  .replace('createScriptURL:same', 'createScriptURL:function(){return null}')
  .replace("s=String(s);sink=String(sink);", "s=String(s).replace(/<script/gi,'<x-blocked');sink=String(sink);")
  .replace("tail=s.slice(-5);if(/srcdoc/i.test(j)&&!/srcdoc/i.test(s))return null", "tail=s.slice(-6);if(/srcdoc|<script/i.test(j)&&!/srcdoc/i.test(s))return null")

/**
 * A kötött verzió dokumentuma és CSP-je: doctype, indítószkript, adatblokk, majd az agent
 * változatlan HTML-je. A hash-ek az agent mentett HTML-jéből készülnek, így cellaérték
 * soha nem kap engedélyt, akárhová is íródik ki.
 */
export function buildMiniAppLiveDocument(html: string, input: { dataJson: string; meta?: boolean }): { html: string; csp: string } {
  const { doctype, source } = splitDoctype(html)
  const sources = [MINI_APP_BOUND_HARDENING_JS, ...new Set(inlineScriptBodies(source))].map(scriptHashSource)
  const meta = input.meta ? `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(miniAppDownloadCsp(sources))}">` : ''
  return {
    html: `${doctype}${meta}<script>${MINI_APP_BOUND_HARDENING_JS}</script><script type="application/json" id="${MINI_APP_DATA_ELEMENT_ID}">${input.dataJson}</script>${source}`,
    csp: miniAppBoundContentCsp(sources),
  }
}

/**
 * A tartalom csak beágyazva szolgálható ki (a keretoldalon belül): a közvetlen
 * megnyitást a keretoldalra irányítjuk, minden más lekérést elutasítunk. A fejléc
 * hiánya (régi böngésző, nem-böngésző kliens) a mai viselkedést hagyja.
 */
export function miniAppContentFetchDecision(secFetchDest: string | null): 'serve' | 'open_frame' | 'reject' {
  if (!secFetchDest || secFetchDest === 'iframe' || secFetchDest === 'frame') return 'serve'
  return secFetchDest === 'document' ? 'open_frame' : 'reject'
}

/** Kötött appnál a tartalom csak iframe-be tölthető: a fejléc hiánya sem elég (§5). */
export function miniAppBoundContentFetchDecision(secFetchDest: string | null): 'serve' | 'open_frame' | 'reject' {
  if (secFetchDest === 'iframe' || secFetchDest === 'frame') return 'serve'
  return !secFetchDest || secFetchDest === 'document' ? 'open_frame' : 'reject'
}

/**
 * A keretoldal: nincs agent-JS, csak a sáv és a tartalom-iframe. A keretet
 * a Control Plane előnézete és a desktop kliensek MCP Apps nézője is
 * beágyazza (változó, előre nem ismert origin) — ezért a `frame-ancestors`
 * nyitott; a keretoldalon nincs kattintható művelet, ami clickjackinggel
 * visszaélhető lenne (a „Megnyitás a platformon" bejelentkezést kér).
 *
 * A keretoldalt a Control Plane / MCP-kliens is beágyazza. Ha a beágyazó
 * `sandbox` allow-same-origin nélkül fut, a keret originje opaque, és
 * `frame-src 'self'` a tartalom URL-jét nem engedi. A mini app origin
 * host-source kell, ugyanúgy, ahogy a tartalom CSP-je `'self'` helyett
 * `frame-ancestors *`-ot küld. A Control Plane ezért a külső iframe-et
 * nem sandboxolja: a tartalom-iframe + CSP `sandbox` izolál.
 */
export function miniAppFrameCsp(frameSrcOrigin: string): string {
  const origin = new URL(frameSrcOrigin).origin
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `frame-src ${origin}`,
    "base-uri 'none'",
    "form-action 'none'",
    'frame-ancestors *',
  ].join('; ')
}

export const MINI_APP_COMMON_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatMiniAppTime(date: Date): string {
  return new Intl.DateTimeFormat('hu-HU', {
    timeZone: MINI_APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export type MiniAppBarInput = {
  name: string
  createdAt: Date
  /** Az aktuálisan megnyitott verzió készítési ideje. */
  versionCreatedAt: Date
  ownerAgentName: string
  version: number
  currentVersion: number
  /** Kötött verzió: élő adat állapota (§4.4); az agent nem tudja eltüntetni. */
  live?: MiniAppLiveBar
}

export type MiniAppLiveBar = {
  /** `live`: böngészőben frissül; `download`: a fájl már nem frissül; `denied`: adat nem ment ki. */
  mode: 'live' | 'download' | 'denied'
  lastLoadAt: Date | null
  /** Hétköznapi figyelmeztetések, cellaérték nélkül. */
  warnings: string[]
  dataTakenAt?: Date
}

/** A sáv élő adatról szóló része: a keretoldal és a letöltés közös forrása. */
export function miniAppLiveBarParts(live: MiniAppLiveBar): string[] {
  const parts: string[] = []
  if (live.mode === 'live') parts.push('Élő adat')
  if (live.mode === 'download') parts.push(`Adatok állapota: ${formatMiniAppTime(live.dataTakenAt ?? new Date())} · ez a fájl már nem frissül`)
  if (live.mode === 'denied') parts.push('Az élő adat nem jelenik meg')
  if (live.mode !== 'denied') parts.push(live.lastLoadAt ? `Utolsó betöltés: ${formatMiniAppTime(live.lastLoadAt)}` : 'Még nem volt adatbetöltés')
  return [...parts, ...live.warnings.map((warning) => `⚠ ${warning}`)]
}

/** A sáv szöveges részei (§5.3) — a keretoldal és a letöltés közös forrása. */
export function miniAppBarParts(input: MiniAppBarInput): string[] {
  const parts = [`Készült: ${formatMiniAppTime(input.createdAt)}`]
  if (input.version > 1) parts.push(`Utoljára módosítva: ${formatMiniAppTime(input.versionCreatedAt)}`)
  parts.push(`Készítette: ${input.ownerAgentName}`, `${input.version}. verzió`)
  if (input.version < input.currentVersion) {
    parts.push(`Ez a ${input.version}. verzió — van újabb (${input.currentVersion}.)`)
  }
  return parts
}

const BAR_STYLE =
  'font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#1f2933;color:#f5f7fa;padding:8px 14px;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center'

function barHtml(input: MiniAppBarInput): string {
  const parts = [...(input.live ? miniAppLiveBarParts(input.live) : []), ...miniAppBarParts(input)]
    .map((part) => `<span style="opacity:.85">${escapeHtml(part)}</span>`)
    .join('<span aria-hidden="true" style="opacity:.4">·</span>')
  return `<div role="banner" data-mini-app-bar style="${BAR_STYLE}"><strong>${escapeHtml(input.name)}</strong><span aria-hidden="true" style="opacity:.4">·</span>${parts}</div>`
}

export function renderMiniAppFrame(input: MiniAppBarInput & { contentUrl: string }): string {
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(input.name)}</title>
<style>html,body{margin:0;height:100%;background:#fff}body{display:flex;flex-direction:column}iframe{flex:1;border:0;width:100%}a{color:#ffd8cc}</style>
</head>
<body>
${barHtml(input)}
${input.live?.mode === 'denied' ? '<main style="font:15px/1.5 system-ui,sans-serif;padding:24px;color:#1f2933">Ez a riport élő adatból dolgozik, az adat most nem jeleníthető meg. Az okot a fenti sáv írja ki.</main>' : `<iframe src="${escapeHtml(input.contentUrl)}" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(input.name)}"></iframe>`}
</body>
</html>`
}

/** Letöltés .html-ként: a sáv statikus HTML-ként a `<body>` elejére kerül (§5.3). */
export function withStaticMiniAppBar(html: string, input: MiniAppBarInput): string {
  const bar = barHtml(input)
  const body = /<body[^>]*>/i.exec(html)
  if (body) {
    const at = body.index + body[0].length
    return `${html.slice(0, at)}\n${bar}\n${html.slice(at)}`
  }
  return `${bar}\n${html}`
}

/** 410 lejárt/érvénytelen link: agent-tartalom és a riport neve nélkül (§5.3.1). */
export function renderMiniAppExpiredPage(input: { permanentUrl: string | null; reason: 'expired' | 'invalid' }): string {
  const title = input.reason === 'expired' ? 'Ez a link lejárt.' : 'Ez a link nem érvényes.'
  const button = input.permanentUrl
    ? `<p><a class="btn" href="${escapeHtml(input.permanentUrl)}" target="_top" rel="noreferrer">Megnyitás a platformon</a></p>`
    : ''
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#1f2933}h1{font-size:22px}.btn{display:inline-block;background:#e4572e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}p{color:#52606d}</style>
</head>
<body>
<h1>${title}</h1>
<p>A gyors megnyitási linkek biztonsági okból csak korlátozott ideig érvényesek. A riportot újra megnyithatod a platformon (bejelentkezés szükséges).</p>
${button}
<p>Vagy kérd meg az AI munkatársat, hogy adjon új linket.</p>
</body>
</html>`
}
