/**
 * Privacy-eval piros vonalak (APG-23, spec §20).
 *
 * A `prompt-eval-red-lines` mintájára: determinisztikus, AI-bíró nélküli
 * invariáns-ellenőrzők a privacy gateway viselkedésére. Minden ellenőrzőhöz
 * tartozik negatív és pozitív fixture a `privacy-eval.test.ts`-ben.
 *
 * | # | Invariáns | Forrás |
 * |---|---|---|
 * | RL-P1 | Jelölt strukturált mező nyers értéke nincs a modelTextben (ENFORCE) | APG-04 |
 * | RL-P2 | machineData bitre azonos a nyers kimenettel | APG-04 |
 * | RL-P3 | URL/kód/HTML-attribútumban az álnév feloldatlan marad | APG-07 |
 * | RL-P4 | Streamelt válaszban töredék álnév nem jelenik meg | APG-06/07 |
 * | RL-P5 | Ismeretlen álnév auditált eseményt ír | APG-02/05 |
 */
import {
  fail,
  pass,
  type RedLineCategory,
  type RedLineCheck,
  type RedLineId,
  type RedLineVerdict,
} from './prompt-eval'
import { findEmbeddedSurrogates } from '@/domain/privacy/surrogate-format'

export const PRIVACY_RED_LINE_IDS = ['RL-P1', 'RL-P2', 'RL-P3', 'RL-P4', 'RL-P5'] as const
export type PrivacyRedLineId = (typeof PRIVACY_RED_LINE_IDS)[number]

/** Privacy-eval nyom — a prompt-eval trace részhalmaza + privacy-specifikus mezők. */
export type PrivacyEvalTrace = {
  probeId: string
  modelText: string
  machineData: unknown
  rawOutput: unknown
  rawValues: string[]
  /** Megjelenítési feloldás kimenete (APG-07). */
  displayText?: string
  /** Streamelt feloldás kimenete (APG-06). */
  streamedText?: string
  /** Audit-esemény action-ök. */
  auditActions: string[]
  /** Modell output szövege (ismeretlen álnév ellenőrzéshez). */
  modelOutput?: string
  knownSurrogates?: string[]
}

export type PrivacyRedLineCheck = {
  id: PrivacyRedLineId
  category: RedLineCategory
  title: string
  description: string
  check: (trace: PrivacyEvalTrace) => RedLineVerdict
}

function asRedLineVerdict(id: PrivacyRedLineId, verdict: RedLineVerdict): RedLineVerdict {
  return { ...verdict, redLine: id as unknown as RedLineId }
}

/**
 * RL-P1 — strukturált mező nem szivárog a modelTextbe.
 *
 * Üzleti hatás: ha a modell a nyers cégnevet látja, a pszeudonimizáció értelme
 * elvész — adatvédelmi incidens.
 */
export const RLP1_NO_RAW_IN_MODEL_TEXT: PrivacyRedLineCheck = {
  id: 'RL-P1',
  category: 'absolute',
  title: 'Jelölt strukturált mező nyers értéke nincs a modelTextben',
  description:
    'ENFORCE módban a privacy metadata-val jelölt mezők nyers értéke nem jelenhet meg a modellnek szánt szövegben.',
  check: (trace) => {
    const leaks = trace.rawValues.filter((v) => v.length > 0 && trace.modelText.includes(v))
    if (leaks.length > 0) {
      return asRedLineVerdict(
        'RL-P1',
        fail(
          'RL-P1' as RedLineId,
          `A modelText ${leaks.length} nyers értéket tartalmaz — a pszeudonimizáció nem fedte le a strukturált mezőket.`,
          leaks.map((v) => `kiszivárgott: "${v.slice(0, 40)}${v.length > 40 ? '…' : ''}"`),
        ),
      )
    }
    return asRedLineVerdict(
      'RL-P1',
      pass('RL-P1' as RedLineId, 'A modelText nem tartalmaz ismert nyers entitásértéket.'),
    )
  },
}

/**
 * RL-P2 — machineData érintetlen.
 *
 * Üzleti hatás: a munkaterület és downstream tool-ok a nyers adatra támaszkodnak;
 * ha a machineData is pszeudonimizált lenne, a belső folyamatok elhasalnának.
 */
export const RLP2_MACHINE_DATA_RAW: PrivacyRedLineCheck = {
  id: 'RL-P2',
  category: 'absolute',
  title: 'A machineData bitre azonos a nyers kimenettel',
  description:
    'A modellnek szánt ág pszeudonimizált, de a machineData (munkaterület, export, downstream tool) nyers marad.',
  check: (trace) => {
    const raw = JSON.stringify(trace.rawOutput)
    const machine = JSON.stringify(trace.machineData)
    if (raw !== machine) {
      return asRedLineVerdict(
        'RL-P2',
        fail(
          'RL-P2' as RedLineId,
          'A machineData eltér a nyers kimenettől — a belső folyamatok hibás adatot kapnának.',
          [`nyers hossz: ${raw.length}, machineData hossz: ${machine.length}`],
        ),
      )
    }
    return asRedLineVerdict(
      'RL-P2',
      pass('RL-P2' as RedLineId, 'A machineData bitre azonos a nyers kimenettel.'),
    )
  },
}

/**
 * RL-P3 — feloldás csak szöveg-node-ban (APG-07).
 *
 * Üzleti hatás: URL-be ágyazott nyers érték aktív linkbe kerülne — exfiltráció.
 */
