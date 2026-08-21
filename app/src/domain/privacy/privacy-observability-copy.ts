/**
 * APG-22 — magyar, zsargon nélküli szövegek a privacy megfigyelhetőség UI-hoz.
 */
import type { PrivacyTransformStatus } from '@/domain/privacy/privacy-observability'

export const PRIVACY_OBSERVABILITY_EMPTY = {
  title: 'Még nincs nyomkövethető forduló',
  body: 'Válassz egy beszélgetést, vagy illeszd be a vizsgálni kívánt szöveget. Megfigyelés módban itt látod, mit cserélt volna a rendszer álnévre, miközben a modell még a valódi adatot kapja.',
} as const

export const PRIVACY_CHAIN_STAGE_LABELS = {
  original: 'Eredeti bemenet',
  transformation: 'Védelem — mit cseréltünk volna',
  llm_input: 'A modellnek ténylegesen ment',
  llm_output: 'Modell válasza',
  user_output: 'Amit te látsz',
} as const

export const PRIVACY_TRANSFORM_STATUS_LABELS: Record<
  PrivacyTransformStatus,
  { label: string; explanation: string }
> = {
  observed: {
    label: 'Megfigyelve',
    explanation: 'Feljegyeztük, de a modell még a valódi adatot kapta.',
  },
  applied: {
    label: 'Álnévre cserélve',
    explanation: 'A modell csak az álnevet látta; a valódi adat bent maradt.',
  },
  skipped: {
    label: 'Nem cseréljük',
    explanation: 'Ez az adatfajta a szabály szerint változatlanul mehet.',
  },
  blocked: {
    label: 'Tiltva',
    explanation: 'A hívás megállna, az adat sehova nem menne ki.',
  },
  none: {
    label: 'Nincs védelem',
    explanation: 'A védelem ki van kapcsolva, vagy nem ismert fel védendő adat.',
  },
}

export const PRIVACY_OBSERVABILITY_INTRO =
  'Megfigyelés módban a rendszer feljegyzi, mit cserélt volna álnévre, de a modell még a valódi adatot kapja. Így gyorsan kiderül, ha valamit feleslegesen vagy épp kimaradt védendőnek jelöl a rendszer.'

export const PRIVACY_OBSERVABILITY_ADMIN_HINT =
  'Admin nézet: az álnév-előnézet csak itt látszik — a chatben a valódi név marad kiemelve.'
