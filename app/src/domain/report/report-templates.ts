/**
 * §5.10 generateReport — előre definiált riport-sablonok.
 *
 * Egy sablon lényegében egy rögzített utasítás, amely a wiki-agentet arra kéri,
 * hogy a tudásbázisból (kb_search) citált, strukturált riportot állítson elő.
 * A generálás ugyanazon a két átjárón (Tool Broker + Model Gateway) megy át,
 * mint a sima wiki-kérdés, így auditált és reprodukálható marad.
 */
export type ReportTemplate = {
  id: string
  name: string
  description: string
  /** A wiki-runtime felé „kérdésként" átadott riport-utasítás (retrieval + szintézis). */
  prompt: string
}

export const REPORT_TEMPLATES: readonly ReportTemplate[] = [
  {
    id: 'kb-overview',
    name: 'Tudásbázis-áttekintő',
    description:
      'Strukturált összefoglaló a tudásbázis fő témáiról, alfejezetekre bontva, forrásokkal citálva.',
    prompt: [
      'Készíts strukturált áttekintő riportot a tudásbázis tartalmáról.',
      'Foglald össze a fő témákat 3–6 alfejezetben, mindegyiket rövid bekezdéssel.',
      'Csak a megtalált forrásrészletekre támaszkodj, és minden állításhoz add meg a forrást.',
      'Ha egy téma nincs lefedve a tudásbázisban, azt jelezd, ne találj ki tényt.',
    ].join(' '),
  },
  {
    id: 'kb-gaps',
    name: 'Hiányelemzés',
    description:
      'A tudásbázis lefedettségét vizsgálja: mely témák jól dokumentáltak, és hol vannak hiányok.',
    prompt: [
      'Készíts hiányelemzést a tudásbázisról.',
      'Sorold fel, mely témák vannak jól dokumentálva, és mely területeken hiányos vagy ellentmondásos a tartalom.',
      'Csak a megtalált forrásrészletekre támaszkodj; a hiányokat a források alapján következtetve jelezd.',
      'Zárd egy rövid, priorizált javaslattal arra, milyen dokumentumokkal lenne érdemes bővíteni a tudásbázist.',
    ].join(' '),
  },
] as const

export function listReportTemplates(): readonly ReportTemplate[] {
  return REPORT_TEMPLATES
}

export function getReportTemplate(id: string): ReportTemplate | undefined {
  return REPORT_TEMPLATES.find((template) => template.id === id)
}
