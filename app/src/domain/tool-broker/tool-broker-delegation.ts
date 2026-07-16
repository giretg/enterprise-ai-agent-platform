/**
 * WP-8 — Tool Broker delegáció-törzsek (a broker-magból kiemelve).
 *
 * A `ToolBrokerService.invoke` KERET (authorize → speciális kapuk → recordCall/
 * audit) változatlan; ez a modul CSAK a tool-specifikus végrehajtást tartja. Minden
 * függvény `self: ToolBrokerService`-t kap (az injektált service-ek és a keret-
 * segédek elérésére), és bittre azonos viselkedést ad, mint a korábbi metódusok.
 * A handlerek a `HandlerContext`-en át (a keret köti be) hívják ezeket.
 *
 * Runtime import-ciklus nincs: a mag ÉRTÉKként importálja ezeket a függvényeket, ez
 * a modul viszont a `ToolBrokerService`-t CSAK `import type`-ként (törlődik build-kor).
 */
import type {
  Connector,
  Prisma,
  Ticket,
  TicketState,
} from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { personaFor } from '@/lib/agent-persona'
import {
  buildAgentCatalogEntry,
  scoreAgentForCatalogQuery,
} from '@/lib/agent-catalog'
import { readDelegationPayload, shouldCompleteDelegation } from '@/lib/delegation-payload'

import { isAgentReachableFromTenant, filterAgentsByTenant } from '@/lib/tenant-reachability'
import {
  agentAnswerStructuredFromPayload,
  extractAgentAnswerDisplayBody,
} from '@/lib/playbook-v2/process-step-payload'
import {
  isRunAsAuthorized,
  readRunAsUserId,
  RUN_AS_AUTHORIZED_AT,
  RUN_AS_AUTHORIZED_BY,
} from '@/lib/run-as-payload'

import {
  HttpApiClient,
  parseHttpApiConfig,
  resolveConnectorApiKey,
} from '@/domain/connector/http-api-client'
import { enrichOstorosborConnectorConfig } from '@/domain/connector-template/ostorosbor-config-enrichment'
import { normalizeConnectorConfig } from '@/domain/provisioning/connector-config'

import {
  type WebSearchResult,
} from '@/domain/web-search/web-search-types'
import { KnownUrlRegistry } from '@/domain/web-research/known-url-registry'
import { validateWebResearchResult } from '@/domain/web-research/web-research-validator'
import type {
  WebResearchResult,
  WebResearchSourceType,
} from '@/domain/web-research/web-research-types'
// WP-8 — tool-onkénti handler-regiszter (az óriás executeTool switch kiváltása).

// WP-8 — a publikus tool-típusok külön fájlba (tool-broker-types.ts) kerültek;
// a magban belül használt nevek innen importálva, a teljes felület re-exportálva.
import type {
  AgentAskResult,
  AgentCatalogArgs,
  AgentCatalogResult,
  AgentResolveArgs,
  AgentResolveResult,
  AuthorizationResult,
  BoardWriteResult,
  HttpApiCallResult,
  KbGetPageArgs,
  KbGetPageResult,
  KbListIndexArgs,
  KbListIndexResult,
  KbSearchArgs,
  KbSearchResult,
  MemoryProposeResult,
  RepoOpenPullRequestResult,
  RepoPrepareResult,
  TicketCreateResult,
  ToolBrokerInvokeInput,
  UserDirectoryResult,
  WebResearchDelegationResult,
} from './tool-broker-types'
// WP-8 — az authorizáció-koncern külön modulban (tool-broker-authorizer.ts);
// a mag a szükséges lookupokat importálja, a publikus felületet re-exportálja.

// WP-8 — állapotmentes segédfüggvények külön modulban (tool-broker-support.ts).
import {
  assembleKbHits,
  assembleKbIndex,
  assembleKbPage,
  assertUtf8Text,
  decodeRepoMetadata,
  filterUserDirectory,
  gitBlobSha1,
  isRecord,
  normalizeText,
  repoPrepareNextSteps,
  resolveRepoTarget,
  shouldSkipRepoPath,
  systemUserId,
  REPO_IMPORT_MAX_FILE_BYTES,
  REPO_IMPORT_MAX_FILES,
  REPO_IMPORT_MAX_TOTAL_BYTES,
  REPO_METADATA_PATH,
  REPO_WORKSPACE_PATH,
} from './tool-broker-support'
import type {
  GitHubBlobResponse,
  GitHubCommitResponse,
  GitHubRepoResponse,
  GitHubTreeItem,
  GitHubTreeResponse,
  RepoPrepareMetadata,
} from './tool-broker-support'
import type { ToolBrokerService } from './tool-broker-service'

// A folyamat-ticket "agent-válasz kész" cél-állapotai (l. maybeRecordAgentAnswerComment).
const AGENT_ANSWER_COMPLETION_STATES = new Set<string>(['done', 'awaiting_human'])

function resolveHttpApiConnectorConfig(raw: unknown): unknown {
  try {
    return enrichOstorosborConnectorConfig(normalizeConnectorConfig(raw)).config
  } catch {
    return raw
  }
}

export async function executeHttpApiTool(self: ToolBrokerService,
    input: Extract<ToolBrokerInvokeInput, { tool: 'http_api_get' | 'http_api_request' }>,
    connector: Connector,
    actingTenantId: string | null,
    actingUserId: string | null,
    agentSecretAlias?: string | null,
    delegatedAccessToken?: string,
  ): Promise<HttpApiCallResult> {
    const config = parseHttpApiConfig(resolveHttpApiConnectorConfig(connector.config))
    // user_delegated (auto-consent oauth2): a per-user grant access token megy ki
    // Bearerként (config.auth = bearer). A connector secretAlias ilyenkor a
    // client_secret-et rejti, ezt SOHA nem oldjuk fel apiKey-ként — ezt a delegált
    // ág (delegatedAccessToken) rövidre zárja, így az alias-feloldás meg sem történik.
    // WP-2 (B2, D-1/A): ha az agent-kötésen van per-agent kulcs (agentSecretAlias),
    // azt használjuk az ÜZEMMÓDTÓL függetlenül (service/agent_owned egyaránt); ha
    // nincs, a connector-szintű (tenant) megosztott kulcs a fallback. Így a UI-ban
    // megadott per-agent kulcs valóban hat, nem nyelődik el csendben.
    const effectiveAlias = agentSecretAlias ?? connector.secretAlias
    const defaultApiKey = delegatedAccessToken
      ? delegatedAccessToken
      : effectiveAlias
        ? await resolveConnectorApiKey(effectiveAlias)
        : undefined
    const client = new HttpApiClient(config, {
      defaultApiKey,
      resolveProfileApiKey: (_profile, secretAlias) => resolveConnectorApiKey(secretAlias),
    })
    const callId = randomUUID()
    const actingUser = actingUserId
      ? await prisma.user.findUnique({
          where: { id: actingUserId },
          select: { id: true, email: true, tenantId: true },
        })
      : null
    const context = {
      agent: { id: input.agentId, version: input.agentVersion },
      connector: { id: connector.id, name: connector.name },
      actingUser,
      defaultActingUserEmail: config.defaultActingUserEmail,
      tenant: actingTenantId ? { id: actingTenantId } : null,
      call: { id: callId, idempotencyKey: callId },
      now: { iso: new Date().toISOString() },
    }

    if (input.tool === 'http_api_get') {
      return client.request({
        method: 'GET',
        path: input.args.path,
        query: input.args.query,
        headers: input.args.headers,
        context,
      })
    }
    return client.request({
      method: input.args.method,
      path: input.args.path,
      query: input.args.query,
      headers: input.args.headers,
      body: input.args.body,
      context,
    })
  }

