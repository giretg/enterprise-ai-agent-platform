# Kulcsceremónia jegyzőkönyv — Kulcsrotáció / -csere (ZMK/ZPK) — Thales payShield 10K

> Ipoteka Bank · key_rotation · generálva: 2026-06-18T15:25:47+00:00
> PCI hivatkozás: PCI DSS 3.7.4 (kulcscsere a kriptoperiódus végén), PCI DSS 3.6.1, PCI DSS 3.7.6 (dual control / split knowledge), PCI PIN Req 18, PCI PIN Req 29

**Státusz:** BEFEJEZVE

## Résztvevők
| Név | Szerep | Employee ID |
|---|---|---|
| Aliyev R. | key_custodian | E1000 |
| Karimova D. | key_custodian | E1001 |
| Yusupov B. | authorization_officer | E1002 |
| Rashidov S. | security_officer | E1003 |

## Pre-flight ellenőrzés
- [x] A csere oka és a lecserélendő kulcs azonosítva (kriptoperiódus lejárt / gyanú / scheme-kérés).
- [x] Min. 2 különböző key custodian + 1 AO + 1 security officer jelen, érvényes kinevezéssel.
- [x] Separation of duties: senki nem tölt be ütköző szerepet.
- [x] A művelet a secure operation roomban zajlik; HSM hardened és commissioned állapotban.
- [x] Egy kulcs = egy cél elv betartva: az új kulcs kizárólag a régi céljára készül.
- [x] Elegendő üres smartcard + serializált tamper-evident boríték rendelkezésre áll.

## Ceremónia lépések
| # | Leírás | Parancs | Végrehajtó | Eredmény | Rögzített | Időbélyeg |
|---|---|---|---|---|---|---|
| 1 | Eszköz- és LMK-állapot ellenőrzése | `VR / VK` | Aliyev R. | Eszköz genuine; LMK Live; állapot rendben | serial_number=val_serial_number | 2026-06-18T15:25:47+00:00 |
| 2 | A lecserélendő kulcs azonosítása a leltárból (Ref.Num, KCV) | `(leltár)` | Aliyev R. | A régi kulcs Ref.Num és KCV egyezik a leltárral | old_key_ref=val_old_key_ref; old_key_kcv=val_old_key_kcv | 2026-06-18T15:25:47+00:00 |
| 3 | Új kulcs generálása az LMK alatt (a régi céljára) | `GC / GK` | Aliyev R. | Új kulcs generálva; KCV megjelenik | new_key_kcv=val_new_key_kcv; key_type=val_key_type | 2026-06-18T15:25:47+00:00 |
| 4 | Kettős kontrollú komponens-rögzítés smartcardra (custodianonként) | `FC / export` | Aliyev R. | Komponensek külön kártyákon, custodianok saját PIN-nel |  | 2026-06-18T15:25:47+00:00 |
| 5 | Új kulcs aktiválása / élesítése a célrendszer felé | `(host import / aktiválás)` | Aliyev R. | Az új kulcs a régi helyére lép; tranzakció-teszt OK | new_key_ref=val_new_key_ref | 2026-06-18T15:25:47+00:00 |
| 6 | A régi kulcs visszavonása / törlése a HSM-ből (lásd decommission) | `DK` | Aliyev R. | Régi kulcs törölve / visszavonva, dokumentálva |  | 2026-06-18T15:25:47+00:00 |

## Lezárás
- [x] Az új kulcs komponensei serializált tamper-evident borítékba, sorszám rögzítve.
- [x] A régi kulcs komponensei dekomissziós eljárásra kijelölve (külön ceremónia).
- [x] Leltár-frissítési javaslat: régi kulcs lezárva, új kulcs felvéve (KCV, dátum).
- [x] Security Officer és custodianok aláírása.

## Aláírások

- key_custodian — Aliyev R.: __________________________  dátum: __________
- key_custodian — Karimova D.: __________________________  dátum: __________
- authorization_officer — Yusupov B.: __________________________  dátum: __________
- security_officer — Rashidov S.: __________________________  dátum: __________

---
*Megjegyzés: e jegyzőkönyv nem tartalmaz PIN-t, teljes kulcsértéket vagy komponens-titkot — kizárólag azonosítókat, KCV/check value-t és metaadatot (PCI DSS 3.6.x / 3.7.x, evidence-first elv).*