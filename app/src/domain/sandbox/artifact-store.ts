/**
 * Sandbox App Registry artifact store (Feature-spec — App Registry §2.2, §3.3).
 *
 * A HTML-artefakt KÍVÜL kerül a relációs adatmodellen: a `sandbox_app_versions`
 * sor csak `artifactRef + contentHash + size + mime`-t tárol, sosem a HTML-t.
 * Ez a §2.3/5. invariáns ("a verzió tartalma immutable") és az F-AR-1 elfogadás
 * ("a DB-ben nincs HTML content, csak artifact reference") garanciája.
 *
 * Prod: GCS REST az ambient Cloud Run service accounttal (a WorkspaceStorage
 * mintájára). Dev/test: SANDBOX_APP_STUB=true (vagy FILE_EDITOR_STUB=true) →
 * process-global memóriatár. A ref ilyenkor is path, NEM inline HTML, hogy a
 * DB-be tényleg csak hivatkozás kerüljön.
 */

export class ArtifactStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactStoreError'
  }
}

// A stub-tár process-szinten osztott, mert Next dev alatt a server action-ök és a
// route handler-ek külön modulpéldányt kapnak ugyanabban a folyamatban (lásd
// workspace-storage.ts ugyanezt a megoldást használja a prisma-szerű singletonhoz).
const globalStub = globalThis as typeof globalThis & {
  __sandboxAppArtifactStub__?: Map<string, string>
}
const stubStore: Map<string, string> = (globalStub.__sandboxAppArtifactStub__ ??= new Map<
  string,
  string
>())

export function artifactObjectPath(params: {
  tenantId: string | null
  appId: string
  version: number
}): string {
  const tenant = params.tenantId ?? '_global'
  return `sandbox-apps/${tenant}/${params.appId}/versions/${params.version}/index.html`
}

async function resolveGcsToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  )
  if (!res.ok) {
    throw new ArtifactStoreError('GCS_AUTH_FAILED', `Metadata server returned ${res.status}`)
  }
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

export interface ArtifactStore {
  /** Immutable feltöltés. A ref a verzió object-path-e (NEM a HTML). */
  put(params: {
    tenantId: string | null
    appId: string
    version: number
    html: string
  }): Promise<{ artifactRef: string; sizeBytes: number }>
  /** A ref alapján visszaadja a HTML tartalmat (preview/export). */
  get(artifactRef: string): Promise<string>
}

export class GcsArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: string) {}

  private isStub(): boolean {
    return process.env.SANDBOX_APP_STUB === 'true' || process.env.FILE_EDITOR_STUB === 'true'
  }

  async put(params: {
    tenantId: string | null
    appId: string
    version: number
    html: string
  }): Promise<{ artifactRef: string; sizeBytes: number }> {
    const objectPath = artifactObjectPath(params)
    const sizeBytes = Buffer.byteLength(params.html, 'utf8')

    if (this.isStub()) {
      stubStore.set(objectPath, params.html)
      return { artifactRef: objectPath, sizeBytes }
    }

    const token = await resolveGcsToken()
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(
      objectPath,
    )}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/html; charset=utf-8',
      },
      body: params.html,
    })
    if (!res.ok) {
      throw new ArtifactStoreError('GCS_WRITE_FAILED', `GCS upload failed: HTTP ${res.status}`)
    }
    return { artifactRef: objectPath, sizeBytes }
  }

  async get(artifactRef: string): Promise<string> {
    if (this.isStub()) {
      const html = stubStore.get(artifactRef)
      if (html == null) {
        throw new ArtifactStoreError('ARTIFACT_NOT_FOUND', `Artifact not found: ${artifactRef}`)
      }
      return html
    }

    const token = await resolveGcsToken()
    const url = `https://storage.googleapis.com/download/storage/v1/b/${this.bucket}/o/${encodeURIComponent(
      artifactRef,
    )}?alt=media`
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 404) {
      throw new ArtifactStoreError('ARTIFACT_NOT_FOUND', `Artifact not found: ${artifactRef}`)
    }
    if (!res.ok) {
      throw new ArtifactStoreError('GCS_READ_FAILED', `GCS read failed: HTTP ${res.status}`)
    }
    return res.text()
  }
}