export async function repoPrepare(self: ToolBrokerService, 
    input: Extract<ToolBrokerInvokeInput, { tool: 'repo_prepare' }>,
    workspaceConnector: Connector,
    actingTenantId: string | null,
  ): Promise<RepoPrepareResult> {
    const workspaceId = input.ticketId ?? input.conversationId
    if (!workspaceId) throw new Error('repo_prepare requires a ticketId or conversationId')

    const agent = await self.agents.findById(input.agentId)
    if (!agent) throw new Error('repo_prepare agent not found')

    const target = resolveRepoTarget(input.args, agent)
    const token = await resolveGitHubTokenForAgent(self, input.agentId)
    const repoInfo = await githubJson<GitHubRepoResponse>(self, 
      `/repos/${target.owner}/${target.repo}`,
      token,
    )
    const ref = target.ref ?? repoInfo.default_branch ?? 'main'
    const commit = await githubJson<GitHubCommitResponse>(self, 
      `/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(ref)}`,
      token,
    )
    const commitSha = commit.sha
    const treeSha = commit.commit?.tree?.sha ?? commitSha

    const tenantId = actingTenantId ?? workspaceConnector.tenantId ?? 'global'
    const existingMetadata = decodeRepoMetadata(
      await self.fileEditor.readTextFileOrNull(tenantId, workspaceId, { path: REPO_METADATA_PATH }),
    )
    if (
      !input.args.forceRefresh &&
      existingMetadata?.owner === target.owner &&
      existingMetadata.repo === target.repo &&
      existingMetadata.ref === ref &&
      existingMetadata.commitSha === commitSha
    ) {
      return {
        ok: true,
        repoPath: REPO_WORKSPACE_PATH,
        status: 'already_current',
        owner: target.owner,
        repo: target.repo,
        ref,
        commitSha,
        filesIndexed: existingMetadata.filesIndexed ?? 0,
        filesWritten: 0,
        filesSkipped: 0,
        bytesWritten: existingMetadata.bytesWritten ?? 0,
        metadataPath: REPO_METADATA_PATH,
        nextSteps: repoPrepareNextSteps(),
      }
    }

    const tree = await githubJson<GitHubTreeResponse>(self, 
      `/repos/${target.owner}/${target.repo}/git/trees/${treeSha}?recursive=1`,
      token,
    )
    if (tree.truncated) {
      throw new Error('repo_prepare GitHub tree is truncated; narrow the repo/ref or raise import limits')
    }

    const current = await self.fileEditor.listFiles(tenantId, workspaceId, {
      path: REPO_WORKSPACE_PATH,
      recursive: true,
    })
    await Promise.all(
      current.entries
        .filter((entry) => entry.type === 'file')
        .map((entry) => self.fileEditor.deleteFile(tenantId, workspaceId, { path: entry.path })),
    )

    const blobs = tree.tree.filter((item) => item.type === 'blob')
    const candidates = blobs
      .filter((item) => !shouldSkipRepoPath(item.path, item.size ?? 0))
      .slice(0, REPO_IMPORT_MAX_FILES)
    let filesWritten = 0
    let filesSkipped = blobs.length - candidates.length
    let bytesWritten = 0
    let nextIndex = 0

    const importOne = async (item: GitHubTreeItem) => {
      if (bytesWritten >= REPO_IMPORT_MAX_TOTAL_BYTES) {
        filesSkipped += 1
        return
      }
      const blob = await githubJson<GitHubBlobResponse>(self, 
        `/repos/${target.owner}/${target.repo}/git/blobs/${item.sha}`,
        token,
      )
      if (blob.encoding !== 'base64') {
        filesSkipped += 1
        return
      }
      const buffer = Buffer.from(blob.content.replace(/\s+/g, ''), 'base64')
      if (buffer.length > REPO_IMPORT_MAX_FILE_BYTES || !assertUtf8Text(buffer)) {
        filesSkipped += 1
        return
      }
      if (bytesWritten + buffer.length > REPO_IMPORT_MAX_TOTAL_BYTES) {
        filesSkipped += 1
        return
      }
      await self.fileEditor.writeFile(tenantId, workspaceId, {
        path: `${REPO_WORKSPACE_PATH}/${item.path}`,
        content: buffer.toString('utf8'),
      })
      bytesWritten += buffer.length
      filesWritten += 1
    }

    const worker = async () => {
      while (nextIndex < candidates.length) {
        const item = candidates[nextIndex]
        nextIndex += 1
        await importOne(item)
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, () => worker()))

    const metadata: RepoPrepareMetadata = {
      owner: target.owner,
      repo: target.repo,
      ref,
      commitSha,
      repoPath: REPO_WORKSPACE_PATH,
      filesIndexed: filesWritten,
      bytesWritten,
      preparedAt: new Date().toISOString(),
    }
    await self.fileEditor.writeFile(tenantId, workspaceId, {
      path: REPO_METADATA_PATH,
      content: JSON.stringify(metadata, null, 2),
    })

    return {
      ok: true,
      repoPath: REPO_WORKSPACE_PATH,
      status: 'updated',
      owner: target.owner,
      repo: target.repo,
      ref,
      commitSha,
      filesIndexed: filesWritten,
      filesWritten,
      filesSkipped,
      bytesWritten,
      metadataPath: REPO_METADATA_PATH,
      nextSteps: repoPrepareNextSteps(),
    }
  }

  /**
   * Branch létrehozása + commit + PR megnyitása a `repo_prepare`-rel importált
   * workspace-klón és a jelenlegi bázisref FRISS állása közti diffből. A
   * diff-bázis szándékosan az import-kori snapshot (metadata.commitSha), NEM a
   * friss head — így csak a ténylegesen file_edit/file_write/file_delete-elt
   * fájlok kerülnek be, a commit/tree bázisa viszont a friss head-ről ágazik,
   * hogy ne írjunk felül közben történt remote változásokat.
   */
