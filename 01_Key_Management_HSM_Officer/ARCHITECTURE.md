# Architektúra & koncepció — Key Management / HSM Officer Asszisztens

> Ipoteka Bank · PCI DSS v4.0.1 (3.6.x / 3.7.x) · PCI PIN Req 18/28/29
> Társdokumentum a `CLAUDE.md` munkaköri leíráshoz · v0.1 · 2026-06-18

---

## 1. Az agent egy mondatban

Egy **human-in-the-loop** asszisztens, amely a Thales payShield 10K HSM-en végzett
kulcsceremóniákat **vezérli és auditálhatóan dokumentálja** — de magát a kriptográfiai
műveletet mindig ember hajtja végre és hagyja jóvá, a dual control / split knowledge
megsértése nélkül.

## 2. Tervezési pozíció: miért „fél-automata"?

A kulcskezelés a PCI egyik legérzékenyebb területe. A teljes automatizálás itt
**kontraproduktív és szabálysértő** lenne (a 3.7.6 dual control és a PIN Req 18/29 épp
azt írja elő, hogy ne egyetlen entitás kezelje a kulcsot). Ezért az agent értéke nem a
művelet kiváltása, hanem három dolog:

1. **Hibamentes vezetés** — a ceremónia egyetlen lépése sem marad ki, rossz sorrendben.
2. **Kikényszerített kontroll** — dual control / split knowledge / SoD gépi ellenőrzése
   még a kezdés előtt (pre-flight STOP).
3. **Evidence-first nyomvonal** — a jegyzőkönyv automatikusan, konzisztensen, titok
   nélkül készül el, auditra kész.

## 3. Architektúra és adatfolyam

```
        ┌─────────────────────────────────────────────────────────┐
        │  Operátor / Security Officer / Key Custodianok (emberek)  │
        └───────────────▲───────────────────────────┬──────────────┘
                        │ vezérlés, kérdés/válasz    │ kézi végrehajtás
                        │                            ▼
        ┌───────────────┴───────────────┐   ┌──────────────────────┐
        │  Key Mgmt / HSM Officer Agent  │   │  Thales payShield 10K │
        │  (CLAUDE.md + key-ceremony     │   │  HSM (konzol/Manager)  │
        │   skill + orchestrátor)        │   └──────────────────────┘
        └───┬───────┬───────┬───────┬────┘     ▲ az agent NEM ad ki
            │       │       │       │           parancsot — csak vezet
   ┌────────▼─┐ ┌───▼────┐ ┌▼──────┐ ┌▼─────────────┐
   │knowledge │ │templates│ │inventory│ │ evidence out │
   │(policy,  │ │(ceremónia│ │(kulcs- │ │ (MD + JSON,  │
   │ requir.  │ │ sablonok)│ │ kripto-│ │  aláírásra   │
   │ HSM man.)│ │          │ │ leltár)│ │  kész)       │
   └──────────┘ └─────────┘ └────────┘ └──────────────┘
```

Folyamat (a `key-ceremony` skill szerint): kiválasztás → **pre-flight STOP** (dual
control/SoD + eszköz-state) → lépésenkénti levezetés (parancs → emberi végrehajtás →
eredmény-rögzítés → megerősítés) → lezárás (boríték-sorszám, aláírás) → **evidence**.

## 4. Külső / még nem létező függőségek

Az alábbiak ahhoz kellenek, hogy az agent a mostani „offline vezérlő + dokumentáló"
szintről magasabb integrációs szintre lépjen. Prioritás szerint:

### 4.1 Most hiányzó, de a prototípushoz is hasznos (gyorsan pótolható)
- ~~**PCI DSS v4.0.1 + PCI PIN követelményszöveg**~~ → **KÉSZ**: `knowledge/standards/`
  (PCI DSS v4.0.1, PCI PIN v3.1, PCI 3DS Core). A forrásolt Q&A-hoz az indexelésük
  (chunkolás/kereshetővé tétel) a következő lépés.
- ~~**Élő key custodian roster**~~ → **KÉSZ**: `inventory/model/custodian_roster.json`
  (+ séma), ellenőrző: `prototype/roster_check.py` (SoD/dual control konfliktus-riport).
  ⚠️ A jelenlegi roster **2 MAGAS súlyosságú SoD-konfliktust** tartalmaz — lásd lent.
- **Tamper-evident boríték-sorszám nyilvántartás** (ma kézi). Egy egyszerű register-fájl
  is elég a kezdéshez.
