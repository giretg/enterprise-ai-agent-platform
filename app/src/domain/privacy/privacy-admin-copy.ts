/**
 * APG-14 — magyar, zsargon nélküli szövegek a kategória-policy szerkesztőhöz
 * és a dry-run teszterhez. A UI ezeket a mondatokat mutatja; a technikai név
 * (OBSERVE, ref/val) csak zárójelben, egy mondatos magyarázattal.
 */
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import type {
  PrivacyCategoryAction,
  PrivacyEditorLayer,
  PrivacyPolicySource,
} from '@/domain/privacy/privacy-category-policy'
import { CREATE_AGENT_WIZARD_EXTERNAL_HREFS } from '@/lib/create-agent-wizard'

export type PrivacyGlossaryTerm = {
  id: string
  term: string
  explanation: string
}

export const PRIVACY_GLOSSARY: readonly PrivacyGlossaryTerm[] = [
  {
    id: 'alias',
    term: 'Álnév',
    explanation:
      'A modell ezt a rövid helyettesítőt látja a valódi név vagy adat helyett, például [[EMAIL_1]].',
  },
  {
    id: 'observe',
    term: 'Megfigyelés (OBSERVE)',
    explanation:
      'A rendszer feljegyzi, mit cserélt volna álnévre, de a modellnek még a valódi adat megy. Így biztonságosan kipróbálható a védelem.',
  },
  {
    id: 'ref',
    term: 'Hivatkozásos álnév (ref)',
    explanation:
      'Csak annyit őrzünk, hogy melyik rekord a forrásrendszerben — a nyers nevet nem másoljuk ide.',
  },
  {
    id: 'val',
    term: 'Értékmásolatos álnév (val)',
    explanation:
      'Ha nincs azonosító a forrásban, a begépelt értéket titkosítva eltesszük, hogy a válaszban vissza tudjuk tenni.',
  },
  {
    id: 'enforce',
    term: 'Érvényesítés (ENFORCE)',
    explanation: 'A modell csak az álneveket kapja; a valódi adat a platformon marad.',
  },
  {
    id: 'off',
    term: 'Kikapcsolva (OFF)',
    explanation: 'A védelem nem fut: a modell a begépelt és a kapcsolatokból jövő adatot nyersen kapja.',
  },
  {
    id: 'scanner',
    term: 'Mintaszűrő',
    explanation:
      'A régi réteg: TAJ, adószám, bankkártya, IBAN és titok mintáját keresi a teljes szövegben. Nem álnevez, hanem terel vagy megállít. Külön kapcsolható a tokenizálástól.',
  },
]

export const PRIVACY_CATEGORY_LABELS: Record<string, { label: string; explanation: string }> = {
  company: {
    label: 'Cégnév',
    explanation: 'Cégek, üzletek, szervezetek neve, ahogy a forrásrendszer vagy a szöveg említi.',
  },
  person: {
    label: 'Személynév',
    explanation: 'Emberek neve — ügyfél, munkatárs, kapcsolattartó.',
  },
  email: {
    label: 'E-mail-cím',
    explanation: 'Elektronikus levelezési cím, például anna@pelda.hu.',
  },
  phone: {
    label: 'Telefonszám',
    explanation: 'Hívható szám, mobil vagy vezetékes.',
  },
  account: {
    label: 'Ügyfél- vagy fiókazonosító',
    explanation: 'Belső azonosító, amivel a forrásrendszer egy ügyfelet vagy fiókot megjelöl.',
  },
  taj: {
    label: 'TAJ-szám',
    explanation: 'Magyar társadalombiztosítási azonosító jel.',
  },
  adoszam: {
    label: 'Adószám',
    explanation: 'Magyar adóazonosító, céges vagy magánszemélyé.',
  },
  pan: {
    label: 'Bankkártyaszám',
    explanation: 'Bankkártya 13–19 számjegyes száma.',
  },
  iban: {
    label: 'Bankszámlaszám (IBAN)',
    explanation: 'Nemzetközi bankszámlaszám, például HU42…',
  },
  secret_key: {
    label: 'Jelszó, kulcs vagy belépési token',
    explanation: 'Titok, amivel valaki be tud lépni egy rendszerbe. Ezt soha nem cseréljük álnévre, mindig tiltjuk.',
  },
}

export const PRIVACY_ACTION_LABELS: Record<
  PrivacyCategoryAction,
  { label: string; explanation: string }
> = {
  allow: {
    label: 'Mehet a modellnek',
    explanation: 'A valódi adat kimehet a külső modellhez.',
  },
  tokenize: {
    label: 'Álnévre cseréljük',
    explanation: 'A modell egy rövid álnevet lát, a valódi adat bent marad.',
  },
  local_only: {
    label: 'Csak helyi modell',
    explanation:
      'Külső modell nem kapja meg. Ha van telepített helyi modell, az dolgozik vele; ha nincs, a hívás megáll.',
  },
  block: {
    label: 'Tiltva',
    explanation: 'A hívás megáll, az adat sehova nem megy ki.',
  },
}

export const PRIVACY_SOURCE_LABELS: Record<PrivacyPolicySource, string> = {
  default: 'Alapértelmezés',
  platform: 'Platform',
  tenant: 'Szervezet',
  agent: 'Ez az AI-munkatárs',
  legacy: 'Régi teljes felmentés',
}