export async function repoOpenPullRequest(self: ToolBrokerService, 
    input: Extract<ToolBrokerInvokeInput, { tool: 'repo_open_pull_request' }>,
    workspaceConnector: Connector,
    actingTenantId: string | null,
  ): Promise<RepoOpenPullRequestResult> {
    const workspaceId = input.ticketId ?? input.conversationId
    if (!workspaceId) throw new Error('repo_open_pull_request requires a ticketId or conversationId')

    const tenantId = actingTenantId ?? workspaceConnector.tenantId ?? 'global'
    const metadata = decodeRepoMetadata(
      await self.fileEditor.readTextFileOrNull(tenantId, workspaceId, { path: REPO_METADATA_PATH }),
    )
    if (!metadata) {
      throw new Error(
        'repo_open_pull_request requires a prior repo_prepare in this workspace (no .repo_prepare.json found)',
      )
    }

    const token = await resolveGitHubTokenForAgent(self, input.agentId)
    const baseRef = input.args.baseRef ?? metadata.ref

    const importedTree = await githubJson<GitHubTreeResponse>(self, 
      `/repos/${metadata.owner}/${metadata.repo}/git/trees/${metadata.commitSha}?recursive=1`,
      token,
    )
    if (importedTree.truncated) {
      throw new Error('repo_open_pull_request: imported GitHub tree is truncated; cannot diff reliably')
    }
    const originalShaByPath = new Map(
      importedTree.tree.filter((item) => item.type === 'blob').map((item) => [item.path, item.sha]),
    )

    const prefix = `${REPO_WORKSPACE_PATH}/`
    const current = await self.fileEditor.listFiles(tenantId, workspaceId, {
      path: REPO_WORKSPACE_PATH,
      recursive: true,
    })
    const currentRelPaths = current.entries
      .filter((entry) => entry.type === 'file' && entry.path !== REPO_METADATA_PATH)
      .map((entry) => entry.path.slice(prefix.length))

    const changes: Array<{ path: string; content: Buffer | null }> = []
    for (const relPath of currentRelPaths) {
      const buf = await self.fileEditor.readRawFile(tenantId, workspaceId, { path: `${prefix}${relPath}` })
      if (!buf) continue
      if (originalShaByPath.get(relPath) !== gitBlobSha1(buf)) {
        changes.push({ path: relPath, content: buf })
      }
    }
    const currentRelSet = new Set(currentRelPaths)
    for (const relPath of originalShaByPath.keys()) {
      if (!currentRelSet.has(relPath)) changes.push({ path: relPath, content: null })
    }

    if (changes.length === 0) {
      return {
        ok: true,
        changed: false,
        message:
          'Nincs változás a repo workspace-ben a legutóbbi repo_prepare óta — nincs mit commitolni/PR-ezni.',
      }
    }

    const baseCommit = await githubJson<GitHubCommitResponse>(self, 
      `/repos/${metadata.owner}/${metadata.repo}/commits/${encodeURIComponent(baseRef)}`,
      token,
    )
    const baseHeadSha = baseCommit.sha
    const baseHeadTreeSha = baseCommit.commit?.tree?.sha ?? baseHeadSha

    const treeEntries = changes.map((change) =>
      change.content
        ? { path: change.path, mode: '100644', type: 'blob', content: change.content.toString('utf8') }
        : { path: change.path, mode: '100644', type: 'blob', sha: null },
    )
    const newTree = await githubRequestJson<{ sha: string }>(self, 
      `/repos/${metadata.owner}/${metadata.repo}/git/trees`,
      token,
      'POST',
      { base_tree: baseHeadTreeSha, tree: treeEntries },
    )
    const newCommit = await githubRequestJson<{ sha: string }>(self, 
      `/repos/${metadata.owner}/${metadata.repo}/git/commits`,
      token,
      'POST',
      { message: input.args.title, tree: newTree.sha, parents: [baseHeadSha] },
    )
    const branch = await createRepoBranch(self, 
      metadata.owner,
      metadata.repo,
      token,
      input.args.branch,
      newCommit.sha,
    )
    const pr = await githubRequestJson<{ html_url: string; number: number }>(self, 
      `/repos/${metadata.owner}/${metadata.repo}/pulls`,
      token,
      'POST',
      {
        title: input.args.title,
        body: input.args.body ?? '',
        head: branch,
        base: baseRef,
        draft: input.args.draft ?? false,
      },
    )

    return {
      ok: true,
      changed: true,
      owner: metadata.owner,
      repo: metadata.repo,
      baseRef,
      branch,
      commitSha: newCommit.sha,
      pullRequestUrl: pr.html_url,
      pullRequestNumber: pr.number,
      filesChanged: changes.length,
      changedPaths: changes.map((c) => c.path).sort(),
    }
  }

export async function createRepoBranch(self: ToolBrokerService, 
    owner: string,
    repo: string,
    token: string | null,
    requestedBranch: string | undefined,
    commitSha: string,
  ): Promise<string> {
    const base = requestedBranch?.trim() || `agent/pr-${Date.now().toString(36)}`
    let candidate = base
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'enterprise-ai-agent-platform',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ref: `refs/heads/${candidate}`, sha: commitSha }),
      })
      if (res.ok) return candidate
      if (res.status !== 422) {
        const detail = await res.text().catch(() => '')
        throw new Error(`GitHub API failed creating branch: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
      }
      candidate = `${base}-${attempt + 2}`
    }
    throw new Error('repo_open_pull_request: could not allocate a free branch name (too many collisions)')
  }

export async function githubJson<T>(self: ToolBrokerService, path: string, token: string | null): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'enterprise-ai-agent-platform',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!res.ok) {
      throw new Error(`GitHub API failed: HTTP ${res.status}`)
    }
    return (await res.json()) as T
  }

export async function githubRequestJson<T>(self: ToolBrokerService, 
    path: string,
    token: string | null,
    method: 'POST' | 'PATCH',
    body: unknown,
  ): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'enterprise-ai-agent-platform',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`GitHub API failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
    }
    return (await res.json()) as T
  }

export async function resolveGitHubTokenForAgent(self: ToolBrokerService, agentId: string): Promise<string | null> {
    const connectors = await self.tools.findConnectorsForAgent(agentId)
    const github = connectors.find(({ connector }) => {
      if (connector.type !== 'http_api') return false
      const config = isRecord(connector.config) ? connector.config : {}
      const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : ''
      const provider = typeof config.provider === 'string' ? config.provider.toLowerCase() : ''
      return provider.includes('github') || baseUrl.includes('api.github.com')
    })
    if (!github) return null
    const alias = github.agentSecretAlias ?? github.connector.secretAlias
    return alias ? resolveConnectorApiKey(alias) : null
  }

