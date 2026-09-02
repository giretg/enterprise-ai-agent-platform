/**
 * Tudásbázis feldolgozási mód felületi címkék — a feltöltő panel és a jóváhagyói
 * review ugyanebből a szótárból dolgozik (nem „Nyers KB” / „OKF wiki”).
 */

export type KbProcessingModeValue = 'raw_text_only' | 'okf'

export const KB_PROCESSING_MODE_OPTIONS: Array<{
  value: KbProcessingModeValue
  label: string
  description: string
}> = [
  {
    value: 'raw_text_only',
    label: 'Egyszerű fájl feltöltés',
    description: 'A szöveg a feltöltött formában kerül a tudásbázisba, jóváhagyás után kereshető.',
  },
  {
    value: 'okf',
    label: 'Wiki formátumba alakítás',
    description: 'Oldalakra bontott wiki-előnézet és ellenőrzés jóváhagyás előtt.',
  },
]

export function kbProcessingModeLabel(mode: KbProcessingModeValue | null | undefined): string {
  if (mode === 'raw_text_only') return 'Egyszerű fájl feltöltés'
  if (mode === 'okf') return 'Wiki formátumba alakítás'
  return 'Mód nincs kiválasztva'
}

export const KB_PROCESSING_MODE_APPROVER_HINT =
  'A feldolgozási módot a jóváhagyó választja ki az áttekintésben.'

export function kbSharingWholeBaseHint(agentName: string): string {
  return `Ezzel a(z) ${agentName} összes jóváhagyott dokumentuma olvashatóvá válik a kiválasztott agent számára. Nem fájlonkénti megosztás.`
}
