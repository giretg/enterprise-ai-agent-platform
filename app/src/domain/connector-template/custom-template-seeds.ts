import type { InstanceFieldDescriptor, TemplateDescriptor } from './template-descriptor'
import { GITHUB_REPOSITORY_LIST_PATTERN_SOURCE } from '@/domain/connector/github-repository-access'

const GOOGLE_USER_DELEGATED_OAUTH = {
  kind: 'user_delegated_oauth2' as const,
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  accountEmailField: 'email',
  offlineParams: { access_type: 'offline' },
  scopeTransform: 'none' as const,
}

const GOOGLE_OAUTH_EGRESS_HOSTS = [
  'accounts.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
] as const

function googleOauthClientFields(secretAliasHint: string): InstanceFieldDescriptor[] {
  return [
    {
      name: 'clientId',
      label: 'OAuth client ID',
      type: 'string',
      required: true,
      target: 'auth.clientId',
    },
    {
      name: 'clientSecret',
      label: 'OAuth client secret',
      type: 'secret',
      required: true,
      secretAliasHint,
      target: 'auth.secretAliasSuggested',
    },
  ]
}

/** Éles CRM host — provisioning UI alapértelmezett kitöltéshez. */
export const OSTOROSBOR_CRM_DEFAULT_INSTANCE_VALUES: Record<string, string> = {
  crmHost: 'ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app',
}

/** Kötelező CRM audit/trace fejlécek — a sablon materializáláskor a connector configba kerülnek. */
export const OSTOROSBOR_CRM_REQUEST_HEADERS = {
  'X-Agent-Id': '{{agent.id}}',
  'X-Acting-User': '{{actingUser.email}}',
  'X-Connector-Call-Id': '{{call.id}}',
} as const

/**
 * Globális custom connector-sablonok seedje.
 *
 * A GitHub sablont szándékosan bearer-tokenes (PAT / fine-grained PAT) módban
 * adjuk, mert a jelenlegi delegált OAuth-flow refresh_tokent vár el, a GitHub
 * klasszikus OAuth app flow pedig ezt nem garantálja.
 */
