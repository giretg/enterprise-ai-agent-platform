import { WorkspaceStorage, safeObjectPath } from './workspace-storage'
import { isWorkspaceFileUserFacing } from '@/lib/workspace-file-visibility'

/**
 * A workspace-fájl letöltés-kapuja — a ticket- és a conversation-route KÖZÖS
 * döntése, hogy egyetlen helyen ne tudjon szétcsúszni.
 *
 * A fájllista szándékosan elrejti a felhasználó elől az agent belső munka-fájljait
 * (nyers tool-kimenetek, kivonat-JSON-ok, `.workspace-meta` markerek). A letöltésnek
 * UGYANEZT a döntést kell hoznia — különben a „rejtett" jelző puszta UI-dísz, és egy
 * nyers `?path=…`-sal a legalacsonyabb szerepkör is lehúzhatná a rejtett fájlokat.
 *
 * Visszatérés: a normalizált, LETÖLTHETŐ path — vagy `null`, ha az útvonal érvénytelen
 * (`..` kilépés), vagy a fájl nem a felhasználónak szól. A hívó route mindkét esetben
 * `404`-et ad (nem különböztetjük meg a „nincs ilyen" és a „belső" esetet, hogy a
 * végpont ne legyen létezés-orákulum a rejtett fájlokra).
 */
export async function resolveDownloadableWorkspacePath(
  storage: WorkspaceStorage,
  tenantId: string,
  workspaceId: string,
  rawPath: string,
): Promise<string | null> {
  let safePath: string
  try {
    safePath = safeObjectPath(rawPath)
  } catch {
    return null
  }
  const audience = await storage.getFileAudience(tenantId, workspaceId, safePath)
  return isWorkspaceFileUserFacing(safePath, audience) ? safePath : null
}
