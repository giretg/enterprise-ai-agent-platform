import type { TemplateDescriptor } from './template-descriptor'

export const BUILTIN_CONNECTOR_TEMPLATES: TemplateDescriptor[] = [
  {
    key: 'google-workspace',
    connectorType: 'gmail',
    displayName: 'Gmail (felhasználói)',
    description:
      'Per-user delegált Gmail OAuth connector — a platform gmail_* eszközei ezen a connectoron futnak.',
    activationHelp: `1. Nyisd meg a Google Cloud Console-t: https://console.cloud.google.com/
2. Válaszd ki vagy hozd létre a projektet.
3. APIs & Services → Library → engedélyezd a „Gmail API” szolgáltatást.
4. APIs & Services → OAuth consent screen → állítsd be (Internal vagy External; teszthez add hozzá a tesztfelhasználókat).
5. APIs & Services → Credentials → Create credentials → OAuth client ID.
6. Application type: Web application.
7. Authorized redirect URIs: add meg a platform redirect URI-ját (az aktiválás lépésnél másolható: …/api/connectors/oauth/callback).
8. Másold ki a Client ID-t és a Client secretet — ezeket az aktiválás lépésnél add meg (nem a sablon-forrásnál).`,
    baseUrl: 'https://gmail.googleapis.com',
    egressHosts: [
      'gmail.googleapis.com',
      'accounts.google.com',
      'oauth2.googleapis.com',
      'www.googleapis.com',
    ],
    authMethods: [
      {
        kind: 'user_delegated_oauth2',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
        accountEmailField: 'email',
        offlineParams: { access_type: 'offline' },
        scopeTransform: 'gmailAlias',
      },
    ],
    scopeCatalog: [
      {
        value: 'gmail.modify',
        label: 'Olvasás + írás',
        description: 'Gmail olvasás, piszkozat és címkézés.',
        default: true,
      },
      {
        value: 'gmail.readonly',
        label: 'Csak olvasás',
        description: 'Gmail üzenetek és metaadatok olvasása.',
        default: false,
      },
      {
        value: 'gmail.send',
        label: 'Csak küldés',
        description: 'Email küldés a csatlakoztatott fiókból.',
        default: false,
      },
    ],
    endpoints: [
      {
        name: 'gmail_profile',
        method: 'GET',
        path: '/gmail/v1/users/me/profile',
        access: 'read',
        description: 'Read the connected Gmail profile.',
        default: true,
      },
      {
        name: 'gmail_messages',
        method: 'GET',
        path: '/gmail/v1/users/me/messages',
        access: 'read',
        description: 'List Gmail messages for the connected user.',
        default: true,
      },
    ],
    instanceFields: [],
  },
  {
    key: 'microsoft-365',
    displayName: 'Microsoft 365',
    description: 'Microsoft Graph delegated OAuth connector with explicit provider metadata.',
    connectorType: 'http_api',
    baseUrl: 'https://graph.microsoft.com',
    egressHosts: ['graph.microsoft.com', 'login.microsoftonline.com'],
    authMethods: [
      {
        kind: 'user_delegated_oauth2',
        authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
        accountEmailField: 'userPrincipalName',
        offlineParams: { prompt: 'consent' },
        scopeTransform: 'none',
      },
    ],
    scopeCatalog: [
      {
        value: 'offline_access',
        label: 'Offline access',
        description: 'Allow refresh tokens for delegated access.',
        default: true,
      },
      {
        value: 'User.Read',
        label: 'User profile',
        description: 'Read the connected user profile.',
        default: true,
      },
      {
        value: 'Mail.Read',
        label: 'Mail read',
        description: 'Read user mail through Microsoft Graph.',
        default: false,
      },
      {
        value: 'Mail.Send',
        label: 'Mail send',
        description: 'Send mail as the connected user.',
        default: false,
      },
    ],
    endpoints: [
      {
        name: 'me',
        method: 'GET',
        path: '/v1.0/me',
        access: 'read',
        description: 'Read the connected Microsoft Graph profile.',
        default: true,
      },
      {
        name: 'messages',
        method: 'GET',
        path: '/v1.0/me/messages',
        access: 'read',
        description: 'List mailbox messages for the connected user.',
        default: true,
      },
    ],
    instanceFields: [
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
        secretAliasHint: 'microsoft-365-oauth-client-secret',
        target: 'auth.secretAliasSuggested',
      },
    ],
  },
  {
    key: 'jira-cloud',
    displayName: 'Jira Cloud',
    description: 'Atlassian Jira Cloud REST connector using an API token header.',
    connectorType: 'http_api',
    baseUrl: 'https://{siteHost}',
    egressHosts: ['{siteHost}'],
    authMethods: [{ kind: 'api_key', header: 'Authorization' }],
    scopeCatalog: [],
    endpoints: [
      {
        name: 'myself',
        method: 'GET',
        path: '/rest/api/3/myself',
        access: 'read',
        description: 'Read the authenticated Jira user.',
        default: true,
      },
      {
        name: 'search_issues',
        method: 'GET',
        path: '/rest/api/3/search',
        access: 'read',
        description: 'Search Jira issues with JQL.',
        default: true,
      },
      {
        name: 'create_issue',
        method: 'POST',
        path: '/rest/api/3/issue',
        access: 'write',
        description: 'Create a Jira issue.',
        default: false,
      },
    ],
    instanceFields: [
      {
        name: 'siteHost',
        label: 'Jira site host',
        type: 'string',
        required: true,
        validation: { format: 'host', pattern: '^[a-z0-9][a-z0-9.-]*\\.atlassian\\.net$' },
        target: 'egressHosts',
      },
      {
        name: 'apiToken',
        label: 'API token',
        type: 'secret',
        required: true,
        secretAliasHint: 'jira-cloud-api-token',
        target: 'auth.secretAliasSuggested',
      },
    ],
  },
  {
    key: 'slack',
    displayName: 'Slack',
    description: 'Slack Web API connector using a bot or user bearer token.',
    connectorType: 'http_api',
    baseUrl: 'https://slack.com',
    egressHosts: ['slack.com', 'www.slack.com'],
    authMethods: [{ kind: 'bearer' }],
    scopeCatalog: [],
    endpoints: [
      {
        name: 'auth_test',
        method: 'GET',
        path: '/api/auth.test',
        access: 'read',
        description: 'Validate the Slack token and read workspace identity.',
        default: true,
      },
      {
        name: 'conversations_list',
        method: 'GET',
        path: '/api/conversations.list',
        access: 'read',
        description: 'List Slack channels visible to the token.',
        default: true,
      },
      {
        name: 'chat_post_message',
        method: 'POST',
        path: '/api/chat.postMessage',
        access: 'write',
        description: 'Post a Slack message.',
        default: false,
      },
    ],
    instanceFields: [
      {
        name: 'botToken',
        label: 'Slack bearer token',
        type: 'secret',
        required: true,
        secretAliasHint: 'slack-bearer-token',
        target: 'auth.secretAliasSuggested',
      },
    ],
  },
]
