/**
 * Mini app megnyitás (#967 §5.3): platform-tulajdonú keretoldal információs sávval
 * (D13), alatta sandboxolt iframe az agent HTML-jével; lejárt-oldal (410); a
 * letöltéshez statikus sáv. Az agent JS-e a keretoldalt nem éri el, így a sávot
 * nem tudja eltüntetni.
 */

export const MINI_APP_TIME_ZONE = 'Europe/Budapest'

/**
 * Az agent HTML-je: hálózat nélkül, saját opaque originben (CSP `sandbox allow-scripts`).
 * Csak a vele azonos originű keretoldal ágyazhatja be (`frame-ancestors 'self'`).
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
    "frame-ancestors 'self'",
    "base-uri 'none'",
    'sandbox allow-scripts',
  ].join('; ')
}

/**
 * A keretoldal: nincs agent-JS, csak a sáv és a tartalom-iframe. A keretet
 * a Control Plane előnézete és a desktop kliensek MCP Apps nézője is
 * beágyazza (változó, előre nem ismert origin) — ezért a `frame-ancestors`
 * nyitott; a keretoldalon nincs kattintható művelet, ami clickjackinggel
 * visszaélhető lenne (a „Megnyitás a platformon" bejelentkezést kér).
 */
export function miniAppFrameCsp(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "frame-src 'self'",
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
  const parts = miniAppBarParts(input)
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
<iframe src="${escapeHtml(input.contentUrl)}" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(input.name)}"></iframe>
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
