import {
  SKILL_ATTACHMENTS_TOTAL_MAX_BYTES,
  SKILL_ATTACHMENT_MAX_BYTES,
  SKILL_ATTACHMENT_MAX_COUNT,
  hashAttachmentBytes,
  type SkillAttachment,
} from './skill-attachments'

/**
 * Több-fájlos skill-csomag adapter (a `skill-md-adapter` egy-fájlos útjának
 * kiterjesztése). Bemenete egy kicsomagolt fájllista (ZIP vagy letöltött
 * archívum), kimenete: a `SKILL.md` nyers szövege + a megtartott Level-2
 * mellékletek + egy TÉTELES jelentés arról, mi maradt ki és miért.
 *
 * Alapelv (a felhasználó döntése, 2026-08-12): a futtatható kód-fájlok
 * KIMARADNAK, de nem buktatják el az egész importot — a skill használható lesz,
 * és az admin pontosan látja, mi nem jött át. Ez nem lazít a Fázis 1 kód-tiltásán:
 * a kód egyszerűen nem kerül be a rendszerbe, se tárolva, se betölthetően.
 */

export type SkillPackageFileKind = 'skill_md' | 'reference' | 'code' | 'unsupported'

export type SkillPackageSkipReason =
  | 'code_file'
  | 'unsupported_type'
  | 'binary_content'
  | 'too_large'
  | 'attachment_limit'
  | 'total_size_limit'
  | 'injection_pattern'

export interface SkillPackageSkippedFile {
  path: string
  reason: SkillPackageSkipReason
  bytes: number
}

export interface SkillPackageResult {
  /** A `SKILL.md` nyers tartalma — innen a meglévő `parseSkillMd` veszi át. */
  skillMdRaw: string
  /** A csomagon belüli skill-gyökér (a `SKILL.md` könyvtára), pl. `document-skills/pdf`. */
  skillRoot: string
  attachments: SkillAttachment[]
  skipped: SkillPackageSkippedFile[]
}

export class SkillPackageError extends Error {
  constructor(
    message: string,
    readonly code: 'no_skill_md' | 'multiple_skills' | 'skill_md_unreadable',
    /** `multiple_skills` esetén a választható skill-gyökerek — a UI ebből kínál listát. */
    readonly candidates: string[] = [],
  ) {
    super(message)
    this.name = 'SkillPackageError'
  }
}

/**
 * Futtatható kód — ezek a fájlok KIMARADNAK. A lista szándékosan bőkezű: ha egy
 * kiterjesztésről nem tudjuk biztosan, hogy adat, inkább kódnak vesszük
 * (a Fázis 1 „kétség esetén elutasít” elve fájl-szinten).
 */
export const CODE_EXTENSIONS = new Set([
  'py', 'pyc', 'pyw', 'ipynb',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'rb', 'php', 'pl', 'pm', 'lua', 'r', 'jl',
  'go', 'rs', 'java', 'kt', 'scala', 'swift', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs',
  'sql', 'vbs', 'applescript', 'awk', 'sed',
  'jar', 'exe', 'dll', 'so', 'dylib', 'wasm', 'bin',
  'makefile', 'dockerfile',
])

/** Szöveges melléklet — ezek jöhetnek be Level-2 referenciaként. */
const REFERENCE_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'rst', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'ini', 'toml', 'cfg',
])

/** Fejlesztői zaj, ami sosem érdekes — külön jelentés nélkül dobjuk. */
const IGNORED_SEGMENTS = new Set(['.git', '.github', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build'])
const IGNORED_FILENAMES = new Set(['.ds_store', 'thumbs.db', '.gitignore', '.gitattributes'])

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name.toLowerCase() // pl. `Makefile`, `Dockerfile`
  return name.slice(dot + 1).toLowerCase()
}

export function classifyPackageFile(path: string): SkillPackageFileKind {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (name === 'skill.md') return 'skill_md'
  const ext = extensionOf(path)
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (REFERENCE_EXTENSIONS.has(ext)) return 'reference'
  return 'unsupported'
}

function isIgnored(path: string): boolean {
  const segments = path.split('/')
  const name = (segments.pop() ?? '').toLowerCase()
  if (IGNORED_FILENAMES.has(name)) return true
  return segments.some((s) => IGNORED_SEGMENTS.has(s.toLowerCase()))
}

/** NUL-bájt → bináris tartalom; a melléklet szöveg-tár, binárist nem fogadunk. */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8_000)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

/**
 * A GitHub-archívum egyetlen felső szintű könyvtárba csomagol (`repo-main/…`).
 * Ha MINDEN bejegyzés ugyanazzal a szegmenssel kezdődik, azt levágjuk — így a
 * `subpath` a felhasználó által ismert repo-úttal egyezik, nem a zip belsejével.
 */
export function stripCommonRoot(paths: string[]): { prefix: string; stripped: string[] } {
  if (paths.length === 0) return { prefix: '', stripped: [] }
  const first = paths[0]!.split('/')[0]!
  const allShare = paths.every((p) => p.startsWith(`${first}/`))
  if (!allShare) return { prefix: '', stripped: paths }
  return { prefix: `${first}/`, stripped: paths.map((p) => p.slice(first.length + 1)) }
}

function normalizeSubpath(subpath: string | undefined): string {
  if (!subpath) return ''
  return subpath.replace(/^\/+|\/+$/g, '')
}

export interface SkillPackageInputFile {
  path: string
  bytes: Uint8Array
}

