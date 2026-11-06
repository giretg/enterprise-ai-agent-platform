/**
 * Munkafájlok oldal: rendezés/szűrés, mélylink, HTML- és Word-letöltés.
 * Futtatás: npm run test:work-files-ui
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  filterWorkFiles,
  formatFileSize,
  groupByFolder,
  sortWorkFiles,
  splitFrontmatter,
} from '../src/lib/work-file-list'
import { parseWorkFileDeepLink, workFilePagePath, workFileUrl } from '../src/lib/work-file-link'
import {
  documentTitle,
  exportBaseName,
  markdownToDocxBuffer,
  markdownToHtmlDocument,
  parseMarkdown,
  plainTextToHtmlDocument,
} from '../src/lib/markdown-export'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const files = [
  { path: 'migration/b-terv.md', byteSize: 500, createdAt: '2026-10-20T08:00:00Z', updatedAt: '2026-11-05T08:00:00Z' },
  { path: 'demand-cards/Árvíz.md', byteSize: 9000, createdAt: '2026-10-27T08:00:00Z', updatedAt: '2026-10-28T08:00:00Z' },
  { path: 'jegyzet.md', byteSize: 100, createdAt: '2026-11-01T08:00:00Z', updatedAt: '2026-11-06T08:00:00Z' },
  { path: 'demand-cards/alma.md', byteSize: 2000, createdAt: '2026-10-25T08:00:00Z', updatedAt: '2026-11-02T08:00:00Z' },
]
const paths = (rows: Array<{ path: string }>) => rows.map((r) => r.path)

async function main() {
  await check('rendezés: mappa és név (magyar ábécé, mappánként)', () => {
    assert.deepEqual(paths(sortWorkFiles(files, 'path')), [
      'jegyzet.md',
      'demand-cards/alma.md',
      'demand-cards/Árvíz.md',
      'migration/b-terv.md',
    ])
  })
  await check('rendezés: név, módosítás, létrehozás, méret', () => {
    assert.deepEqual(paths(sortWorkFiles(files, 'name')), [
      'demand-cards/alma.md',
      'demand-cards/Árvíz.md',
      'migration/b-terv.md',
      'jegyzet.md',
    ])
    assert.deepEqual(paths(sortWorkFiles(files, 'updated_desc')), [
      'jegyzet.md',
      'migration/b-terv.md',
      'demand-cards/alma.md',
      'demand-cards/Árvíz.md',
    ])
    assert.deepEqual(paths(sortWorkFiles(files, 'updated_asc')).at(0), 'demand-cards/Árvíz.md')
    assert.deepEqual(paths(sortWorkFiles(files, 'created_desc')).at(0), 'jegyzet.md')
    assert.deepEqual(paths(sortWorkFiles(files, 'created_asc')).at(0), 'migration/b-terv.md')
    assert.deepEqual(paths(sortWorkFiles(files, 'size_desc')).at(0), 'demand-cards/Árvíz.md')
  })
  await check('a rendezés nem módosítja a bemenetet', () => {
    const before = paths(files)
    sortWorkFiles(files, 'size_desc')
    assert.deepEqual(paths(files), before)
  })
  await check('szűrés: ékezet- és kisbetű-érzéketlen, több szó együtt', () => {
    assert.deepEqual(paths(filterWorkFiles(files, 'arviz')), ['demand-cards/Árvíz.md'])
    assert.deepEqual(paths(filterWorkFiles(files, 'DEMAND alma')), ['demand-cards/alma.md'])
    assert.equal(filterWorkFiles(files, '   ').length, 4)
    assert.equal(filterWorkFiles(files, 'nincs ilyen').length, 0)
  })
  await check('csoportosítás mappánként, gyökér külön csoport', () => {
    const groups = groupByFolder(sortWorkFiles(files, 'path'))
    assert.deepEqual(groups.map((g) => g.folder), ['', 'demand-cards', 'migration'])
    assert.equal(groups[1]!.files.length, 2)
  })
  await check('méret emberi formában', () => {
    assert.equal(formatFileSize(512), '512 B')
    assert.equal(formatFileSize(2048), '2.0 KB')
    assert.equal(formatFileSize(300 * 1024), '300 KB')
  })
  await check('YAML-fejléc leválasztása', () => {
    const { front, body } = splitFrontmatter('---\ntitle: x\n---\n# Cím\n')
    assert.equal(front, 'title: x')
    assert.equal(body, '# Cím\n')
    assert.equal(splitFrontmatter('# Cím\n---\nszöveg').front, null)
  })

  await check('mélylink: útvonal, abszolút URL és visszaolvasás', () => {
    const path = workFilePagePath('atvilagitas', 'demand-cards/brd á.md')
    assert.equal(path, '/control-plane/projects?project=atvilagitas&tab=files&file=demand-cards%2Fbrd%20%C3%A1.md')
    assert.equal(
      workFileUrl('https://app.example.test//', null, 'a.md'),
      'https://app.example.test/control-plane/projects?project=__general__&tab=files&file=a.md',
    )
    const query = new URL(`https://x.test${path}`).searchParams
    assert.deepEqual(
      parseWorkFileDeepLink({ project: query.get('project')!, tab: query.get('tab')!, file: query.get('file')! }),
      { project: 'atvilagitas', tab: 'files', file: 'demand-cards/brd á.md' },
    )
    assert.deepEqual(parseWorkFileDeepLink({ file: 'x.md' }).tab, 'files')
    assert.deepEqual(parseWorkFileDeepLink({ tab: 'bármi' }), { project: null, tab: null, file: null })
    assert.deepEqual(parseWorkFileDeepLink({ project: ['a', 'b'] }).project, 'a')
  })

  const md = [
    '---',
    'cim: titkos-fejlec',
    '---',
    '# Demand kártya: Petrol Ofisi',
    '',
    'Ez **vastag**, ez *dőlt*, ez `kód`, ez [link](https://example.com/a?x=1&y=2).',
    '',
    '| Mező | Érték |',
    '|---|---:|',
    '| Név | <b>x</b> |',
    '',
    '- egy',
    '- kettő',
    '  - beágyazott',
    '',
    '1. első',
    '2. második',
    '',
    '- [x] kész',
    '- [ ] nyitott',
    '',
    '> idézet',
    '',
    '```',
    'a < b && c',
    '```',
    '',
    '[rossz](javascript:alert(1)) ![külső](https://evil.test/p.png) <script>alert(1)</script>',
  ].join('\n')

  await check('HTML-letöltés: formázott, önálló, biztonságos', () => {
    const html = markdownToHtmlDocument(md, { path: 'demand-cards/brd.md', updatedAt: '2026-11-06T10:00:00Z' })
    assert.match(html, /^<!doctype html>/)
    assert.match(html, /<title>Demand kártya: Petrol Ofisi<\/title>/)
    assert.match(html, /<h1>Demand kártya: Petrol Ofisi<\/h1>/)
    assert.match(html, /<strong>vastag<\/strong>/)
    assert.match(html, /<em>dőlt<\/em>/)
    assert.match(html, /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2">link<\/a>/)
    assert.match(html, /<th style="text-align:right">Érték<\/th>/)
    assert.match(html, /<ul><li>egy<\/li><li>kettő<ul><li>beágyazott<\/li><\/ul><\/li><\/ul>/)
    assert.match(html, /<ol>/)
    assert.match(html, /☑ kész/)
    assert.match(html, /<blockquote>/)
    assert.match(html, /a &lt; b &amp;&amp; c/)
    // A fejléc kódként marad, nem vízszintes vonal.
    assert.match(html, /titkos-fejlec/)
    assert.doesNotMatch(html, /<hr>/)
    // Veszélyes tartalom nem kerül át.
    assert.doesNotMatch(html, /<script/i)
    assert.doesNotMatch(html, /href="javascript/i)
    assert.doesNotMatch(html, /<img[^>]+evil\.test/i)
    assert.match(html, /\[kép: külső\]/)
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/)
  })
  await check('HTML-letöltés: nem markdown fájl előformázva', () => {
    const html = plainTextToHtmlDocument('a,b\n<1>,2', { path: 'adat/x.csv' })
    assert.match(html, /<pre><code>a,b\n&lt;1&gt;,2<\/code><\/pre>/)
  })
  await check('cím és fájlnév', () => {
    assert.equal(documentTitle(parseMarkdown('szöveg\n\n# Első cím\n'), 'a/b.md'), 'Első cím')
    assert.equal(documentTitle(parseMarkdown('csak szöveg'), 'a/jegyzet-1.md'), 'jegyzet-1')
    assert.equal(exportBaseName('demand-cards/brd-2.3.6.2-petrol-ofisi.md'), 'brd-2.3.6.2-petrol-ofisi')
    assert.equal(exportBaseName('x/ké:*z.md'), 'ké-z')
  })

  await check('Word-letöltés: érvényes .docx, a tartalom benne van', async () => {
    const buffer = await markdownToDocxBuffer(md, { path: 'demand-cards/brd.md' })
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK')
    const dir = mkdtempSync(join(tmpdir(), 'docx-'))
    const file = join(dir, 'out.docx')
    writeFileSync(file, buffer)
    const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8' })
    assert.match(xml, /Demand kártya: Petrol Ofisi/)
    assert.match(xml, /Heading1/)
    assert.match(xml, /<w:b\/>|<w:b /)
    assert.match(xml, /w:tbl>/)
    const rels = execFileSync('unzip', ['-p', file, 'word/_rels/document.xml.rels'], { encoding: 'utf8' })
    assert.match(rels, /Target="https:\/\/example\.com\/a\?x=1&amp;y=2"/)
    assert.doesNotMatch(rels, /javascript:/)
    assert.match(xml, /a &lt; b &amp;&amp; c/)
    assert.doesNotMatch(xml, /javascript:/)
    assert.doesNotMatch(xml, /evil\.test/)
    assert.match(xml, /titkos-fejlec/)
  })

  console.log(failures === 0 ? '\nOK work-files-ui' : `\nFAIL ${failures}`)
  if (failures > 0) process.exit(1)
}

void main()
