/** Közös üzleti feliratok az adattárház felületéhez és az Excel-exporthoz. */
const MESSAGES: Record<string, string> = {
  sheet_not_found: 'A kiválasztott munkalap nem található a fájlban.',
  duplicate_target: 'Két forrásoszlop ugyanabba a mezőbe kerülne. Kérj javított tervet.',
  source_column_not_found: 'A tervben megadott oszlop nem található az Excelben.',
  business_key_required: 'Frissítéshez meg kell adni, mely mezők azonosítanak egy rekordot.',
  business_key_not_in_fields: 'A rekordazonosító egyik mezője hiányzik a betöltési tervből.',
  mode_change_not_allowed: 'A meglévő adatkészlet betöltési módja nem változtatható meg.',
  business_key_change_not_allowed: 'A meglévő rekordok azonosítási szabálya nem változtatható meg.',
  type_change_not_allowed: 'Egy meglévő mező adattípusa nem változtatható meg.',
  link_change_not_allowed: 'Egy meglévő kapcsolat szabálya nem változtatható meg. Használj új kapcsolati mezőt.',
  link_field_not_in_fields: 'Az összekapcsoláshoz használt mező hiányzik a betöltési tervből.',
  self_link_not_supported: 'Egy adatkészlet saját rekordjai közötti kapcsolás még nem támogatott.',
  link_dataset_not_found: 'A kapcsolódó adatkészlet még nem létezik. Előbb azt töltsd be.',
  link_field_not_found: 'A kapcsolódó adatkészletben nem található a megadott mező.',
  link_key_must_be_business_key: 'Az összekapcsoláshoz a kapcsolódó adatkészlet rekordazonosítóját kell használni.',
  no_data_rows: 'A kiválasztott munkalapon nincs betölthető adatsor.',
  duplicate_source_file: 'Ezt a fájlt már betöltötték az adatkészletbe.',
  type_mismatch: 'Az oszlop értékei eltérhetnek a tervben megadott adattípustól.',
  hidden_sheet: 'A kiválasztott munkalap rejtett az Excelben.',
  not_a_number: 'Az érték nem értelmezhető számként.',
  not_an_integer: 'Egész szám szükséges, de az érték törtrészt is tartalmaz.',
  number_too_large: 'A szám túl nagy a pontos feldolgozáshoz.',
  not_a_date: 'Az érték nem értelmezhető dátumként.',
  not_a_boolean: 'Az érték nem értelmezhető igen/nem válaszként.',
  definitions_not_confirmed: 'A mezők üzleti jelentését még nem erősítették meg.',
  open_exceptions: 'Hiányzó kapcsolatok vagy más tisztázandó tételek vannak az adatokban.',
  stale_source: 'Az adatok több mint 90 napja frissültek; ellenőrizd, hogy még aktuálisak-e.',
}

export function warehouseMessage(code: string): string {
  return MESSAGES[code] ?? 'Az adat vagy a betöltési terv ellenőrzést igényel.'
}

const FIELD_TYPES: Record<string, string> = {
  text: 'Szöveg',
  integer: 'Egész szám',
  decimal: 'Szám (tizedesekkel is)',
  date: 'Dátum',
  boolean: 'Igen / nem',
  link: 'Kapcsolat',
}

export function warehouseFieldTypeLabel(type: string): string {
  return FIELD_TYPES[type] ?? 'Egyéb adat'
}
