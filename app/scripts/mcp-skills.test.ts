/**
 * Kód-hordozó skill-csomag + MCP skill:// mapping.
 * Futtatás: npm run test:mcp-skills
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { buildSkillPackage } from '../src/lib/skill/skill-package-adapter'
import { parseSkillMd } from '../src/lib/skill/skill-md-adapter'
import { validateSkill } from '../src/lib/skill/skill-validator'
import {
  buildMcpSkillPackage,
  parseSkillResourceUri,
  skillFileUri,
  toSkillsListEntry,
} from '../src/lib/skill/mcp-skill'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

function walkDir(root: string, base = root): { path: string; bytes: Uint8Array }[] {
  const out: { path: string; bytes: Uint8Array }[] = []
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    if (statSync(full).isDirectory()) {
      out.push(...walkDir(full, base))
      continue
    }
    out.push({
      path: relative(base, full).replace(/\\/g, '/'),
      bytes: readFileSync(full),
    })
  }
  return out
}

function main() {
  console.log('MCP code-carrying skills')

  check('tulajdoni-lap package stores parser script', () => {
    const dir = resolve(process.cwd(), '../docs/skills/tulajdoni-lap')
    const pkg = buildSkillPackage(walkDir(dir))
    const parsed = parseSkillMd(pkg.skillMdRaw, { url: 'docs/skills/tulajdoni-lap/SKILL.md' })
    assert.equal(parsed.name, 'tulajdoni-lap')
    assert.ok(pkg.attachments.some((a) => a.path === 'scripts/parse_tulajdoni_lap.py'))
    assert.ok(pkg.attachments.some((a) => a.path === 'references/mezoreferencia.md'))
    const validation = validateSkill({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      requires: parsed.suggestedRequires,
      attachmentPaths: pkg.attachments.map((a) => a.path),
    })
    assert.equal(validation.ok, true, validation.errors.join(' · '))
    assert.equal(validation.riskTier, 't2')

    const mcp = buildMcpSkillPackage({
      skillId: 's1',
      skillVersionId: 'v1',
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      requires: parsed.suggestedRequires,
      attachments: pkg.attachments,
    })
    const entry = toSkillsListEntry(mcp)
    assert.equal(entry.uri, 'skill://tulajdoni-lap/SKILL.md')
    assert.ok(entry.resources.some((r) => r.uri === 'skill://tulajdoni-lap/scripts/parse_tulajdoni_lap.py'))
    assert.equal(parseSkillResourceUri(skillFileUri('tulajdoni-lap', 'scripts/parse_tulajdoni_lap.py'))?.filePath, 'scripts/parse_tulajdoni_lap.py')
    const script = mcp.files.find((f) => f.path === 'scripts/parse_tulajdoni_lap.py')
    assert.ok(script?.text.includes('def extract_pages'))
  })

  console.log(`\n${failures === 0 ? 'mcp-skills: ok' : `mcp-skills: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
