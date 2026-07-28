/**
 * Bizalmi regiszter — tool-nevenkénti `TrustClass` leképezés + a mellékhatásos
 * eszközök explicit halmaza (issue #97).
 *
 * KULCS-ELV: a besorolás determinisztikus és az agent által NEM befolyásolható
 * (SoD, a §4-es scope-injekció-védelem szellemében). A leképezés a `ToolName`
 * unión KIMERÍTŐEN (exhaustive) készül — egy új tool hozzáadása fordításidőben
 * kényszeríti a bizalmi- és a mellékhatás-döntést, így egy elfelejtett besorolás
 * nem maradhat ki.
 *
 * FAIL-SAFE: a nem leképezett (ismeretlen / jövőbeli) tool alapból a legszigorúbb
 * `external_untrusted` kezelést kapja — egy elfelejtett besorolás inkább egy
 * fölösleges jóváhagyás-kérést okoz, mint egy csendes rést.
 */
import type { ToolName, TrustClass } from './tool-broker-types'

/**
 * A tool-eredmény bizalmi osztálya tool-nevenként. `Record<ToolName, …>` →
 * kimerítő: új tool hozzáadása fordításidőben kényszeríti a döntést.
 *
 * Kezdeti besorolás (issue #97 „Implementation Decisions"):
 *   external_untrusted — kívülről beszedett adat (levél, web, ügyfél-feltöltés, 3rd-party API)
 *   internal           — a tenant belső rendszeréből (tudásbázis, directory, katalógus)
 *   trusted            — platform-determinisztikus eredmény (visszaigazolások)
 */
export const TOOL_TRUST_REGISTRY: Record<ToolName, TrustClass> = {
  // ── external_untrusted: bárki eljuttathatja a rendszerhez ──────────────────
  gmail_search: 'external_untrusted',
  gmail_get_message: 'external_untrusted',
  mailbox_count: 'external_untrusted',
  http_api_get: 'external_untrusted',
  http_api_request: 'external_untrusted',
  web_search: 'external_untrusted',
  web_research_request: 'external_untrusted',
  document_read: 'external_untrusted',
  tulajdoni_lap_parse: 'external_untrusted',
  tulajdoni_lap_egyeztetes: 'external_untrusted',

  // ── internal: a tenant belső rendszeréből ──────────────────────────────────
  kb_search: 'internal',
  kb_list_index: 'internal',
  kb_get_page: 'internal',
  user_directory: 'internal',
  agent_catalog: 'internal',
  agent_resolve: 'internal',
  // Másik (tenant-belső) agent válasza — belső rendszerből származó tartalom.
  agent_ask: 'internal',

  // ── trusted: platform-determinisztikus eredmények / visszaigazolások ───────
  board_write: 'trusted',
  ticket_create: 'trusted',
  gmail_create_draft: 'trusted',
  gmail_send: 'trusted',
  repo_prepare: 'trusted',
  repo_open_pull_request: 'trusted',
  file_read: 'trusted',
  file_write: 'trusted',
  create_html: 'trusted',
  file_edit: 'trusted',
  file_list: 'trusted',
  file_glob: 'trusted',
  file_search: 'trusted',
  file_delete: 'trusted',
  xlsx_read_sheet: 'trusted',
  xlsx_write_cells: 'trusted',
  xlsx_format_range: 'trusted',
  xlsx_layout: 'trusted',
  xlsx_create: 'trusted',
  xlsx_append_rows: 'trusted',
  docx_read: 'trusted',
  docx_create: 'trusted',
  pdf_read: 'trusted',
  pdf_create: 'trusted',
  pptx_create: 'trusted',
  memory_propose: 'trusted',
  'sandbox_app.create': 'trusted',
  'sandbox_app.update_artifact': 'trusted',
  'sandbox_app.preview': 'trusted',
  'sandbox_app.export': 'trusted',
  'sandbox_app.list': 'trusted',
  'sandbox_app.get': 'trusted',
  'sandbox.commit': 'trusted',
  'sandbox.request_promotion': 'trusted',
  'sandbox.snapshot': 'trusted',
}

/**
 * Egy tool-név bizalmi osztálya. FAIL-SAFE: nem leképezett (ismeretlen / jövőbeli)
 * tool → `external_untrusted`. A leképezés determinisztikus, args-független és az
 * agent által nem befolyásolható.
 */
export function resolveTrustClass(tool: string): TrustClass {
  return TOOL_TRUST_REGISTRY[tool as ToolName] ?? 'external_untrusted'
}

/**
 * A mellékhatásos (mutáló) eszközök explicit, KIMERÍTŐ halmaza.
 * Dokumentáció + fail-safe az ismeretlen toolokra; a következmény-kapu
 * döntését a `consequence-gate-policy` risk-class listája hozza (nem ez a
 * halmaz × taint). A `true` = küldés / írás / jogosultság-változtatás / memória.
 * Az olvasó eszközök `false`-ok.
 */
export const SIDE_EFFECTING_TOOLS: Record<ToolName, boolean> = {
  // ── mutáló: küldés / írás / jogosultság- vagy memória-változtatás ──────────
  gmail_create_draft: true,
  gmail_send: true,
  http_api_request: true,
  repo_open_pull_request: true,
  file_write: true,
  create_html: true,
  file_edit: true,
  file_delete: true,
  xlsx_write_cells: true,
  xlsx_format_range: true,
  xlsx_layout: true,
  xlsx_create: true,
  xlsx_append_rows: true,
  docx_create: true,
  pdf_create: true,
  pptx_create: true,
  board_write: true,
  ticket_create: true,
  memory_propose: true,
  'sandbox_app.create': true,
  'sandbox_app.update_artifact': true,
  'sandbox_app.export': true,
  'sandbox.commit': true,
  'sandbox.request_promotion': true,
  'sandbox.snapshot': true,

  // ── olvasó / lekérdező: a következmény-kapu NEM blokkolja ──────────────────
  gmail_search: false,
  gmail_get_message: false,
  mailbox_count: false,
  http_api_get: false,
  web_search: false,
  web_research_request: false,
  document_read: false,
  tulajdoni_lap_parse: false,
  // Munkaterületre ír (egyeztető munkafüzet) — mellékhatásos.
  tulajdoni_lap_egyeztetes: true,
  kb_search: false,
  kb_list_index: false,
  kb_get_page: false,
  user_directory: false,
  agent_catalog: false,
  agent_resolve: false,
  // Kérdés egy másik agentnek: delegálás/olvasás jellegű, nem a mutáló halmaz része.
  agent_ask: false,
  repo_prepare: false,
  file_read: false,
  file_list: false,
  file_glob: false,
  file_search: false,
  xlsx_read_sheet: false,
  docx_read: false,
  pdf_read: false,
  'sandbox_app.preview': false,
  'sandbox_app.list': false,
  'sandbox_app.get': false,
}

/**
 * Mellékhatásos-e a tool? FAIL-SAFE: nem leképezett (ismeretlen / jövőbeli) tool
 * → `true` (a kapu inkább kérjen fölöslegesen jóváhagyást, mint hogy egy új
 * mutáló tool csendben kicsússzon).
 */
export function isSideEffectingTool(tool: string): boolean {
  return SIDE_EFFECTING_TOOLS[tool as ToolName] ?? true
}
