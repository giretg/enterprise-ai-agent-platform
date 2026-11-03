export const MAX_GITHUB_REPOSITORIES = 100
export const GITHUB_REPOSITORY_PATTERN_SOURCE = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
export const GITHUB_REPOSITORY_PATTERN = new RegExp(`^${GITHUB_REPOSITORY_PATTERN_SOURCE}$`)
export const GITHUB_REPOSITORY_LIST_PATTERN_SOURCE =
  `^(?:\\*|${GITHUB_REPOSITORY_PATTERN_SOURCE}(?:[\\s,]+${GITHUB_REPOSITORY_PATTERN_SOURCE})*)$`

export type GitHubRepositoryAccess =
  | { mode: 'any' }
  | { mode: 'selected'; repositories: string[] }

function normalizeRepository(repository: unknown): string {
  if (typeof repository !== 'string' || !GITHUB_REPOSITORY_PATTERN.test(repository.trim())) {
    throw new Error(`GitHub repository must use owner/repo format: ${String(repository)}`)
  }
  return repository.trim().toLowerCase()
}

function normalizeRepositories(repositories: unknown[]): string[] {
  const normalized = [...new Set(repositories.map(normalizeRepository))]
  if (normalized.length === 0) {
    throw new Error('Selected GitHub repository access requires at least one owner/repo value')
  }
  if (normalized.length > MAX_GITHUB_REPOSITORIES) {
    throw new Error(`Selected GitHub repository access supports at most ${MAX_GITHUB_REPOSITORIES} repositories`)
  }
  return normalized
}

export function gitHubRepositoryAccessFromText(value: string): GitHubRepositoryAccess {
  const trimmed = value.trim()
  if (trimmed === '*') return { mode: 'any' }
  return {
    mode: 'selected',
    repositories: normalizeRepositories(trimmed.split(/[\s,]+/).filter(Boolean)),
  }
}

export function parseGitHubRepositoryAccessConfig(raw: unknown): GitHubRepositoryAccess | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('GitHub repository access must be an object')
  }
  const value = raw as Record<string, unknown>
  if (value.mode === 'any') return { mode: 'any' }
  if (value.mode !== 'selected' || !Array.isArray(value.repositories)) {
    throw new Error('GitHub repository access mode must be "any" or "selected"')
  }
  return { mode: 'selected', repositories: normalizeRepositories(value.repositories) }
}

/** GitHub sablonból készült (vagy kódtár-körrel rendelkező) http_api konnektor config-e. */
export function isGitHubConnectorConfig(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const config = raw as Record<string, unknown>
  const provenance = config.provenance
  const templateKey =
    typeof provenance === 'object' && provenance !== null && !Array.isArray(provenance)
      ? (provenance as Record<string, unknown>).templateKey
      : undefined
  return templateKey === 'github' || (typeof config.githubRepositoryAccess === 'object' && config.githubRepositoryAccess !== null)
}

/** Agentnek szóló, secret-mentes megjegyzés a definíció-snapshotba. */
export function describeGitHubRepositoryAccess(access: GitHubRepositoryAccess): string {
  if (access.mode === 'any') {
    return 'GitHub: every repository the access token can reach is allowed; ask the user which owner/repo they mean if it is not clear.'
  }
  return `GitHub: only these repositories are allowed (use them as {owner}/{repo} in paths): ${access.repositories.join(', ')}.`
}
