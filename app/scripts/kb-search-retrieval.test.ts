/**
 * kb_search retrieval — fájlnév-alapú lekérdezés (pl. Project_description_users.md).
 * Futtatás: npx tsx scripts/kb-search-retrieval.test.ts
 */
import assert from 'node:assert/strict'

const STEM_LENGTH = 4

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
}

function stemToken(token: string): string {
  return token.length <= STEM_LENGTH ? token : token.slice(0, STEM_LENGTH)
}

function queryTermStems(query: string): string[] {
  return [
    ...new Set(
      normalizeText(query)
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
        .map(stemToken),
    ),
  ]
}

function stemsFromText(text: string): string[] {
  return [
    ...new Set(
      normalizeText(text)
        .split(/\s+/)
        .filter(Boolean)
        .filter((term) => term.length >= 3)
        .map(stemToken),
    ),
  ]
}

function filenameSearchText(filename: string): string {
  return filename.replace(/[._-]+/g, ' ')
}

function documentSearchCorpus(filename: string, extractedText: string | null): string {
  const header = filenameSearchText(filename)
  const body = extractedText?.trim() ?? ''
  return body ? `${header}\n\n${body}` : header
}

function scoreDoc(
  filename: string,
  extractedText: string,
  query: string,
): number {
  const termStems = queryTermStems(query)
  const extraStems = stemsFromText(filenameSearchText(filename))
  const corpus = documentSearchCorpus(filename, extractedText)
  const chunk = corpus.split(/\n{2,}/)[0] ?? corpus
  const chunkStems = new Set([
    ...normalizeText(chunk)
      .split(/\s+/)
      .filter(Boolean)
      .map(stemToken),
    ...extraStems,
  ])
  return termStems.reduce((sum, stem) => sum + (chunkStems.has(stem) ? 1 : 0), 0)
}

const query = 'miről szól a Project_description_users.md dokumenttum?'
const hungarianBody = `A rendszer felhasználói szerepköröket és jogosultságokat ír le.
Az adminisztrátorok kezelhetik az agenteket.`

assert.ok(
  scoreDoc('Project_description_users.md', hungarianBody, query) >= 3,
  'filename stems should match even when body is Hungarian-only',
)

const posQuery = 'miről szól a posnavigator projekt?'
const posBody = `A POSnavigátor egy fizetési összehasonlító platform.
A projekt célja az agent-first integráció.`
assert.ok(
  scoreDoc('Project_description_users.md', posBody, posQuery) >= 1,
  'content keyword posnavigator should match posnavigátor in body',
)

assert.equal(
  scoreDoc('paste.txt', hungarianBody, query),
  0,
  'unrelated filename should not match',
)

console.log('  ✅ kb-search-retrieval.test.ts')
