/** Kliens-oldalon is importálható (nincs node:crypto) — a lint-kódok emberi szövege. */
export const MINI_APP_LINT_LABELS: Record<string, string> = {
  iframe_tag: 'Az oldal egy másik weboldalt próbál beágyazni — ez a mini appban nem engedélyezett.',
  object_tag: 'Az oldal beépülő modult (object) használna — ez a mini appban nem engedélyezett.',
  embed_tag: 'Az oldal beépülő modult (embed) használna — ez a mini appban nem engedélyezett.',
  form_tag: 'Az oldalon beküldhető űrlap van — a mini app nem küldhet adatot sehova.',
  external_script: 'Az oldal külső szkriptet töltene be — ez le van tiltva, ezért az a rész nem fog működni.',
  external_stylesheet: 'Az oldal külső stíluslapot vagy betűtípust töltene be — ez le van tiltva, a kinézet eltérhet.',
  fetch_call: 'Az oldal megpróbál adatot letölteni az internetről — ez a mini appban le van tiltva, ezért az a rész üres maradhat.',
  xhr: 'Az oldal megpróbál adatot letölteni az internetről — ez a mini appban le van tiltva.',
  websocket: 'Az oldal élő kapcsolatot nyitna egy szerverrel — ez a mini appban le van tiltva.',
  event_source: 'Az oldal élő adatfolyamot nyitna egy szerverrel — ez a mini appban le van tiltva.',
  peer_connection: 'Az oldal közvetlen kapcsolatot nyitna más gépekkel — ez a mini appban le van tiltva, ezért az a rész nem fog működni.',
  embedded_document: 'Az oldal beágyazott dokumentumot hozna létre — ez a mini appban le van tiltva, az a rész üres marad.',
  resource_hint: 'Az oldal előre kapcsolódna egy külső címhez — ez a mini appban le van tiltva, és nem is szükséges.',
  document_cookie: 'Az oldal sütiket olvasna — a mini appban nincsenek sütik.',
  local_storage: 'Az oldal adatot tárolna a böngészőben — ez a mini appban nem működik.',
  session_storage: 'Az oldal adatot tárolna a böngészőben — ez a mini appban nem működik.',
  window_top: 'Az oldal a keretén kívülre próbálna hatni — ez le van tiltva.',
  parent_post_message: 'Az oldal üzenetet küldene a befoglaló oldalnak — ez le van tiltva.',
  unsafe_html_sink: 'Az oldal HTML-ként írna ki szöveget (például innerHTML). Élő adatnál ez tilos, mert a cellaérték kódként futhatna: használj textContent-et.',
  document_write: 'Az oldal document.write-tal írna a lapra. Élő adatnál ez tilos: használj textContent-et.',
  inline_event_handler: 'Az oldal HTML-attribútumban adna meg eseménykezelőt (például onclick). Élő adatnál ez nem fut le: használj addEventListener-t.',
  send_beacon: 'Az oldal adatot küldene egy külső címre. Élő adatnál ez tilos.',
  meta_refresh: 'Az oldal automatikusan átirányítana. Élő adatnál ez tilos.',
  dynamic_code: 'Az oldal szövegből futtatna kódot. Élő adatnál ez tilos.',
  too_many_inline_scripts: 'Az oldal túl sok külön szkriptblokkot használ. Élő adatnál vond össze őket.',
  external_resource: 'Az útmutató külső fájlt (betűtípust, szkriptet, stíluslapot) említ — ezek a mini appban nem töltődnek be.',
}

export function miniAppLintLabel(code: string): string {
  return MINI_APP_LINT_LABELS[code] ?? code
}