- ~~**Strukturált kulcs-leltár adatmodell**~~ → **KÉSZ**: `inventory/model/`
  (JSON Schema + seedelt példány + adatszótár), kezelő: `prototype/inventory_tool.py`
  (validáció, lejárat-riport 3.7.4, hierarchia, evidence→leltár javaslat).

### 4.2 Rendszer-integrációk (a fél-automata szint kiteljesítése)
- **HSM read-only telemetria** (payShield Manager API / SNMP / konzol-log): az agent
  *ellenőrizni* tudja a `VR`-állapotot, LMK-státuszt, KCV-t — de **továbbra sem ad ki
  parancsot**. Least-privilege, csak olvasás.
- **Kriptográfiai leltár élő összekötése** (`Ipoteka_Cryptographic_Inventory_Register`):
  kulcs-lejárat / rotáció automatikus figyelése a `Recurring_Tasks` mátrixból.
- **Jira / ticketing**: ceremónia ütemezése, jóváhagyási workflow, a kész jegyzőkönyv
  csatolása a tickethez.
- **SIEM**: az agent minden műveletének naplózása (audit log a 10.x-hez).
- **Naptár (Outlook)**: kulcs-lejárati és review-emlékeztetők.
- **Evidence-tár (SharePoint/Box)**: a jegyzőkönyvek verziózott archiválása.
- **E-aláírás**: a custodian-nyilatkozat és a jegyzőkönyv digitális aláírása (3.7.8).

### 4.3 Még nem létező artefaktumok, amiket létre kell hozni
- **Gépi ceremónia-playbookok**: KÉSZ — mind az 5 típus megvan
  (`lmk_generation`, `key_rotation`, `key_transfer`, `key_decommission`,
  `custodian_handover`), a `Commissioning_10K.docx` és a `Keymanagement requirements v8.docx`
  §6–§8 + App. 8/11–15 alapján.
- **Strukturált kulcs-leltár adatmodell** (a `Key inventory_*.xlsx` ma szabad szöveg).
- **Szerep–személy mátrix** SoD-szabályokkal (ma az ütköző párok a kódban vannak).

## 5. Biztonsági korlátok (nem tárgyalható)
- Az agent **soha** nem csatlakozik a HSM-hez parancskiadásra, és **soha** nem rögzít
  PIN-t, teljes kulcsot vagy komponenst (a prototípus aktívan kiszűri — lásd `FORBIDDEN_PATTERNS`).
- A CDE-ben az agentre ugyanazok a scope-/hozzáférés-/naplózási szabályok vonatkoznak,
  mint bármely más rendszerkomponensre.
- Minden PCI-kritikus döntés (kompromittálás, visszavonás, leltár-írás) emberi jóváhagyással.

## 6. Továbbfejlesztési roadmap

| Fázis | Tartalom | Eredmény |
|---|---|---|
| **0 — Prototípus (kész)** | CLAUDE.md, key-ceremony skill, orchestrátor (dual control + evidence), mind az 5 ceremónia-playbook | Offline vezérlő + auditálható jegyzőkönyv minden ceremónia-típusra |
| **1 — Tudás teljessé tétele** | PCI/PIN szöveg + index (kész), strukturált kulcs-leltár modell (kész), élő custodian roster (hátravan) | Forrásolt Q&A + adatvezérelt lejárat-figyelés |
| **2 — Read-only integráció** | payShield Manager API (csak olvasás), kripto-leltár + Recurring Tasks összekötése, lejárat-figyelés | Az agent ellenőrzi az állapotot és proaktívan jelez |
| **3 — Workflow-integráció** | Jira (ütemezés/jóváhagyás), SharePoint (evidence-archív), SIEM-naplózás, Outlook-emlékeztetők, e-aláírás | Zárt, auditálható folyamat — végponttól végpontig |
| **4 — Skálázás** | A minta más PCI-agentekre (Daily Log Review, TRA, Access Review…) — közös evidence/HITL keret | Egységes AI compliance agent-platform |

## 7. Hogyan kapcsolódik a többi agenthez
Az evidence-first + human-in-the-loop minta (pre-flight ellenőrzés → vezérelt lépések →
auditálható jegyzőkönyv) **újrafelhasználható** a `AI_Agent_Opportunities_PCI_2026.xlsx`
többi agentjéhez. Ez az 1. agent egyúttal a közös keret referencia-implementációja.