export const GLOBAL_CUSTOM_CONNECTOR_TEMPLATES: TemplateDescriptor[] = [
  {
    key: 'github',
    displayName: 'GitHub',
    connectorType: 'http_api',
    description:
      'GitHub REST API connector fine-grained personal access tokennel vagy klasszikus PAT-tel.',
    activationHelp: `1. GitHubban nyisd meg a Settings -> Developer settings -> Personal access tokens oldalt.
2. Hozz létre egy Fine-grained personal access tokent, és válaszd ki a szükséges repository-kat.
3. Add meg legalább azokat a jogosultságokat, amelyek a kiválasztott toolokhoz kellenek:
- read-only hívásokhoz tipikusan repository metadata / issues read / pull requests read
- create_issue-hoz Issues write
- create_pull_request-höz Pull requests write és jellemzően Contents read
4. Másold ki a tokent egyszer, és itt add meg API kulcsként vagy secret-alias mögé mentve.
5. Ha szervezeti repository-t használsz, ellenőrizd, hogy a szervezeti policy engedi a PAT használatát.`,
    baseUrl: 'https://api.github.com',
    egressHosts: ['api.github.com'],
    authMethods: [{ kind: 'bearer' }],
    scopeCatalog: [],
    endpoints: [
      {
        name: 'get_authenticated_user',
        method: 'GET',
        path: '/user',
        access: 'read',
        description: 'Read the authenticated GitHub user profile.',
        default: true,
      },
      {
        name: 'list_user_repositories',
        method: 'GET',
        path: '/user/repos',
        access: 'read',
        description: 'List repositories visible to the authenticated user.',
        default: true,
      },
      {
        name: 'get_repository',
        method: 'GET',
        path: '/repos/{owner}/{repo}',
        access: 'read',
        description: 'Read metadata for a repository.',
        default: true,
      },
      {
        name: 'get_repository_tree',
        method: 'GET',
        path: '/repos/{owner}/{repo}/git/trees/{ref}',
        access: 'read',
        description:
          'A repository teljes fájllistája EGY hívásban (ref = branch neve vagy commit SHA), recursive=1 query paraméterrel az alkönyvtárakkal együtt. Kódkérdésnél ezzel kezdj: ebből válaszd ki, melyik fájlt kell elolvasni — ne lépkedj könyvtáranként.',
        default: true,
      },
      {
        name: 'get_file_contents',
        method: 'GET',
        path: '/repos/{owner}/{repo}/contents/{path}',
        access: 'read',
        description:
          'Egy fájl tartalma, vagy könyvtár-útvonalon a könyvtár listája. Fájlnál a platform a base64 tartalmat UTF-8 szöveggé dekódolja (encoding: "utf-8"), tehát közvetlenül olvasható. Nem alapértelmezett ághoz: ?ref=<branch|sha>.',
        default: true,
      },
      {
        name: 'list_issues',
        method: 'GET',
        path: '/repos/{owner}/{repo}/issues',
        access: 'read',
        description: 'List issues in a repository.',
        default: true,
      },
      {
        name: 'create_issue',
        method: 'POST',
        path: '/repos/{owner}/{repo}/issues',
        access: 'write',
        description: 'Create an issue in a repository.',
        default: false,
      },
      {
        name: 'list_pull_requests',
        method: 'GET',
        path: '/repos/{owner}/{repo}/pulls',
        access: 'read',
        description: 'List pull requests in a repository.',
        default: true,
      },
      {
        name: 'create_pull_request',
        method: 'POST',
        path: '/repos/{owner}/{repo}/pulls',
        access: 'write',
        description: 'Create a pull request in a repository.',
        default: false,
      },
      {
        name: 'list_commits',
        method: 'GET',
        path: '/repos/{owner}/{repo}/commits',
        access: 'read',
        description: 'List commits for a repository branch or revision range.',
        default: false,
      },
    ],
    instanceFields: [
      {
        name: 'repositoryAccess',
        label: 'Repository-hozzáférés (* vagy owner/repo lista)',
        type: 'string',
        required: true,
        validation: {
          pattern: GITHUB_REPOSITORY_LIST_PATTERN_SOURCE,
        },
        target: 'github.repositoryAccess',
      },
      {
        name: 'personalAccessToken',
        label: 'GitHub personal access token',
        type: 'secret',
        required: true,
        secretAliasHint: 'github-personal-access-token',
        target: 'auth.secretAliasSuggested',
      },
    ],
    rateLimit: { rps: 5, burst: 10 },
  },
  {
    key: 'ostorosbor-crm-sales-delegated',
    displayName: 'Ostorosbor CRM - Sales delegated',
    connectorType: 'http_api',
    description:
      'Ertekesito neveben futo CRM kapcsolat: ugyfeladatok olvasasa, erdeklodesek, teendok, interakciok, ajanlatstatusz es dokumentum-draft muveletek. A CRM nem kuld ugyfelnek uzenetet; a javaslatok HITL jovahagyasra kerulnek. A trace fejléceket (X-Agent-Id, X-Acting-User, X-Connector-Call-Id) és az író hívások Idempotency-Key-jét a platform automatikusan küldi — a headers mezőt ehhez ne töltsd. A CRM nem enged közvetlen ügyfélnek küldést és nem támogat végleges DELETE műveletet a connectoron.',
    activationHelp:
      'Az API kulcs generálásához az Ostoros CRM Platform integráció menüpontjában kell API kulcsot létrehoznod (Sales delegated profil), majd az itt megadott API kulcs mezőbe CSAK a nyers kulcsot írd be — a "Bearer " előtagot és az Authorization fejlécet a rendszer automatikusan hozzáadja, neked nem kell beírnod. A CRM host mezőbe a tényleges CRM szerver domainjét/portját add meg (a fejlesztői leírásban szereplő 0.0.0.0:8080 csak helyi teszt-placeholder). Az „Acting user e-mail” mezőbe olyan címet adj meg, amely a CRM-ben regisztrált és aktív felhasználó — a kulcsos teszt és az agent hívások ehhez kötődnek (X-Acting-User fejléc).',
    baseUrl: 'https://{crmHost}/api/connector/v1',
    egressHosts: ['{crmHost}'],
    authMethods: [{ kind: 'bearer' }],
    requestHeaders: { ...OSTOROSBOR_CRM_REQUEST_HEADERS },
    scopeCatalog: [],
    endpoints: [
      {
        name: 'list_accounts',
        method: 'GET',
        path: '/accounts',
        access: 'read',
        description: 'Ugyfellista lekerdezese.',
        default: true,
      },
      {
        name: 'get_account',
        method: 'GET',
        path: '/accounts/{id}',
        access: 'read',
        description: 'Account 360 lekerdezese.',
        default: true,
      },
      {
        name: 'soft_delete_account',
        method: 'POST',
        path: '/accounts/{id}/soft-delete',
        access: 'write',
        description: 'Ugyfel visszafordithato torlese.',
        default: false,
      },
      {
        name: 'list_quotes',
        method: 'GET',
        path: '/quotes',
        access: 'read',
        description: 'Ajanlatlista lekerdezese.',
        default: true,
      },
      {
        name: 'update_quote_status',
        method: 'PATCH',
        path: '/quotes/{id}/status',
        access: 'write',
        description: 'Ajanlat statusz valtasa.',
        default: false,
      },
      {
        name: 'list_inquiries',
        method: 'GET',
        path: '/inquiries',
        access: 'read',
        description: 'Bejovo erdeklodesek lekerdezese.',
        default: true,
      },
      {
        name: 'create_inquiry',
        method: 'POST',
        path: '/inquiries',
        access: 'write',
        description: 'Uj bejovo erdeklodes rogzitese.',
        default: false,
      },
      {
        name: 'create_task',
        method: 'POST',
        path: '/tasks',
        access: 'write',
        description: 'Follow-up teendo letrehozasa.',
        default: false,
      },
      {
        name: 'list_interactions',
        method: 'GET',
        path: '/interactions',
        access: 'read',
        description: 'Interakciok lekerdezese.',
        default: true,
      },
      {
        name: 'create_interaction',
        method: 'POST',
        path: '/interactions',
        access: 'write',
        description: 'Email, hivas, meeting vagy chat interakcio naplozasa.',
        default: false,
      },
      {
        name: 'list_documents',
        method: 'GET',
        path: '/documents',
        access: 'read',
        description: 'Dokumentumlista lekerdezese.',
        default: true,
      },
      {
        name: 'get_document',
        method: 'GET',
        path: '/documents/{id}',
        access: 'read',
        description: 'Dokumentum metaadat es signed download URL.',
        default: true,
      },
      {
        name: 'create_document',
        method: 'POST',
        path: '/documents',
        access: 'write',
        description: 'Uj dokumentum-draft letrehozasa.',
        default: false,
      },
      {
        name: 'create_document_version',
        method: 'POST',
        path: '/documents/{id}/versions',
        access: 'write',
        description: 'Uj dokumentum-draft verzio letrehozasa.',
        default: false,
      },
    ],
    instanceFields: [
      {
        name: 'crmHost',
        label: 'CRM szerver host (domain vagy IP, port opcionálisan, pl. crm.ostorosbor.hu:8080)',
        type: 'string',
        required: true,
        validation: { format: 'host' },
        target: 'egressHosts',
      },
      {
        name: 'actingUserEmail',
        label: 'Acting user e-mail (CRM-ben regisztrált, aktív felhasználó — X-Acting-User fejléc)',
        type: 'string',
        required: true,
        target: 'defaultActingUserEmail',
      },
      {
        name: 'apiKey',
        label: 'API kulcs (a CRM integrációnál generált nyers kulcs — a "Bearer " előtagot a rendszer adja hozzá)',
        type: 'secret',
        required: true,
        secretAliasHint: 'ostorosbor-crm-sales-delegated-api-key',
        target: 'auth.secretAliasSuggested',
      },
    ],
  },
  {
    key: 'ostorosbor-crm-service-insight',
    displayName: 'Ostorosbor CRM - Service insight',
    connectorType: 'http_api',
    description:
      'Service/monitoring kapcsolat: CRM adatok olvasasa, account agent mezok frissitese, insightok es heti osszefoglalo. Nem ertekesitoi muveletekre, hanem belso elemzesre es agent javaslatokra valo. A trace fejléceket (X-Agent-Id, X-Acting-User, X-Connector-Call-Id) és az író hívások Idempotency-Key-jét a platform automatikusan küldi — a headers mezőt ehhez ne töltsd. A CRM nem enged közvetlen ügyfélnek küldést és nem támogat végleges DELETE műveletet a connectoron.',
    activationHelp:
      'Az API kulcs generálásához az Ostoros CRM Platform integráció menüpontjában kell API kulcsot létrehoznod (Service insight profil), majd az itt megadott API kulcs mezőbe CSAK a nyers kulcsot írd be — a "Bearer " előtagot és az Authorization fejlécet a rendszer automatikusan hozzáadja, neked nem kell beírnod. A CRM host mezőbe a tényleges CRM szerver domainjét/portját add meg (a fejlesztői leírásban szereplő 0.0.0.0:8080 csak helyi teszt-placeholder). Az „Acting user e-mail” mezőbe olyan címet adj meg, amely a CRM-ben regisztrált és aktív felhasználó — a kulcsos teszt és az agent hívások ehhez kötődnek (X-Acting-User fejléc).',
    baseUrl: 'https://{crmHost}/api/connector/v1',
    egressHosts: ['{crmHost}'],
    authMethods: [{ kind: 'bearer' }],
    requestHeaders: { ...OSTOROSBOR_CRM_REQUEST_HEADERS },
    scopeCatalog: [],
    endpoints: [
      {
        name: 'list_accounts',
        method: 'GET',
        path: '/accounts',
        access: 'read',
        description: 'Ugyfellista lekerdezese.',
        default: true,
      },
      {
        name: 'get_account',
        method: 'GET',
        path: '/accounts/{id}',
        access: 'read',
        description: 'Account 360 lekerdezese.',
        default: true,
      },
      {
        name: 'update_account_agent_fields',
        method: 'PATCH',
        path: '/accounts/{id}/agent-fields',
        access: 'write',
        description: 'Health score, indoklas es next-best-action frissitese.',
        default: false,
      },
      {
        name: 'list_quotes',
        method: 'GET',
        path: '/quotes',
        access: 'read',
        description: 'Ajanlatlista lekerdezese.',
        default: true,
      },
      {
        name: 'list_inquiries',
        method: 'GET',
        path: '/inquiries',
        access: 'read',
        description: 'Erdeklodeslista lekerdezese.',
        default: true,
      },
      {
        name: 'list_documents',
        method: 'GET',
        path: '/documents',
        access: 'read',
        description: 'Dokumentumlista lekerdezese.',
        default: true,
      },
      {
        name: 'get_document',
        method: 'GET',
        path: '/documents/{id}',
        access: 'read',
        description: 'Dokumentum metaadat es signed download URL.',
        default: true,
      },
      {
        name: 'list_insights',
        method: 'GET',
        path: '/insights',
        access: 'read',
        description: 'CRM analitika lekerdezese.',
        default: true,
      },
      {
        name: 'query_report',
        method: 'POST',
        path: '/reports/query',
        access: 'read',
        risk: 'read',
        description:
          'Riportlekérdezés (nem módosít). Kötelező: period.from + period.to (YYYY-MM-DD, inkluzív); plusz preset VAGY dataset+measures. Példa: {"preset":"turnover","period":{"from":"2026-01-01","to":"2026-06-30"}}',
        default: true,
      },
      {
        name: 'export_report',
        method: 'POST',
        path: '/reports/exports',
        access: 'read',
        risk: 'read',
        description:
          'Riportexport (nem módosít). Ugyanaz a body, mint /reports/query, plusz format: "csv"|"xlsx".',
        default: true,
      },
      {
        name: 'update_insights_nl_summary',
        method: 'PUT',
        path: '/insights/nl-summary',
        access: 'write',
        description: 'Heti termeszetes nyelvu osszefoglalo irasa.',
        default: false,
      },
    ],
    instanceFields: [
      {
        name: 'crmHost',
        label: 'CRM szerver host (domain vagy IP, port opcionálisan, pl. crm.ostorosbor.hu:8080)',
        type: 'string',
        required: true,
        validation: { format: 'host' },
        target: 'egressHosts',
      },
      {
        name: 'actingUserEmail',
        label: 'Acting user e-mail (CRM-ben regisztrált, aktív felhasználó — X-Acting-User fejléc)',
        type: 'string',
        required: true,
        target: 'defaultActingUserEmail',
      },
      {
        name: 'apiKey',
        label: 'API kulcs (a CRM integrációnál generált nyers kulcs — a "Bearer " előtagot a rendszer adja hozzá)',
        type: 'secret',
        required: true,
        secretAliasHint: 'ostorosbor-crm-service-insight-api-key',
        target: 'auth.secretAliasSuggested',
      },
    ],
  },
  {
    key: 'google-search-console',
    displayName: 'Google Search Console',
    connectorType: 'http_api',
    description:
      'Google Search Console API (searchconsole.googleapis.com): Search Analytics, verified site-ek, sitemaps és URL Inspection. Delegált felhasználói OAuth.',
    activationHelp: `1. Nyisd meg a Google Cloud Console-t: https://console.cloud.google.com/
2. Válaszd ki vagy hozd létre a projektet.
3. APIs & Services → Library → engedélyezd a „Google Search Console API” szolgáltatást.
4. APIs & Services → OAuth consent screen → állítsd be (Internal vagy External; teszthez add hozzá a tesztfelhasználókat). Vedd fel a webmasters.readonly vagy webmasters scope-ot.
5. APIs & Services → Credentials → Create credentials → OAuth client ID, típus: Web application.
6. Authorized redirect URIs: add meg a platform redirect URI-ját (az aktiválásnál másolható: …/api/connectors/oauth/callback).
7. Másold ki a Client ID-t és a Client secretet — ezeket az aktiválásnál add meg.
8. A hívott felhasználónak verified owner/user jog kell a Search Console property-n.
9. A siteUrl path-paramétert URL-kódolni kell: https://www.example.com/ → https%3A%2F%2Fwww.example.com%2F; domain-property: sc-domain:example.com.`,
    baseUrl: 'https://searchconsole.googleapis.com',
    egressHosts: ['searchconsole.googleapis.com', ...GOOGLE_OAUTH_EGRESS_HOSTS],
    authMethods: [{ ...GOOGLE_USER_DELEGATED_OAUTH }],
    scopeCatalog: [
      {
        value: 'https://www.googleapis.com/auth/webmasters.readonly',
        label: 'Search Console csak olvasás',
        description: 'Verified site-ek, Search Analytics, sitemaps és URL Inspection olvasása.',
        default: true,
      },
      {
        value: 'https://www.googleapis.com/auth/webmasters',
        label: 'Search Console olvasás + írás',
        description: 'Site hozzáadása/eltávolítása és sitemap beküldése/törlése is.',
        default: false,
      },
    ],
    endpoints: [
      {
        name: 'list_sites',
        method: 'GET',
        path: '/webmasters/v3/sites',
        access: 'read',
        description: 'A felhasználó Search Console site-jainak listája (permissionLevel + siteUrl).',
        default: true,
      },
      {
        name: 'get_site',
        method: 'GET',
        path: '/webmasters/v3/sites/{siteUrl}',
        access: 'read',
        description:
          'Egy Search Console property adatai. siteUrl URL-kódolt, pl. https%3A%2F%2Fwww.example.com%2F vagy sc-domain:example.com.',
        default: true,
      },
      {
        name: 'query_search_analytics',
        method: 'POST',
        path: '/webmasters/v3/sites/{siteUrl}/searchAnalytics/query',
        access: 'read',
        description:
          'Search Analytics lekérdezés. Kötelező body: startDate, endDate (YYYY-MM-DD). Opcionális: dimensions (DATE, QUERY, PAGE, COUNTRY, DEVICE, SEARCH_APPEARANCE, HOUR), rowLimit (max 25000), startRow, type (WEB|IMAGE|VIDEO|NEWS|DISCOVER|GOOGLE_NEWS), dimensionFilterGroups. Példa: {"startDate":"2026-07-01","endDate":"2026-07-31","dimensions":["query","page"],"rowLimit":25}.',
        default: true,
      },
      {
        name: 'list_sitemaps',
        method: 'GET',
        path: '/webmasters/v3/sites/{siteUrl}/sitemaps',
        access: 'read',
        description: 'A site-hoz beküldött sitemap-ek listája. Opcionális query: sitemapIndex.',
        default: true,
      },
      {
        name: 'get_sitemap',
        method: 'GET',
        path: '/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}',
        access: 'read',
        description:
          'Egy sitemap adatai. feedpath a sitemap URL-je, URL-kódolva (pl. https%3A%2F%2Fwww.example.com%2Fsitemap.xml).',
        default: false,
      },
      {
        name: 'inspect_url_index',
        method: 'POST',
        path: '/v1/urlInspection/index:inspect',
        access: 'read',
        description:
          'URL Inspection: indexelési állapot a Google indexben. Body: {"inspectionUrl":"https://www.example.com/page","siteUrl":"https://www.example.com/","languageCode":"hu-HU"}. A siteUrl megegyezik a Search Console property URL-jével (domain-property: sc-domain:example.com).',
        default: true,
      },
      {
        name: 'add_site',
        method: 'PUT',
        path: '/webmasters/v3/sites/{siteUrl}',
        access: 'write',
        description: 'Site hozzáadása a felhasználó Search Console fiókjához. webmasters scope kell.',
        default: false,
      },
      {
        name: 'delete_site',
        method: 'DELETE',
        path: '/webmasters/v3/sites/{siteUrl}',
        access: 'write',
        description: 'Site eltávolítása a felhasználó Search Console fiókjából. webmasters scope kell.',
        default: false,
      },
      {
        name: 'submit_sitemap',
        method: 'PUT',
        path: '/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}',
        access: 'write',
        description: 'Sitemap beküldése. webmasters scope kell.',
        default: false,
      },
      {
        name: 'delete_sitemap',
        method: 'DELETE',
        path: '/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}',
        access: 'write',
        description:
          'Sitemap törlése a Sitemaps jelentésből (a Google ettől még crawlolhatja). webmasters scope kell.',
        default: false,
      },
    ],
    instanceFields: googleOauthClientFields('google-search-console-oauth-client-secret'),
    rateLimit: { rps: 5, burst: 10 },
  },
  {
    key: 'google-analytics',
    displayName: 'Google Analytics',
    connectorType: 'http_api',
    description:
      'Google Analytics Data API v1beta (GA4): runReport, valós idejű és pivot riportok, property metadata. Delegált felhasználói OAuth.',
    activationHelp: `1. Nyisd meg a Google Cloud Console-t: https://console.cloud.google.com/
2. Válaszd ki vagy hozd létre a projektet.
3. APIs & Services → Library → engedélyezd a „Google Analytics Data API” szolgáltatást.
4. APIs & Services → OAuth consent screen → állítsd be, és vedd fel az analytics.readonly (vagy analytics) scope-ot.
5. APIs & Services → Credentials → Create credentials → OAuth client ID, típus: Web application.
6. Authorized redirect URIs: add meg a platform redirect URI-ját (az aktiválásnál másolható: …/api/connectors/oauth/callback).
7. Másold ki a Client ID-t és a Client secretet — ezeket az aktiválásnál add meg.
8. A csatlakoztatott Google-fióknak legalább Viewer joga kell a GA4 property-n.
9. A property ID a GA Admin → Property settings oldalon látható (szám, pl. 123456789). A path-ben: /v1beta/properties/{propertyId}:runReport — a properties/ előtagot a path már tartalmazza, csak a számot add meg.`,
    baseUrl: 'https://analyticsdata.googleapis.com',
    egressHosts: ['analyticsdata.googleapis.com', ...GOOGLE_OAUTH_EGRESS_HOSTS],
    authMethods: [{ ...GOOGLE_USER_DELEGATED_OAUTH }],
    scopeCatalog: [
      {
        value: 'https://www.googleapis.com/auth/analytics.readonly',
        label: 'Analytics csak olvasás',
        description: 'GA4 riportok és property metadata olvasása.',
        default: true,
      },
      {
        value: 'https://www.googleapis.com/auth/analytics',
        label: 'Analytics teljes hozzáférés',
        description: 'Szélesebb Analytics-hozzáférés. Csak ha a readonly scope nem elég.',
        default: false,
      },
    ],
    endpoints: [
      {
        name: 'run_report',
        method: 'POST',
        path: '/v1beta/properties/{propertyId}:runReport',
        access: 'read',
        description:
          'GA4 riport. propertyId a numerikus GA4 property azonosító. Body: dimensions, metrics, dateRanges. Példa: {"dateRanges":[{"startDate":"28daysAgo","endDate":"yesterday"}],"dimensions":[{"name":"date"},{"name":"sessionDefaultChannelGroup"}],"metrics":[{"name":"activeUsers"},{"name":"sessions"},{"name":"bounceRate"}],"limit":"100"}. Dimenzió/metrika nevek: get_metadata.',
        default: true,
      },
      {
        name: 'run_realtime_report',
        method: 'POST',
        path: '/v1beta/properties/{propertyId}:runRealtimeReport',
        access: 'read',
        description:
          'Valós idejű (kb. az utolsó 30 perc) GA4 riport. Body: dimensions + metrics, dateRanges nélkül. Példa: {"dimensions":[{"name":"unifiedScreenName"}],"metrics":[{"name":"activeUsers"}]}.',
        default: true,
      },
      {
        name: 'run_pivot_report',
        method: 'POST',
        path: '/v1beta/properties/{propertyId}:runPivotReport',
        access: 'read',
        description:
          'Pivot GA4 riport. Body: dimensions, metrics, dateRanges és pivots (fieldNames, limit).',
        default: false,
      },
      {
        name: 'batch_run_reports',
        method: 'POST',
        path: '/v1beta/properties/{propertyId}:batchRunReports',
        access: 'read',
        description:
          'Több runReport egy hívásban. Body: {"requests":[ /* RunReportRequest objektumok */ ]}.',
        default: false,
      },
      {
        name: 'get_metadata',
        method: 'GET',
        path: '/v1beta/properties/{propertyId}/metadata',
        access: 'read',
        description:
          'A property elérhető dimenziói és metrikái (név, UI-név, típus). Riportépítés előtt ezzel ellenőrizd a mezőneveket.',
        default: true,
      },
      {
        name: 'check_compatibility',
        method: 'POST',
        path: '/v1beta/properties/{propertyId}:checkCompatibility',
        access: 'read',
        description:
          'Ellenőrzi, hogy a kért dimenziók és metrikák kompatibilisek-e egy riportban. Body ugyanaz a dimensions/metrics alak, mint runReport.',
        default: false,
      },
    ],
    instanceFields: googleOauthClientFields('google-analytics-oauth-client-secret'),
    rateLimit: { rps: 5, burst: 10 },
  },
  {
    key: 'google-ads',
    displayName: 'Google Ads',
    connectorType: 'http_api',
    description:
      'Google Ads API REST v25: fióklista, GAQL search/searchStream és campaign/ad group/ad mutate. Delegált OAuth + developer-token fejléc.',
    activationHelp: `1. Kell egy Google Ads manager (MCC) fiók. A developer token az API Centerben van: https://ads.google.com/aw/apicenter
2. Teszt-hozzáférésű token csak tesztfiókra megy; éles fiókhoz Basic/Standard jóváhagyás kell.
3. Nyisd meg a Google Cloud Console-t: https://console.cloud.google.com/
4. APIs & Services → Library → engedélyezd a „Google Ads API” szolgáltatást.
5. OAuth consent screen + Credentials → OAuth client ID, típus: Web application.
6. Authorized redirect URIs: add meg a platform redirect URI-ját (az aktiválásnál másolható: …/api/connectors/oauth/callback).
7. Aktiváláskor add meg: Client ID, Client secret, developer token. MCC alatti kliensfiókhoz a login-customer-id-t is (kötőjel nélkül, pl. 1234567890).
8. A customerId path-paraméter mindig kötőjel nélküli 10 jegyű szám.
9. Olvasáshoz a googleAds:search GAQL-t használd; a mutate végpontok írnak.`,
    baseUrl: 'https://googleads.googleapis.com',
    egressHosts: ['googleads.googleapis.com', ...GOOGLE_OAUTH_EGRESS_HOSTS],
    authMethods: [{ ...GOOGLE_USER_DELEGATED_OAUTH }],
    scopeCatalog: [
      {
        value: 'https://www.googleapis.com/auth/adwords',
        label: 'Google Ads',
        description: 'Google Ads fiókok kezelése a Google Ads API-n (egyetlen hivatalos Ads-scope).',
        default: true,
      },
    ],
    endpoints: [
      {
        name: 'list_accessible_customers',
        method: 'GET',
        path: '/v25/customers:listAccessibleCustomers',
        access: 'read',
        description:
          'Az OAuth-tokenhez közvetlenül hozzáférhető Google Ads customer resource name-ek. Ehhez a híváshoz nem kell login-customer-id. Válasz: customers/1234567890.',
        default: true,
      },
      {
        name: 'get_customer',
        method: 'GET',
        path: '/v25/customers/{customerId}',
        access: 'read',
        description:
          'Egy Google Ads fiók erőforrása. customerId kötőjel nélkül. Query: fieldMask (pl. customer.id,customer.descriptive_name,customer.currency_code,customer.time_zone).',
        default: true,
      },
      {
        name: 'search',
        method: 'POST',
        path: '/v25/customers/{customerId}/googleAds:search',
        access: 'read',
        description:
          'Google Ads Query Language (GAQL) keresés, lapozható JSON válasz. Body: {"query":"SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS"}. További resource-ok: ad_group, ad_group_ad, keyword_view, customer, geographic_view.',
        default: true,
      },
      {
        name: 'search_stream',
        method: 'POST',
        path: '/v25/customers/{customerId}/googleAds:searchStream',
        access: 'read',
        description:
          'GAQL keresés folyamatos (searchStream) válasszal, nagy eredményhalmazhoz. Body ugyanaz, mint search: {"query":"..."}.',
        default: false,
      },
      {
        name: 'mutate_campaigns',
        method: 'POST',
        path: '/v25/customers/{customerId}/campaigns:mutate',
        access: 'write',
        description:
          'Kampány create/update/remove. Body: {"operations":[{"create":{"name":"...","advertisingChannelType":"SEARCH","status":"PAUSED","campaignBudget":"customers/{customerId}/campaignBudgets/{budgetId}"}}]}. Update-nél updateMask kell.',
        default: false,
      },
      {
        name: 'mutate_ad_groups',
        method: 'POST',
        path: '/v25/customers/{customerId}/adGroups:mutate',
        access: 'write',
        description:
          'Hirdetéscsoport create/update/remove. Body: {"operations":[{"create":{"name":"...","campaign":"customers/{customerId}/campaigns/{campaignId}","status":"PAUSED"}}]}.',
        default: false,
      },
      {
        name: 'mutate_ad_group_ads',
        method: 'POST',
        path: '/v25/customers/{customerId}/adGroupAds:mutate',
        access: 'write',
        description:
          'Hirdetés (ad group ad) create/update/remove. Body: {"operations":[{"create":{"adGroup":"customers/{customerId}/adGroups/{adGroupId}","status":"PAUSED","ad":{}}}]}.',
        default: false,
      },
    ],
    instanceFields: [
      ...googleOauthClientFields('google-ads-oauth-client-secret'),
      {
        name: 'developerToken',
        label: 'Google Ads developer token (API Center)',
        type: 'string',
        required: true,
        target: 'requestHeaders.developer-token',
      },
      {
        name: 'loginCustomerId',
        label: 'Login-customer-id (MCC, kötőjel nélkül — opcionális)',
        type: 'string',
        required: false,
        target: 'requestHeaders.login-customer-id',
      },
    ],
    rateLimit: { rps: 2, burst: 5 },
  },
  {
    key: 'meta-ads',
    displayName: 'Meta Ads',
    connectorType: 'http_api',
    description:
      'Meta Marketing API (Graph API v26.0): hirdetési fiókok, kampányok, ad setek, hirdetések és Insights. System user vagy hosszú életű user access token (bearer).',
    activationHelp: `Egyetlen titok kell: a Meta access token. A Business Manager magyar UI-ján ez „Kód” néven jelenik meg (EAA… / EABA… kezdetű hosszú string). Nincs külön client secret ennél a sablonnál.

Hol add meg:
• Sablon/draft lépés: a „Meta Marketing API access token” mezőt HAGYD a meta-ads-access-token alias-néven — ide NE másold a kódot.
• Sandbox-teszt: tokentelen elérhetőségi próba (nem a te kulcsodat küldi).
• Aktiválás: az „API kulcs” mezőbe illeszd a nyers Kódot. A „Bearer ” előtagot NE írd elé.

Token létrehozása:
1. developers.facebook.com/apps → Business típusú app, Marketing API termék.
2. Business Manager → Rendszerfelhasználók → system user → hirdetési fiók hozzárendelése → token/kód generálása. Jogosultságok: ads_read (íráshoz ads_management, business_management). Lejárat: soha (system user) vagy 60 nap.
3. Alternatíva: Graph API Explorer user token, majd Access Token Debuggerrel hosszú életűre cserélve.

Az adAccountId path-paraméter a numerikus fiókazonosító, act_ nélkül. Éles, idegen fiókra App Review kell; fejlesztésben az app admin/teszt user tokenje elég.`,
    baseUrl: 'https://graph.facebook.com/v26.0',
    egressHosts: ['graph.facebook.com'],
    authMethods: [{ kind: 'bearer' }],
    scopeCatalog: [],
    endpoints: [
      {
        name: 'get_me',
        method: 'GET',
        path: '/me',
        access: 'read',
        description:
          'A tokenhez tartozó user vagy system user. Query: fields=id,name. Kapcsolatellenőrzéshez használd.',
        default: true,
      },
      {
        name: 'list_ad_accounts',
        method: 'GET',
        path: '/me/adaccounts',
        access: 'read',
        description:
          'A tokenhez látható hirdetési fiókok. Query: fields=id,account_id,name,account_status,currency,timezone_name,amount_spent,balance&limit=100.',
        default: true,
      },
      {
        name: 'list_businesses',
        method: 'GET',
        path: '/me/businesses',
        access: 'read',
        description: 'A tokenhez tartozó Business Manager fiókok. Query: fields=id,name.',
        default: true,
      },
      {
        name: 'get_ad_account',
        method: 'GET',
        path: '/act_{adAccountId}',
        access: 'read',
        description:
          'Egy hirdetési fiók. adAccountId numerikus, act_ nélkül. Query: fields=id,account_id,name,account_status,currency,timezone_name,amount_spent,balance,spend_cap.',
        default: true,
      },
      {
        name: 'list_campaigns',
        method: 'GET',
        path: '/act_{adAccountId}/campaigns',
        access: 'read',
        description:
          'Kampányok. Query: fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time&effective_status=["ACTIVE","PAUSED"]&limit=100.',
        default: true,
      },
      {
        name: 'get_campaign',
        method: 'GET',
        path: '/{campaignId}',
        access: 'read',
        description: 'Egy kampány. Query: fields=id,name,status,effective_status,objective,account_id.',
        default: true,
      },
      {
        name: 'list_adsets',
        method: 'GET',
        path: '/act_{adAccountId}/adsets',
        access: 'read',
        description:
          'Ad setek. Query: fields=id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting&limit=100.',
        default: true,
      },
      {
        name: 'list_ads',
        method: 'GET',
        path: '/act_{adAccountId}/ads',
        access: 'read',
        description:
          'Hirdetések. Query: fields=id,name,status,effective_status,adset_id,campaign_id,creative&limit=100.',
        default: true,
      },
      {
        name: 'get_account_insights',
        method: 'GET',
        path: '/act_{adAccountId}/insights',
        access: 'read',
        description:
          'Fiókszintű Insights. Query példa: fields=campaign_name,impressions,clicks,spend,cpc,ctr,actions,reach&level=campaign&date_preset=last_7d. date_preset helyett time_range={"since":"2026-07-01","until":"2026-07-31"}.',
        default: true,
      },
      {
        name: 'get_campaign_insights',
        method: 'GET',
        path: '/{campaignId}/insights',
        access: 'read',
        description:
          'Kampányszintű Insights. Query: fields=impressions,clicks,spend,cpc,ctr,actions&date_preset=last_7d.',
        default: true,
      },
      {
        name: 'get_adset_insights',
        method: 'GET',
        path: '/{adsetId}/insights',
        access: 'read',
        description: 'Ad set Insights. Query: fields=impressions,clicks,spend,cpc,ctr&date_preset=last_7d.',
        default: false,
      },
      {
        name: 'get_ad_insights',
        method: 'GET',
        path: '/{adId}/insights',
        access: 'read',
        description: 'Hirdetés Insights. Query: fields=impressions,clicks,spend,cpc,ctr,actions&date_preset=last_7d.',
        default: false,
      },
      {
        name: 'list_custom_audiences',
        method: 'GET',
        path: '/act_{adAccountId}/customaudiences',
        access: 'read',
        description: 'Egyéni közönségek. Query: fields=id,name,subtype,approximate_count&limit=100.',
        default: false,
      },
      {
        name: 'create_campaign',
        method: 'POST',
        path: '/act_{adAccountId}/campaigns',
        access: 'write',
        description:
          'Kampány létrehozása. Body (form vagy JSON): name, objective (pl. OUTCOME_TRAFFIC, OUTCOME_LEADS, OUTCOME_SALES), status (ACTIVE|PAUSED), special_ad_categories (tömb, üresen [] ha nincs). ads_management kell.',
        default: false,
      },
      {
        name: 'update_campaign',
        method: 'POST',
        path: '/{campaignId}',
        access: 'write',
        description:
          'Kampány módosítása (Graph API POST az objektum-ID-re). Body: name, status (ACTIVE|PAUSED|DELETED). ads_management kell.',
        default: false,
      },
      {
        name: 'create_adset',
        method: 'POST',
        path: '/act_{adAccountId}/adsets',
        access: 'write',
        description:
          'Ad set létrehozása. Body: name, campaign_id, daily_budget vagy lifetime_budget (centes egység), billing_event, optimization_goal, targeting, start_time, status. ads_management kell.',
        default: false,
      },
      {
        name: 'create_ad',
        method: 'POST',
        path: '/act_{adAccountId}/ads',
        access: 'write',
        description:
          'Hirdetés létrehozása. Body: name, adset_id, creative (pl. {"creative_id":"..."}), status (ACTIVE|PAUSED). ads_management kell.',
        default: false,
      },
    ],
    instanceFields: [
      {
        name: 'accessToken',
        label: 'Meta Marketing API access token (system user vagy hosszú életű user token)',
        type: 'secret',
        required: true,
        secretAliasHint: 'meta-ads-access-token',
        target: 'auth.secretAliasSuggested',
      },
    ],
    rateLimit: { rps: 2, burst: 5 },
  },
]