export async function resolveDelegatedAccessToken(self: ToolBrokerService, 
    input: ToolBrokerInvokeInput,
    authorization: Extract<AuthorizationResult, { allowed: true }>,
  ): Promise<string> {
    if (!authorization.connector) throw new Error('delegated_access_token_requires_connector')
    if (authorization.connector.authMode !== 'user_delegated' || !authorization.grant) {
      throw new Error('delegated_access_token_requires_grant')
    }
    const actingUserId = authorization.actingUserId ?? (await self.resolveActingUserId(input))
    if (!actingUserId) throw new Error('acting_user_required')
    return self.grantService.resolveAccessToken({
      connector: authorization.connector,
      grantId: authorization.grant.id,
      tokenRef: authorization.grant.tokenRef,
      actingUserId,
      tenantId: (await self.resolveActingTenantId(input, actingUserId)) ?? authorization.connector.tenantId ?? null,
    })
  }

  /**
   * A hívó agent effektív tenant-kontextusa a tenant-izolációs döntésekhez
   * (agent felderítés/delegálás). A cselekvő felhasználó tenantja az elsődleges,
   * különben a hívó agent saját tenantja — a `user_directory` feloldásával
   * megegyező minta, hogy a humán- és az agent-directory ugyanazon a tenant-határon
   * lásson.
   */
export async function resolveCallerTenantId(self: ToolBrokerService, 
    input: ToolBrokerInvokeInput,
    actingTenantId: string | null,
  ): Promise<string | null> {
    if (actingTenantId) return actingTenantId
    const agent = await self.agents.findById(input.agentId)
    return agent?.tenantId ?? null
  }

  /**
   * §4.9.1 / D-B: az agenthez kötött ÖSSZES knowledge_base connector a scope —
   * a retrieval (kb_search és a navigáció is) ezek unióján dolgozik, nem csak az
   * authorizált egyen. Ha nincs linkelt KB, az authorizált connector a fallback.
   */
export async function resolveKbConnectorScope(self: ToolBrokerService, agentId: string, connector: Connector): Promise<string[]> {
    const linkedKbConnectorIds = (await self.tools.findConnectorsForAgent(agentId))
      .filter((link) => link.connector.type === 'knowledge_base')
      .map((link) => link.connector.id)
    return linkedKbConnectorIds.length > 0 ? linkedKbConnectorIds : [connector.id]
  }

export async function kbSearch(self: ToolBrokerService, 
    agentId: string,
    args: KbSearchArgs,
    connector: Connector,
  ): Promise<KbSearchResult> {
    const detail = await self.agents.findByIdWithDetails(agentId)
    if (!detail) throw new Error('Agent not found')

    const k = args.k ?? 5

    const connectorIds = await resolveKbConnectorScope(self, agentId, connector)

    const [okfChunkHits, supersededList, documentLists] = await Promise.all([
      self.knowledgeChunks.searchChunks({ connectorIds, query: args.query, limit: k }),
      self.knowledgeArtifacts.publishedSourceDocumentIds(connectorIds),
      Promise.all(connectorIds.map((id) => self.tools.findDocumentsForConnector(id))),
    ])

    const hits = assembleKbHits({
      query: args.query,
      k,
      memoryContent: detail.memoryContent ?? '',
      memoryId: detail.agent.memoryId,
      memoryVersion: detail.memoryVersion,
      okfChunkHits,
      docs: documentLists.flat(),
      supersededDocIds: new Set(supersededList),
    })

    return { hits }
  }

  /** §9.3 — az agent scope-jában elérhető published OKF-oldalak listája (navigáció). */
export async function kbListIndex(self: ToolBrokerService, 
    agentId: string,
    args: KbListIndexArgs,
    connector: Connector,
  ): Promise<KbListIndexResult> {
    const connectorIds = await resolveKbConnectorScope(self, agentId, connector)
    const entries = await self.knowledgeChunks.listIndex({
      connectorIds,
      pathPrefix: args.pathPrefix,
    })
    return assembleKbIndex(entries, args.maxDepth)
  }

  /** §9.2 — egy published OKF-oldal teljes tartalma + forrás-link (navigáció). */
export async function kbGetPage(self: ToolBrokerService, 
    agentId: string,
    args: KbGetPageArgs,
    connector: Connector,
  ): Promise<KbGetPageResult> {
    const connectorIds = await resolveKbConnectorScope(self, agentId, connector)
    const chunks = await self.knowledgeChunks.getPageChunks({
      connectorIds,
      path: args.path,
      artifactId: args.artifactId,
    })
    return assembleKbPage(args.path, chunks)
  }

export async function boardWrite(self: ToolBrokerService, 
    input: Extract<ToolBrokerInvokeInput, { tool: 'board_write' }>,
  ): Promise<BoardWriteResult> {
    const ticket = await self.tickets.findById(input.args.ticketId)
    if (!ticket) throw new Error('Ticket not found')

    const mergedPayload: Record<string, unknown> = isRecord(ticket.payload) ? { ...ticket.payload } : {}
    if (input.args.patch.payload) {
      Object.assign(mergedPayload, input.args.patch.payload)
    }

    if (
      shouldCompleteDelegation(mergedPayload, input.agentId, ticket.assigneeId, input.args.patch)
    ) {
      return await completeDelegationReturn(self, ticket, mergedPayload, input)
    }

    let result: BoardWriteResult

    // Folyamat-lépés lezárása a Playbook state machine-en át: a kötelező kapuk és
    // az output-szerződés kikényszerülnek, és a ProcessService.advance tovább-lépteti
    // a Futást. A payload+state itt EGY átmenetben megy (a state machine az
    // outputPayload-ot merge-öli és a szerződés ellen ellenőrzi) — ezért NEM írjuk
    // meg előre a payloadot. Ha nincs bekötve a handler, a legacy útra esünk vissza.
    const isProcessTicket = Boolean(
      ticket.processInstanceId && ticket.playbookVersionId && ticket.playbookStepId,
    )
    if (
      self.playbookTransitioner &&
      isProcessTicket &&
      input.args.patch.state &&
      input.args.patch.state !== ticket.state
    ) {
      await self.playbookTransitioner.transitionTicket({
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        toState: input.args.patch.state,
        actor: { type: 'agent', id: input.agentId },
        outputPayload: input.args.patch.payload,
      })
      const fresh = await self.tickets.findById(ticket.id)
      result = { ok: true, ticketId: ticket.id, state: fresh?.state ?? input.args.patch.state }
    } else {
      let current = ticket
      if (input.args.patch.payload) {
        current = await self.tickets.update(current.id, {
          payload: mergedPayload as Prisma.JsonValue,
        })
      }

      if (input.args.patch.state && input.args.patch.state !== current.state) {
        current = await self.ticketService.transition({
          ticketId: current.id,
          toState: input.args.patch.state,
          actor: { type: 'agent', agentId: input.agentId },
          agentVersion: input.agentVersion,
        })
      }

      result = { ok: true, ticketId: current.id, state: current.state }
    }

    await maybeRecordAgentAnswerComment(self, {
      ticketId: ticket.id,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
    })

    return result
  }

  /** Goose/board_write útvonal: agent-válasz a ticket-szálba (outputContract mezőkkel is). */
