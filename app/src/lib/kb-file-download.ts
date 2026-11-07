/** Ezeknél a formátumoknál a kinyert szöveg nem azonos a feltöltött fájllal (lásd `detectFormat`). */
const CONVERTED_FORMATS = /\.(pdf|docx|xlsx|pptx|html?)$/i

/**
 * #1139: mit kap a felhasználó letöltéskor. Eredeti híján a kinyert szöveget, és ha az nem ugyanaz a
 * formátum, a `.txt` végződés megakadályozza, hogy a gép hibás Word- vagy PDF-fájlként nyissa meg.
 */
export function kbFileDownload(file: { filename: string; hasOriginal: boolean }): { filename: string; asText: boolean } {
  const asText = !file.hasOriginal && CONVERTED_FORMATS.test(file.filename)
  return { filename: asText ? `${file.filename}.txt` : file.filename, asText }
}
