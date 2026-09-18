/**
 * Chat/ticket csatolmány → munkaterület fájlnév.
 *
 * A chat feltöltés az eredeti PDF/Office binárist NEM tárolja — csak a
 * kinyert szöveget (`Document.extractedText`). A workspace-tükrözés ezért
 * `.txt` toldalékkal írja ki ezeket, hogy a fájl-olvasó ne sérült binárist
 * kapjon. A chat-trigger `pdf_path` / `path` réseit ugyanezzel a névvel
 * kell kitölteni, különben a folyamat-lépés FILE_NOT_FOUND-ot kap.
 */

const EXTRACTED_TEXT_SUFFIX_RE = /\.(xlsx|xlsm|docx|pdf)$/i

export function chatAttachmentWorkspacePath(filename: string): string {
  const trimmed = filename.trim()
  if (!trimmed) return trimmed
  if (EXTRACTED_TEXT_SUFFIX_RE.test(trimmed)) return `${trimmed}.txt`
  return trimmed
}