export async function maybeRecordAgentAnswerComment(self: ToolBrokerService, input: {
    ticketId: string
    agentId: string
    agentVersion: number
  }): Promise<void> {
    const ticket = await self.tickets.findById(input.ticketId)
    if (!ticket || ticket.agentId !== input.agentId) return
    if (!AGENT_ANSWER_COMPLETION_STATES.has(ticket.state)) return

    const payload = isRecord(ticket.payload) ? ticket.payload : {}
    const body = extractAgentAnswerDisplayBody(payload)
    if (!body) return

    const existing = await self.tickets.listComments(input.ticketId)
    const lastAgent = [...existing].reverse().find((comment) => comment.kind === 'agent_answer')
    if (lastAgent && lastAgent.body.trim() === body.trim()) return

    const agent = await self.agents.findById(input.agentId)
    await self.tickets.appendComment({
      ticketId: input.ticketId,
      kind: 'agent_answer',
      authorType: 'agent',
      authorAgentId: input.agentId,
      authorDisplayName: agent?.name ?? 'Agent',
      agentVersion: input.agentVersion,
      body,
      structured: agentAnswerStructuredFromPayload(payload) as Prisma.JsonObject,
    })
  }

export async function completeDelegationReturn(self: ToolBrokerService, 
    ticket: Ticket,
    mergedPayload: Record<string, unknown>,
    input: Extract<ToolBrokerInvokeInput, { tool: 'board_write' }>,
  ): Promise<BoardWriteResult> {
    const delegation = readDelegationPayload(mergedPayload)
    if (!delegation) throw new Error('Delegation payload missing')

    const requesterId = delegation.requesterAgentId
    const finalPayload: Record<string, unknown> = {
      ...mergedPayload,
      delegationReturned: true,
      answeredByAgentId: input.agentId,
      delegationCompletedAt: new Date().toISOString(),
    }

    if (ticket.lockToken) {
      await self.tickets.releaseDispatchLock(ticket.id, ticket.lockToken)
    }

    const fromState = ticket.state
    const updated = await self.tickets.update(ticket.id, {
      state: 'done',
      assigneeType: 'agent',
      assigneeId: requesterId,
      agentId: requesterId,
      payload: finalPayload as Prisma.JsonValue,
      lockToken: null,
      lockedAt: null,
    })

    await self.tickets.recordTransition({
      ticketId: ticket.id,
      fromState,
      toState: 'done',
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      note: `delegation completed; answer returned to requester ${requesterId}`,
    })

    await self.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: input.agentVersion,
      action: 'delegation.return',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: requesterId,
      outputRef: 'done',
      policyDecision: 'allowed',
      metadata: {
        answeredByAgentId: input.agentId,
        requesterAgentId: requesterId,
        parentTicketId: delegation.parentTicketId,
      } as Prisma.JsonValue,
    })

    if (delegation.parentTicketId) {
      await mergeDelegationIntoParent(self, 
        delegation.parentTicketId,
        requesterId,
        ticket.id,
        finalPayload,
      )
    }

    return { ok: true, ticketId: updated.id, state: updated.state }
  }

export async function mergeDelegationIntoParent(self: ToolBrokerService, 
    parentTicketId: string,
    requesterId: string,
    childTicketId: string,
    childPayload: Record<string, unknown>,
  ) {
    const parent = await self.tickets.findById(parentTicketId)
    if (!parent) return

    const parentPayload = isRecord(parent.payload) ? parent.payload : {}
    const entry = {
      delegationTicketId: childTicketId,
      question: typeof childPayload.question === 'string' ? childPayload.question : '',
      answer: typeof childPayload.answer === 'string' ? childPayload.answer : null,
      answeredByAgentId: childPayload.answeredByAgentId,
      returnedAt: childPayload.delegationCompletedAt,
    }

    const delegatedAnswers: Prisma.JsonValue[] = Array.isArray(parentPayload.delegatedAnswers)
      ? [...(parentPayload.delegatedAnswers as Prisma.JsonValue[]), entry as Prisma.JsonValue]
      : [entry as Prisma.JsonValue]

    await self.tickets.update(parentTicketId, {
      payload: { ...parentPayload, delegatedAnswers } as Prisma.JsonValue,
      assigneeType: 'agent',
      assigneeId: requesterId,
      agentId: requesterId,
    })
  }

