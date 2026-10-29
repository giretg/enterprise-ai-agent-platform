/**
 * Külön jogosultság (#984 §8): olvasás / import / szerkezetmódosítás /
 * üzemeltetés. v1-ben a tenant-szerep rangsorára képezve (Q5 nyitott: a
 * finomabb jóváhagyási mátrix később ide kerül).
 */
import type { UserRole } from '@prisma/client'
import { meetsMinRole } from '@/lib/iam-policy'

export type WarehouseAction = 'read' | 'import' | 'schema' | 'operate'

export const WAREHOUSE_ACTION_MIN_ROLE: Record<WarehouseAction, UserRole> = {
  read: 'viewer',
  import: 'operator',
  // Új adatkészlet/mező jóváhagyása, kapcsolat-elfogadás, definíció-megerősítés, visszavonás.
  schema: 'approver',
  operate: 'admin',
}

export function canWarehouse(role: string | null | undefined, action: WarehouseAction): boolean {
  return meetsMinRole((role ?? null) as UserRole | null, WAREHOUSE_ACTION_MIN_ROLE[action])
}

/**
 * Törölhető-e az import: csak amíg semmi nem töltődött be belőle. A betöltött
 * (vagy már visszavont) import sor-előzménye a visszavonás és az eredet alapja.
 */
const NOT_DISCARDABLE = new Set(['loading', 'published', 'rolled_back'])

export function canDiscardImport(state: string): boolean {
  return !NOT_DISCARDABLE.has(state)
}
