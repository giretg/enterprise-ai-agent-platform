/** A felhasználói fájllistából rejtendő, agent-munkához szükséges fájlok. */
export type WorkspaceFileAudience = 'user' | 'internal'

export const WORKSPACE_FILE_AUDIENCE_MANIFEST = '.workspace-meta/file-audience.json'
export const WORKSPACE_FILE_AUDIENCE_PREFIX = '.workspace-meta/file-audience/'

export function isHtmlWorkspaceFile(path: string): boolean {
  return /\.html?$/i.test(path)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function workspaceReferencePattern(paths: string[]): RegExp | null {
  const alternatives = paths
    .filter((path) => path.length > 0 && path.length <= 512 && !path.startsWith('/'))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
  if (alternatives.length === 0) return null
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_.\\-/])(${alternatives.join('|')})(?=$|[^\\p{L}\\p{N}_\\-/])`,
    'gu',
  )
}

/** A válaszban ténylegesen említett, ismert workspace-fájlok. */
export function referencedWorkspaceFiles(content: string, workspaceFiles: string[]): string[] {
  const pattern = workspaceReferencePattern(workspaceFiles)
  if (!pattern) return []
  const referenced = new Set<string>()
  for (const match of content.matchAll(pattern)) referenced.add(match[2])
  return [...referenced]
}

/** A simán említett fájlneveket is Markdown-linkké teszi; meglévő linket/kódot nem ír át. */
export function linkWorkspaceFileReferences(
  content: string,
  workspaceFiles: string[],
  baseUrl: string,
): string {
  const pattern = workspaceReferencePattern(workspaceFiles)
  if (!pattern) return content
  const protectedSegments = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]*\]\([^)]+\))/g
  return content
    .split(protectedSegments)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(pattern, (_match, prefix: string, path: string) =>
            `${prefix}[${path}](${workspaceFileLink(baseUrl, path)})`,
          ),
    )
    .join('')
}

/**
 * A régebbi workspace-ekhez nincs audience-metadata. Ezeknél a jól ismert
 * technikai útvonalakat és a gépi kivonatokat továbbra is elrejtjük.
 */
export function isInternalWorkspaceFile(path: string): boolean {
  return (
    path === WORKSPACE_FILE_AUDIENCE_MANIFEST ||
    path.startsWith('.workspace-meta/') ||
    path.startsWith('.tool-results/') ||
    path.startsWith('tool-outputs/') ||
    /(?:^|\/)[^/]+_(?:extract|raw|response)\.json$/i.test(path)
  )
}

/** A fájl akkor látható, ha a felhasználó töltötte fel vagy neki készült. */
export function isWorkspaceFileUserFacing(
  path: string,
  audience?: WorkspaceFileAudience,
): boolean {
  if (path === WORKSPACE_FILE_AUDIENCE_MANIFEST || path.startsWith('.workspace-meta/')) return false
  if (audience) return audience === 'user'
  return !isInternalWorkspaceFile(path)
}

/**
 * Azonos eredetű, jogosultság-ellenőrzött letöltési/megjelenítési link.
 * A HTML nem a GCS aláírt URL-jét használja: a route izolált inline választ ad.
 */
export function workspaceFileLink(baseUrl: string, path: string): string {
  const params = new URLSearchParams({ path })
  if (isHtmlWorkspaceFile(path)) params.set('disposition', 'inline')
  return `${baseUrl}?${params}`
}

/** Attachment letöltés — disposition nélkül (a route alapból attachment). */
export function workspaceFileDownloadLink(baseUrl: string, path: string): string {
  return `${baseUrl}?${new URLSearchParams({ path })}`
}

export type WorkspaceHtmlPreviewTarget = {
  url: string
  downloadUrl: string
  fileName: string
  path: string
}

/** Modal / előnézet cél egy ismert workspace HTML path-ból. */
export function workspaceHtmlPreviewTarget(
  baseUrl: string,
  path: string,
): WorkspaceHtmlPreviewTarget | null {
  if (!isHtmlWorkspaceFile(path)) return null
  return {
    url: workspaceFileLink(baseUrl, path),
    downloadUrl: workspaceFileDownloadLink(baseUrl, path),
    fileName: path.split('/').pop() ?? path,
    path,
  }
}

/**
 * Workspace HTML megnyitási linkből állít előnézeti célt
 * (chat markdown href → modal).
 */
export function workspaceHtmlPreviewFromLink(href: string): WorkspaceHtmlPreviewTarget | null {
  try {
    const url = new URL(href, 'http://local.invalid')
    if (!url.pathname.includes('/workspace/files')) return null
    const path = url.searchParams.get('path')
    if (!path) return null
    return workspaceHtmlPreviewTarget(url.pathname, path)
  } catch {
    return null
  }
}

/**
 * Az agent olykor maga ír Markdown-linket egy workspace-fájl nevére
 * (például `[Riport megnyitása](riport.html)`). Ilyenkor a relatív href
 * nem a workspace-re mutatna, ezért csak ismert fájlnév esetén feloldjuk.
 */
export function workspaceFileLinkForReference(
  href: string | undefined,
  workspaceFiles: string[],
  baseUrl: string,
): string | null {
  if (!href) return null

  let reference: string
  try {
    reference = decodeURIComponent(href).replace(/^\.\//, '')
  } catch {
    return null
  }

  return workspaceFiles.includes(reference) ? workspaceFileLink(baseUrl, reference) : null
}