export async function ticketCreate(self: ToolBrokerService, 
    input: Extract<ToolBrokerInvokeInput, { tool: 'ticket_create' }>,
    actingTenantId: string | null,
  ): Promise<TicketCreateResult> {
    const { args } = input

    // A modell néha nem-UUID értéket ad (pl. fájlnevet) UUID mezőkbe — ezt a
    // Prisma nyers „Error creating UUID" hibával dobná. Tisztán kezeljük.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (args.assigneeType === 'agent') {
      if (!args.assigneeId) throw new Error('assigneeId is required when assigneeType is agent')
      if (!UUID_RE.test(args.assigneeId)) {
        throw new Error(`assigneeId must be an agent UUID, got "${args.assigneeId}"`)
      }
      const assignee = await self.agents.findById(args.assigneeId)
      if (!assignee) throw new Error('Assignee agent not found')
      // Tenant-izoláció: a feladat a szülő-ticket (különben a cselekvő felhasználó)
      // tenantjában jön létre; cross-tenant agenthez SOHA nem rendelünk ticketet.
      // Ez az agent-felelős párja a humán-felelős ág alábbi tenant-ellenőrzésének.
      const assigneeRefTenantId =
        (input.ticketId ? (await self.tickets.findById(input.ticketId))?.tenantId ?? null : null) ??
        actingTenantId
      if (!isAgentReachableFromTenant(assignee.tenantId, assigneeRefTenantId)) {
        throw new Error('Assignee agent is not reachable from this tenant')
      }
    }
    // Humán felelős (a user_directory-ból): ha az agent egy konkrét humán
    // userId-t ad, validáljuk (létező, aktív, azonos tenant) és a ticketre
    // kötjük — így a feladat egy NEVESÍTETT emberhez kerül, nem csak a "human"
    // várólistára. Érvénytelen/ismeretlen id némán null (a ticket attól még
    // awaiting_human-ra megy).
    let humanAssigneeId: string | null = null
    if (args.assigneeType === 'human' && args.assigneeId && UUID_RE.test(args.assigneeId)) {
      const parentTenantId = input.ticketId
        ? (await self.tickets.findById(input.ticketId))?.tenantId ?? null
        : null
      const candidate = await prisma.user.findUnique({
        where: { id: args.assigneeId },
        select: { id: true, status: true, tenantId: true },
      })
      if (candidate && candidate.status === 'active' && candidate.tenantId === parentTenantId) {
        humanAssigneeId = candidate.id
      }
    }

    const safeSourceDocumentId =
      args.sourceDocumentId && UUID_RE.test(args.sourceDocumentId) ? args.sourceDocumentId : null

    const workerAgentId = args.assigneeType === 'agent' ? args.assigneeId! : input.agentId
    const payload: Record<string, unknown> = {
      ...args.payload,
      source: 'agent_tool',
      createdByAgentId: input.agentId,
    }
    if (input.ticketId) payload.parentTicketId = input.ticketId
    if (input.conversationId) payload.conversationId = input.conversationId

    const parent = input.ticketId ? await self.tickets.findById(input.ticketId) : null
    if (parent) {
      const parentPayload = isRecord(parent?.payload) ? parent.payload : null
      if (isRunAsAuthorized(parentPayload)) {
        payload.runAsUserId = readRunAsUserId(parentPayload)
        payload[RUN_AS_AUTHORIZED_AT] = parentPayload![RUN_AS_AUTHORIZED_AT]
        payload[RUN_AS_AUTHORIZED_BY] = parentPayload![RUN_AS_AUTHORIZED_BY]
      }
    }

    const initialState: TicketState = args.assigneeType === 'agent' ? 'ready' : 'in_progress'

    let ticket = await self.tickets.create({
      tenantId: parent?.tenantId ?? null,
      type: 'interaction',
      title: args.title,
      state: initialState,
      assigneeType: args.assigneeType,
      assigneeId: args.assigneeType === 'agent' ? args.assigneeId! : humanAssigneeId,
      agentId: workerAgentId,
      payload: payload as Prisma.JsonValue,
      sourceDocumentId: safeSourceDocumentId,
      executeAfter: null,
      dueBy: null,
      createdById: await systemUserId(),
    })

    if (args.assigneeType === 'human') {
      ticket = await self.ticketService.transition({
        ticketId: ticket.id,
        toState: 'awaiting_human',
        actor: { type: 'agent', agentId: input.agentId },
        agentVersion: input.agentVersion,
      })
    }

    return {
      ok: true,
      ticketId: ticket.id,
      state: ticket.state,
      assigneeType: args.assigneeType,
      assigneeId: ticket.assigneeId,
    }
  }

export async function agentAsk(self: ToolBrokerService, 
    input: Extract<ToolBrokerInvokeInput, { tool: 'agent_ask' }>,
    actingTenantId: string | null,
  ): Promise<AgentAskResult> {
    const question = input.args.question.trim()
    if (!question) throw new Error('Question is required')

    if (input.args.targetAgentId === input.agentId) {
      throw new Error('Cannot delegate to the same agent — choose a different targetAgentId')
    }

    const target = await self.agents.findById(input.args.targetAgentId)
    if (!target) throw new Error('Target agent not found')
    if (target.role === 'orchestrator') {
      throw new Error('Target agent is orchestrator and cannot answer delegated tickets')
    }

    // Tenant-izoláció: a delegálás-ticket a szülő-ticket (különben a cselekvő
    // felhasználó) tenantjában jön létre; cross-tenant agentnek SOHA nem delegálunk.
    const parentTenantId = input.ticketId
      ? (await self.tickets.findById(input.ticketId))?.tenantId ?? null
      : null
    const effectiveTenantId = parentTenantId ?? actingTenantId
    if (!isAgentReachableFromTenant(target.tenantId, effectiveTenantId)) {
      throw new Error('Target agent is not reachable from this tenant')
    }

    const payload: Record<string, unknown> = {
      delegation: true,
      requesterAgentId: input.agentId,
      question,
      source: 'agent_ask',
    }
    if (input.ticketId) payload.parentTicketId = input.ticketId
    if (input.conversationId) payload.conversationId = input.conversationId
    if (input.args.context && Object.keys(input.args.context).length > 0) {
      payload.context = input.args.context
    }

    const ticket = await self.tickets.create({
      tenantId: parentTenantId,
      type: 'interaction',
      title: `Delegálás: ${question.slice(0, 80)}`,
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: input.args.targetAgentId,
      agentId: input.args.targetAgentId,
      payload: payload as Prisma.JsonValue,
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: await systemUserId(),
    })

    const base: AgentAskResult = {
      ok: true,
      ticketId: ticket.id,
      state: ticket.state,
      targetAgentId: input.args.targetAgentId,
      requesterAgentId: input.agentId,
    }

    // Chat flow: szinkron delegálás — ne térjen vissza, amíg a célagent meg nem válaszolt.
    if (!self.delegationProcessor || !input.conversationId) {
      return base
    }

    try {
      await self.delegationProcessor({
        ticketId: ticket.id,
        targetAgentId: input.args.targetAgentId,
        requesterAgentId: input.agentId,
        actingUserId: input.actingUserId,
      })
    } catch (error) {
      return {
        ...base,
        completed: false,
        error: error instanceof Error ? error.message : 'delegation_failed',
      }
    }

    const finished = await self.tickets.findById(ticket.id)
    if (!finished) {
      return { ...base, completed: false, error: 'delegation_ticket_missing' }
    }

    const finishedPayload = isRecord(finished.payload) ? finished.payload : {}
    if (finishedPayload.delegationReturned !== true || typeof finishedPayload.answer !== 'string') {
      return {
        ...base,
        state: finished.state,
        completed: false,
        error: 'delegation_not_completed',
      }
    }

    return {
      ...base,
      state: finished.state,
      completed: true,
      answer: finishedPayload.answer,
      sources: finishedPayload.sources,
      rationale:
        typeof finishedPayload.rationale === 'string' ? finishedPayload.rationale : undefined,
      confidence:
        typeof finishedPayload.confidence === 'string' ? finishedPayload.confidence : undefined,
      answeredByAgentId:
        typeof finishedPayload.answeredByAgentId === 'string'
          ? finishedPayload.answeredByAgentId
          : input.args.targetAgentId,
    }
  }

