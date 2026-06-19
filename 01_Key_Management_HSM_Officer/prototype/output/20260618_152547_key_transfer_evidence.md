# Kulcsceremónia jegyzőkönyv — Kulcskomponens-átadás harmadik félnek — Thales payShield 10K

> Ipoteka Bank · key_transfer · generálva: 2026-06-18T15:25:47+00:00
> PCI hivatkozás: PCI DSS 3.7.3 (biztonságos kulcs-elosztás), PCI DSS 3.6.1, PCI DSS 3.7.6 (dual control / split knowledge), PCI PIN Req 18, PCI PIN Req 29

**Státusz:** BEFEJEZVE

## Résztvevők
| Név | Szerep | Employee ID |
|---|---|---|
| Aliyev R. | key_custodian | E1000 |
| Karimova D. | key_custodian | E1001 |
| Yusupov B. | key_custodian | E1002 |
| Rashidov S. | security_officer | E1003 |

## Pre-flight ellenőrzés
- [x] A kulcs-átadást a releváns üzletág senior managere kérte, a Security Officer szervezi.
- [x] Min. 3 különböző key custodian (komponensenként egy) + 1 security officer jelen.
- [x] A harmadik fél 3 key custodianja kijelölve; adataik (név, szerep, telefon, e-mail, postacím, komponens-ID) biztonságosan, írásban megérkeztek és telefonon egyeztetve (App. 11).
- [x] Három KÜLÖNBÖZŐ futárszolgálat elérhető (komponensenként más).
- [x] Serializált tamper-evident borítékok rendelkezésre állnak.
- [x] A művelet a secure operation roomban zajlik.

## Ceremónia lépések
| # | Leírás | Parancs | Végrehajtó | Eredmény | Rögzített | Időbélyeg |
|---|---|---|---|---|---|---|
| 1 | Harmadik fél custodian-adatok rögzítése és egyeztetése (App. 11) | `(dokumentáció)` | Aliyev R. | 3 third-party custodian adat egyeztetve és visszaigazolva | tp_custodian_ids=val_tp_custodian_ids | 2026-06-18T15:25:47+00:00 |
| 2 | Komponens-másolatok készítése (csak custodianok férnek hozzá; App. 12) | `DC` | Aliyev R. | Mindhárom komponensről másolat; primary+copy újra-borítékolva serializáltan | copy_envelope_serials=val_copy_envelope_serials | 2026-06-18T15:25:47+00:00 |
| 3 | Minden komponens külön serializált tamper-evident borítékba | `(csomagolás)` | Aliyev R. | 3 boríték, 3 sorszám rögzítve | envelope_serials=val_envelope_serials | 2026-06-18T15:25:47+00:00 |
| 4 | Boríték-sorszámok előzetes közlése a counterparttal (külön csatornán) | `(kommunikáció)` | Aliyev R. | Mindhárom counterpart megkapta a saját boríték-sorszámot |  | 2026-06-18T15:25:47+00:00 |
| 5 | Komponensek feladása 3 különböző futárral + Sent key component dokumentum (App. 13) | `(feladás)` | Aliyev R. | 3 komponens feladva külön futárral; feladás dokumentálva | courier_refs=val_courier_refs | 2026-06-18T15:25:47+00:00 |
| 6 | Átvételi visszaigazolás fogadása a third party custodianoktól (App. 14) | `(visszaigazolás)` | Aliyev R. | Mindhárom megerősítő űrlap visszaérkezett és a Security Officerhez továbbítva | confirmation_refs=val_confirmation_refs | 2026-06-18T15:25:47+00:00 |

## Lezárás
- [x] Mindhárom komponens átadása visszaigazolva (delivery confirmation, App. 14).
- [x] Boríték-sorszámok a feladott és visszaigazolt dokumentumokon egyeznek.
- [x] Esetleges sérülés / eltérés esetén incidens nyitva (compromise-gyanú).
- [x] Security Officer és custodianok aláírása.

## Aláírások

- key_custodian — Aliyev R.: __________________________  dátum: __________
- key_custodian — Karimova D.: __________________________  dátum: __________
- key_custodian — Yusupov B.: __________________________  dátum: __________
- security_officer — Rashidov S.: __________________________  dátum: __________

---
*Megjegyzés: e jegyzőkönyv nem tartalmaz PIN-t, teljes kulcsértéket vagy komponens-titkot — kizárólag azonosítókat, KCV/check value-t és metaadatot (PCI DSS 3.6.x / 3.7.x, evidence-first elv).*