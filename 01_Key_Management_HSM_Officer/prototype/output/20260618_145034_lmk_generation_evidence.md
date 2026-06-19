# Kulcsceremónia jegyzőkönyv — LMK generálás és betöltés — Thales payShield 10K

> Ipoteka Bank · lmk_generation · generálva: 2026-06-18T14:50:34+00:00
> PCI hivatkozás: PCI DSS 3.6.1, PCI DSS 3.7.1, PCI DSS 3.7.6 (dual control / split knowledge), PCI PIN Req 18, PCI PIN Req 29

**Státusz:** BEFEJEZVE

## Résztvevők
| Név | Szerep | Employee ID |
|---|---|---|
| Aliyev R. | key_custodian | EMP-1021 |
| Karimova D. | key_custodian | EMP-1044 |
| Yusupov B. | authorization_officer | EMP-2003 |
| G. Giret | security_officer | EMP-0007 |

## Pre-flight ellenőrzés
- [x] Min. 2 különböző key custodian + 1 AO + 1 security officer jelen (érvényes kinevezéssel).
- [x] Separation of duties: senki nem tölt be ütköző szerepet.
- [x] Secure room access napló kitöltve.
- [x] HSM secure state-be kapcsolva a két fizikai kulccsal.
- [x] Elegendő üres smartcard + tamper-evident boríték rendelkezésre áll.

## Ceremónia lépések
| # | Leírás | Parancs | Végrehajtó | Eredmény | Rögzített | Időbélyeg |
|---|---|---|---|---|---|---|
| 1 | Eszköz-ellenőrzés (firmware, serial, genuineness) | `VR` | G. Giret | Base release 3.1a; Serial A3453266741E egyezik | serial_number=A3453266741E; base_release=3.1a | 2026-06-18T14:50:34+00:00 |
| 2 | Smartcard formázás LMK komponenshez (custodianonként saját PIN) | `FC` | Aliyev R. | Format complete | card_user_id=LMKA1 | 2026-06-18T14:50:34+00:00 |
| 3 | LMK komponensek generálása (3 komponens, 3 kártyára) | `GK` | Aliyev R. | [VISSZAUTASÍTVA: tiltott titok került be — lehetséges teljes kulcs/komponens (>=16 hex)] |  | 2026-06-18T14:50:34+00:00 |
| 4 | Authorization Officer kártyák létrehozása | `CO` | Yusupov B. | Copy complete |  | 2026-06-18T14:50:34+00:00 |
| 5 | Deputy smartcardok formázása | `FC` | Karimova D. | Format complete |  | 2026-06-18T14:50:34+00:00 |
| 6 | Komponens-duplikátumok deputy custodianoknak | `DC` | Karimova D. | Device write complete, check: 3333 94 | component_kcv=3333 94 | 2026-06-18T14:50:34+00:00 |
| 7 | Deputy AO kártyák | `CO` | Yusupov B. | Copy complete |  | 2026-06-18T14:50:34+00:00 |
| 8 | LMK betöltése a kártyákról | `LK` | G. Giret | LMK status: Live; KCV 0441 62 | lmk_id=00; lmk_kcv=0441 62 | 2026-06-18T14:50:34+00:00 |
| 9 | LMK key change storage-be töltése | `LO` | G. Giret | LO sikeres |  | 2026-06-18T14:50:34+00:00 |

## Lezárás
- [x] Minden LMK-komponens és AO-kártya tamper-evident borítékba, sorszám rögzítve.
- [x] Eszköz-sorozatszám, dátum, helyszín rögzítve.
- [x] Security Officer(ek) és custodianok aláírása.

## ⚠️ Figyelmeztetések / eltérések
- 3. lépés: tiltott titok kiszűrve (lehetséges teljes kulcs/komponens (>=16 hex)).

## Aláírások

- key_custodian — Aliyev R.: __________________________  dátum: __________
- key_custodian — Karimova D.: __________________________  dátum: __________
- authorization_officer — Yusupov B.: __________________________  dátum: __________
- security_officer — G. Giret: __________________________  dátum: __________

---
*Megjegyzés: e jegyzőkönyv nem tartalmaz PIN-t, teljes kulcsértéket vagy komponens-titkot — kizárólag azonosítókat, KCV/check value-t és metaadatot (PCI DSS 3.6.x / 3.7.x, evidence-first elv).*