export async function webResearchRequest(self: ToolBrokerService, 
    input: Extract<ToolBrokerInvokeInput, { tool: 'web_research_request' }>,
  ): Promise<WebResearchDelegationResult> {
    const objective = input.args.objective.trim()
    if (!objective) throw new Error('objective is required')

    const requester = await self.agents.findById(input.agentId)
    const requesterVersion = requester?.currentVersion ?? input.agentVersion
    const objectiveHash = createHash('sha256').update(objective).digest('hex').slice(0, 16)

    if (!(await self.isWebResearchDelegationEnabled())) {
      await auditWebResearchBlocked(self, input.agentId, requesterVersion, 'delegation_disabled', { objectiveHash })
      return { ok: false, error: 'delegation_disabled' }
    }
    if (!(await self.isWebFetchEnabled())) {
      await auditWebResearchBlocked(self, input.agentId, requesterVersion, 'web_fetch_disabled', { objectiveHash })
      return { ok: false, error: 'web_fetch_disabled' }
    }

    const maxPerRequesterDay =
      Number(process.env.WEB_RESEARCH_MAX_PER_REQUESTER_DAY) > 0
        ? Number(process.env.WEB_RESEARCH_MAX_PER_REQUESTER_DAY)
        : 20
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const requesterDayUsed = await prisma.auditLog
      .count({
        where: {
          action: 'agent.web_research.requested',
          actorId: input.agentId,
          createdAt: { gte: since },
        },
      })
      .catch(() => 0)
    if (requesterDayUsed >= maxPerRequesterDay) {
      await auditWebResearchBlocked(self, input.agentId, requesterVersion, 'requester_daily_limit', { objectiveHash })
      return { ok: false, error: 'requester_daily_limit' }
    }

    const egressAgent = await resolveWebEgressAgent(self, requester?.tenantId ?? null)
    if (!egressAgent) {
      await auditWebResearchBlocked(self, input.agentId, requesterVersion, 'web_egress_agent_missing', { objectiveHash })
      return { ok: false, error: 'web_egress_agent_missing' }
    }

    const allowedSourceTypes = resolveResearchSourceTypes(self, input.args.allowedSourceTypes)
    await self.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: requesterVersion,
      action: 'agent.web_research.requested',
      targetType: 'web_research',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: {
        requesterAgentId: input.agentId,
        egressRoleAgentId: egressAgent.id,
        objectiveHash,
        contractVersion: 'web_research/v1',
        allowedSourceTypes,
      } as Prisma.JsonValue,
    })

    const maxSources = Math.max(
      1,
      Math.min(
        Number(input.args.maxSources) > 0 ? Math.floor(Number(input.args.maxSources)) : 4,
        Number(process.env.WEB_RESEARCH_MAX_SOURCES) > 0 ? Number(process.env.WEB_RESEARCH_MAX_SOURCES) : 8,
      ),
    )
    const query = input.args.knownDomain ? `${objective} site:${input.args.knownDomain}` : objective
    const search = await self.invoke({
      agentId: egressAgent.id,
      agentVersion: egressAgent.currentVersion,
      tool: 'web_search',
      args: { query, maxResults: maxSources * 2, purpose: 'web_research_request' },
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.ticketId ? { ticketId: input.ticketId } : {}),
      ...(input.actingUserId ? { actingUserId: input.actingUserId } : {}),
    })
    if (search.denied) {
      await auditWebResearchBlocked(self, egressAgent.id, egressAgent.currentVersion, 'NO_TRUSTED_SOURCE', {
        requesterAgentId: input.agentId,
        reason: search.reason,
        objectiveHash,
      })
      return { ok: false, error: 'NO_TRUSTED_SOURCE' }
    }

    const registry = new KnownUrlRegistry()
    const searchResult = search.result as WebSearchResult
    const usable = searchResult.results
      .filter((r) => isResearchSourceType(self, r.sourceType) && allowedSourceTypes.includes(r.sourceType))
      .slice(0, maxSources)
    if (usable.length === 0) {
      await auditWebResearchBlocked(self, egressAgent.id, egressAgent.currentVersion, 'NO_TRUSTED_SOURCE', {
        requesterAgentId: input.agentId,
        objectiveHash,
      })
      return { ok: false, error: 'NO_TRUSTED_SOURCE' }
    }

    const fetchedAt = new Date().toISOString()
    const sources = usable.map((source) => {
      registry.add(source.url, source.sourceType)
      const statementSeed = `${source.title}\n${source.snippet}`
      return {
        urlHash: createHash('sha256').update(source.url).digest('hex').slice(0, 16),
        host: source.domain.toLowerCase(),
        sourceType: source.sourceType as WebResearchSourceType,
        contentHash: createHash('sha256').update(statementSeed).digest('hex').slice(0, 16),
        fetchedAt,
      }
    })
    const facts = usable.map((source, index) => ({
      statement: `${source.title}: ${source.snippet}`.replace(/\s+/g, ' ').trim().slice(0, 1000),
      sourceIndices: [index],
      confidence: source.sourceType === 'official' || source.sourceType === 'vendor_doc' ? 'medium' as const : 'low' as const,
    }))
    const hasUnverified = sources.some((source) => source.sourceType === 'news' || source.sourceType === 'blog')
    const candidate: WebResearchResult = {
      objectiveEcho: objective.slice(0, 500),
      facts,
      sources,
      overallConfidence: hasUnverified ? 'medium' : 'medium',
      unverified: hasUnverified,
      provenance: {
        egressRoleAgentId: egressAgent.id,
        egressRoleAgentVersion: egressAgent.currentVersion,
        requesterAgentId: input.agentId,
        queryHash: objectiveHash,
        contractVersion: 'web_research/v1',
      },
    }

    const validation = validateWebResearchResult(candidate, {
      knownHosts: registry.hosts(),
      maxFacts: Number(process.env.WEB_RESEARCH_MAX_FACTS) > 0 ? Number(process.env.WEB_RESEARCH_MAX_FACTS) : 20,
      maxSources,
    })
    if (validation.status === 'failed') {
      await auditWebResearchBlocked(self, egressAgent.id, egressAgent.currentVersion, 'RESEARCH_VALIDATION_FAILED', {
        requesterAgentId: input.agentId,
        objectiveHash,
        errors: validation.errors,
      })
      return { ok: false, error: 'RESEARCH_VALIDATION_FAILED' }
    }

    const sourceHistogram: Record<string, number> = {}
    for (const source of validation.result.sources) {
      sourceHistogram[source.sourceType] = (sourceHistogram[source.sourceType] ?? 0) + 1
    }
    await self.audit.append({
      actorType: 'agent',
      actorId: egressAgent.id,
      agentVersion: egressAgent.currentVersion,
      action: 'agent.web_research.completed',
      targetType: 'web_research',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: validation.status === 'warned' ? 'warned' : 'allowed',
      metadata: {
        requesterAgentId: input.agentId,
        sourceCount: validation.result.sources.length,
        factCount: validation.result.facts.length,
        sourceHistogram,
        overallConfidence: validation.result.overallConfidence,
        unverified: validation.result.unverified,
        contractVersion: 'web_research/v1',
      } as Prisma.JsonValue,
    })

    return { ok: true, result: validation.result }
  }

