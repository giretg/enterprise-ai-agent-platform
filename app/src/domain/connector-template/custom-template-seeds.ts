import type { TemplateDescriptor } from './template-descriptor'
import { GITHUB_REPOSITORY_LIST_PATTERN_SOURCE } from '@/domain/connector/github-repository-access'

/** Demo CRM host — provisioning UI alapértelmezett kitöltéshez. */
export const OSTOROSBOR_CRM_DEFAULT_INSTANCE_VALUES: Record<string, string> = {
  crmHost: 'ostorosbor-crm--enterprise-ai-demo.europe-west4.hosted.app',
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
]
