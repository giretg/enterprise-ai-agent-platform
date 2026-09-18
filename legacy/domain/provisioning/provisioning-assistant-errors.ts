/**
 * Emberi olvasható, következő-lépéses hibaüzenetek a provisioning-asszisztens
 * (doksi→config, felfedezés, URL-letöltés) technikai kódjaihoz.
 * A domain kódok (audit, tesztek) változatlanok maradnak — csak az UI-réteg kap
 * értelmezhető magyar szöveget.
 */

export type ProvisioningAssistantErrorContext = 'discover' | 'doc' | 'fetch'

function withNextStep(summary: string, nextStep: string): string {
  return `${summary} Következő lépés: ${nextStep}`
}

function parseFailedMessage(detail: string, context?: ProvisioningAssistantErrorContext): string {
  switch (detail) {
    case 'empty document':
      return withNextStep(
        'Üres dokumentum — a provisioning asszisztens nem tudott belőle configot kinyerni.',
        context === 'fetch'
          ? 'Ellenőrizd, hogy az URL valódi API-dokumentációt vagy OpenAPI specifikációt szolgál ki (ne forráskód-útvonal legyen), majd próbáld újra.'
          : 'Tölts fel vagy illessz be érvényes API-dokumentációt, majd generálj config-jelöltet.',
      )
    case 'empty connector name':
      return withNextStep(
        'Nincs megadva connector-név a felfedezéshez.',
        'Add meg a kapcsolat nevét (pl. „Acme CRM"), opcionálisan az ismert API-doksi domainjét is, majd indítsd újra a felfedezést.',
      )
    case 'no JSON object in model output':
      return withNextStep(
        'A provisioning asszisztens nem JSON formátumú configot adott vissza — valószínűleg a modell prózában válaszolt, vagy a dokumentum túl zavaros volt.',
        context === 'discover'
          ? 'Próbáld meg az „API-doksi" forrást: töltsd fel vagy illeszd be a hivatalos dokumentumot, majd generálj config-jelöltet. Ha ismét sikertelen, válaszd a „Kézi JSON" forrást.'
          : 'Próbáld újra rövidebb vagy tisztább dokumentummal. Ha ismét sikertelen, válaszd a „Kézi JSON" forrást és állítsd össze a configot saját kezűleg.',
      )
    case 'schema mismatch':
      return withNextStep(
        'A provisioning asszisztens config-jelöltet adott vissza, de az nem felel meg a várt connector-sémának (hiányzó vagy hibás mezők).',
        context === 'discover'
          ? 'Próbáld az „API-doksi" forrást: töltsd fel vagy illeszd be a hivatalos OpenAPI/API-leírást, majd generálj újra. Ha nem megy, válaszd a „Kézi JSON" forrást, vagy használj connector-sablont a katalógusból.'
          : 'Ellenőrizd, hogy a dokumentum API-leírást vagy OpenAPI specifikációt tartalmaz-e, majd generálj újra. Ha ismét sikertelen, válaszd a „Kézi JSON" forrást, vagy másold a configot sablonból.',
      )
    default:
      return withNextStep(
        'A provisioning asszisztens nem tudott érvényes config-jelöltet készíteni.',
        context === 'discover'
          ? 'Próbáld meg az „API-doksi" forrást feltöltéssel vagy beillesztéssel, vagy válaszd a „Kézi JSON" / sablon forrást.'
          : 'Próbáld újra más dokumentummal, vagy válaszd a „Kézi JSON" / sablon forrást.',
      )
  }
}

function fetchFailedMessage(detail: string, context?: ProvisioningAssistantErrorContext): string {
  if (detail === 'empty document') {
    return parseFailedMessage(detail, context)
  }
  if (detail === 'web_fetch platform-tool is disabled') {
    return withNextStep(
      'A web_fetch platform-tool ki van kapcsolva — a dokumentum letöltése nem engedélyezett.',
      'Kapcsold be a web_fetch-et a Rendszer → Web fetch beállításoknál, majd próbáld újra.',
    )
  }
  if (detail === 'all candidate fetches blocked/failed') {
    return withNextStep(
      'A felfedezés megtalálta a lehetséges forrásokat, de egyiket sem sikerült letölteni (egress-szabály vagy allowlist).',
      'Bővítsd az egress allowlistet a szükséges hostokkal (Rendszer → Web fetch), adj meg ismert domain-t, vagy töltsd fel / illeszd be az API-doksit kézzel.',
    )
  }
  if (detail === 'no content fetched') {
    return withNextStep(
      'A felfedezés nem tudott letölthető API-dokumentumot szerezni.',
      'Add meg az ismert API-doksi domainjét, vagy válaszd az „API-doksi" forrást és töltsd fel a dokumentumot.',
    )
  }
  if (detail.includes('allowlist') || detail.includes('egress')) {
    return withNextStep(
      'A letöltés az egress-szabályok miatt nem engedélyezett.',
      'Bővítsd az egress allowlistet a cél hosttal (Rendszer → Web fetch), vagy töltsd fel / illesszd be az API-doksit kézzel.',
    )
  }
  return withNextStep(
    'Nem sikerült letölteni az API-dokumentumot.',
    context === 'fetch'
      ? 'Ellenőrizd az URL-t (https, nyilvános OpenAPI/API-doksi endpoint — ne forráskód-útvonal), majd próbáld újra. Ha nem megy, másold be a dokumentum tartalmát kézzel.'
      : 'Próbáld meg az „API-doksi" forrást feltöltéssel vagy beillesztéssel.',
  )
}

export function formatProvisioningAssistantError(
  error: string,
  detail: string,
  context?: ProvisioningAssistantErrorContext,
): string {
  switch (error) {
    case 'PARSE_FAILED':
      return parseFailedMessage(detail, context)
    case 'NO_TRUSTED_SOURCE':
      return withNextStep(
        'A webes felfedezés nem talált hivatalos vagy szállítói API-dokumentációt a megadott név alapján.',
        'Add meg az ismert API-doksi domainjét (pl. developers.example.com), vagy válaszd az „API-doksi" forrást és töltsd fel / illeszd be a dokumentumot.',
      )
    case 'DISCOVERY_DISABLED':
      return withNextStep(
        detail === 'web_discovery flag off'
          ? 'A „Kapcsolat felfedezése névből" funkció ki van kapcsolva.'
          : 'A webes felfedezés nincs konfigurálva ebben a környezetben.',
        'Kapcsold be a web_discovery flaget a Rendszer → Web fetch beállításoknál, vagy használd az „API-doksi" / sablon / kézi JSON forrást.',
      )
    case 'FETCH_DISABLED':
      return withNextStep(
        'A dokumentum-letöltés (web_fetch) nincs konfigurálva.',
        'Kapcsold be a web_fetch platform-toolt a Rendszer → Web fetch beállításoknál, vagy másold be az API-doksi tartalmát kézzel.',
      )
    case 'INVALID_URL':
      return withNextStep(
        detail === 'only https urls are allowed'
          ? 'Csak https URL engedélyezett a dokumentum letöltéséhez.'
          : 'Érvénytelen URL.',
        'Adj meg egy nyilvános https API-doksi vagy OpenAPI URL-t (pl. …/openapi.json), ne forráskód-fájl útvonalat.',
      )
    case 'FETCH_FAILED':
      return fetchFailedMessage(detail, context)
    default:
      return withNextStep(
        'A provisioning asszisztens nem tudta befejezni a munkát.',
        'Próbáld újra, vagy válaszd a „Kézi JSON" / sablon forrást.',
      )
  }
}
