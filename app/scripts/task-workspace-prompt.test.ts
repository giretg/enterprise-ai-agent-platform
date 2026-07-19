/**
 * Board/task workspace prompt — a ticket Fájlok paneljével egyező lista.
 * Run: npx tsx scripts/task-workspace-prompt.test.ts
 */
import assert from 'node:assert/strict'
import { formatTaskWorkspaceFilesPrompt } from '../src/lib/task-workspace-prompt'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

check('lists visible workspace files with exact paths', () => {
  const prompt = formatTaskWorkspaceFilesPrompt([
    '043_15 2026.07.16.pdf',
    '.tool-results/hidden.json',
  ])
  assert.match(prompt, /043_15 2026\.07\.16\.pdf/)
  assert.doesNotMatch(prompt, /\.tool-results/)
  assert.match(prompt, /pdf_read/)
  assert.match(prompt, /NE találj ki documentId-t/)
  assert.match(prompt, /page_range/)
})

check('empty workspace tells the agent to ask for an attachment', () => {
  const prompt = formatTaskWorkspaceFilesPrompt([])
  assert.match(prompt, /üres/)
  assert.match(prompt, /Fájlok/)
})

check('existing deliverables warn against delete-and-rebuild', () => {
  const prompt = formatTaskWorkspaceFilesPrompt(['audit.xlsx', 'source.pdf'])
  assert.match(prompt, /audit\.xlsx/)
  assert.match(prompt, /confirm:true/)
  assert.match(prompt, /NE töröld/)
})

if (failures > 0) {
  console.error(`\n${failures} task workspace prompt test(s) failed`)
  process.exit(1)
}

console.log('\ntask-workspace-prompt tests passed')
