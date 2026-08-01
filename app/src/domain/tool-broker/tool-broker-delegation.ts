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
  Document,
  Prisma,
  Ticket,
  TicketState,
} from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { readFile as nodeReadFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { prisma } from '@/lib/db'
import { loadPdfParse } from '@/lib/pdf-parse'
import { buildTulajdoniLapView, parseTulajdoniLap } from '@/lib/tulajdoni-lap'
import {
  bufferLooksLikePdf,
  pagesFromDocumentExtraction,
} from '@/lib/tulajdoni-lap-pages'
import { resolveTulajdoniLapParseSource } from '@/lib/tulajdoni-lap-source'
import {
  EGYEZTETES_STATUSZOK,
  assessNyilvantartasCompleteness,
  buildEgyeztetesMunkafuzet,
  hasCompleteHttpApiGetAllProvenance,
  egyeztetesSorok,
  normalizeNyilvantartasRows,
  type EgyeztetesNyilvantartasSor,
} from '@/lib/tulajdoni-lap-egyeztetes'
import { parseReconcileRecordList } from '@/lib/reconcile-records'
import { FileEditorError } from '@/domain/file-editor/workspace-storage'
import { unwrapExternalDataEnvelope } from '@/domain/tool-broker/tool-result-envelope'
import { personaFor } from '@/lib/agent-persona'
import {
  buildAgentCatalogEntry,
  scoreAgentForCatalogQuery,
} from '@/lib/agent-catalog'
import { readDelegationPayload, shouldCompleteDelegation } from '@/lib/delegation-payload'
import { DELEGATION_DEADLINE, raceDelegationDeadline } from '@/lib/delegation-deadline'

import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import { AgentAccessError } from '@/domain/agent-access/agent-access-errors'
import { selectActiveTenantWebEgress } from '@/domain/agent-access/tenant-web-egress-selection'
import type { AgentAccessChannel } from '@/lib/agent-access-graph'
import type { AgentGraphNode } from '@/domain/agent-access/agent-access-service'
import { resolveToolWorkspaceTenantKey } from '@/lib/workspace-resource-access'
import {
  agentAnswerStructuredFromPayload,
  extractAgentAnswerDisplayBody,
} from '@/lib/playbook-v2/process-step-payload'
import {
  isRunAsAuthorized,
  readRunAsUserId,
  RUN_AS_AUTHORIZED_AT,
  RUN_AS_AUTHORIZED_BY,
  RUN_AS_USER_ID,
  SCHEDULED_TASK_ID,
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
  DocumentReadResult,
  MemoryProposeResult,
  RepoOpenPullRequestResult,
  RepoPrepareResult,
  TicketCreateResult,
  ToolBrokerInvokeInput,
  TulajdoniLapParseResult,
  TulajdoniLapEgyeztetesResult,
  UserDirectoryResult,
  WebResearchDelegationResult,
} from './tool-broker-types'
import { blocksFromDocument, readDocumentPages } from '@/lib/document-read'
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

    const tenantId = await resolveWorkspaceStorageTenantId(
      self,
      input,
      actingTenantId,
      workspaceConnector.tenantId,
    )
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

    const tenantId = await resolveWorkspaceStorageTenantId(
      self,
      input,
      actingTenantId,
      workspaceConnector.tenantId,
    )
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
 * Workspace storage tenant a file/repo toolökhöz: ticket/conversation tenant
 * elsőbbség (feltöltési úttal egyező), majd acting / connector / `global`.
 */
export async function resolveWorkspaceStorageTenantId(
  self: ToolBrokerService,
  input: Pick<ToolBrokerInvokeInput, 'ticketId' | 'conversationId'>,
  actingTenantId: string | null,
  connectorTenantId: string | null | undefined,
): Promise<string> {
  let resourceTenantId: string | null = null
  if (input.ticketId) {
    const ticket = await self.tickets.findById(input.ticketId)
    resourceTenantId = ticket?.tenantId ?? null
  } else if (input.conversationId) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { tenantId: true },
    })
    resourceTenantId = conversation?.tenantId ?? null
  }
  return resolveToolWorkspaceTenantKey({
    resourceTenantId,
    actingTenantId,
    connectorTenantId,
  })
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
    const detail = await self.agents.findByIdForRuntime(agentId)
    if (!detail) throw new Error('Agent not found')

    const k = args.k ?? 5

    const connectorIds = await resolveKbConnectorScope(self, agentId, connector)

    const [okfChunkHits, supersededList] = await Promise.all([
      self.knowledgeChunks.searchChunks({ connectorIds, query: args.query, limit: k }),
      self.knowledgeArtifacts.publishedSourceDocumentIds(connectorIds),
    ])

    // Legacy docs: egy batch query, a published OKF forrásdokumentumok kihagyásával
    // (nincs nyers+parafrázis dupla betöltés), hard cap a stem-scoring CPU/IO miatt.
    const docs = await self.tools.findDocumentsForConnectors(connectorIds, {
      excludeIds: supersededList,
      take: 200,
    })

    const hits = assembleKbHits({
      query: args.query,
      k,
      memoryContent: detail.memoryContent ?? '',
      memoryId: detail.agent.memoryId,
      memoryVersion: detail.memoryVersion,
      okfChunkHits,
      docs,
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
    // A scheduled run-as hivatkozás bizalmi adat, nem agent-módosítható output.
    // Enélkül egy board_write nullra írhatná a task-ID-t, és megkerülhetné a
    // Broker futáskori, visszavonható grant-ellenőrzését.
    const originalPayload = isRecord(ticket.payload) ? ticket.payload : null
    if (typeof originalPayload?.[SCHEDULED_TASK_ID] === 'string') {
      for (const key of [SCHEDULED_TASK_ID, RUN_AS_USER_ID, RUN_AS_AUTHORIZED_AT, RUN_AS_AUTHORIZED_BY]) {
        mergedPayload[key] = originalPayload[key]
      }
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
      // #142 — a ticket agent-felelősre címzése ugyanaz az `address` ige, mint a chat
      // vagy a delegálás; csak a CSATORNA más. Ha ez a kapu hiányozna, a gráfot meg
      // lehetne kerülni egy ticket felvételével.
      await assertAgentGraphAccess(self, {
        callerAgentId: input.agentId,
        callerAgentVersion: input.agentVersion,
        targetAgentId: args.assigneeId,
        effectiveTenantId: assigneeRefTenantId,
        channel: 'ticket',
        ticketId: input.ticketId ?? null,
        conversationId: input.conversationId ?? null,
        actingUserId: input.actingUserId ?? null,
      })
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

/**
 * Az agent-hozzáférési gráf EXPLICIT kapuja a tool-úton (#142).
 *
 * A sorrend a specé: hitelesítés és tenant-kontextus → meglévő durva capability-check
 * (`AllowlistAuthorizer`, a `invoke` keretben) → cél feloldása és csatorna-alkalmassága
 * → EZ a kapu → végrehajtás és audit. A gráf-gate tehát TOVÁBBI feltétel: nem írja felül
 * a capability-checket, az agent státuszát vagy az orchestrator-szabályt.
 *
 * FAIL-CLOSED: ha a gráf-szolgáltatás nincs bekötve, `AGENT_NOT_FOUND`-ot dobunk. Egy
 * elmaradt dependency-injection sosem nyithat meg agent→agent utat.
 */
async function assertAgentGraphAccess(
  self: ToolBrokerService,
  params: {
    callerAgentId: string
    callerAgentVersion?: number | null
    targetAgentId: string
    effectiveTenantId: string | null
    channel: AgentAccessChannel
    ticketId?: string | null
    conversationId?: string | null
    actingUserId?: string | null
  },
): Promise<void> {
  if (!self.agentAccess) throw AgentAccessError.notFound()
  if (!params.effectiveTenantId) throw AgentAccessError.notFound('tenant_boundary')

  await self.agentAccess.assertCanAccessAgent({
    subject: {
      kind: 'agent',
      agentId: params.callerAgentId,
      tenantId: params.effectiveTenantId,
    },
    targetAgentId: params.targetAgentId,
    verb: 'address',
    audit: {
      channel: params.channel,
      ticketId: params.ticketId ?? null,
      conversationId: params.conversationId ?? null,
      // A kezdeményező ember AUDIT-KORRELÁCIÓ, nem authorization subject (I1).
      initiatingUserId: params.actingUserId ?? null,
      agentVersion: params.callerAgentVersion ?? null,
    },
  })
}

/**
 * A gráf szerint LÁTHATÓ (`view`) tenant-agentek listája a felderítő toolokhoz
 * (`agent_catalog`, `agent_resolve`). Fail-closed: bekötetlen gráf-szolgáltatásnál
 * üres lista — a felderítés inkább semmit ne adjon, mint idegen agenteket.
 */
async function listViewableAgents(
  self: ToolBrokerService,
  callerAgentId: string,
  effectiveTenantId: string | null,
): Promise<AgentGraphNode[]> {
  if (!self.agentAccess || !effectiveTenantId) return []
  return self.agentAccess.listAccessibleAgents(
    { kind: 'agent', agentId: callerAgentId, tenantId: effectiveTenantId },
    'view',
    { activeOnly: true },
  )
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

    // #142 — agent-hozzáférési gráf: a delegáció a HÍVÓ AGENT saját `address` jogán
    // fut (I1), nem a kezdeményező emberén. A `view` jog függvényében 403- vagy
    // 404-jellegű, determinisztikus elutasítást kap.
    await assertAgentGraphAccess(self, {
      callerAgentId: input.agentId,
      callerAgentVersion: input.agentVersion,
      targetAgentId: input.args.targetAgentId,
      effectiveTenantId,
      channel: 'agent_ask',
      ticketId: input.ticketId ?? null,
      conversationId: input.conversationId ?? null,
      actingUserId: input.actingUserId ?? null,
    })

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

    // A delegált agent futása a HÍVÓ fordulójának faliórájából fogy (mért eset
    // 2026-07-31: négy kérdés 136 másodpercet vitt el egy 180 másodperces
    // keretből, és két forduló emiatt futott ki idő előtt). A határidő nem
    // szakítja meg a cél-agentet — csak elengedi a várást: a ticket megmarad, a
    // válasz később a beszélgetésbe kerül (l. `listReturnedDelegationsForConversation`).
    // A `.then(ok, err)` pár SZÁNDÉKOSAN a versenyeztetés ELŐTT áll: a határidő
    // után az elengedett ág tovább fut, és ha ilyenkor dobna, kezeletlen
    // promise-elutasítás lenne belőle (a processz szintjén). Így viszont a hiba
    // már értékként van elnyelve — nincs mit kezeletlenül hagyni.
    const running = self
      .delegationProcessor({
        ticketId: ticket.id,
        targetAgentId: input.args.targetAgentId,
        requesterAgentId: input.agentId,
        actingUserId: input.actingUserId,
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )

    const settled = await raceDelegationDeadline(running, input.deadlineAt)
    if (settled === DELEGATION_DEADLINE) {
      // A cél-agent tovább dolgozik, és a ticketbe beírja a válaszát; a
      // beszélgetésbe a következő fordulóban kerül be.
      return { ...base, completed: false, error: 'deadline_exceeded' }
    }
    if (!settled.ok) {
      return {
        ...base,
        completed: false,
        error: settled.error instanceof Error ? settled.error.message : 'delegation_failed',
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

    // A válasz MOST kerül a modell elé tool-eredményként, tehát a beszélgetésbe
    // már ne injektáljuk be még egyszer a következő fordulóban. Fail-soft: a
    // jelölés hibája legfeljebb egy ismételt megjelenítést okoz, nem hibát.
    await self.tickets.markDelegationSurfaced(ticket.id).catch(() => {})

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

    // #142 — a tenant Web-Egress példánya teljes gráfcsomópont, `inboundRestricted=true`
    // alapértékkel: CSAK explicit agent→Web-Egress `address` granttal hívható. Ez teszi
    // a webes kimenetet tudatos, tenant-admin által engedélyezett opt-inné.
    try {
      await assertAgentGraphAccess(self, {
        callerAgentId: input.agentId,
        callerAgentVersion: requesterVersion,
        targetAgentId: egressAgent.id,
        effectiveTenantId: requester?.tenantId ?? null,
        channel: 'web_research',
        ticketId: input.ticketId ?? null,
        conversationId: input.conversationId ?? null,
        actingUserId: input.actingUserId ?? null,
      })
    } catch (error) {
      if (!(error instanceof AgentAccessError)) throw error
      await auditWebResearchBlocked(self, input.agentId, requesterVersion, 'web_egress_access_denied', {
        objectiveHash,
        accessErrorCode: error.code,
      })
      return { ok: false, error: 'web_egress_access_denied' }
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
      .filter((r) =>
        (r.sourceType === 'official' || r.sourceType === 'vendor_doc') &&
        allowedSourceTypes.includes(r.sourceType),
      )
      .slice(0, maxSources)
    if (usable.length === 0) {
      await auditWebResearchBlocked(self, egressAgent.id, egressAgent.currentVersion, 'NO_TRUSTED_SOURCE', {
        requesterAgentId: input.agentId,
        objectiveHash,
      })
      return { ok: false, error: 'NO_TRUSTED_SOURCE' }
    }

    if (!self.webResearchFetch) {
      throw new Error('web_research_fetch_not_configured')
    }
    const allowedSourceUrls = usable.map((source) => source.url)
    const fetched = [] as Array<{ source: (typeof usable)[number]; text: string; host: string; contentHash: string }>
    for (const [index, source] of usable.entries()) {
      registry.add(source.url, source.sourceType)
      const result = await self.webResearchFetch({
        agentId: egressAgent.id,
        tenantId: requester?.tenantId ?? null,
        url: source.url,
        sourceType: source.sourceType as 'official' | 'vendor_doc',
        allowedSourceUrls,
        fetchIndex: index,
      })
      if (result.ok) {
        fetched.push({ source, text: result.text, host: result.host, contentHash: result.contentHash })
      }
    }
    if (fetched.length === 0) {
      await auditWebResearchBlocked(self, egressAgent.id, egressAgent.currentVersion, 'NO_TRUSTED_SOURCE', {
        requesterAgentId: input.agentId,
        objectiveHash,
      })
      return { ok: false, error: 'NO_TRUSTED_SOURCE' }
    }
    const fetchedAt = new Date().toISOString()
    const sources = fetched.map(({ source, host, contentHash }) => ({
      urlHash: createHash('sha256').update(source.url).digest('hex').slice(0, 16),
      host: host.toLowerCase(),
      sourceType: source.sourceType as WebResearchSourceType,
      contentHash,
      fetchedAt,
    }))
    const facts = fetched.map(({ source, text }, index) => ({
      statement: `${source.title}: ${text}`.replace(/\s+/g, ' ').trim().slice(0, 1000),
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
    // #142 fail-closed: csak a tenant saját, perzisztált systemRole=web_egress
    // példánya. Capability vagy név alapján nem választunk — az adminisztrálható
    // UI-adat / hibásan kiosztott tool-jog nem nyithat webes egress-utat.
    if (!tenantId) return null
    const candidates = await self.agents.findMany({ tenantId })
    return selectActiveTenantWebEgress(tenantId, candidates)
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
    callerAgentId: string,
  ): Promise<AgentResolveResult> {
    const query = normalizeText(args.query.trim())
    if (!query) throw new Error('Query is required')

    const limit = args.limit ?? 5
    // #142 — a találatok a hívó agent `view` jogán szűrt listából jönnek (a
    // tenant-izoláció ennek része). Szűrt lista, ezért deny-esemény NEM keletkezik.
    // A pontozás a teljes agent-soron dolgozik (szerep-instrukció is), ezért a gráf
    // engedélyezett id-halmazát metsszük rá a tenant agent-listájára.
    const viewableIds = (await listViewableAgents(self, callerAgentId, effectiveTenantId)).map(
      (n) => n.id,
    )
    const all = await self.agents.findMany({ tenantId: effectiveTenantId, ids: viewableIds })

    const scored = all
      .map((agent) => {
        const persona = personaFor(agent.name, agent)
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
    callerAgentId: string,
  ): Promise<AgentCatalogResult> {
    const limitDefault = args.query?.trim() ? 5 : 25

    if (args.agentId) {
      // EXPLICIT egyedi feloldás → deny-szemantika (#142). A `view` jog hiánya
      // 404-jellegű „nem található", hogy a cél LÉTEZÉSE se szivárogjon ki; a hívó
      // nem tud id-találgatással feltérképezni rejtett agenteket.
      if (!self.agentAccess || !effectiveTenantId) return { agents: [] }
      const decision = await self.agentAccess.canAccessAgent(
        { kind: 'agent', agentId: callerAgentId, tenantId: effectiveTenantId },
        args.agentId,
        'view',
      )
      if (!decision.allowed) return { agents: [] }
      const entry = await buildAgentCatalogEntry(args.agentId, self.agents, self.tools)
      return { agents: [entry] }
    }

    // #142 — szűrt lista a hívó agent `view` jogán (a tenant-izoláció ennek része).
    // A pontozás a teljes agent-soron dolgozik (szerep-instrukció is), ezért a gráf
    // ENGEDÉLYEZETT id-halmazát metsszük rá a tenant agent-listájára.
    const viewableIds = (await listViewableAgents(self, callerAgentId, effectiveTenantId)).map(
      (n) => n.id,
    )
    let candidates = await self.agents.findMany({ tenantId: effectiveTenantId, ids: viewableIds })

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
   * cross-tenant felhasználó SOHA nem szivárog ki. A `query` KÖTELEZŐ és a
   * néven / szerepen / e-mailen szűr (ékezet- és kisbetű-független): érdemi
   * keresőkifejezés nélkül a szűrő fail-closed üres listát ad, teljes névsor
   * tehát nem kérhető le. Az e-mail csak keresési kulcs — a válaszba nem kerül.
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

/**
 * document_read — csatolmány oldal/keresés. Capability-only auth a brokerben;
 * itt a Document hozzáférés (uploader / beszélgetés-csatolmány / ticket / KB).
 */
export async function documentRead(
  self: ToolBrokerService,
  input: Extract<ToolBrokerInvokeInput, { tool: 'document_read' }>,
  actingUserId: string | null,
): Promise<DocumentReadResult> {
  const doc = await prisma.document.findUnique({ where: { id: input.args.documentId } })
  if (!doc) throw new Error('document_not_found')

  const allowed = await canAccessDocument(self, input, doc, actingUserId)
  if (!allowed) throw new Error('document_access_denied')

  const blocks = blocksFromDocument(doc.metadata, doc.extractedText)
  return readDocumentPages({
    documentId: doc.id,
    filename: doc.filename,
    blocks,
    pages: input.args.pages,
    query: input.args.query,
    maxChars: input.args.maxChars,
    maxMatches: input.args.maxMatches,
  })
}

/**
 * Csatolmány-hozzáférés: uploader / beszélgetés / ticket / KB-connector út.
 *
 * A bemenet szándékosan SZŰK (nem a teljes invoke-input), hogy több tool
 * használhassa ugyanazt a kaput — ma a `document_read` és a
 * `tulajdoni_lap_parse`. Így egy új olvasó-tool sem nyithat kerülőutat.
 */
async function canAccessDocument(
  self: ToolBrokerService,
  input: { agentId: string; conversationId?: string | null; ticketId?: string | null },
  doc: Document,
  actingUserId: string | null,
): Promise<boolean> {
  if (actingUserId && doc.uploadedById === actingUserId) return true

  if (input.conversationId) {
    if (await conversationReferencesDocument(input.conversationId, doc.id)) return true
  }

  if (input.ticketId) {
    if (await ticketReferencesDocument(input.ticketId, doc.id)) return true
  }

  if (doc.connectorId) {
    const link = await self.tools.findConnectorForAgentById(
      input.agentId,
      doc.connectorId,
      'knowledge_base',
      'read',
      null,
    )
    if (link) return true
  }

  return false
}

async function conversationReferencesDocument(
  conversationId: string,
  documentId: string,
): Promise<boolean> {
  const messages = await prisma.message.findMany({
    where: { conversationId, contentDeletedAt: null },
    select: { contentRef: true },
    orderBy: { seq: 'desc' },
    take: 80,
  })
  for (const message of messages) {
    if (!message.contentRef) continue
    const raw = message.contentRef.startsWith('inline:')
      ? message.contentRef.slice('inline:'.length)
      : message.contentRef
    try {
      const parsed = JSON.parse(raw) as { attachmentIds?: unknown }
      if (
        Array.isArray(parsed.attachmentIds) &&
        parsed.attachmentIds.some((id) => id === documentId)
      ) {
        return true
      }
    } catch {
      if (raw.includes(documentId)) return true
    }
  }
  return false
}

async function ticketReferencesDocument(ticketId: string, documentId: string): Promise<boolean> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { sourceDocumentId: true },
  })
  if (ticket?.sourceDocumentId === documentId) return true

  const attachment = await prisma.ticketCommentAttachment.findFirst({
    where: { documentId, comment: { ticketId } },
    select: { id: true },
  })
  return Boolean(attachment)
}

/**
 * tulajdoni_lap_parse — magyar e-hiteles tulajdoni lap (TULLAP/INYER PDF)
 * strukturált kinyerése. Document UUID (chat/board csatolmány) vagy workspace path.
 *
 * Chat feltöltéskor az eredeti PDF bináris nincs eltárolva — a Document
 * `metadata.extraction` / `extractedText` a forrás. Workspace ágon valódi PDF
 * VAGY a materializált `.pdf.txt` markdown is megy.
 */
export async function tulajdoniLapParse(
  self: ToolBrokerService,
  input: Extract<ToolBrokerInvokeInput, { tool: 'tulajdoni_lap_parse' }>,
  actingUserId: string | null,
  extras?: {
    authorization: Extract<AuthorizationResult, { allowed: true }>
    actingTenantId: string | null
  },
): Promise<TulajdoniLapParseResult> {
  const source = resolveTulajdoniLapParseSource(input.args)

  let pages: string[]
  let filename: string
  let documentId: string | null = null
  let path: string | undefined

  if (source.kind === 'document') {
    const doc = await prisma.document.findUnique({ where: { id: source.documentId } })
    if (!doc) throw new Error('document_not_found')

    const allowed = await canAccessDocument(self, input, doc, actingUserId)
    if (!allowed) throw new Error('document_access_denied')

    pages = pagesFromDocumentExtraction(doc.metadata, doc.extractedText)
    if (pages.length === 0) {
      // Régi / kézi feltöltés: ha van még fájl a storageRef-en (PDF vagy markdown).
      pages = await readPagesFromStorageRef(doc.storageRef)
    }
    if (pages.length === 0) {
      throw new Error('document_extraction_unavailable')
    }
    filename = doc.filename
    documentId = doc.id
  } else {
    const connector = extras?.authorization.connector
    if (!connector) {
      throw new Error(
        'tulajdoni_lap_parse workspace path requires workspace connector authorization',
      )
    }
    const workspaceId = input.ticketId ?? input.conversationId
    if (!workspaceId) {
      throw new Error('tulajdoni_lap_parse path requires ticketId or conversationId')
    }
    const tenantId = await resolveWorkspaceStorageTenantId(
      self,
      input,
      extras.actingTenantId,
      connector.tenantId,
    )
    let buffer: Buffer
    try {
      buffer = await self.fileEditor.readBinary(tenantId, workspaceId, source.path)
    } catch (error) {
      if (error instanceof FileEditorError) {
        throw new Error(`${error.code}: ${error.message}`)
      }
      throw error
    }
    pages = await readPagesFromBuffer(buffer)
    if (pages.length === 0) {
      throw new Error('tulajdoni_lap_parse: üres vagy nem értelmezhető forrás')
    }
    filename = source.path.split('/').filter(Boolean).pop() ?? source.path
    path = source.path
  }

  const parsed = parseTulajdoniLap(pages)
  const view = buildTulajdoniLapView(parsed, {
    nezet: input.args.nezet,
    csakHatalyos: input.args.csakHatalyos,
    limit: input.args.limit,
    offset: input.args.offset,
    raw: input.args.raw,
  })

  return { documentId, path, filename, ...view }
}

/**
 * A lap oldalainak betöltése — Document UUID VAGY munkaterület-fájl. A
 * `tulajdoni_lap_parse` és a `tulajdoni_lap_egyeztetes` UGYANEZEN az úton jut
 * a tartalomhoz, hogy az egyeztetés ne nyithasson kerülőutat a hozzáférési
 * ellenőrzés (document-access, workspace tenant-feloldás) mellett.
 */
async function loadTulajdoniLapPages(
  self: ToolBrokerService,
  input: Extract<
    ToolBrokerInvokeInput,
    { tool: 'tulajdoni_lap_parse' | 'tulajdoni_lap_egyeztetes' }
  >,
  actingUserId: string | null,
  extras?: {
    authorization: Extract<AuthorizationResult, { allowed: true }>
    actingTenantId: string | null
  },
): Promise<{ pages: string[]; filename: string; documentId: string | null; path?: string }> {
  const source = resolveTulajdoniLapParseSource(input.args)

  if (source.kind === 'document') {
    const doc = await prisma.document.findUnique({ where: { id: source.documentId } })
    if (!doc) throw new Error('document_not_found')

    const allowed = await canAccessDocument(self, input, doc, actingUserId)
    if (!allowed) throw new Error('document_access_denied')

    let pages = pagesFromDocumentExtraction(doc.metadata, doc.extractedText)
    if (pages.length === 0) {
      pages = await readPagesFromStorageRef(doc.storageRef)
    }
    if (pages.length === 0) throw new Error('document_extraction_unavailable')
    return { pages, filename: doc.filename, documentId: doc.id }
  }

  const connector = extras?.authorization.connector
  if (!connector) {
    throw new Error(`${input.tool} workspace path requires workspace connector authorization`)
  }
  const workspaceId = input.ticketId ?? input.conversationId
  if (!workspaceId) throw new Error(`${input.tool} path requires ticketId or conversationId`)

  const tenantId = await resolveWorkspaceStorageTenantId(
    self,
    input,
    extras.actingTenantId,
    connector.tenantId,
  )
  let buffer: Buffer
  try {
    buffer = await self.fileEditor.readBinary(tenantId, workspaceId, source.path)
  } catch (error) {
    if (error instanceof FileEditorError) {
      throw new Error(`${error.code}: ${error.message}`)
    }
    throw error
  }
  const pages = await readPagesFromBuffer(buffer)
  if (pages.length === 0) {
    throw new Error(`${input.tool}: üres vagy nem értelmezhető forrás`)
  }
  return {
    pages,
    filename: source.path.split('/').filter(Boolean).pop() ?? source.path,
    documentId: null,
    path: source.path,
  }
}

/**
 * tulajdoni_lap_egyeztetes — EGY hívás: lap-parse → párosítás → kész munkafüzet
 * (issue #161).
 *
 * Korábban ez a chatben, sok LLM-körben zajlott: a tulajdonos-nézet lapozása
 * (minden hívás ÚJRA parse-olta a PDF-et), ad-hoc JSON köztes fájlok, majd
 * cellánkénti Excel-írás. Egy nagy lapnál ez rendszeresen kifutott a forduló
 * kereteiből, és a felhasználó „Folytasd" körökkel tolta tovább. A párosítás
 * viszont determinisztikus szabály — itt fut le, egyszer.
 */
export async function tulajdoniLapEgyeztetes(
  self: ToolBrokerService,
  input: Extract<ToolBrokerInvokeInput, { tool: 'tulajdoni_lap_egyeztetes' }>,
  actingUserId: string | null,
  extras?: {
    authorization: Extract<AuthorizationResult, { allowed: true }>
    actingTenantId: string | null
  },
): Promise<TulajdoniLapEgyeztetesResult> {
  const connector = extras?.authorization.connector
  if (!connector) {
    throw new Error('tulajdoni_lap_egyeztetes requires workspace connector authorization')
  }
  const workspaceId = input.ticketId ?? input.conversationId
  if (!workspaceId) {
    throw new Error('tulajdoni_lap_egyeztetes requires ticketId or conversationId')
  }
  const tenantId = await resolveWorkspaceStorageTenantId(
    self,
    input,
    extras.actingTenantId,
    connector.tenantId,
  )

  const { pages } = await loadTulajdoniLapPages(self, input, actingUserId, extras)
  const parsed = parseTulajdoniLap(pages)
  const view = buildTulajdoniLapView(parsed, { nezet: 'osszefoglalo' })

  // Bukott ellenőrzés (a hatályos hányadok összege ≠ 1) → NEM készítünk táblát.
  // Hibás alapon egyeztetni rosszabb, mint nem egyeztetni: a tábla hitelesnek
  // látszana, és emberi jóváhagyással menne tovább.
  if (!parsed.osszesites.valid) {
    return {
      ok: false,
      figyelmeztetes:
        view.figyelmeztetes ??
        `A hatályos tulajdoni hányadok összege ${parsed.osszesites.hatalyosHanyadOsszeg}, nem 1 — az egyeztetés nem megbízható.`,
      path: null,
      meta: view.meta,
      osszesites: view.osszesites,
      egyeztetes: null,
      eltero: [],
      szeljegyDb: parsed.szeljegyek.length,
    }
  }

  const nyilvantartasSource = await resolveEgyeztetesNyilvantartas(self, {
    tenantId,
    workspaceId,
    inline: input.args.nyilvantartas,
    path: input.args.nyilvantartasPath,
  })
  const nyilvantartas = nyilvantartasSource.rows

  const { sorok, osszegzes } = egyeztetesSorok({
    lapTulajdonosok: parsed.tulajdonosok,
    nyilvantartas,
    vanSzeljegy: parsed.szeljegyek.length > 0,
  })

  // Csonka nyilvántartás (tipikusan http_api_get első oldala) → ne legyen
  // „kész" Excel. A modellnek újra kell kérnie get_all-lal.
  const completeness = assessNyilvantartasCompleteness({
    lapTulajdonosDb: parsed.tulajdonosok.length,
    nyilvantartasDb: nyilvantartas.length,
    ujRekordDb: osszegzes.ujRekord,
    sourceLooksComplete: nyilvantartasSource.provenanceComplete,
    confirmedComplete: input.args.confirmNyilvantartasComplete === true,
  })
  if (completeness.block) {
    return {
      ok: false,
      figyelmeztetes: completeness.indok,
      path: null,
      meta: view.meta,
      osszesites: view.osszesites,
      egyeztetes: osszegzes,
      eltero: [],
      szeljegyDb: parsed.szeljegyek.length,
    }
  }

  const munkafuzet = buildEgyeztetesMunkafuzet({ sorok, parsed })

  const kimenet = (input.args.kimenet ?? 'egyeztetes.xlsx').trim() || 'egyeztetes.xlsx'
  const path = kimenet.toLowerCase().endsWith('.xlsx') ? kimenet : `${kimenet}.xlsx`

  // A munkafüzet egyetlen menetben áll elő: létrehozás → cellák → elrendezés →
  // fejléc-kiemelés. Ez korábban 4+ külön eszközhívás volt, körönként.
  await self.fileEditor.xlsxCreate(tenantId, workspaceId, {
    path,
    sheets: [
      { name: 'Egyeztetés', rows: munkafuzet.egyeztetesSorok },
      { name: 'Ingatlan', rows: munkafuzet.ingatlanSorok },
    ],
  })
  await self.fileEditor.xlsxLayout(tenantId, workspaceId, {
    path,
    sheet: 'Egyeztetés',
    freeze: { rows: 1 },
    autoFilter: `A1:L1`,
    columnWidths: [
      { column: 'A', width: 16 },
      { column: 'B', width: 30 },
      { column: 'C', width: 12 },
      { column: 'D', width: 26 },
      { column: 'E', width: 14 },
      { column: 'F', width: 14 },
      { column: 'G', width: 10 },
      { column: 'H', width: 16 },
      { column: 'I', width: 12 },
      { column: 'J', width: 10 },
      { column: 'K', width: 22 },
      { column: 'L', width: 60 },
    ],
    dataValidations: [
      {
        range: `K2:K${Math.max(2, munkafuzet.utolsoAdatSor)}`,
        values: EGYEZTETES_STATUSZOK,
        errorTitle: 'Érvénytelen státusz',
        error: 'Válassz a legördülő listából.',
      },
    ],
  })
  await self.fileEditor.xlsxFormatRange(tenantId, workspaceId, {
    path,
    sheet: 'Egyeztetés',
    range: 'A1:L1',
    style: { font: { bold: true } },
  })

  const eltero = sorok
    .filter((sor) => sor.statusz !== 'Rendben')
    .slice(0, 100)
    .map((sor) => ({
      nev: sor.nev,
      statusz: sor.statusz,
      hanyadLap: sor.hanyadLap,
      hanyadNyilvantartas: sor.hanyadNyilvantartas,
      megjegyzes: sor.megjegyzes,
    }))

  const figyelmeztetes = [view.figyelmeztetes, completeness.warn ? completeness.indok : null]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ') || null

  return {
    ok: true,
    figyelmeztetes,
    path,
    meta: view.meta,
    osszesites: view.osszesites,
    egyeztetes: osszegzes,
    eltero,
    szeljegyDb: parsed.szeljegyek.length,
  }
}

/**
 * A nyilvántartás oldala: közvetlen argumentum VAGY munkaterület-beli JSON.
 * A fájlos út a nagy névsoroké — így a több száz sor nem megy át a modellen.
 */
async function resolveEgyeztetesNyilvantartas(
  self: ToolBrokerService,
  input: {
    tenantId: string
    workspaceId: string
    inline?: EgyeztetesNyilvantartasSor[]
    path?: string
  },
): Promise<{ rows: EgyeztetesNyilvantartasSor[]; provenanceComplete: boolean }> {
  if (Array.isArray(input.inline) && input.inline.length > 0) {
    return { rows: normalizeNyilvantartasRows(input.inline), provenanceComplete: false }
  }
  if (!input.path) return { rows: [], provenanceComplete: false }

  const content = await self.fileEditor.readTextFileOrNull(input.tenantId, input.workspaceId, {
    path: input.path,
  })
  if (content == null) {
    throw new Error(`tulajdoni_lap_egyeztetes: a(z) "${input.path}" fájl nem található`)
  }
  let parsed: unknown
  try {
    // Nyers szöveg kell — a readFile sortáblázott (1\t…) kimenete NEM érvényes JSON.
    // Legacy tool-outputs: korábban a modellnek szánt EXTERNAL_UNTRUSTED burkolat
    // került a fájlba; azt is elfogadjuk, hogy a régi futások újraegyeztethetők legyenek.
    parsed = JSON.parse(unwrapExternalDataEnvelope(content).trim())
  } catch {
    throw new Error(
      `tulajdoni_lap_egyeztetes: a(z) "${input.path}" fájl nem érvényes JSON (tömb vagy { sorok|items|data|…: [...] } kell)`,
    )
  }
  const rows = parseReconcileRecordList(parsed)
  if (!rows) {
    throw new Error(
      `tulajdoni_lap_egyeztetes: a(z) "${input.path}" fájl nem tömb és nincs benne rows/sorok/items/data/records tömb`,
    )
  }
  const normalized = normalizeNyilvantartasRows(rows)
  if (normalized.length === 0) {
    throw new Error(
      `tulajdoni_lap_egyeztetes: a(z) "${input.path}" fájlból 0 nyilvántartási sor jött ki ` +
        `(üres tömb, vagy hiányzik a névmező: nev/partnerNev/name). ` +
        `Ne egyeztess üres nyilvántartással — ellenőrizd a forrásfájlt / http_api_get_all kimenetet.`,
    )
  }
  return { rows: normalized, provenanceComplete: hasCompleteHttpApiGetAllProvenance(parsed) }
}

/**
 * Document storageRef → oldalak. Chat feltöltéskor ez gyakran markdown
 * (extractedText), nem PDF — mindkettőt kezeljük.
 */
async function readPagesFromStorageRef(storageRef: string): Promise<string[]> {
  const absolutePath = nodePath.resolve(process.cwd(), storageRef)
  const uploadRoot = nodePath.resolve(process.cwd(), 'uploads')
  const uploadRootPrefix = uploadRoot.endsWith(nodePath.sep)
    ? uploadRoot
    : `${uploadRoot}${nodePath.sep}`
  // Path-traversal zár: a storageRef csak az uploads gyökér alá mutathat.
  if (!absolutePath.startsWith(uploadRootPrefix)) {
    throw new Error('document_storage_out_of_root')
  }

  let buffer: Buffer
  try {
    buffer = await nodeReadFile(absolutePath)
  } catch {
    throw new Error('document_file_unavailable')
  }

  return readPagesFromBuffer(buffer)
}

async function readPagesFromBuffer(buffer: Buffer): Promise<string[]> {
  if (bufferLooksLikePdf(buffer)) {
    return readPdfPageTextsFromBuffer(buffer)
  }
  // Workspace `.pdf.txt` / storageRef markdown (chat csatolmány).
  return pagesFromDocumentExtraction(null, buffer.toString('utf8'))
}

async function readPdfPageTextsFromBuffer(buffer: Buffer): Promise<string[]> {
  const PDFParse = await loadPdfParse()
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    // `pageJoiner: ''` — az alapértelmezett oldaljelölő (`-- 1 of 3 --`) beszennyezné
    // a szöveget; az oldalhatárt a `pages[].num` hordozza.
    const { pages } = await parser.getText({ pageJoiner: '' })
    return pages.map((p) => p.text)
  } finally {
    await parser.destroy()
  }
}
