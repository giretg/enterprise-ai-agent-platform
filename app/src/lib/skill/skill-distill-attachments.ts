import {
  SKILL_ATTACHMENTS_TOTAL_MAX_BYTES,
  SKILL_ATTACHMENT_MAX_BYTES,
  SKILL_ATTACHMENT_MAX_COUNT,
  hashAttachmentBytes,
  type SkillAttachment,
} from './skill-attachments'
import { classifyPackageFile } from './skill-package-adapter'
import { isInternalWorkspaceFile } from '@/lib/workspace-file-visibility'

/**
 * Beszélgetés-workspace → skill Level-2 melléklet. Ugyanaz a kapu, mint a
 * csomag-importnál: csak szöveges referencia (md/txt/csv/json…), kód és bináris
 * kimarad. A modell ezután VÁLASZT a jelöltek közül — egy-egy futás számlái,
 * személyes adatai nem válnak automatikusan skill-fájllá.
 */

export interface DistillAttachmentCandidateFile {
  path: string
  bytes: Uint8Array
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8_000)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

function normalizeAttachmentPath(path: string): string {
  return path.trim().replace(/^\/+/, '')
}

/** Workspace-fájlok, amelyek skill-mellékletnek *jelölhetők*. */
export function collectDistillAttachmentCandidates(
  files: DistillAttachmentCandidateFile[],
): SkillAttachment[] {
  const attachments: SkillAttachment[] = []
  const seen = new Set<string>()
  let totalBytes = 0

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  for (const file of sorted) {
    const path = normalizeAttachmentPath(file.path)
    if (!path || seen.has(path) || isInternalWorkspaceFile(path)) continue
    if (classifyPackageFile(path) !== 'reference') continue

    const size = file.bytes.byteLength
    if (size === 0 || size > SKILL_ATTACHMENT_MAX_BYTES) continue
    if (looksBinary(file.bytes)) continue
    if (attachments.length >= SKILL_ATTACHMENT_MAX_COUNT) break
    if (totalBytes + size > SKILL_ATTACHMENTS_TOTAL_MAX_BYTES) continue

    seen.add(path)
    totalBytes += size
    attachments.push({
      path,
      text: Buffer.from(file.bytes).toString('utf8'),
      bytes: size,
      sha256: hashAttachmentBytes(file.bytes),
    })
  }
  return attachments
}

/**
 * A modell által kért útvonalak ∩ a jelölt lista. Ismeretlen / kitalált path
 * nem kerül be — a beszélgetés a nem-megbízható input.
 */
export function selectDistillAttachments(
  candidates: SkillAttachment[],
  requestedPaths: string[],
): SkillAttachment[] {
  if (requestedPaths.length === 0) return []
  const wanted = new Set(
    requestedPaths.map(normalizeAttachmentPath).filter((path) => path.length > 0),
  )
  const picked: SkillAttachment[] = []
  for (const candidate of candidates) {
    if (!wanted.has(candidate.path)) continue
    picked.push(candidate)
    if (picked.length >= SKILL_ATTACHMENT_MAX_COUNT) break
  }
  return picked
}

/** Rövid index a desztilláló promptjába — tartalom nélkül, csak path + méret + előnézet. */
export function formatDistillAttachmentIndex(candidates: SkillAttachment[]): string {
  if (candidates.length === 0) return ''
  const lines = candidates.map((a) => {
    const preview = a.text.replace(/\s+/g, ' ').trim().slice(0, 180)
    return `- ${a.path} (${Math.ceil(a.bytes / 1024)} KB): ${preview}`
  })
  return lines.join('\n')
}
