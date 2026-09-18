import Link from 'next/link'
import { buildRunAnalysisHref, type RunAnalysisScope } from '@/lib/run-analysis-shared'

const DEFAULT_CLASS =
  'rounded-full border border-honey/35 bg-honey/10 px-4 py-2.5 text-sm font-semibold text-honey transition-colors hover:bg-honey/20'

/**
 * RA-08 — egy kattintásos navigáció az elemző chathez (nincs szerver-oldali futás).
 * Csak akkor rendereljük, ha a hívó már ellenőrizte a `analysis.run` jogot.
 */
export function RunAnalysisButton({
  runAnalystAgentId,
  scope,
  className = DEFAULT_CLASS,
}: {
  runAnalystAgentId: string
  scope: RunAnalysisScope
  className?: string
}) {
  return (
    <Link
      href={buildRunAnalysisHref(runAnalystAgentId, scope)}
      target="_top"
      className={className}
      title="Futás-elemző megnyitása előre kitöltött kéréssel"
    >
      Elemezd
    </Link>
  )
}
