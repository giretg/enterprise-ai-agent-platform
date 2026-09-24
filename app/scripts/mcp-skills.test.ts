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
  dedupeMcpSkillPackagesByUri,
  parseSkillResourceUri,
  skillFileUri,
  skillUriName,
  toSkillsListEntry,
  type McpSkillPackageCandidate,
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

  check('skillUriName collapses underscore and hyphen to the same slug', () => {
    assert.equal(skillUriName('tulajdoni_lap'), 'tulajdoni-lap')
    assert.equal(skillUriName('tulajdoni-lap'), 'tulajdoni-lap')
    assert.equal(skillUriName('My_Skill'), 'my-skill')
  })

  check('tenant–tenant URI collision omits both packages (fail-closed)', () => {
    const older: McpSkillPackageCandidate = {
      name: 'tulajdoni_lap',
      uriName: 'tulajdoni-lap',
      description: 'older scripts',
      license: null,
      skillId: 'skill-old',
      skillVersionId: 'v-old',
      files: [{ path: 'SKILL.md', text: 'old', sha256: 'a', mimeType: 'text/markdown' }],
      tenantId: 'tenant-1',
    }
    const newer: McpSkillPackageCandidate = {
      name: 'tulajdoni-lap',
      uriName: 'tulajdoni-lap',
      description: 'newer scripts',
      license: null,
      skillId: 'skill-new',
      skillVersionId: 'v-new',
      files: [{ path: 'SKILL.md', text: 'new', sha256: 'b', mimeType: 'text/markdown' }],
      tenantId: 'tenant-1',
    }
    // listForTenant: createdAt desc → newer first
    const out = dedupeMcpSkillPackagesByUri([newer, older])
    assert.equal(out.length, 0)
  })

  check('tenant skill wins over platform on the same URI', () => {
    const platform: McpSkillPackageCandidate = {
      name: 'tulajdoni-lap',
      uriName: 'tulajdoni-lap',
      description: 'platform',
      license: null,
      skillId: 'skill-platform',
      skillVersionId: 'v-p',
      files: [{ path: 'SKILL.md', text: 'platform', sha256: 'p', mimeType: 'text/markdown' }],
      tenantId: null,
    }
    const tenant: McpSkillPackageCandidate = {
      name: 'tulajdoni_lap',
      uriName: 'tulajdoni-lap',
      description: 'tenant',
      license: null,
      skillId: 'skill-tenant',
      skillVersionId: 'v-t',
      files: [{ path: 'SKILL.md', text: 'tenant', sha256: 't', mimeType: 'text/markdown' }],
      tenantId: 'tenant-1',
    }
    const tenantFirst = dedupeMcpSkillPackagesByUri([tenant, platform])
    assert.equal(tenantFirst.length, 1)
    assert.equal(tenantFirst[0]?.skillId, 'skill-tenant')

    const platformFirst = dedupeMcpSkillPackagesByUri([platform, tenant])
    assert.equal(platformFirst.length, 1)
    assert.equal(platformFirst[0]?.skillId, 'skill-tenant')
  })

  check('platform–platform URI collision omits both packages', () => {
    const a: McpSkillPackageCandidate = {
      name: 'my_skill',
      uriName: 'my-skill',
      description: 'a',
      license: null,
      skillId: 'a',
      skillVersionId: 'va',
      files: [{ path: 'SKILL.md', text: 'a', sha256: 'a', mimeType: 'text/markdown' }],
      tenantId: null,
    }
    const b: McpSkillPackageCandidate = {
      name: 'my-skill',
      uriName: 'my-skill',
      description: 'b',
      license: null,
      skillId: 'b',
      skillVersionId: 'vb',
      files: [{ path: 'SKILL.md', text: 'b', sha256: 'b', mimeType: 'text/markdown' }],
      tenantId: null,
    }
    assert.equal(dedupeMcpSkillPackagesByUri([a, b]).length, 0)
  })

  console.log(`\n${failures === 0 ? 'mcp-skills: ok' : `mcp-skills: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
