import type { ContractIssue } from './types'

/**
 * Hibalista → közérthető magyar összefoglaló (emberi felülvizsgálathoz / javító prompthoz).
 * Nem nyers Zod/technikai stack.
 */
export function formatContractErrors(errors: ContractIssue[]): string {
  if (errors.length === 0) return 'A kimenet nem felel meg a várt szerkezetnek.'
  if (errors.length === 1) return errors[0]!.message
  return [
    'A lépés kimenete nem felel meg a várt szerkezetnek:',
    ...errors.map((e, i) => `${i + 1}. ${e.message}`),
  ].join('\n')
}
