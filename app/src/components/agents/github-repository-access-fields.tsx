'use client'

export type GitHubRepositoryAccessMode = 'any' | 'selected'
export type GitHubRepositoryAccess =
  | { mode: 'any' }
  | { mode: 'selected'; repositories: string[] }

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function isGitHubApiUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.github.com'
  } catch {
    return false
  }
}

export function parseGitHubRepositoryAccess(
  baseUrl: string,
  mode: GitHubRepositoryAccessMode,
  repositoriesText: string,
): GitHubRepositoryAccess | undefined {
  if (!isGitHubApiUrl(baseUrl)) return undefined
  if (mode === 'any') return { mode: 'any' }

  const repositories = [
    ...new Set(
      repositoriesText
        .split(/[\s,]+/)
        .map((repository) => repository.trim())
        .filter(Boolean),
    ),
  ]
  if (repositories.length === 0) {
    throw new Error('GitHub repository-hozzáférés: adj meg legalább egy owner/repo értéket.')
  }
  const invalid = repositories.find((repository) => !REPOSITORY_PATTERN.test(repository))
  if (invalid) {
    throw new Error(`GitHub repository-hozzáférés: érvénytelen owner/repo érték: ${invalid}`)
  }
  return { mode: 'selected', repositories }
}

export function readGitHubRepositoryAccess(raw: unknown): {
  mode: GitHubRepositoryAccessMode
  repositoriesText: string
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { mode: 'any', repositoriesText: '' }
  }
  const value = raw as Record<string, unknown>
  if (value.mode !== 'selected' || !Array.isArray(value.repositories)) {
    return { mode: 'any', repositoriesText: '' }
  }
  return {
    mode: 'selected',
    repositoriesText: value.repositories
      .filter((repository): repository is string => typeof repository === 'string')
      .join('\n'),
  }
}

export function GitHubRepositoryAccessFields({
  baseUrl,
  mode,
  repositoriesText,
  onModeChange,
  onRepositoriesTextChange,
}: {
  baseUrl: string
  mode: GitHubRepositoryAccessMode
  repositoriesText: string
  onModeChange: (mode: GitHubRepositoryAccessMode) => void
  onRepositoriesTextChange: (value: string) => void
}) {
  if (!isGitHubApiUrl(baseUrl)) return null

  return (
    <fieldset className="space-y-2 rounded-lg border border-line bg-night/30 p-3 sm:col-span-2">
      <legend className="px-1 text-sm font-semibold text-ink-soft">GitHub repository-hozzáférés</legend>
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="radio"
          checked={mode === 'selected'}
          onChange={() => onModeChange('selected')}
        />
        Csak konkrét repository-k
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input type="radio" checked={mode === 'any'} onChange={() => onModeChange('any')} />
        Bármi az api.github.com alatt
      </label>
      {mode === 'selected' ? (
        <label className="block text-sm">
          <span className="text-ink-soft">Engedélyezett repository-k (owner/repo, soronként vagy vesszővel)</span>
          <textarea
            value={repositoriesText}
            onChange={(event) => onRepositoriesTextChange(event.target.value)}
            placeholder="giretg/ostorosbor-crm"
            rows={3}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 font-mono text-sm"
          />
        </label>
      ) : (
        <p className="text-xs text-honey">
          Ez a mód nyilvános repository-kat is enged olvasni, függetlenül a token jogosultságaitól.
        </p>
      )}
    </fieldset>
  )
}
