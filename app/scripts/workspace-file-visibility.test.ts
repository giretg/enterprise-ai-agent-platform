/**
 * Workspace fájlok felhasználói láthatósági szabályai.
 * Run: npm run test:workspace-file-visibility
 */
import assert from 'node:assert/strict'
import {
  isWorkspaceFileUserFacing,
  isInternalWorkspaceFile,
  linkWorkspaceFileReferences,
  referencedWorkspaceFiles,
  workspaceFileDownloadLink,
  workspaceFileLink,
  workspaceFileLinkForReference,
  workspaceHtmlPreviewFromLink,
  workspaceHtmlPreviewTarget,
} from '../src/lib/workspace-file-visibility'
import { WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main() {
  await check('a felhasználó által feltöltött fájl megjelenik, névtől függetlenül', () => {
    assert.equal(isWorkspaceFileUserFacing('orders_extract.json', 'user'), true)
  })

  await check('az agentnek szánt kivonat nem jelenik meg a fájlpanelen', () => {
    assert.equal(isWorkspaceFileUserFacing('orders_extract.json', 'internal'), false)
    assert.equal(isWorkspaceFileUserFacing('tool-outputs/02-http_api_get-call.json'), false)
    assert.equal(isWorkspaceFileUserFacing('.tool-results/02-http_api_get-call.json'), false)
  })

  await check('a régi, ismert gépi kimenetek metadata nélkül is rejtve maradnak', () => {
    assert.equal(isWorkspaceFileUserFacing('orders_extract.json'), false)
    assert.equal(isInternalWorkspaceFile('tool-outputs/02-http_api_get-call.json'), true)
    assert.equal(isInternalWorkspaceFile('orders_extract.json'), true)
    assert.equal(isWorkspaceFileUserFacing('havi_riport.html'), true)
  })

  await check('a HTML hivatkozás megnyitási URL-t, más fájl letöltési URL-t kap', () => {
    assert.equal(
      workspaceFileLink('/api/v1/conversations/c-1/workspace/files', 'havi riport.html'),
      '/api/v1/conversations/c-1/workspace/files?path=havi+riport.html&disposition=inline',
    )
    assert.equal(
      workspaceFileLink('/api/v1/conversations/c-1/workspace/files', 'adatok.xlsx'),
      '/api/v1/conversations/c-1/workspace/files?path=adatok.xlsx',
    )
  })

  await check('minden ténylegesen létező workspace-fájlhivatkozás kattintható, kiterjesztéstől függetlenül', () => {
    const files = ['havi riport.html', 'export.zip', 'notebook.ipynb']
    assert.deepEqual(
      referencedWorkspaceFiles('Megnyitható a havi riport.html, a `export.zip` és a notebook.ipynb.', files),
      ['havi riport.html', 'export.zip', 'notebook.ipynb'],
    )
    assert.equal(
      linkWorkspaceFileReferences('Töltsd le az export.zip fájlt.', files, '/workspace'),
      'Töltsd le az [export.zip](/workspace?path=export.zip) fájlt.',
    )
  })

  await check('az agent saját Markdown-fájllinkje is a workspace megnyitási URL-jére mutat', () => {
    const baseUrl = '/api/v1/tickets/t-1/workspace/files'
    const files = ['ugyfelek_tavaly_vasarlas_iden_nincs_rendeles.html']
    assert.equal(
      workspaceFileLinkForReference('ugyfelek_tavaly_vasarlas_iden_nincs_rendeles.html', files, baseUrl),
      `${baseUrl}?path=ugyfelek_tavaly_vasarlas_iden_nincs_rendeles.html&disposition=inline`,
    )
    assert.equal(
      workspaceFileLinkForReference('./ugyfelek_tavaly_vasarlas_iden_nincs_rendeles.html', files, baseUrl),
      `${baseUrl}?path=ugyfelek_tavaly_vasarlas_iden_nincs_rendeles.html&disposition=inline`,
    )
    assert.equal(workspaceFileLinkForReference('https://example.com/report.html', files, baseUrl), null)
  })

  await check('a HTML előnézet célja külön inline és letöltési URL-t ad', () => {
    const baseUrl = '/api/v1/conversations/c-1/workspace/files'
    const target = workspaceHtmlPreviewTarget(baseUrl, 'havi riport.html')
    assert.ok(target)
    assert.equal(target.url, `${baseUrl}?path=havi+riport.html&disposition=inline`)
    assert.equal(target.downloadUrl, `${baseUrl}?path=havi+riport.html`)
    assert.equal(target.fileName, 'havi riport.html')
    assert.equal(workspaceHtmlPreviewTarget(baseUrl, 'adatok.xlsx'), null)
    assert.equal(
      workspaceFileDownloadLink(baseUrl, 'havi riport.html'),
      `${baseUrl}?path=havi+riport.html`,
    )
    assert.deepEqual(
      workspaceHtmlPreviewFromLink(`${baseUrl}?path=havi+riport.html&disposition=inline`),
      target,
    )
    assert.equal(workspaceHtmlPreviewFromLink('https://example.com/report.html'), null)
  })

  await check('a workspace manifest külön kezeli a feltöltött és a belső azonos nevű JSON-okat', async () => {
    process.env.FILE_EDITOR_STUB = 'true'
    process.env.FILE_EDITOR_STUB_MEMORY = 'true'
    const storage = new WorkspaceStorage('test-bucket')
    const tenantId = 'workspace-file-visibility-test'
    const workspaceId = 'audience-separation'
    await storage.write(tenantId, workspaceId, 'orders_extract.json', Buffer.from('[]'))
    await storage.setFileAudience(tenantId, workspaceId, 'orders_extract.json', 'user')
    await storage.write(tenantId, workspaceId, 'tool-outputs/orders_extract.json', Buffer.from('[]'))
    await storage.setFileAudience(tenantId, workspaceId, 'tool-outputs/orders_extract.json', 'internal')

    assert.deepEqual(await storage.listUserFacing(tenantId, workspaceId), ['orders_extract.json'])
  })

  if (failures > 0) process.exit(1)
  console.log('\nworkspace file visibility tests passed')
}

void main()
