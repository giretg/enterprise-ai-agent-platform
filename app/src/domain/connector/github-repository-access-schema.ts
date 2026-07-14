import { z } from 'zod'
import {
  GITHUB_REPOSITORY_PATTERN,
  MAX_GITHUB_REPOSITORIES,
} from './github-repository-access'

export const githubRepositoryAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('any') }),
  z.object({
    mode: z.literal('selected'),
    repositories: z
      .array(
        z
          .string()
          .trim()
          .regex(GITHUB_REPOSITORY_PATTERN)
          .transform((repository) => repository.toLowerCase()),
      )
      .min(1)
      .transform((repositories) => [...new Set(repositories)])
      .refine((repositories) => repositories.length <= MAX_GITHUB_REPOSITORIES, {
        message: `At most ${MAX_GITHUB_REPOSITORIES} GitHub repositories are allowed`,
      }),
  }),
])
