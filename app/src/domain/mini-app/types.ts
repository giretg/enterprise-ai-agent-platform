export type MiniAppVisibility = 'private' | 'agents' | 'organization'
export type MiniAppStatus = 'active' | 'archived'

export type MiniAppRecord = {
  id: string
  tenantId: string
  ownerAgentId: string
  projectKey: string
  name: string
  description: string | null
  status: MiniAppStatus
  visibility: MiniAppVisibility
  currentVersion: number
  copiedFromAppId: string | null
  copiedFromVersion: number | null
  createdByUserId: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export type MiniAppVersionMeta = {
  id: string
  appId: string
  version: number
  contentHash: string
  byteSize: number
  lintWarnings: string[]
  changeNote: string | null
  createdByUserId: string
  createdAt: Date
}

export type MiniAppVersionRecord = MiniAppVersionMeta & { html: string }

export type MiniAppShareRecord = {
  appId: string
  agentId: string
  sharedByUserId: string
  createdAt: Date
}

export type MiniAppListScope = 'mine' | 'shared_with_me' | 'all'

export type NewMiniAppVersion = {
  html: string
  contentHash: string
  byteSize: number
  lintWarnings: string[]
  changeNote: string | null
  idempotencyKey: string | null
  createdByUserId: string
}

export interface MiniAppStore {
  findById(tenantId: string, appId: string): Promise<MiniAppRecord | null>
  findByCreateKey(tenantId: string, ownerAgentId: string, key: string): Promise<MiniAppRecord | null>
  /** App + 1. verzió egy tranzakcióban. Idempotencia-ütközésnél a meglévő appot adja. */
  createWithVersion(input: {
    tenantId: string
    ownerAgentId: string
    projectKey: string
    name: string
    description: string | null
    copiedFromAppId: string | null
    copiedFromVersion: number | null
    createIdempotencyKey: string
    createdByUserId: string
    version: NewMiniAppVersion
  }): Promise<{ app: MiniAppRecord; created: boolean }>
  findVersion(appId: string, version: number): Promise<MiniAppVersionRecord | null>
  findVersionByKey(appId: string, key: string): Promise<MiniAppVersionMeta | null>
  listVersions(appId: string): Promise<MiniAppVersionMeta[]>
  /** Új verzió `currentVersion + 1`-gyel; ha közben más verzió jött → `conflict`. */
  addVersion(input: {
    appId: string
    tenantId: string
    expectedCurrentVersion: number
    version: NewMiniAppVersion
  }): Promise<MiniAppVersionMeta | 'conflict'>
  listVisibleToAgent(input: {
    tenantId: string
    agentId: string
    scope: MiniAppListScope
    query?: string
    includeArchived: boolean
    limit: number
    offset: number
  }): Promise<MiniAppRecord[]>
  listActiveShares(appId: string): Promise<MiniAppShareRecord[]>
  hasActiveShare(appId: string, agentId: string): Promise<boolean>
  /** Aktívvá teszi a megosztást (új vagy visszavont sor); a ténylegesen újonnan aktívakat adja. */
  activateShares(input: { tenantId: string; appId: string; agentIds: string[]; sharedByUserId: string }): Promise<string[]>
  revokeShares(appId: string, agentIds: string[]): Promise<string[]>
  setVisibility(appId: string, visibility: MiniAppVisibility): Promise<void>
  setStatus(appId: string, status: MiniAppStatus, archivedAt: Date | null): Promise<void>
  /** Archiválás után a határidőn túli appok végleges törlése (D10). */
  purgeArchivedBefore(cutoff: Date): Promise<Array<{ id: string; tenantId: string }>>
}
