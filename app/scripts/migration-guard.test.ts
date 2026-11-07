/**
 * #1126 migráció-őr: a szabály tesztje és az új migrációk ellenőrzése.
 * Futtatás: npm run test:migration-guard
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkMigrationSql, checkMigrationsDirectory, LAST_UNGUARDED_MIGRATION } from './migration-guard'

const blocked: Array<[string, string, string]> = [
  ['oszlop törlése', 'ALTER TABLE "a" DROP COLUMN "b";', 'DROP'],
  ['tábla törlése', 'DROP TABLE "a";', 'DROP'],
  ['átnevezés', 'ALTER TABLE "a" RENAME COLUMN "b" TO "c";', 'RENAME'],
  ['kötelezővé tétel', 'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;', 'SET NOT NULL'],
  ['típusváltás', 'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE BIGINT;', 'oszloptípus-váltás'],
  ['rövid típusváltás', 'ALTER TABLE "a" ALTER COLUMN "b" TYPE BIGINT;', 'oszloptípus-váltás'],
  ['kötelező oszlop alapérték nélkül', 'ALTER TABLE "a" ADD COLUMN "b" TEXT NOT NULL;', 'alapérték nélküli NOT NULL oszlop'],
  [
    'több ADD COLUMN, a második a hibás',
    'ALTER TABLE "a" ADD COLUMN "b" TEXT NOT NULL DEFAULT \'x\',\nADD COLUMN "c" DECIMAL(10,2) NOT NULL;',
    'alapérték nélküli NOT NULL oszlop',
  ],
  ['kisbetűs', 'alter table a drop column b;', 'DROP'],
]
for (const [name, sql, expected] of blocked) {
  assert.ok(checkMigrationSql(sql).includes(expected), `${name}: ${expected}`)
}
console.log(`  OK  ${blocked.length} törlő vagy átnevező minta megbukik`)

const allowed: Array<[string, string]> = [
  ['új tábla NOT NULL oszlopokkal', 'CREATE TABLE "a" ("id" TEXT NOT NULL, "b" INT NOT NULL DEFAULT 1, CONSTRAINT "a_pkey" PRIMARY KEY ("id"));'],
  ['opcionális oszlop', 'ALTER TABLE "a" ADD COLUMN "b" TEXT;'],
  ['kötelező oszlop alapértékkel', 'ALTER TABLE "a" ADD COLUMN "b" TEXT NOT NULL DEFAULT \'x\';'],
  ['idegen kulcs', 'ALTER TABLE "a" ADD CONSTRAINT "a_b_fkey" FOREIGN KEY ("b") REFERENCES "c"("id") ON DELETE CASCADE;'],
  ['kommentben a szó', '-- DROP is not happening here\nCREATE INDEX "x" ON "a"("b");'],
  ['azonosítóban a szó', 'ALTER TABLE "a" ADD COLUMN "drop_rename_at" TIMESTAMPTZ;'],
  ['szöveges értékben a szó', "UPDATE \"a\" SET \"b\" = 'DROP TABLE x';"],
]
for (const [name, sql] of allowed) {
  assert.deepEqual(checkMigrationSql(sql), [], name)
}
console.log(`  OK  ${allowed.length} bővítő minta átmegy`)

assert.deepEqual(checkMigrationSql('-- destructive-ok: #1234\nALTER TABLE "a" DROP COLUMN "b";'), [])
assert.notDeepEqual(checkMigrationSql('-- destructive-ok\nALTER TABLE "a" DROP COLUMN "b";'), [], 'issue-szám nélkül nem elég')
assert.notDeepEqual(checkMigrationSql('-- destructive-ok: 1234\nALTER TABLE "a" DROP COLUMN "b";'), [], '# nélkül nem elég')
console.log('  OK  a jelölés csak issue-számmal enged át')

const temp = mkdtempSync(join(tmpdir(), 'migration-guard-'))
try {
  const write = (name: string, sql: string) => {
    mkdirSync(join(temp, name))
    writeFileSync(join(temp, name, 'migration.sql'), sql)
  }
  write('0001_regi', 'DROP TABLE "x";')
  write('0002_uj_jo', 'CREATE TABLE "y" ("id" TEXT NOT NULL);')
  write('0003_uj_rossz', 'ALTER TABLE "y" DROP COLUMN "id";')
  writeFileSync(join(temp, 'migration_lock.toml'), '')
  assert.deepEqual(checkMigrationsDirectory(temp, '0001_regi'), [{ migration: '0003_uj_rossz', problems: ['DROP'] }])
} finally {
  rmSync(temp, { recursive: true, force: true })
}
console.log('  OK  a meglévő migrációkra nem fut, az újakra igen')

const violations = checkMigrationsDirectory(join(import.meta.dirname, '../prisma/migrations'))
for (const { migration, problems } of violations) {
  console.error(`  FAIL ${migration}: ${problems.join(', ')}. Bővítő migráció kell, vagy "-- destructive-ok: #<issue>" jelölés.`)
}
if (violations.length > 0) process.exit(1)
console.log(`  OK  a ${LAST_UNGUARDED_MIGRATION} utáni migrációk bővítők`)
console.log('\nmigration-guard: ok')
