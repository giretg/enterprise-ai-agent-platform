/**
 * Regresszió: ticketen előtöltött skill referencia-melléklete ugyanúgy
 * betölthető legyen, mint chatben. A runtime teljes DB/Gateway-felépítése
 * helyett a bekötési szerződést őrzi.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/domain/agent/general-task-runtime.ts'), 'utf8')

assert.match(source, /type LoadSkillAttachmentFn/, 'a ticket runtime ismeri a Level-2 callback típusát')
assert.match(source, /const loadSkillAttachment: LoadSkillAttachmentFn \| undefined\s*=/, 'a ticket runtime elkészíti a mellékletolvasót')
assert.match(source, /loadSkillAttachment,\s*\n\s*\.\.\.\(skillAttachmentsAvailable/, 'a tool loop megkapja a mellékletolvasót és az induló jelzést')
assert.match(source, /skillAttachmentsAvailable = preloaded\.attachmentsAvailable === true/, 'az előtöltött skill mellékletjelzése átmegy a ticket runtime-on')

console.log('OK — ticket skill-melléklet runtime bekötés')
