/**
 * #1126 migráció-őr: a migráció a build előtt lefut, ezért a flag nem védi. Az új migráció csak bővíthet,
 * kivéve ha `-- destructive-ok: #<issue>` jelölést visel.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Az ennél régebbi (név szerint kisebb vagy egyenlő) migrációkra az őr nem fut. */
export const LAST_UNGUARDED_MIGRATION = '0059_ai_audit_voice_and_unclassified_kinds'

const DESTRUCTIVE_OK_MARKER = /^\s*--\s*destructive-ok:\s*#\d+\s*$/m

/** Komment és szöveges érték nélküli SQL; az azonosítók is kiürülnek, hogy egy `"drop_at"` ne számítson. */
function stripSqlNoise(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]
      i += 1
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] !== quote) break
          i += 1
        }
        i += 1
      }
      i += 1
      out += quote === '"' ? '"_"' : "''"
    } else {
      out += sql[i]
      i += 1
    }
  }
  return out
}

/** Vesszők mentén bont, a zárójeleken belülieket (pl. `DECIMAL(10,2)`) egyben hagyva. */
function splitTopLevel(statement: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of statement) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

export function checkMigrationSql(sql: string): string[] {
  if (DESTRUCTIVE_OK_MARKER.test(sql)) return []
  const clean = stripSqlNoise(sql)
  const problems = new Set<string>()
  for (const statement of clean.split(';')) {
    if (/\bDROP\b/i.test(statement)) problems.add('DROP')
    if (/\bRENAME\b/i.test(statement)) problems.add('RENAME')
    if (/\bSET\s+NOT\s+NULL\b/i.test(statement)) problems.add('SET NOT NULL')
    if (/\bALTER\s+COLUMN\b[^,]*?\b(SET\s+DATA\s+)?TYPE\b/i.test(statement)) problems.add('oszloptípus-váltás')
    if (!/\bALTER\s+TABLE\b/i.test(statement)) continue
    for (const clause of splitTopLevel(statement)) {
      if (/\bADD\s+(COLUMN\s+)?/i.test(clause) && /\bNOT\s+NULL\b/i.test(clause) && !/\bDEFAULT\b/i.test(clause)
        && !/\bADD\s+CONSTRAINT\b/i.test(clause)) {
        problems.add('alapérték nélküli NOT NULL oszlop')
      }
    }
  }
  return [...problems]
}

export function checkMigrationsDirectory(dir: string, baseline = LAST_UNGUARDED_MIGRATION): Array<{ migration: string; problems: string[] }> {
  return readdirSync(dir)
    .filter((name) => name > baseline && existsSync(join(dir, name, 'migration.sql')))
    .sort()
    .map((migration) => ({ migration, problems: checkMigrationSql(readFileSync(join(dir, migration, 'migration.sql'), 'utf8')) }))
    .filter((entry) => entry.problems.length > 0)
}
