/**
 * Board/task prompt: felhasználói workspace-fájlok listája (UI Fájlok panellel egyező).
 */
import { isWorkspaceFileUserFacing } from '@/lib/workspace-file-visibility'

export function formatTaskWorkspaceFilesPrompt(workspaceFiles: string[]): string {
  const visible = workspaceFiles.filter((path) => isWorkspaceFileUserFacing(path))
  if (visible.length === 0) {
    return (
      'A ticket munkaterülete jelenleg üres (nincs feltöltött fájl). ' +
      'Ha a feladat fájlra hivatkozik, kérd meg a felhasználót, hogy csatolja a ticket Fájlok paneljén.'
    )
  }

  const deliverables = visible.filter((path) => /\.(xlsx|xlsm|docx|pptx)$/i.test(path))
  const pdfs = visible.filter((path) => /\.pdf$/i.test(path))

  const parts = [
    `A ticket munkaterületén jelenleg elérhető fájlok (pontos elérési utak):\n` +
      visible.map((path) => `- ${path}`).join('\n'),
    `Ezeket a file_read / pdf_read / xlsx_read_sheet / file_search stb. eszközökkel éred el a fenti pontos néven. ` +
      `Workspace PDF/DOCX-hez NE találj ki documentId-t — a document_read csak a csatolmány-blokkban megadott documentId-kre való. ` +
      `Tulajdoni lap (földhivatali TULLAP/INYER PDF) esetén NE pdf_read-del lapozz: hívd a tulajdoni_lap_parse-t ` +
      `(chat csatolmánynál documentId, workspace fájlnál path — pl. path: "fajl.pdf" vagy "fajl.pdf.txt"). ` +
      `Ha a kért adat egy itt felsorolt fájlban van, onnan dolgozz. Kész fájlra a válaszodban pontos, backtickbe tett fájlnévvel hivatkozz (pl. \`riport.xlsx\`), hogy a felhasználó egy kattintással letölthesse; HTML-nél a link megnyitja a riportot.`,
  ]

  if (pdfs.length > 0) {
    parts.push(
      `PDF fájlok: pdf_read-nél használd a page_range-t (pl. "1-12"); nagy PDF-et ne olvasd be egyszerre.`,
    )
  }
  if (deliverables.length > 0) {
    parts.push(
      `Meglévő deliverable fájlok (${deliverables.join(', ')}): folytatáskor NE töröld őket újraépítéshez — javítsd/bővítsd. Törléshez confirm:true kell.`,
    )
  }

  return parts.join('\n\n')
}
