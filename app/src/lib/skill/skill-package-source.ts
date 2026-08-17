/**
 * Skill-csomag forrás-URL normalizálás (import „URL-behúzás” ág).
 *
 * Miért kell normalizálni: az admin azt az URL-t másolja be, amit a böngészőben
 * lát (`github.com/owner/repo/tree/main/skills/pdf`), a letöltés viszont egy
 * archívum-végpontra megy. Ha a nyers URL-t követnénk, egy cross-host
 * átirányításon (`github.com` → `codeload.github.com`) kéne átengednünk a
 * letöltőt — az pedig pont az a redirect-lazítás, ami máshol már SSRF-leletet
 * okozott. Ehelyett ELŐRE, determinisztikusan kiszámoljuk a végleges
 * archívum-URL-t, és a letöltő nulla átirányítást enged.
 *
 * A tényleges hálózati kaput (séma, SSRF, allowlist, DNS-rebinding) a közös
 * `guardEgressUrl` adja — ez a modul csak a cél-URL alakját dönti el.
 */

/** Alap-allowlist. Bővíthető `SKILL_IMPORT_ALLOWED_HOSTS`-szal (belső Git-szerverhez). */
export const DEFAULT_SKILL_IMPORT_HOSTS = [
  'github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
] as const

export function skillImportAllowlistHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.SKILL_IMPORT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
  return [...DEFAULT_SKILL_IMPORT_HOSTS, ...extra]
}

export interface NormalizedSkillSource {
  /** A letöltendő archívum URL-je (https, allowlistolt host). */
  archiveUrl: string
  /** A csomagon belüli skill-alkönyvtár, ha az URL erre mutatott. */
  subpath?: string
  /** Ha a ref-et nem az admin adta meg, ezeket próbáljuk sorban. */
  refCandidates: string[]
  /** Embernek szóló forrás-megjelölés a provenience-hez. */
  label: string
}

export class SkillSourceUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillSourceUrlError'
  }
}

function codeloadUrl(owner: string, repo: string, ref: string): string {
  // A `refs/heads/` prefix nélküli alak tag-re és commit-hash-re is működik.
  return `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`
}

/**
 * A támogatott alakok:
 *   - `https://github.com/owner/repo`
 *   - `https://github.com/owner/repo/tree/<ref>/<alkönyvtár...>`
 *   - `https://github.com/owner/repo/archive/refs/heads/<ref>.zip`
 *   - `https://codeload.github.com/owner/repo/zip/<ref>`
 *   - bármely allowlistolt host `.zip`-re végződő URL-je (belső Git-szerver)
 */
export function normalizeSkillSourceUrl(rawUrl: string): NormalizedSkillSource {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new SkillSourceUrlError('Nem értelmezhető URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new SkillSourceUrlError('Csak https URL tölthető le.')
  }

  const host = parsed.hostname.toLowerCase()
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0).map(decodeURIComponent)

  if (host === 'github.com') {
    const [owner, repoRaw, kind, ...rest] = segments
    if (!owner || !repoRaw) {
      throw new SkillSourceUrlError('A GitHub URL-ből hiányzik a tulajdonos vagy a repó neve.')
    }
    const repo = repoRaw.replace(/\.git$/, '')

    if (!kind) {
      return {
        archiveUrl: codeloadUrl(owner, repo, 'main'),
        refCandidates: ['main', 'master'],
        label: `${owner}/${repo}`,
      }
    }
    if (kind === 'tree' || kind === 'blob') {
      const [ref, ...pathParts] = rest
      if (!ref) throw new SkillSourceUrlError('A GitHub URL-ből hiányzik az ág/tag neve.')
      // `blob` esetén a fájlnév (SKILL.md) a végén áll — a skill gyökere a könyvtára.
      const parts = kind === 'blob' ? pathParts.slice(0, -1) : pathParts
      const subpath = parts.join('/')
      return {
        archiveUrl: codeloadUrl(owner, repo, ref),
        ...(subpath ? { subpath } : {}),
        refCandidates: [ref],
        label: `${owner}/${repo}@${ref}${subpath ? `/${subpath}` : ''}`,
      }
    }
    if (kind === 'archive') {
      const ref = rest.join('/').replace(/^refs\/(heads|tags)\//, '').replace(/\.zip$/, '')
      if (!ref) throw new SkillSourceUrlError('A GitHub archívum-URL-ből hiányzik az ág/tag neve.')
      return {
        archiveUrl: codeloadUrl(owner, repo, ref),
        refCandidates: [ref],
        label: `${owner}/${repo}@${ref}`,
      }
    }
    throw new SkillSourceUrlError(
      'Ezt a GitHub-útvonalat nem tudjuk letölteni. Használd a repó vagy egy mappa (tree) URL-jét.',
    )
  }

  if (host === 'codeload.github.com') {
    return { archiveUrl: parsed.toString(), refCandidates: [], label: parsed.pathname }
  }

  if (parsed.pathname.toLowerCase().endsWith('.zip')) {
    return { archiveUrl: parsed.toString(), refCandidates: [], label: `${host}${parsed.pathname}` }
  }

  throw new SkillSourceUrlError(
    'Erről a címről nem tudunk csomagot letölteni. Adj meg GitHub repó/mappa URL-t vagy közvetlen .zip címet.',
  )
}

/** A `refCandidates` alapján előálló további próbálkozási URL-ek (pl. main → master). */
export function archiveUrlForRef(archiveUrl: string, ref: string): string {
  return archiveUrl.replace(/\/zip\/[^/]+$/, `/zip/${encodeURIComponent(ref)}`)
}
