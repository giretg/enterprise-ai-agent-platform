/**
 * Bizalmi regiszter — tool-nevenkénti `TrustClass` leképezés + a mellékhatásos
 * eszközök explicit halmaza (issue #97).
 *
 * A besorolás FORRÁSA a kanonikus `TOOL_REGISTRY` (`tool-registry.ts`, issue
 * #194): a `trust` és a `sideEffecting` a descriptor mezői, ez a modul már csak
 * a bevált publikus felületet (`TOOL_TRUST_REGISTRY`, `SIDE_EFFECTING_TOOLS`,
 * `resolveTrustClass`, `isSideEffectingTool`) tartja fenn, vetületként.
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
import { TOOL_NAMES, TOOL_REGISTRY } from './tool-registry'

function projectRegistry<T>(pick: (name: ToolName) => T): Record<ToolName, T> {
  const out = {} as Record<ToolName, T>
  for (const name of TOOL_NAMES) out[name] = pick(name)
  return out
}

/**
 * A tool-eredmény bizalmi osztálya tool-nevenként. `Record<ToolName, …>` →
 * kimerítő: új tool hozzáadása fordításidőben kényszeríti a döntést.
 *
 * Besorolás (issue #97 „Implementation Decisions"):
 *   external_untrusted — kívülről beszedett adat (levél, web, ügyfél-feltöltés, 3rd-party API)
 *   internal           — a tenant belső rendszeréből (tudásbázis, directory, katalógus)
 *   trusted            — platform-determinisztikus eredmény (visszaigazolások)
 */
export const TOOL_TRUST_REGISTRY: Record<ToolName, TrustClass> = projectRegistry(
  (name) => TOOL_REGISTRY[name].trust,
)

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
export const SIDE_EFFECTING_TOOLS: Record<ToolName, boolean> = projectRegistry(
  (name) => TOOL_REGISTRY[name].sideEffecting,
)

/**
 * Mellékhatásos-e a tool? FAIL-SAFE: nem leképezett (ismeretlen / jövőbeli) tool
 * → `true` (a kapu inkább kérjen fölöslegesen jóváhagyást, mint hogy egy új
 * mutáló tool csendben kicsússzon).
 */
export function isSideEffectingTool(tool: string): boolean {
  return SIDE_EFFECTING_TOOLS[tool as ToolName] ?? true
}