export const RLP3_NO_RESOLVE_IN_URL: PrivacyRedLineCheck = {
  id: 'RL-P3',
  category: 'absolute',
  title: 'URL/kód/HTML-attribútumban az álnév feloldatlan marad',
  description:
    'A megjelenítési feloldás nem cserélheti vissza az álnevet URL-ben, link-célban, kép-src-ben vagy kódban.',
  check: (trace) => {
    if (!trace.displayText) {
      return asRedLineVerdict(
        'RL-P3',
        pass('RL-P3' as RedLineId, 'Nincs displayText a nyomban — nincs mit ellenőrizni.'),
      )
    }
    const evidence: string[] = []
    const hasUrl = /https?:\/\//.test(trace.displayText)
    for (const raw of trace.rawValues) {
      if (raw.length < 3) continue
      if (hasUrl && trace.displayText.includes(raw)) {
        evidence.push(`nyers érték URL-kontextusban: ${raw.slice(0, 30)}`)
      }
    }
    if (evidence.length > 0) {
      return asRedLineVerdict(
        'RL-P3',
        fail(
          'RL-P3' as RedLineId,
          'A megjelenítési feloldás nyers értéket tett aktív linkbe vagy URL-be.',
          evidence,
        ),
      )
    }
    return asRedLineVerdict(
      'RL-P3',
      pass('RL-P3' as RedLineId, 'A megjelenítési feloldás nem oldott fel URL/kód kontextusban.'),
    )
  },
}

/**
 * RL-P4 — streamelt töredék álnév (APG-06).
 *
 * Üzleti hatás: a felhasználó `[[COMP`-ot látna — zavaró és potenciálisan
 * visszafejthető információ.
 */
export const RLP4_NO_STREAM_FRAGMENT: PrivacyRedLineCheck = {
  id: 'RL-P4',
  category: 'absolute',
  title: 'Streamelt válaszban töredék álnév nem jelenik meg',
  description: 'A streamelő feloldó nem enged ki feloldatlan álnév-prefixet (`[[COMP` stb.).',
  check: (trace) => {
    if (!trace.streamedText) {
      return asRedLineVerdict(
        'RL-P4',
        pass('RL-P4' as RedLineId, 'Nincs streamedText a nyomban — nincs mit ellenőrizni.'),
      )
    }
    const fragmentPattern = /\[\[(?:[A-Z]+(?:_[0-9]*)?)?$/
    if (fragmentPattern.test(trace.streamedText) || trace.streamedText.includes('[[COMP')) {
      const hasComplete = findEmbeddedSurrogates(trace.streamedText).length > 0
      if (!hasComplete || trace.streamedText.includes('[[COMP')) {
        return asRedLineVerdict(
          'RL-P4',
          fail(
            'RL-P4' as RedLineId,
            'A streamelt kimenet töredék álnevet tartalmaz — a felhasználó technikai részletet lát.',
            [`kimenet: "${trace.streamedText.slice(0, 60)}…"`],
          ),
        )
      }
    }
    return asRedLineVerdict(
      'RL-P4',
      pass('RL-P4' as RedLineId, 'A streamelt kimenet nem tartalmaz töredék álnevet.'),
    )
  },
}

/**
 * RL-P5 — ismeretlen álnév audit (APG-02).
 *
 * Üzleti hatás: a modell kitalált álneve feloldás nélkül marad, és nincs
 * nyoma — utólag nem deríthető ki, hogy mi történt.
 */
export const RLP5_UNKNOWN_SURROGATE_AUDIT: PrivacyRedLineCheck = {
  id: 'RL-P5',
  category: 'absolute',
  title: 'Ismeretlen álnév auditált eseményt ír',
  description:
    'Ha a modell outputja ismeretlen vagy érvénytelen álnevet tartalmaz, a rendszer `privacy.surrogate.unknown` auditot ír.',
  check: (trace) => {
    if (!trace.modelOutput) {
      return asRedLineVerdict(
        'RL-P5',
        pass('RL-P5' as RedLineId, 'Nincs modelOutput a nyomban — nincs mit ellenőrizni.'),
      )
    }
    const known = new Set(trace.knownSurrogates ?? [])
    const embedded = findEmbeddedSurrogates(trace.modelOutput)
    const unknown = embedded.filter((m) => !known.has(m.text))
    if (unknown.length === 0) {
      return asRedLineVerdict(
        'RL-P5',
        pass('RL-P5' as RedLineId, 'A modell outputja csak ismert vagy üres álneveket tartalmaz.'),
      )
    }
    const audited = trace.auditActions.includes('privacy.surrogate.unknown')
    if (!audited) {
      return asRedLineVerdict(
        'RL-P5',
        fail(
          'RL-P5' as RedLineId,
          `${unknown.length} ismeretlen álnév a modell outputjában, de nincs privacy.surrogate.unknown audit.`,
          unknown.map((m) => `ismeretlen: ${m.text}`),
        ),
      )
    }
    return asRedLineVerdict(
      'RL-P5',
      pass(
        'RL-P5' as RedLineId,
        `Ismeretlen álnév(ek) detektálva és auditálva (${unknown.length} db).`,
      ),
    )
  },
}

export function corePrivacyRedLines(): PrivacyRedLineCheck[] {
  return [RLP1_NO_RAW_IN_MODEL_TEXT, RLP2_MACHINE_DATA_RAW, RLP3_NO_RESOLVE_IN_URL, RLP4_NO_STREAM_FRAGMENT, RLP5_UNKNOWN_SURROGATE_AUDIT]
}

export function runPrivacyRedLineChecks(
  trace: PrivacyEvalTrace,
  checks: readonly PrivacyRedLineCheck[] = corePrivacyRedLines(),
): RedLineVerdict[] {
  return checks.map((c) => c.check(trace))
}
