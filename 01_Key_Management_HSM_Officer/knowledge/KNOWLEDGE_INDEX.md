# Tudásbázis-index — Key Management / HSM Officer Asszisztens

Ez az index sorolja fel, mely dokumentumokra támaszkodik az agent, és hol vannak.
A „lényegi" fájlokat bemásoltuk ebbe a mappába; a nehéz HSM-manuálokra csak hivatkozunk
(elkerülve a felesleges OneDrive-szinkront).

## 1. Szabályzatok (bemásolva) — `knowledge/policy/`

| Fájl | Tartalom | Mire használja az agent |
|---|---|---|
| `Key_Management_Policy_Main-01.docx` | Fő kulcskezelési politika | Magas szintű elvek, szerepkörök, felelősségek |
| `Keymanagement requirements v8.docx` | Részletes követelmények + **21 melléklet-sablon** | Ceremónia-lépések, dual control, custodian szabályok, jegyzőkönyv-sablonok (App. 3,5,6,9,10,15) |

**Kulcs-szakaszok** (a custodian nyilatkozat ezekre hivatkozik — 5/6/7. pont):
Key generation requirements · Key component storage requirements · Key usage requirements.

## 1.b PCI hivatalos szabványok (bemásolva) — `knowledge/standards/`

| Fájl | Standard | Mire használja az agent |
|---|---|---|
| `PCI-DSS-v4_0_1.pdf` | PCI DSS v4.0.1 | Req 3.6.x / 3.7.x kulcskezelési követelmények forrásszövege (forrásolt Q&A) |
| `PCI_PIN_Security_Requirements_Testing_v3_1.pdf` | PCI PIN Security v3.1 | Req 18 / 28 / 29 — kulcs-custodian, dual control / split knowledge a PIN-kulcsokra |
| `PCI-3DS-Core-Security-Standard-v1.pdf` | PCI 3DS Core | 3DS-kapcsolódó kriptográfiai követelmények (kiegészítő hivatkozás) |

## 2. Sablonok (bemásolva) — `templates/`

| Fájl | Ceremónia / cél |
|---|---|
| `Commissioning_10K.docx` | payShield 10K commissioning + LMK generálás teljes lépéssor (VR/FC/GK/CO/DC/LK) — ez a prototípus `lmk_generation` config forrása |
| `Hand-Take-over.docx` | Key custodian átadás-átvételi jegyzőkönyv |
| `AO-appointment.docx` / `KC-appointment.docx` | Authorization Officer / Key Custodian kinevezés |
| `Key custodian list.docx` | Custodian + backup roster (min. 2+2) |
| `Event log sample.docx` | Secure room / esemény-napló minta |

## 3. Leltárak (bemásolva) — `inventory/`

| Fájl | Tartalom |
|---|---|
| `Key inventory_Ipoteka_to_continue.xlsx` | Élő kulcs-leltár (Ref.Num, Key name, type, exp., strength, transport key, creation date, storage, usage) |
| `Key inventory_Example.xlsx` | Kitöltött minta |
| `Ipoteka_Cryptographic_Inventory_Register_v1.1.xlsx` | Teljes kripto-leltár (CIR-001…), PCI scope mapping, tiltott protokollok, kivétel-register |
| `model/key_inventory.schema.json` + `key_inventory.json` + `DATA_DICTIONARY.md` | **Strukturált kulcs-leltár adatmodell** (a szabad-szöveges xlsx kiváltása): séma, seedelt példány, adatszótár. Kezelő: `prototype/inventory_tool.py` |

## 4. HSM-manuálok (HIVATKOZÁS, nem másolva) — `../../KMDOC/HSM_MANUALS/`

A teljes Thales payShield 10K kézikönyvkészlet (~50 MB), v1.7a:

| Manuál | Mikor kell |
|---|---|
| `...Security Operations V1.7a.pdf` | **Elsődleges** — biztonságos üzemeltetés, dual control, LMK kezelés |
| `...Console Guide V1.7a.pdf` | Konzol-parancsok (FC, GK, CO, DC, LK, LO, VR) |
| `...Core Host Commands V1.7a.pdf` | Host-parancsok (kulcs-generálás/-import éles forgalomban) |
| `...Installation and User Guide V1.7a.pdf` | Telepítés, fizikai biztonság |
| `...Host Command Examples / Programmers / Applications Manual` | Integrációs részletek |
| `payShield Manager Quick Start` | Távmenedzsment (jövőbeli API-integráció alapja) |

## 5. Kapcsolódó projekt-dokumentumok (hivatkozás a gyökérből)

- `Ipoteka_Cryptographic_Inventory_Register_v1.1.xlsx` (gyökér) — kanonikus kripto-leltár
- `Ipoteka_PCI_DSS_Recurring_Tasks_v1.6_EN.xlsx` — a kulcskezelési visszatérő feladatok (rotáció, review) ütemezése
- `GAP_Analysis_PCI_3DS_2026.xlsx` / `findings_IPOTEKA_2026.xlsx` — nyitott kulcskezelési findingök

## 6. Hiányzó / még behozandó források (lásd ARCHITECTURE.md §4)

- ~~PCI DSS v4.0.1 és PCI PIN követelmények szövege~~ → **KÉSZ**, lásd §1.b (`knowledge/standards/`)
- ~~Élő key custodian roster~~ → **KÉSZ**: `inventory/model/custodian_roster.json` + `roster_check.py`
- Tamper-evident boríték-sorszám nyilvántartás
- Secure room beléptető-napló rendszer-export
