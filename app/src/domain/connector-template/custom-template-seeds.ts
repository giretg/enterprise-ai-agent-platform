import type { TemplateDescriptor } from './template-descriptor'

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
]
