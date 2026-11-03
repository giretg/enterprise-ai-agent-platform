'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { updateGitHubRepositoryAccess } from '@/lib/connector-update-publishing'
import {
  GITHUB_REPOSITORY_PATTERN,
  MAX_GITHUB_REPOSITORIES,
  type GitHubRepositoryAccess,
} from '@/domain/connector/github-repository-access'
import { DetailSection, FilterChip, PillButton } from './connector-hub-ui'

/** Soronként / vesszővel elválasztott lista; a bemásolt GitHub-linkből owner/repo lesz. */
function splitRepositories(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) =>
      item
        .trim()
        .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
        .replace(/\.git$/i, '')
        .split('/')
        .slice(0, 2)
        .join('/'),
    )
    .filter(Boolean)
}

/**
 * GitHub-kapcsolat kódtár-köre: mely owner/repo-khoz nyúlhatnak a munkatársak. Bekapcsolás
 * előtt és után is szerkeszthető — a kulcs és az agent-kötések megmaradnak.
 */
export function GitHubRepositoryPanel({
  draftId,
  access,
  pending,
  run,
}: {
  draftId: string
  access: GitHubRepositoryAccess
  pending: boolean
  run: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const t = useTranslations('Provisioning')
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<GitHubRepositoryAccess['mode']>(access.mode)
  const [text, setText] = useState('')

  const repositories = splitRepositories(text)
  const invalid = repositories.filter((repo) => !GITHUB_REPOSITORY_PATTERN.test(repo))
  const tooMany = new Set(repositories.map((repo) => repo.toLowerCase())).size > MAX_GITHUB_REPOSITORIES
  const canSave =
    !pending && (mode === 'any' || (repositories.length > 0 && invalid.length === 0 && !tooMany))

  const startEdit = () => {
    setMode(access.mode)
    setText(access.mode === 'selected' ? access.repositories.join('\n') : '')
    setEditing(true)
  }

  const save = () => {
    run(async () => {
      const res = await updateGitHubRepositoryAccess({
        draftId,
        repositoryAccess: mode === 'any' ? '*' : repositories.join('\n'),
      })
      if (res.success) setEditing(false)
      return res
    }, mode === 'any' ? t('githubReposSavedAny') : t('githubReposSaved'))
  }

  return (
    <DetailSection title={t('githubReposTitle')} hint={t('githubReposHint')}>
      {editing ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <FilterChip active={mode === 'selected'} onClick={() => setMode('selected')}>
              {t('githubReposModeSelected')}
            </FilterChip>
            <FilterChip active={mode === 'any'} onClick={() => setMode('any')}>
              {t('githubReposModeAny')}
            </FilterChip>
          </div>
          {mode === 'selected' ? (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink">{t('githubReposListLabel')}</span>
              <textarea
                rows={4}
                className="w-full rounded-xl border border-ink/15 bg-paper px-3 py-2.5 font-mono text-sm"
                value={text}
                placeholder="ceg/crm-rendszer"
                onChange={(e) => setText(e.target.value)}
              />
              <span className="mt-1 block text-xs text-ink-soft">{t('githubReposListHelp')}</span>
              {invalid.length > 0 ? (
                <span className="mt-1 block text-xs text-coral">
                  {t('githubReposInvalid', { items: invalid.join(', ') })}
                </span>
              ) : null}
              {tooMany ? (
                <span className="mt-1 block text-xs text-coral">
                  {t('githubReposTooMany', { max: MAX_GITHUB_REPOSITORIES })}
                </span>
              ) : null}
            </label>
          ) : (
            <p className="text-sm text-honey">{t('githubReposAnyWarn')}</p>
          )}
          <div className="flex justify-end gap-2">
            <PillButton disabled={pending} onClick={() => setEditing(false)}>
              {t('googleBindingCancel')}
            </PillButton>
            <PillButton variant="primary" disabled={!canSave} onClick={save}>
              {t('googleBindingSave')}
            </PillButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 text-sm">
            {access.mode === 'selected' ? (
              <ul className="space-y-1 font-mono">
                {access.repositories.map((repo) => (
                  <li key={repo} className="break-all text-ink">
                    {repo}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink">{t('githubReposAny')}</p>
            )}
          </div>
          <PillButton disabled={pending} onClick={startEdit}>
            {t('githubReposEdit')}
          </PillButton>
        </div>
      )}
    </DetailSection>
  )
}
