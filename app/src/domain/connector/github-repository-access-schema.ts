import { z } from 'zod'
import {
  parseGitHubRepositoryAccessConfig,
  type GitHubRepositoryAccess,
} from './github-repository-access'

export const githubRepositoryAccessSchema = z.unknown().transform((value, context) => {
  try {
    const parsed = parseGitHubRepositoryAccessConfig(value)
    if (!parsed) throw new Error('GitHub repository access is required')
    return parsed satisfies GitHubRepositoryAccess
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid GitHub repository access',
    })
    return z.NEVER
  }
})