/**
 * Csomag → egy skill. `subpath` megadásával a csomagon belüli konkrét skill
 * választható ki (több-skilles repóknál kötelező).
 */
export function buildSkillPackage(
  files: SkillPackageInputFile[],
  options: { subpath?: string } = {},
): SkillPackageResult {
  const relevant = files.filter((f) => !isIgnored(f.path))
  const { stripped } = stripCommonRoot(relevant.map((f) => f.path))
  const normalized = relevant.map((f, i) => ({ path: stripped[i]!, bytes: f.bytes }))

  const subpath = normalizeSubpath(options.subpath)
  const skillMdCandidates = normalized
    .filter((f) => classifyPackageFile(f.path) === 'skill_md')
    .map((f) => ({ file: f, root: f.path.slice(0, Math.max(0, f.path.length - 'SKILL.md'.length - 1)) }))

  if (skillMdCandidates.length === 0) {
    throw new SkillPackageError(
      'A csomagban nincs SKILL.md — enélkül nem tudjuk, mi a skill neve, leírása és instrukciója.',
      'no_skill_md',
    )
  }

  let chosen = skillMdCandidates[0]!
  if (subpath) {
    const match = skillMdCandidates.find((c) => c.root === subpath)
    if (!match) {
      throw new SkillPackageError(
        `A megadott alkönyvtárban (${subpath}) nincs SKILL.md.`,
        'no_skill_md',
        skillMdCandidates.map((c) => c.root || '.'),
      )
    }
    chosen = match
  } else if (skillMdCandidates.length > 1) {
    throw new SkillPackageError(
      'A csomag több skillt tartalmaz — válaszd ki, melyiket importáljuk.',
      'multiple_skills',
      skillMdCandidates.map((c) => c.root || '.').sort((a, b) => a.localeCompare(b)),
    )
  }

  const skillRoot = chosen.root
  if (looksBinary(chosen.file.bytes)) {
    throw new SkillPackageError('A SKILL.md nem olvasható szövegként.', 'skill_md_unreadable')
  }
  const skillMdRaw = Buffer.from(chosen.file.bytes).toString('utf8')

  // Csak a kiválasztott skill könyvtárán BELÜLI fájlok tartoznak a skillhez —
  // egy több-skilles repóból nem szívjuk fel a szomszéd skill mellékleteit.
  const scopePrefix = skillRoot ? `${skillRoot}/` : ''
  const attachments: SkillAttachment[] = []
  const skipped: SkillPackageSkippedFile[] = []
  let totalBytes = 0

  const inScope = normalized
    .filter((f) => f.path !== chosen.file.path && f.path.startsWith(scopePrefix))
    .map((f) => ({ relPath: f.path.slice(scopePrefix.length), bytes: f.bytes }))
    // Determinista sorrend: a limitbe ugyanaz a készlet fér be minden futáskor.
    .sort((a, b) => a.relPath.localeCompare(b.relPath))

  for (const file of inScope) {
    const kind = classifyPackageFile(file.relPath)
    const size = file.bytes.byteLength

    if (kind === 'skill_md') continue // beágyazott al-skill: nem a mi hatókörünk
    if (kind === 'code') {
      skipped.push({ path: file.relPath, reason: 'code_file', bytes: size })
      continue
    }
    if (kind === 'unsupported') {
      skipped.push({ path: file.relPath, reason: 'unsupported_type', bytes: size })
      continue
    }
    if (size > SKILL_ATTACHMENT_MAX_BYTES) {
      skipped.push({ path: file.relPath, reason: 'too_large', bytes: size })
      continue
    }
    if (looksBinary(file.bytes)) {
      skipped.push({ path: file.relPath, reason: 'binary_content', bytes: size })
      continue
    }
    if (attachments.length >= SKILL_ATTACHMENT_MAX_COUNT) {
      skipped.push({ path: file.relPath, reason: 'attachment_limit', bytes: size })
      continue
    }
    if (totalBytes + size > SKILL_ATTACHMENTS_TOTAL_MAX_BYTES) {
      skipped.push({ path: file.relPath, reason: 'total_size_limit', bytes: size })
      continue
    }

    totalBytes += size
    attachments.push({
      path: file.relPath,
      text: Buffer.from(file.bytes).toString('utf8'),
      bytes: size,
      sha256: hashAttachmentBytes(file.bytes),
    })
  }

  return { skillMdRaw, skillRoot, attachments, skipped }
}

/** Közérthető indoklás a UI-nak — az admin ebből érti meg, miért maradt ki egy fájl. */
export const SKILL_PACKAGE_SKIP_LABEL: Record<SkillPackageSkipReason, string> = {
  code_file: 'futtatható kód — a platform nem futtat skill-kódot, ezért nem hoztuk be',
  unsupported_type: 'nem szöveges melléklet-típus',
  binary_content: 'bináris tartalom',
  too_large: `nagyobb, mint a melléklet-limit (${Math.round(SKILL_ATTACHMENT_MAX_BYTES / 1024)} KB)`,
  attachment_limit: `elérte a melléklet-darabszám keretet (${SKILL_ATTACHMENT_MAX_COUNT})`,
  total_size_limit: `elérte az összesített melléklet-keretet (${Math.round(SKILL_ATTACHMENTS_TOTAL_MAX_BYTES / 1024)} KB)`,
  injection_pattern: 'prompt-injection gyanús minta a szövegben',
}
