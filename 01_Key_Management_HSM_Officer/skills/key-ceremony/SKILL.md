---
name: key-ceremony
description: Kulcsceremónia végigvezetése a Thales payShield 10K HSM-en — LMK generálás/betöltés, ZMK/ZPK rotáció, kulcs-átadás, dekomisszió, custodian átadás-átvétel. Kettős kontroll és split knowledge kikényszerítése, lépésenkénti emberi végrehajtás, auditálható jegyzőkönyv. Triggerek: "kulcsceremónia", "LMK generálás", "kulcscsere", "key rotation", "új kulcs HSM", "ZMK", "custodian átadás".
---

# Key Ceremony — végigvezető skill

## Cél
Egy kulcsceremónia hibamentes, szabályos, **auditálható** levezetése. Az agent
**vezérel és dokumentál**, az ember **végrehajt és jóváhagy**. Dual control és split
knowledge soha nem sérülhet.

## Alapszabályok (mindig érvényes)
1. Egyetlen HSM-parancsot sem futtatok automatikusan. Megmutatom → ember végrehajtja →
   eredményt rögzítem → ember megerősíti.
2. PIN-t, teljes kulcsértéket, komponenst SOHA nem kérek be és nem rögzítek. Csak:
   KCV/check value, eszköz-sorozatszám, boríték-sorszám, időbélyeg, résztvevő, parancs.
3. Bármely eltérésnél (KCV nem egyezik, hiányzó résztvevő, sérült boríték) → **STOP** +
   eszkaláció a Security Officer felé.

## Folyamat

### 0. Ceremónia kiválasztása
Kérdezd meg / azonosítsd a típust. Töltsd be a hozzá tartozó configot:
`prototype/ceremonies/<típus>.json`. Támogatott: `lmk_generation`, `key_rotation`,
`key_transfer`, `key_decommission`, `custodian_handover`.

### 1. Előellenőrzés (pre-flight) — kötelező STOP-pontok
- [ ] **Résztvevők és szerepek**: min. 2 különböző Key Custodian + Authorization Officer.
      A `templates/Key custodian list.docx` és az érvényes AO/KC kinevezés (App. 4) alapján.
- [ ] **Separation of duties**: senki nem tölt be ütköző szerepet (pl. nem ugyanaz a
      személy KC1 és AO).
- [ ] **Secure room access** rögzítve (Event log / access log).
- [ ] **Eszköz-állapot**: `VR` parancs → firmware/serial egyezik a vendor-adattal;
      fizikai tamper-ellenőrzés OK; HSM secure state (két fizikai kulcs).
- [ ] **Smartcard-készlet**: elegendő üres kártya + tamper-evident borítékok.
Ha bármi hiányzik → **NE indítsd a ceremóniát**, sorold fel a hiányt.

### 2. Lépésenkénti levezetés
Minden lépésnél ezt a sablont kövesd:
```
LÉPÉS n/N — <leírás>
Parancs:        <payShield parancs, pl. GK>
Várt eredmény:  <pl. "Device write complete, check: XXXX YY">
→ Kérlek hajtsd végre a HSM-en, majd add meg a tényleges check value-t / eredményt.
```
Rögzítendő mezők lépésenként: parancs, végrehajtó személy, időbélyeg, eredmény
(KCV/check), megjegyzés. Eltérésnél STOP.

**Példa LMK-generálás lépéssor** (forrás: `templates/Commissioning_10K.docx`):
`VR` (eszköz-ellenőrzés) → `FC` (kártya-formázás, custodianonként saját PIN) →
`GK` (3 LMK komponens generálás, 3 kártyára) → `CO` (2 AO authorizing kártya) →
`FC` (deputy kártyák) → `DC` (komponens-duplikátum deputy custodianoknak) →
`CO` (deputy AO kártyák) → `LK` (LMK betöltés a kártyákról) → `LO` (key change storage).

### 3. Lezárás
- [ ] Minden LMK-komponens és AO-kártya **tamper-evident borítékba** került, sorszám rögzítve.
- [ ] Eszköz-sorozatszám, dátum, helyszín rögzítve.
- [ ] Aláírás-helyek a Security Officer(ek) és custodianok számára kijelölve.

### 4. Evidence-generálás
Hívd a prototípust:
`python3 prototype/ceremony_orchestrator.py --ceremony <típus> --record <session.json>`
Kimenet: `prototype/output/<dátum>_<típus>_evidence.md` + `.json`. A jegyzőkönyv a
`Keymanagement requirements v8.docx` melléklet-sablonjához (App. 3/5/6/9/10/15) igazodik,
aláírásra/archiválásra kész.

### 5. Leltár-frissítés (emberi jóváhagyással)
Javasold az új kulcs felvételét a `inventory/Key inventory_Ipoteka_to_continue.xlsx`-be
(Ref.Num, Key name, type, strength, KCV, creation date, storage, usage). **Csak javaslat** —
a tényleges írást ember hagyja jóvá.

## PCI-leképezés (a jegyzőkönyvbe is kerüljön)
- Dual control / split knowledge → PCI DSS 3.7.6; PIN Req 18/29
- Kulcs-generálás erős kulccsal → 3.6.1, 3.7.1
- Custodian nyilatkozat → 3.7.8
- Kulcs-tárolás minimális hozzáféréssel → 3.6.1.x
