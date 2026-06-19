# Key Management / HSM Officer Asszisztens — 1. AI agent

Ipoteka Bank · PCI DSS v4.0.1 (3.6.x / 3.7.x) · PCI PIN Req 18/28/29
A `AI_Agent_Opportunities_PCI_2026.xlsx` 1. sorának megvalósítása.

## Mi ez?
A bank kulcsceremóniáit (LMK generálás/betöltés, kulcsrotáció, kulcs-átadás,
dekomisszió, custodian átadás-átvétel) **vezérlő és auditálhatóan dokumentáló**
human-in-the-loop AI agent. A HSM-műveletet mindig ember hajtja végre — az agent
a dual control / split knowledge / SoD szabályokat kényszeríti ki, és a jegyzőkönyvet
állítja elő.

## Mappa-szerkezet
```
01_Key_Management_HSM_Officer/
├── CLAUDE.md                 # az agent munkaköri leírása (system prompt)
├── ARCHITECTURE.md           # architektúra, integrációk, külső függőségek, roadmap
├── README.md                 # ez a fájl
├── knowledge/
│   ├── KNOWLEDGE_INDEX.md     # mi hol van (forrásdokumentumok indexe)
│   ├── policy/               # Key Management Policy + Requirements v8 (bemásolva)
│   └── standards/            # PCI DSS / PIN szöveg helye (még behozandó)
├── templates/                # ceremónia- és kinevezési sablonok (bemásolva)
├── inventory/                # kulcs- és kriptográfiai leltár (bemásolva)
├── skills/key-ceremony/
│   └── SKILL.md              # a ceremónia-levezető skill
└── prototype/
    ├── ceremony_orchestrator.py   # futtatható orchestrátor (dual control + evidence)
    ├── ceremonies/lmk_generation.json  # LMK-ceremónia gépi playbook
    ├── session.example.json       # minta-session (replay/teszt)
    └── output/                    # generált jegyzőkönyvek (MD + JSON)
```
A nehéz Thales payShield 10K kézikönyveket NEM másoltuk be — hivatkozás:
`../../KMDOC/HSM_MANUALS/`.

## Prototípus futtatása
```bash
cd prototype

# Teszt / demó előre rögzített session-nel:
python3 ceremony_orchestrator.py --ceremony lmk_generation --record session.example.json

# Éles, interaktív levezetés (lépésenként kérdez):
python3 ceremony_orchestrator.py --ceremony lmk_generation
```
A jegyzőkönyv a `prototype/output/` mappába kerül (`*_evidence.md` + `*.json`).

## Mit bizonyít a prototípus
- **Dual control / split knowledge / SoD** gépi kikényszerítése a kezdés előtt
  (hiányzó vagy ütköző szerep → a ceremónia NEM indul).
- **Lépésenkénti human-in-the-loop** vezetés a valós payShield parancsokkal.
- **Titok-szűrés**: PIN / teljes kulcs / komponens soha nem kerül a nyomvonalba.
- **Evidence-first**: auditra kész jegyzőkönyv automatikusan, konzisztensen.

## Következő lépés
Lásd `ARCHITECTURE.md` §6 (roadmap) — a többi ceremónia-playbook, a PCI/PIN szöveg
behozása, majd read-only HSM- és workflow-integrációk.
