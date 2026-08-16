/**
 * Workspace accessMode a tulajdoni-lap toolokhoz — tiszta (DB-mentes) kapu.
 *
 * Az authorizer ebből dönti el, read vagy write workspace connector kell.
 * A coverage-only ág tényleg csak olvas; a többi egyeztető útvonal Excel nélkül
 * is írhat `egyeztetes-eltero.json` / `fold_muveletek.json` fájlt.
 */

export type TulajdoniWorkspaceTool = 'tulajdoni_lap_parse' | 'tulajdoni_lap_egyeztetes'
export type TulajdoniWorkspaceAccessMode = 'read' | 'write'

/**
 * Coverage-only egyeztetés: csak proposal-lefedettség, nincs lap/nyilvántartás.
 */
export function isTulajdoniLapEgyeztetesCoverageOnly(
  args: Record<string, unknown> | undefined,
): boolean {
  return (
    typeof args?.coverageAppliedPath === 'string' &&
    args.coverageAppliedPath.trim().length > 0 &&
    !(typeof args?.documentId === 'string' && args.documentId.trim()) &&
    !(typeof args?.path === 'string' && args.path.trim()) &&
    !(typeof args?.feldolgozottLapPath === 'string' && args.feldolgozottLapPath.trim()) &&
    !(typeof args?.nyilvantartasPath === 'string' && args.nyilvantartasPath.trim()) &&
    !(Array.isArray(args?.nyilvantartas) && args.nyilvantartas.length > 0)
  )
}

/**
 * - `tulajdoni_lap_parse`: handoff `kimenet` → write; különben read.
 * - `tulajdoni_lap_egyeztetes`: coverage-only → read; MINDEN más → write.
 *   A korábbi „JSON-only → read” szabály read-only workspace connectorral
 *   workspace-írási bypass volt (eltero / fold_muveletek).
 */
export function resolveTulajdoniWorkspaceAccessMode(
  tool: TulajdoniWorkspaceTool,
  args: Record<string, unknown> | undefined,
): TulajdoniWorkspaceAccessMode {
  if (tool === 'tulajdoni_lap_parse') {
    const kimenet = typeof args?.kimenet === 'string' ? args.kimenet.trim() : ''
    return kimenet ? 'write' : 'read'
  }
  return isTulajdoniLapEgyeztetesCoverageOnly(args) ? 'read' : 'write'
}
