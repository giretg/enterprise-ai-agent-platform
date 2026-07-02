import type { TemplateDescriptor } from './template-descriptor'

export const BUILTIN_CONNECTOR_TEMPLATES: TemplateDescriptor[] = [
  {
    key: 'google-workspace',
    displayName: 'Google Workspace',
    description: 'Google Workspace/Gmail delegated OAuth connector with explicit provider metadata.',
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
        value: 'gmail.readonly',
        label: 'Gmail read-only',
        description: 'Read Gmail messages and metadata.',
        default: true,
      },
      {
        value: 'gmail.send',
        label: 'Gmail send',
        description: 'Send email as the connected user.',
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
        secretAliasHint: 'google-workspace-oauth-client-secret',
        target: 'auth.secretAliasSuggested',
      },
    ],
  },
]