export const PRIVACY_LAYER_LABELS: Record<PrivacyEditorLayer, string> = {
  platform: 'Platform',
  tenant: 'Szervezet',
  agent: 'Ez az AI-munkatárs',
}

export const PRIVACY_MODE_LABELS: Record<
  PrivacyGatewayMode,
  { label: string; explanation: string }
> = {
  off: {
    label: 'Kikapcsolva',
    explanation: 'A védelem nem fut: a modell a nyers adatot kapja.',
  },
  observe: {
    label: 'Megfigyelés',
    explanation:
      'A rendszer feljegyzi, mit cserélt volna, de a modellnek még a valódi adat megy.',
  },
  enforce: {
    label: 'Érvényesítés',
    explanation: 'A modell csak az álneveket kapja; a valódi adat a platformon marad.',
  },
}

export const SENSITIVITY_MODE_LABELS: Record<
  PrivacyGatewayMode,
  { label: string; explanation: string }
> = {
  off: {
    label: 'Kikapcsolva',
    explanation: 'A mintaszűrő nem állítja meg a hívást. TAJ, adószám, kártya mehet a külső modellnek.',
  },
  observe: {
    label: 'Megfigyelés',
    explanation:
      'Feljegyezzük, mit tiltott vagy helyi modellre terelt volna a szűrő, de a hívás megy tovább.',
  },
  enforce: {
    label: 'Érvényesítés',
    explanation:
      'Érzékeny találatnál helyi modell kell; ha nincs, a hívás megáll. Tiltott mintánál (kártya, titok) mindig megáll.',
  },
}

export const SENSITIVITY_LAYER_INTRO =
  'Ez a mintaszűrő a begépelt szövegben és a tool-válaszokban keresi a TAJ-t, adószámot, bankkártyát, IBAN-t és titkokat. Nem cserél álnévre — vagy továbbengedi, vagy helyi modellre tereli, vagy megállítja a hívást. Külön él a fenti álnév-rétegtől: a Megfigyelés ott nem kapcsolja ki ezt a szűrőt.'

export const PRIVACY_INHERIT_LABEL = 'Öröklés'
export const PRIVACY_INHERIT_EXPLANATION =
  'A fölötte lévő szint szabálya marad érvényben — itt nincs külön felülírás.'

export const PRIVACY_CONNECTORS_HREF = CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections

export const PRIVACY_EMPTY_CONNECTOR_STATE = {
  title: 'Először egy kapcsolatot kell megjelölni',
  body:
    'Még nincs olyan forrásrendszer-kapcsolat, ami megmondaná, mely cégneveket vagy személyes adatokat kell álnévre cserélni. A Kapcsolatok oldalon állíts be egy CRM-et vagy más forrást, és jelöld meg a védendő mezőket. Addig a szabályok menthetők, a próba pedig csak a begépelt szövegben felismert mintákra (e-mail, TAJ, bankkártya) működik.',
  cta: 'Ugrás a kapcsolatok beállításához',
  href: PRIVACY_CONNECTORS_HREF,
} as const

export const PRIVACY_LEGACY_TOGGLE_WARNING =
  'Ez az AI-munkatárs még a régi, mindent átengedő felmentést használja. Ha itt bármelyik kategóriát külön beállítod, a felmentés helyett a kategória-szabályok lépnek életbe.'

export const PRIVACY_DRY_RUN_INTRO =
  'Illessz be egy szöveget. A próba helyben, modellhívás nélkül megmutatja, mit cserélnénk álnévre, mit terelnénk helyi modellre, és mit tiltanánk.'

export const PRIVACY_DRY_RUN_NO_HITS =
  'A begépelt szövegben a rendszer nem ismert fel védendő mintát. A cégnevek és személynevek csak akkor cserélődnek, ha a kapcsolat megjelöli őket.'

export const PRIVACY_PAN_IBAN_CONFIRM_HINT =
  'Bankkártyaszám vagy IBAN külső modellnek küldése külön megerősítést kér. Írd be: ALLOW_PAN_IBAN'

export function inheritedFromLabel(source: PrivacyPolicySource): string {
  if (source === 'legacy') return 'örökölt (régi felmentés)'
  if (source === 'default') return 'örökölt (alapértelmezés)'
  if (source === 'platform') return 'örökölt (platform)'
  if (source === 'tenant') return 'örökölt (szervezet)'
  return 'itt felülírva'
}

export type PrivacyConnectorRow = {
  id: string
  name: string
  hasPrivacyMetadata: boolean
}

export function privacyConnectorEmptyState(connectors: readonly PrivacyConnectorRow[]): {
  kind: 'ready' | 'empty'
  title: string | null
  body: string | null
  cta: string | null
  href: string | null
  ready: Array<{ id: string; name: string }>
} {
  const ready = connectors.filter((row) => row.hasPrivacyMetadata).map((row) => ({
    id: row.id,
    name: row.name,
  }))
  if (ready.length > 0) {
    return { kind: 'ready', title: null, body: null, cta: null, href: null, ready }
  }
  return {
    kind: 'empty',
    title: PRIVACY_EMPTY_CONNECTOR_STATE.title,
    body: PRIVACY_EMPTY_CONNECTOR_STATE.body,
    cta: PRIVACY_EMPTY_CONNECTOR_STATE.cta,
    href: PRIVACY_EMPTY_CONNECTOR_STATE.href,
    ready: [],
  }
}
