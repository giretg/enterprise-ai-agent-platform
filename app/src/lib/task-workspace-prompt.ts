/**
 * Board/task prompt: workspace fájlok pontos listája (UI Fájlok panellel egyező).
 */
export function formatTaskWorkspaceFilesPrompt(workspaceFiles: string[]): string {
  const visible = workspaceFiles.filter((path) => !path.startsWith('.tool-results/'))
  if (visible.length === 0) {
    return (
      'A ticket munkaterülete jelenleg üres (nincs feltöltött fájl). ' +
      'Ha a feladat fájlra hivatkozik, kérd meg a felhasználót, hogy csatolja a ticket Fájlok paneljén.'
    )
  }
  return (
    `A ticket munkaterületén jelenleg elérhető fájlok (pontos elérési utak):\n` +
    visible.map((path) => `- ${path}`).join('\n') +
    `\n\nEzeket a file_read / pdf_read / xlsx_read_sheet / file_search stb. eszközökkel éred el a fenti pontos néven. ` +
    `Workspace PDF/DOCX-hez NE találj ki documentId-t — a document_read csak a csatolmány-blokkban megadott documentId-kre való. ` +
    `Ha a kért adat egy itt felsorolt fájlban van, onnan dolgozz.`
  )
}
