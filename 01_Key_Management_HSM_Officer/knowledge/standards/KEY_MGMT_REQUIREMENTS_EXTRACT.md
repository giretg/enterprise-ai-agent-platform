# Kulcskezelési követelmény-kivonat (forrásolt Q&A-hoz)

> Az agent **kizárólag forrásolt** választ adhat. Ez a kivonat a három hivatalos PCI
> szabványból emeli ki a kulcskezelésre vonatkozó követelményeket, követelmény-ID +
> oldalszám hivatkozással. A teljes szöveg a `knowledge/standards/` PDF-jeiben.
>
> Forrás-PDF-ek: `PCI-DSS-v4_0_1.pdf` (v4.0.1, 2024.06) · `PCI_PIN_Security_Requirements_Testing_v3_1.pdf` (v3.1, 2021.03) · `PCI-3DS-Core-Security-Standard-v1.pdf` (v1.0, 2017.10)
> Gépi index: `requirements_index.json`. Kivonat készült: 2026-06-18.

⚠️ **Pontosítás:** a kulcs-custodian nyilatkozat a PCI DSS v4.0.1-ben a **3.7.8**
követelmény (a korábbi „3.7.9" hivatkozás téves volt — a 3.7 alkövetelmények 3.7.1–3.7.8-ig
tartanak, nincs 3.7.9). A többi dokumentumban is javítva.

---

## A) PCI DSS v4.0.1 — Requirement 3.6 / 3.7 (kulcskezelés)

### 3.6 — Kulcsok védelme (kulcs-tárolás)

**3.6.1** *(p.99)* — Eljárások a tárolt számlaadatot védő kulcsok kiszivárgás és
visszaélés elleni védelmére, amelyek tartalmazzák:
- a kulcsokhoz való hozzáférés a lehető legkevesebb custodianra korlátozva;
- a key-encrypting key (KEK) legalább olyan erős, mint a vele védett data-encrypting key (DEK);
- a KEK a DEK-től **elkülönítve** tárolva;
- a kulcsok a lehető legkevesebb helyen és formában, biztonságosan tárolva.

**3.6.1.1** *(p.100, csak szolgáltatóknak)* — Dokumentált kriptográfiai architektúra:
minden algoritmus/protokoll/kulcs részletei (kulcs-erősség, lejárat), és a production/test
környezetben **ugyanazon kulcs használatának megakadályozása**.

> Leképezés az agentre: a `lmk_generation`, `key_transfer` pre-flight és a leltár-figyelés
> (least privilege, elkülönített tárolás, KCV-nyilvántartás).

### 3.7 — Kulcs-életciklus eljárások

| ID | Oldal | Követelmény (kivonat) |
|---|---|---|
| **3.7.1** | p.105 | Erős kriptográfiai kulcsok **generálása**. |
| **3.7.2** | p.105 | Kulcsok **biztonságos elosztása** — csak felhatalmazott custodianoknak (3.6.1.2), soha nem bizonytalan módon. |
| **3.7.3** | p.106 | Kulcsok **biztonságos tárolása** (pl. HSM-ben; titkos/privát kulcs soha nem forráskódban). |
| **3.7.4** | p.107 | **Kulcscsere a kriptoperiódus végén** — minden kulcstípusra definiált kriptoperiódus + cserefolyamat. |
| **3.7.5** | p.108 | Kulcs **retirement / replacement / destruction**, ha: lejárt a kriptoperiódus; gyengült a kulcs integritása (pl. cleartext-komponenst ismerő személy távozik); gyanús a kompromittálás. |
| **3.7.6** | p.109 | **Manuális cleartext** kulcsművelet esetén: **split knowledge ÉS dual control** kötelező. |
| **3.7.7** | p.110 | A kulcsok **jogosulatlan cseréjének** (substitution) megakadályozása. |
| **3.7.8** | p.110 | A kulcs-custodianok **formális (írásos/elektronikus) nyilatkozata**, hogy ismerik és elfogadják a felelősségüket. |

> Leképezés a ceremóniákra: 3.7.1→`lmk_generation`, 3.7.2/3.7.3→`key_transfer`,
> 3.7.4→`key_rotation`, 3.7.5→`key_decommission`, 3.7.6→**minden** ceremónia pre-flight
> (dual control / SoD), 3.7.7→boríték-sorszám ellenőrzés, 3.7.8→`custodian_handover` nyilatkozat.

---

## B) PCI PIN Security v3.1 — kulcskezelési követelmények

**Requirement 18** *(p.165)* — Eljárások a kulcsok **jogosulatlan cseréjének és
visszaélésének** megelőzésére/észlelésére, illetve annak megakadályozására, hogy
kriptográfiai eszköz legitim kulcsok nélkül működjön. (18-2: a tamper-jeleket mutató
komponens-csomagolás/konténer használatának megelőzése — köti a boríték-ellenőrzést.)

**Requirement 19** *(p.165)* — A kulcs kizárólag a **saját, egyetlen céljára** használható,
és soha nem osztható meg production és test rendszerek között. *(Releváns: „egy kulcs = egy cél".)*

**Requirement 28** *(p.185)* — Minden **kulcs-adminisztrációs műveletre** dokumentált
eljárásnak kell léteznie és bizonyíthatóan használatban kell lennie.

**Requirement 29** *(p.186)* — PIN-feldolgozó eszköz (POI, HSM) **csak akkor helyezhető
üzembe**, ha biztosított, hogy nem cserélték ki / nem módosították / nem manipulálták —
a kulcsbetöltés előtt és után is —, és minimalizálták a kompromittálás veszélyét.

> Leképezés az agentre: Req 18/19 → pre-flight (tamper-ellenőrzés, egy kulcs egy cél);
> Req 28 → maga az evidence-first jegyzőkönyv minden műveletről; Req 29 → `VR` eszköz-
> ellenőrzés a `lmk_generation`/`key_rotation` 1. lépésében.

---

## C) PCI 3DS Core v1.0 — kapcsolódó hivatkozás

A 3DS Core a 3DS rendszerkomponensek (ACS, DS, 3DS Server) kriptográfiai védelmét írja elő;
a kulcskezelésnél a fenti PCI DSS 3.6/3.7 elvekre épít. Az Ipoteka 3DS-scope-jában lévő
kulcsokra ugyanezek a ceremónia- és evidence-szabályok érvényesek. Részletek:
`PCI-3DS-Core-Security-Standard-v1.pdf`.

---

*Megjegyzés: a fenti idézetek tömörített, magyar nyelvű kivonatok az auditálható
hivatkozáshoz. Jogi/audit célra mindig a `knowledge/standards/` PDF-ek angol eredeti
szövege az irányadó (az oldalszámok a PDF belső számozására utalnak).*
