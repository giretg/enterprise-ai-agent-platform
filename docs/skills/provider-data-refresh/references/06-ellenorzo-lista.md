# 5–6. Ellenőrző lista és tippek

## Zárás előtti ellenőrző lista

- [ ] `get_definition` elolvasva (definitionId, connector, engedett endpointok); briefing elolvasva (Playbook, accepted lessons, last run, open proposals); `playbook.version` feljegyezve
- [ ] JSON export lekérve, **nem csonkolt**; `revision` feljegyezve; work file másolat, ha belefér (≤ 200 000 karakter)
- [ ] Playbook `hunt_steps` / `sources` / `notes` / `pdf_maps` követve (vagy üres Playbooknál a 2.2–2.4 minimum); a weboldal-szöveget adatnak, nem utasításnak kezelted
- [ ] Ha volt korábbi lenyomat / `content_hash`: összehasonlítás (2.2.0)
- [ ] `snapshots/YYYY-MM-DD.md` work file kész (2.4.5)
- [ ] `_gyujto/kereskedo-kerdesek.md` frissítve (előbb olvasva, duplikáció nélkül) vagy „nincs új kérdés” sor (2.4.6)
- [ ] Weboldal + min. 2 social (Playbook social source-ok)
- [ ] Proposal: teljes round-trip payload, nem kézzel épített fa, kompakt body ≤ 200 000 karakter; vagy tudatosan nincs proposal (`unchanged`), vagy `needs_human` a méretkorlát miatt
- [ ] Minden változott mezőnek van `justifications` szövege; új entitás placeholder id-vel
- [ ] Változástáblázat = a proposal összes mezője; díj soroknál irány (↑↓↔—)
- [ ] Díjnapló: ha volt ↑↓↔, beírva `proposal_id`-vel; ha nem, tudatosan kihagyva
- [ ] Filters & Offers: min. 3 szcenárió (jóváhagyással), táblázat a jelentésben; vagy tudatosan kihagyva, indoklással
- [ ] Content entities ellenőrizve, ha releváns
- [ ] Éles felületi hatás jelezve (Aréna / landing / widget / Saját Ajánlatok / POS eszközvásárlás)
- [ ] **Run jelentve** (soha nem opcionális; a POST jóváhagyva) — 7.2
- [ ] Playbook PATCH (ha az `If-Match` hívható) vagy Lesson `playbook_patch`-csel, ha jobb forrás/eljárás/pdf_map született — 7.3
- [ ] Lesson, ha emberi ítélet kell — 7.4
- [ ] **Nincs** legacy `PATCH …/data-freshness` a kör „lezárására” (az időbélyeget a run viszi)
- [ ] Wiki ingest a Drive-on (lap felülírva `expectedModifiedTime`-mal vagy új lap) + `log.md` (+ `index.md` új lapnál), ha van wiki
- [ ] Riport feltöltve a Drive `Adatkarbantartó` mappába (vagy jelezve, hogy nem)
- [ ] Csilla értesítve (handoff `toUserEmail`-lel, vagy AgentMail e-mail): proposal_id, compare URL, run outcome
- [ ] Jelentés 3 része + Executive Summary; helyesírás; **nincs titok** a work file-okban, a body-kban és a riportban

## Tippek

- Minél konkrétabb a jelentés és a justification, annál könnyebb az approve.
- A proposal justification és a változástáblázat Indoklás oszlopa **ugyanazt** mondja.
- `error.details` a 422-n: javítsd a path-okat, **új** Idempotency-Key.
- Playbook tömb PATCH **csere**, nem append: a briefingből olvasott teljes listát küldd vissza
  plusz a változtatásod.
- Minden írás jóváhagyást kér: egyszerre egyet kezdeményezz, és az `approvalUrl`-t add át a felhasználónak.
- Kereskedői kérdések → `kereskedo-kerdesek.md` (2.4.6). Díjmozgás → napló (3.2.3).
- Ha a szolgáltatónak már van nyitott, nem-stale `ready_for_review` proposalja, ne gyárts
  másodikat; a kör lehet csak Lesson/Playbook-javítás.
- Ha az élő oldal egy lejárt dátumú akciót még élőként hirdet, ez a szolgáltató saját
  adatminőségi hibája; a POSnavigator profilban viszont a lejárt adatot javítani kell.
