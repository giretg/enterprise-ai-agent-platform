# Kulcsceremónia jegyzőkönyv — Key custodian átadás-átvétel (handover / takeover)

> Ipoteka Bank · custodian_handover · generálva: 2026-06-18T15:25:47+00:00
> PCI hivatkozás: PCI DSS 3.7.8 (kulcs-custodian szerep és felelősség), PCI DSS 3.7.9 (custodian nyilatkozat), PCI DSS 3.7.6 (dual control), PCI PIN Req 29

**Státusz:** BEFEJEZVE

## Résztvevők
| Név | Szerep | Employee ID |
|---|---|---|
| Aliyev R. | handover_custodian | E1000 |
| Karimova D. | takeover_custodian | E1001 |
| Yusupov B. | security_officer | E1002 |

## Pre-flight ellenőrzés
- [x] Az átadó (handover) és az átvevő (takeover) custodian személye azonosítva, érvényes/új kinevezéssel.
- [x] A Security Officer jelen van és levezeti az eseményt.
- [x] Az átadandó tételek (komponens-borítékok, smartcardok) listázva, sorszámmal.
- [x] Az átvevő custodian megismerte a felelősségeit (Requirements §5/6/7).

## Ceremónia lépések
| # | Leírás | Parancs | Végrehajtó | Eredmény | Rögzített | Időbélyeg |
|---|---|---|---|---|---|---|
| 1 | Átadandó tételek leltár-ellenőrzése (sorszám vs. inventory) | `(safe check)` | Aliyev R. | Minden tétel sértetlen, sorszámok egyeznek a leltárral | item_serials=val_item_serials | 2026-06-18T15:25:47+00:00 |
| 2 | Tételek átadása az átvevő custodiannak | `(átadás)` | Aliyev R. | Minden tétel fizikailag átadva és átvéve | item_count=val_item_count | 2026-06-18T15:25:47+00:00 |
| 3 | Átvevő custodian nyilatkozat aláírása (szerep elfogadása, App. 8) | `(nyilatkozat)` | Aliyev R. | Takeover custodian aláírta a felelősség-elfogadó nyilatkozatot |  | 2026-06-18T15:25:47+00:00 |
| 4 | Régi custodian kinevezésének visszavonása | `(revocation)` | Aliyev R. | A handover custodian kijelölése visszavonva és dokumentálva | revoked_name=val_revoked_name | 2026-06-18T15:25:47+00:00 |

## Lezárás
- [x] Az átadás-átvételi jegyzőkönyv kitöltve (jelenlévők, helyszín, tételek).
- [x] Az átvevő custodian felvéve a Key custodian listára; a régi eltávolítva (emberi jóváhagyással).
- [x] Handover party, takeover party és Security Officer aláírása.

## Aláírások

- handover_custodian — Aliyev R.: __________________________  dátum: __________
- takeover_custodian — Karimova D.: __________________________  dátum: __________
- security_officer — Yusupov B.: __________________________  dátum: __________

---
*Megjegyzés: e jegyzőkönyv nem tartalmaz PIN-t, teljes kulcsértéket vagy komponens-titkot — kizárólag azonosítókat, KCV/check value-t és metaadatot (PCI DSS 3.6.x / 3.7.x, evidence-first elv).*