export async function resolveWebEgressAgent(self: ToolBrokerService, tenantId: string | null) {
    const candidates = await self.agents.findMany({ tenantId })
    for (const agent of candidates.filter((a) => a.status === 'active')) {
      const [searchCap, fetchCap] = await Promise.all([
        self.tools.findCapability(agent.id, 'web_search'),
        self.tools.findCapability(agent.id, 'web_fetch'),
      ])
      if (searchCap?.allowed && fetchCap?.allowed) return agent
    }
    return null
  }

export function resolveResearchSourceTypes(self: ToolBrokerService, requested?: WebResearchSourceType[]): WebResearchSourceType[] {
    const bankPreset = process.env.PROVISIONING_BANK_PRESET === 'true'
    const policy: WebResearchSourceType[] = bankPreset
      ? ['official', 'vendor_doc']
      : ['official', 'vendor_doc', 'news', 'blog']
    if (!requested || requested.length === 0) return policy
    const requestedSet = new Set(requested)
    return policy.filter((sourceType) => requestedSet.has(sourceType))
  }

export function isResearchSourceType(self: ToolBrokerService, value: string): value is WebResearchSourceType {
    return value === 'official' || value === 'vendor_doc' || value === 'news' || value === 'blog'
  }

export async function auditWebResearchBlocked(self: ToolBrokerService, 
    actorId: string,
    agentVersion: number | null,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await self.audit.append({
      actorType: 'agent',
      actorId,
      agentVersion,
      action: 'agent.web_research.blocked',
      targetType: 'web_research',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'blocked',
      metadata: { reason, ...metadata } as Prisma.JsonValue,
    })
  }

export async function agentResolve(self: ToolBrokerService, 
    args: AgentResolveArgs,
    effectiveTenantId: string | null,
  ): Promise<AgentResolveResult> {
    const query = normalizeText(args.query.trim())
    if (!query) throw new Error('Query is required')

    const limit = args.limit ?? 5
    // Tenant-izoláció: cross-tenant agent SOHA nem szivárog ki a felderítésbe.
    const all = filterAgentsByTenant(await self.agents.findMany(), effectiveTenantId)

    const scored = all
      .filter((agent) => agent.status === 'active')
      .map((agent) => {
        const persona = personaFor(agent.name)
        const score = scoreAgentForCatalogQuery(agent, args.query)
        return { agent, persona, score }
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return {
      agents: scored.map(({ agent, persona, score }) => ({
        agentId: agent.id,
        name: agent.name,
        nickname: persona.nickname,
        role: agent.role,
        trait: persona.trait,
        score,
      })),
    }
  }

export async function agentCatalog(self: ToolBrokerService, 
    args: AgentCatalogArgs,
    effectiveTenantId: string | null,
  ): Promise<AgentCatalogResult> {
    const limitDefault = args.query?.trim() ? 5 : 25

    if (args.agentId) {
      // Tenant-izoláció: cross-tenant agentet nem árulunk el (a teljes
      // capability-/connector-katalógusát sem) — nem-elérhető id némán üres.
      const agent = await self.agents.findById(args.agentId)
      if (!agent || !isAgentReachableFromTenant(agent.tenantId, effectiveTenantId)) {
        return { agents: [] }
      }
      const entry = await buildAgentCatalogEntry(args.agentId, self.agents, self.tools)
      return { agents: [entry] }
    }

    // Tenant-izoláció: a katalógus csak a saját tenant + megosztott agenteket listázza.
    const all = filterAgentsByTenant(await self.agents.findMany(), effectiveTenantId)
    let candidates = all.filter((agent) => agent.status === 'active')

    if (args.query?.trim()) {
      candidates = candidates
        .map((agent) => ({ agent, score: scoreAgentForCatalogQuery(agent, args.query!) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((row) => row.agent)
    }

    const limit = args.limit ?? limitDefault
    const selected = candidates.slice(0, limit)
    const agents = await Promise.all(
      selected.map((agent) => buildAgentCatalogEntry(agent.id, self.agents, self.tools)),
    )

    return { agents }
  }

  /**
   * user_directory — a hívó agent tenantjához tartozó AKTÍV humán felhasználók
   * listája a szabad szöveges szerepükkel (`jobDescription`). A tenant a hívó
   * kontextusából oldódik fel (acting-user tenant, különben az agent tenantja) —
   * cross-tenant felhasználó SOHA nem szivárog ki. Az opcionális `query` a
   * néven / szerepen / e-mailen szűr (ékezet- és kisbetű-független).
   */
export async function userDirectory(self: ToolBrokerService, 
    input: Extract<ToolBrokerInvokeInput, { tool: 'user_directory' }>,
    actingTenantId: string | null,
  ): Promise<UserDirectoryResult> {
    const agent = await self.agents.findById(input.agentId)
    const tenantId = actingTenantId ?? agent?.tenantId ?? null

    const all = await self.lookupTenantUserDirectory(tenantId)
    return filterUserDirectory(all, input.args)
  }

/**
 * memory_propose — agent-memory-persistent-cross-conversation-spec.md §6.1/§10.3.
 * A `projectKey`-t NEM az agent args-ja adja (scope-injekció ellen, §2.1 NF2):
 * a futás kontextusából oldódik fel — chatben a `Conversation.projectKey`,
 * folyamat-ticketnél a `Ticket.processInstanceId → ProcessInstance.processDefinitionId`,
 * egyébként a `__general__` szentinel (§2.1).
 */
export async function memoryPropose(self: ToolBrokerService,
  input: Extract<ToolBrokerInvokeInput, { tool: 'memory_propose' }>,
  actingTenantId: string | null,
): Promise<MemoryProposeResult> {
  const projectKey = await resolveMemoryProjectKey(self, input)
  return self.memoryProposal.proposeMemoryChange(
    {
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      actingTenantId,
      projectKey,
      ticketId: input.ticketId ?? null,
      conversationId: input.conversationId ?? null,
    },
    input.args,
  )
}

async function resolveMemoryProjectKey(
  self: ToolBrokerService,
  input: Extract<ToolBrokerInvokeInput, { tool: 'memory_propose' }>,
): Promise<string> {
  if (input.conversationId) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { projectKey: true },
    })
    if (conversation) return conversation.projectKey
  }
  if (input.ticketId) {
    const ticket = await self.tickets.findById(input.ticketId)
    if (ticket?.processInstanceId) {
      const process = await prisma.processInstance.findUnique({
        where: { id: ticket.processInstanceId },
        select: { processDefinitionId: true },
      })
      if (process?.processDefinitionId) return process.processDefinitionId
    }
  }
  return '__general__'
}
