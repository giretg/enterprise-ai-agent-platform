# Kulcs-leltár adatmodell — adatszótár

> Strukturált, géppel olvasható kulcs-leltár az 1. AI agenthez.
> Séma: `key_inventory.schema.json` · Példány: `key_inventory.json` · Eszköz: `../../prototype/inventory_tool.py`
> A korábbi szabad-szöveges `Key inventory_*.xlsx` kiváltása.

## Miért kell?
A régi xlsx szabad szöveg: nem validálható, nem köthető a ceremóniákhoz, és nem lehet
rajta automatikus lejárat-figyelést futtatni. A strukturált modell:
- **validálható** (JSON Schema),
- **hierarchikus** (`transport_key_ref` a szülő kulcsra mutat → kulcsfa),
- **életciklus-kötött** (a ceremónia-evidence-re hivatkozik),
- **auditálható és titokmentes** (csak KCV + metaadat, soha nem kulcsanyag).

## Mezők

| Mező | Típus | Leírás | PCI-kötés |
|---|---|---|---|
| `ref_num` | string | Egyedi azonosító (pl. `K0`) | — |
| `key_name` | string | Beszédes név | — |
| `category` | enum | `key_management` / `h2h_interface` / `device` / `application` | scope |
| `key_type` | string | LMK, ZMK, ZCMK, ZPK, KEK, AWK, TMK, BDK, PIN_session, RSA_keypair… | — |
| `algorithm` | enum | 3DES, AES, RSA, ECC | 3.6.1 (erősség) |
| `key_strength_bits` | int/null | Effektív erősség (3DES 2-key = 112) | 3.7.1 |
| `kcv` | string/null | **Key Check Value** — NEM titok, azonosításra | evidence |
| `single_purpose` | string | A kulcs **egyetlen** célja | **PIN Req 19** |
| `transport_key_ref` | string/null | Szülő/transport kulcs `ref_num`-ja → hierarchia | 3.6.1 (KEK lánc) |
| `creation_date` | date/null | Létrehozás | 3.7.1 |
| `cryptoperiod` | string/null | ISO 8601 időtartam (`P6M`, `P2Y`) vagy `n.a.` | **3.7.4** |
| `expiry_date` | date/null | Konkrét lejárat | **3.7.4 / 3.7.5** |
| `storage_locations` | string[] | Hol tárolt (HSM, smartcard, DB…) | 3.6.1 / 3.7.3 |
| `cde_scope` | bool | CDE-n belüli-e | scope |
| `crypto_inventory_ref` | string/null | Link a kripto-leltárhoz (`CIR-xxx`) | 3.6.1.1 |
| `custodians[]` | obj[] | Hozzárendelt custodianok (név, szerep, komponens) | 3.7.6 / 3.7.8 |
| `status` | enum | `active` / `pending` / `retired` / `compromised` / `decommissioned` | 3.7.5 |
| `lifecycle` | obj | Ceremónia-kötések evidence-hivatkozással (lásd lent) | 3.7.x |
| `notes` | string | Szabad megjegyzés | — |

### `lifecycle` almező
`created_by_ceremony`, `created_evidence_ref`, `last_rotation_date`,
`last_rotation_evidence_ref`, `decommission_date`, `decommission_evidence_ref`.
Ezek a `prototype/output/*_evidence.json` jegyzőkönyvekre mutatnak — így minden
kulcs-állapotváltozás **auditálhatóan** vissszavezethető egy ceremóniára.

## Titok-tilalom (kemény szabály)
A séma `additionalProperties: false`, így a `key_value`, `component`, `secret`, `pin`
típusú mezők **elutasításra kerülnek**. A `inventory_tool.py` ezen felül mintázat-
ellenőrzéssel is kiszűri a véletlenül bekerülő kulcs-/PIN-anyagot.

## Hierarchia-példa (a seedelt adatban)
```
K0 (LMK, root)
├── K1 (OFB ZMK) ── K10 (OFB ZPK)
├── K3 (UP ZMK)
└── K6 (POS KEK) ── Pn-m (POS PIN Master / TMK)
An-m (ATM TMK, directly injected)
```

## Munkafolyamat a ceremóniákkal
1. `lmk_generation` / `key_rotation` lefut → `*_evidence.json` keletkezik.
2. `inventory_tool.py --from-evidence <evidence.json>` → **javaslatot** ad az új/
   módosított kulcs-rekordra (KCV, dátum, lifecycle-link kitöltve).
3. Ember jóváhagyja → a rekord bekerül a `key_inventory.json`-be.
4. `inventory_tool.py --report` → lejárat/kriptoperiódus és integritás-riport (3.7.4).
