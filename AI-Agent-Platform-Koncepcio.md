# Kontrollált Enterprise AI Agent Platform — Koncepció

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.1 — belső koncepció
**Dátum:** 2026-06-12
**Státusz:** Vitaanyag prototípus-tervezéshez

> A fejezetek elején **"Közérthetően"** dobozok segítenek azoknak, akik nem járatosak az AI-agentek világában: ezek egyszerű nyelven, hasonlatokkal mondják el, miről szól az adott rész. Az alábbi fogalomtár a leggyakoribb szakszavakat magyarázza.

---

## 0. Fogalmak röviden (akinek újak az AI-agentek)

- **AI-agent (AI-munkatárs):** olyan AI-program, amely nem csak válaszol, hanem *feladatokat is elvégez* (pl. elolvas egy számlát, javaslatot készít, létrehoz egy feladatot). Úgy érdemes elképzelni, mint egy digitális alkalmazottat.
- **Prompt (alapprompt):** az az utasítás/leírás, amely megmondja az AI-munkatársnak, ki ő és mi a dolga — gyakorlatilag a "munkaköri leírása".
- **Memória / tudás:** amit az AI-munkatárs "tud" a feladatáról; ez frissíthető (tanítható), de nálunk csak ellenőrzött módon.
- **Token:** az AI-használat elszámolási egysége — leegyszerűsítve minden AI-"gondolkodás" tokenbe, azaz **pénzbe** kerül. Ezért fontos, hogy az AI ne fusson feleslegesen.
- **Ticket:** egy feladatkártya egy táblán (mint a Trello/Jira), amelyen a munka látható és követhető.
- **Control plane (irányítóközpont):** az 1. alkalmazás — az őrzött rész, amely a szabályokat, jogosultságokat és naplózást kezeli.
- **Sandbox / execution plane (munkatér):** a 2. alkalmazás — a szabad rész, ahol a tényleges munka zajlik.
- **Governance:** "kormányzás" — annak biztosítása, hogy minden szabályozottan, ellenőrizhetően és naplózva történjen.
- **Audit / audit-log:** visszakereshető napló mindenről, ami történt — ez bizonyítja utólag, ki mit csinált.
- **Human-in-the-loop:** "ember a hurokban" — a fontos döntéseket ember hagyja jóvá, mielőtt élesben megtörténnének.
- **API-kulcs:** egyfajta digitális belépőkártya, amellyel egy program (vagy AI-munkatárs) hozzáfér a rendszerhez.
- **RAG (knowledge base):** módszer, amellyel az AI egy dokumentum-/tudásbázisból keres ki releváns információt, mielőtt válaszol.
- **Prompt injection:** támadás, amikor egy feldolgozandó szövegbe (pl. egy számlába) rejtett utasítást csempésznek, hogy az AI-t félrevezessék.

---

## 1. Vezetői összefoglaló

> **Közérthetően:** Két webes alkalmazást építünk. Az első egy szigorúan őrzött "irányítóközpont", amely felügyeli, mit csinálhatnak az AI-"munkatársak", és mindent naplóz. A második egy szabad "munkatér", ahol ezek az AI-munkatársak a tényleges feladatokat végzik. A lényeg: a szabályok és az ellenőrzés egy zárt helyen vannak, a tényleges munka pedig egy rugalmas helyen — így a megoldás egyszerre biztonságos és testreszabható.

A koncepció lényege egy **kétrétegű AI agent platform**, amely szétválasztja a *kormányzást* (governance) és a *végrehajtást* (execution):

1. **Control Plane — "AI Governance & Orchestration Hub"** (1. alkalmazás)
   Egy szigorúan kontrollált, általunk szállított és karbantartott alkalmazás, amely a Kanban-board / ticket modellen keresztül vezérli az AI agentek és emberek munkáját. Itt történik minden hozzáférés-kezelés, jogosultságkezelés, naplózás, audit, agent-életciklus-menedzsment, tanítás és többszintű jóváhagyás. Ez a platform a vállalat **megbízhatósági és megfelelőségi (compliance) garanciája**: nem módosítható kontrollálatlanul, minden agent-interakció és tanulási esemény auditálható.

2. **Execution / Sandbox Plane — "Agent Workspace"** (2. alkalmazás)
   Egy ügyfélre szabott, szabadon továbbfejleszthető környezet, amelyben az 1. alkalmazásban definiált agentek API-n keresztül ténylegesen dolgoznak: dashboardokat, adatbázisokat, funkciókat kezelnek. Ezt az ügyfél, az agentek és mi is fejleszthetjük — itt jön létre a tényleges, testreszabott üzleti érték.

A **kulcsgondolat**: a kontroll és az audit egy zárt, nem-módosítható rétegben él, miközben az üzleti érték és az innováció egy nyitott, rugalmas rétegben születik. A kettő szándékosan külön van választva — ez teszi a megoldást egyszerre **enterprise-grade-dé és eladhatóvá**.

### 1.1 Három pillér

A platform értékét **három pillér** adja, nem kettő:

1. **Kontroll (Control Plane)** — a governance, audit és jogosultság zárt, nem-módosítható magja (4. fejezet).
2. **Végrehajtás (Execution Plane)** — az ügyfélre szabott, szabadon fejleszthető munkatér, ahol a tényleges üzleti érték keletkezik (5. fejezet).
3. **Integráció** — a meglévő vállalati rendszerekhez (ERP, könyvelés, e-mail, dokumentumtár, adatbázis, bank/PSP-API) való kapcsolódás (4.12). Ez nem külön réteg, hanem egy **first-class, újrahasznosítható képesség**: *egyszer integrálunk, minden agent használja*. Enterprise (és mid-market) környezetben az érték nagy része nem az agent "okosságából", hanem abból jön, hogy az agent **eléri és összeköti a már meglévő rendszereket** — rendszercsere nélkül. A korábbi kétrétegű architektúra ettől nem változik; az integráció a két réteget átfogó, governance alá vont képesség.

---

## 2. Stratégiai pozicionálás

> **Közérthetően:** Itt azt tisztázzuk, kinek és miért adjuk el ezt. Nem a nagy bankoknak (ők erősek AI-ban, és nehéz hozzájuk bejutni), hanem a közepes cégeknek, akiknek van valós problémájuk és adatuk, de nincs saját AI-csapatuk. A fő ígéretünk nem az, hogy "az AI okos", hanem hogy "az AI nálunk megbízható, ellenőrzött és számonkérhető".

Ez nem "GenAI demo" és nem egy újabb chatbot. A termék lényege a **kontrollált, auditálható autonómia**: az enterprise ügyfeleknél (különösen szabályozott iparágakban — bank, fizetés, biztosítás) az AI bevezetés fő gátja nem a modellképesség, hanem a **bizalom, az audit, a jogosultságkezelés és a megfelelőség** hiánya.

A platform pontosan erre a fájdalompontra válaszol:

- **Minden agent-művelet attribútálható és naplózott** (ki, mit, mikor, milyen modellel, milyen adat alapján).
- **Az agentek nem tanulnak és nem módosulnak kontroll nélkül** — a tanulás külön, jóváhagyott folyamat.
- **A hozzáférés finom granularitással menedzselt** — agent- és ember-szinten egyaránt.
- **A magas kockázatú döntések ember elé kerülnek** (human-in-the-loop), konfigurálható jóváhagyási láncokkal.

### Célszegmens (ICP) — nem a tier-1 bankok

**A fő célpont nem a nagybank.** A nagy bankok erősek AI-ban, van saját szakembergárdájuk, specializált beszállítóik és kemény beszerzésük — egy kis, rugalmas tanácsadónak rossz belépő. A valódi rés a **közép- (és kisebb nagy-) vállalati szegmens**, amelynek:

- **van** valós üzleti fájdalma és adata (dokumentum-feldolgozás, reconciliation, back-office),
- **nincs** belső AI-kompetenciája és nincs is rá külön beszállítója,
- **gyorsan** akar kézzelfogható eredményt, nem többéves enterprise programot.

Itt egy **fürge tanácsadó** gyorsabban szállít, mint egy nagy integrátor. A fizetési fókusz ettől nem vész el: a **kisebb PSP-k és fintechek** pont ilyenek — fizetési adat és fájdalom megvan, nagy AI-csapat nincs.

**Deployment-következmény:** az **alapértelmezett út a gyorsan deployolható, megbízható felhő** (nem kompromisszum, hanem a szegmenshez illő, helyes választás). A **bank-szintű / on-prem felépítés az upgrade-path**, nem a kiindulás. Fontos azonban: a "nem bank" nem "nulla megfelelőség" — GDPR, ügyféladat-védelem, B2B-nél akár SOC2-elvárás itt is van, ezért a felhőnek is **elfogadható biztonsági alapszintet** kell adnia, és a **governance/audit sztori marad a fő differenciátor** — csak a deployment felhő-alapértelmezett.

### Üzleti / értékesítési modell

A kétrétegű felépítés természetes módon ad **kétféle bevételi forrást**:

| Réteg | Jellege | Bevételi modell |
|---|---|---|
| Control Plane (1. app) | Termékesített, újrahasznosítható platform | Licenc / SaaS / éves előfizetés + támogatás |
| Execution Plane (2. app) | Ügyfélspecifikus, testreszabott | Tanácsadói / fejlesztői projektbevétel (professional services) |

Ez egészséges felállás: a platform ismételhető és skálázható, a sandbox pedig magas marzsú, ügyfélre szabott munka.

---

## 3. Rendszerarchitektúra áttekintés

> **Közérthetően:** Ez az ábra madártávlatból mutatja a két alkalmazást és azt, hogyan kommunikálnak. A felső doboz az őrzött irányítóközpont (1. app), az alsó jobb doboz a munkatér (2. app). Az AI-munkatársak egy API-kulccsal — egyfajta belépőkártyával — érik el a rendszert, és minden mozdulatuk naplózódik.

```
┌──────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE — "AI Governance & Orchestration Hub" (1. app)      │
│  Általunk szállított, zárt, auditált. Kontrollált változtatás.     │
│                                                                    │
│   • Kanban board / Ticket motor (állapotgép)                       │
│   • Agent Registry & életciklus (verziózott)                       │
│   • Identity & Access Management (ember + agent)                   │
│   • Policy / jogosultság motor (ki mit tehet, mi kire tehető)      │
│   • Tanítási csatorna (memória-frissítés jóváhagyással)            │
│   • Audit log (append-only, tamper-evident)                        │
│   • Model Gateway (külső API / lokális modell absztrakció)         │
│   • Observability & eval (token, költség, guardrail, minőség)      │
└───────────┬───────────────────────────────────────┬──────────────┘
            │  REST/Eseményvezérelt API (scoped key)  │
            │  - board olvasás / ticket írás          │
            │  - minden hívás naplózva + policy-check  │
            ▼                                         ▼
┌────────────────────────┐              ┌───────────────────────────┐
│  AGENT RUNTIME          │              │  EXECUTION / SANDBOX (2.app)│
│  (a) belső, megbízható  │              │  Ügyfélre szabott munkakörny│
│  (b) külső, pl. Cowork   │─────────────▶│  • dashboardok, adatbázisok │
│      (csak teszt célra) │   dolgozik   │  • feltöltött dokumentumok  │
└────────────────────────┘    rajta      │  • agent által fejleszthető │
                                          │  • saját access + log       │
                                          └───────────────────────────┘
```

---

## 4. Control Plane — 1. alkalmazás részletei

> **Közérthetően:** Ez a fejezet az "irányítóközpontot" írja le — azt az alkalmazást, amit mi szállítunk és szigorúan kontrollálunk. A feladata, hogy minden AI-munkatárs csak azt tehesse, amit szabad, mindent naplózzon, és semmi ne történjen ellenőrizetlenül. Ez a cég biztonsági és megfelelőségi garanciája. A következő alfejezetek ennek az egyes részeit veszik sorra.

### 4.1 Cél

A vállalat **enterprise-szintű elvárásainak garantálása**: minden agent-interakció naplózott, minden tanítás auditált, minden hozzáférés menedzselt. Ez az alkalmazás a megbízhatóság horgonypontja, ezért **csak szigorúan kontrollált körülmények között — általunk, a szállítóként — módosítható**.

### 4.2 Ticket-modell (a board mint univerzális interfész)

> **Közérthetően:** A "ticket" egy feladatkártya — olyan, mint egy Trello- vagy Jira-kártya. Minden munka, akár emberé, akár AI-é, ilyen kártyaként jelenik meg egy közös táblán. Ez azért jó, mert így minden feladat egy helyen látható, követhető és naplózható — nincs "láthatatlan" AI-tevékenység.

Minden munka — emberé és agenté egyaránt — **ticketként** jelenik meg a Kanban-boardon. A ticket az egyetlen, naplózott interakciós felület. Két alapvető tickettípus:

- **Interakciós (munka-) ticket:** az agent végrehajt egy feladatot, de **nem módosíthatja önmagát** belőle. Tisztán "olvasd a kontextust → cselekedj → naplózz" minta.
- **Tanítási ticket (speciális):** kizárólag ez frissítheti az agent memóriáját / tudását. Külön típus, külön jóváhagyási lánccal és külön naplóval.

A ticketek **szerveroldali állapotgépen** mozognak (pl. `Backlog → In Review → Approved → In Progress → Awaiting Human → Done`). Az engedélyezett állapotátmeneteket és tickettípusokat az **admin felület** konfigurálja — nem az agent dönti el, hová léphet egy ticket.

### 4.3 Admin felület — paraméterezés

Az adminban konfigurálható:

- **Tickettípusok** és azok engedélyezett **állapotai / átmenetei**.
- **Hozzárendelési szabályok:** melyik tickettípus kire (ember/agent/szerep) tehető rá. Pl. *fejlesztési ticket csak X emberre tehető rá, akinek jóvá kell hagynia, mielőtt fejlesztő agenthez kerül.*
- **Jóváhagyási láncok** (multi-level approval) tickettípusonként.
- **Jogosultságok:** ki paraméterezhet, ki hozhat létre tickettet, ki hagyhat jóvá, ki láthat naplót.

### 4.4 Identity & Access Management (ember + agent)

> **Közérthetően:** Itt arról van szó, hogy ki kicsoda a rendszerben, és ki mit csinálhat. Az embereknél ez a megszokott belépés (felhasználónév / céges SSO). Az AI-munkatársaknak is van saját "személyazonosságuk" — mint egy alkalmazotti belépőkártya —, hogy minden tettük egyértelműen hozzájuk legyen köthető, és utólag is vissza lehessen nézni, ki mit csinált.

- **Emberi identitás:** ideálisan a vállalat saját IAM-jéhez kötve (SSO / SCIM), szerepköralapú jogosultság (RBAC).
- **Agent-identitás:** minden agent egy **service account**-szerű identitás, saját jogosultságkészlettel (mihez fér hozzá, milyen tickettet hozhat létre, milyen eszközöket hívhat). Minden agent-művelet **non-repudiation** elven naplózott: visszavezethető konkrét agentre és annak konkrét verziójára.

#### 4.4.1 Auth-provider választás (prototípus → on-prem)

A humán authentikációra a javaslat **kétlépcsős**, a platformfüggetlenség-döntéssel (8.7) összhangban:

| Szakasz / ügyfél | Megoldás | Indok |
|---|---|---|
| Prototípus + hostolt / nem szabályozott ügyfél | **Clerk** | Gyors Next.js-integráció, kész UI, már ismert (posnavigator). Enterprise SSO (SAML/OIDC) + SCIM a cég IdP-jéhez (Entra/Azure AD, Okta, Google) köthető |
| Bank / pénzügyi / on-prem | **Keycloak** (alt.: Zitadel) | Self-hostolható, SAML IdP **és** SP (upstream IdP brókerelés), LDAP/AD, SCIM, az identitásadat a cég kontrollhatárán belül marad |

**Két architekturális szabály, hogy a csere fájdalommentes legyen:**

1. **Humán auth standard OIDC-absztrakció mögött** → a Clerk ↔ Keycloak csere ne igényelje az app újraírását. (A Clerk **nem self-hostolható**, ezért on-premre eleve nem alkalmas.)
2. **Agent-authz NEM a külső auth-providerben.** Az agentek nem humán felhasználók, hanem API-kulcsos service account-ok (4.4, 4.9) → a finomszemcsés jogosultság (ticket-jogok, erőforrás-hozzáférés, jóváhagyási láncok) a **saját control plane-ben** él. Előny: a Clerk per-MAU díja csak az emberekre vonatkozik (az agentek nem drágítják), és a governance-logika auditálhatóan nálunk marad.

*(Megjegyzés: a Clerk SAML/SCIM tier-besorolása a források szerint ellentmondó és gördülő kiadásban van — éles döntés előtt a friss árazás közvetlen ellenőrzése szükséges.)*

### 4.5 Agent Registry & életciklus

> **Közérthetően:** Itt "születik meg" egy AI-munkatárs. Megadjuk, mi a feladata, mihez férhet hozzá, melyik AI-modellt használja. És akárcsak egy alkalmazottnál, itt is van életciklus: felvétel, betanítás, munkába állás, felügyelet, és ha kell, "nyugdíjazás". Minden korábbi változata el van mentve, hogy később pontosan vissza lehessen nézni, melyik verzió mit csinált.

Egy AI munkatárs létrehozása itt történik. Egy agent rekord tartalmazza:

- nevét, szerepét, feladatleírását (system prompt / instrukció),
- jogosultságkészletét (mihez fér hozzá a boardon és a 2. appban),
- **modell-konfigurációját** (lásd 4.7),
- memória-/tudásállapotát (verziózva),
- API-kulcsait (scoped, rotálható).

Az életciklus: **Létrehozás → Konfiguráció → Teszt/Eval → Élesítés → Monitorozás → Nyugdíjazás.** Minden agent **verziózott**: bármely lezárt ticketre visszakereshető, melyik agent-verzió, milyen modellel, milyen memóriaállapottal dolgozott (reprodukálhatóság).

### 4.6 Tanítás és memória — jóváhagyott tudásfrissítés

> **Közérthetően:** Hogyan "tanul" egy AI-munkatárs? Úgy, hogy frissítjük a tudását (a "memóriáját"). Ez kényes pont: ha bárki, bármikor, ellenőrzés nélkül átírhatná, a munkatárs megbízhatatlanná válna. Ezért nálunk a tanulás olyan, mint egy hivatalos dokumentum módosítása: javaslat születik, valaki jóváhagyja, és csak utána lép életbe — ráadásul bármikor visszavonható, ha mégsem vált be.

A tanítás a platform legérzékenyebb és legértékesebb mechanizmusa, ezért kontrollált:

1. Egy **tanítási ticket** *javasolt* tudásfrissítést hordoz (új tény, szabály, példa, korrekció).
2. A javaslat **nem kerül azonnal élesbe** — a memória **verziózott**, a frissítés egy *diff* (mi változna).
3. A diff **jóváhagyási láncon** megy át (ember vagy magasabb jogú szerep), opcionálisan **eval-kapun** (a frissített agent nem romlik-e egy tesztkészleten).
4. Jóváhagyás után a memória új verzióra promótálódik; **bármikor visszagörgethető** (rollback).

Ez egyszerre véd a **memória-mérgezés** (prompt/knowledge poisoning) ellen és ad teljes auditnyomot a "hogyan tanult az agent" kérdésre — ami szabályozott környezetben aranyat ér.

#### 4.6.1 Memória-írás zárolása szerveroldali aláírt tokennel (write-gate)

A memória felülírása **csak a platform által, kontrollált csővezetéken** történhet — soha nem egy agent saját döntéséből, és főleg nem egy külső beszélgetés/prompt hatására. A mechanizmus:

- Amikor a platformon **tanítási ticket** jön létre, az alkalmazás **maga generál** hozzá egy **egyedi, egyszer használatos, aláírt tokent** (write-gate kód), amely **az adott ticketre és az adott memória-verzióra van kötve**.
- A memória-író szolgáltatás **csak ezt a tokent fogadja el**: token nélkül (vagy hibás/lejárt/már felhasznált tokennel) **nem ír memóriát**. Így egy másik forrásból ("tanulj meg ezt…" típusú külső prompt) **nem lehet** az agentet tanulásra rávenni.
- **Kulcsfontosságú finomítás (biztonsági okból):** a tokent **a platform tartja szerveroldalon**, az agent **nem birtokolja és nem adja tovább** — különben egy prompt injection ki tudná csalni vagy újra le tudná játszani. A modell legfeljebb *javasol* egy tudásfrissítést (tartalom), de a **tényleges írást a platform végzi**, miután a javaslat átment a jóváhagyáson, és a platform a saját tokenjével engedélyezi.
- A token **egyszer használatos** és **a jóváhagyott diffhez kötött** — így a write nem hamisítható és nem ismételhető.

> Gyakorlatban: a "titkos kód" = a platform által kiállított, aláírt, egyszer használatos *capability*, amely egy konkrét, jóváhagyott tanítási tickethez és memória-verzióhoz tartozik. Ez teszi a tanulást **nem hamisíthatóvá** — pontosan az a garancia, ami egy banknak kell.

### 4.7 Model Gateway — modellabsztrakció

> **Közérthetően:** A "Model Gateway" egy univerzális adapter az AI-motorok felé. Az AI-munkatárs nem közvetlenül beszél a háttérben dolgozó AI-modellel (pl. Claude, vagy egy saját, helyben telepített modell), hanem ezen az adapteren keresztül. Előnye: bármikor lecserélhető, melyik modellt használja (akár külső, akár saját), és egy helyen mérhető a költség, valamint itt kényszeríthetők ki a biztonsági szűrők.

Az agentek **nem közvetlenül** hívnak modellt, hanem egy belső **Model Gateway**-en keresztül. Ez:

- absztrahálja, hogy az adott agent **külső API**-t (pl. Claude, OpenAI) vagy **lokálisan telepített modellt** használ-e,
- agentenként konfigurálható (API-kulcs, modell, paraméterek),
- **központilag naplózza** a prompt/response párokat, a token- és költségadatokat,
- egységesen alkalmazza a **guardrail**-eket (PII-szűrés, tiltott tartalom, kimeneti validáció).

A végcél: nagyvállalatnál egy **külön szerverre telepített, csak a cég számára elérhető lokális modell**, amelyhez senki külső nem fér hozzá az adatokkal. A Gateway teszi lehetővé, hogy ugyanaz az agent külső modellről átálljon lokálisra a kód módosítása nélkül.

### 4.8 Külső agent-runtime (teszt opció)

Tesztelési célból az agent **futtatókörnyezete lehet a platformon kívül** (pl. egy laptopon futó Claude Cowork agent). Ekkor:

- a platformon létrehozzuk az agentet, és **scoped API-kulcsot** generálunk neki,
- a külső agent ezzel a kulccsal **olvas a boardról** és **hozhat létre tickettet**,
- pl. egy tanítási ticket beolvasásával "tanul".

**Fontos korlát (lásd 8.3):** a külső runtime esetén csak a *board-interakciók* auditálhatók, az agent belső működése (milyen eszközöket hív, milyen adatot lát) nem. Ezért ez **kizárólag demó / fejlesztői-teszt** minta — **soha nem éles enterprise működés**.

**Miért tartjuk mégis a koncepcióban (egyelőre):** az API-alapú éles agent **drága** futtatni. Egy Cowork-előfizetés viszont **olcsón** kipróbálható, és kiválóan alkalmas arra, hogy egy use case-t fejlesztői szinten validáljunk, mielőtt a tényleges, API/lokális-modell alapú agentet felépítjük belőle. Tehát a Cowork-runtime szerepe: **olcsó fejlesztői prototípus → ebből épül a valódi agent.** Megfontolandó opció, hogy éles termékből **teljesen kivesszük**, és csak az API-alapú modellt tartjuk meg — ez a demó/teszt-igény vs. egyszerűség mérlegelése.

---

### 4.9 Agent-anatómia és erőforrás-modell

> **Közérthetően:** Egy AI-munkatárs nem egyetlen darab, hanem több részből áll össze — mint egy alkalmazott, akinek van munkaköri leírása, tudása, és vannak eszközei: kulcsok, dokumentumok, hozzáférések. Ebben a fejezetben azt írjuk le, hogyan kezeljük ezeket az "eszközöket" (erőforrásokat) külön-külön, és hogyan osztjuk ki őket az egyes AI-munkatársaknak — van, amit többen is használhatnak (pl. egy közös szabályzat), és van, ami csak egyvalakié (pl. egy jelszó).

Egy agent nem monolit, hanem **összerakott entitás**:

```
Agent = Identitás (service account)
      + Instrukció / alapprompt
      + Memória (privát, verziózott, write-gate-elt — 4.6)
      + Hozzárendelt erőforrások (many-to-many)
      + Eszközök / képességek (capability)
      + Modell-konfiguráció (Model Gateway — 4.7)
```

#### 4.9.1 Erőforrás mint first-class objektum

Az erőforrás az appban **külön létrehozható, típusos objektum**, amelyet aztán agentekhez rendelünk. Egy erőforrás → több agent, és egy agent → több erőforrás (many-to-many).

| Erőforrás-típus | Példa | Scope | Megjegyzés |
|---|---|---|---|
| **Secret** | API kulcs, kredencia | jellemzően 1 agent | **Soha nem a promptban/memóriában** — alias-szal hivatkozott, szerver injektálja (4.9.2) |
| **Policy / szabályzat** | "Számlajóváhagyási szabályzat" | megosztott | Verziózott; változás azonnal hat a kötött agentekre; nagy hatókörű módosítás jóváhagyás-köteles |
| **File / dokumentum** | sablon, kézikönyv | megosztott v. privát | Read-only tudás/input |
| **Dataset / knowledge base** | RAG-forrás | megosztott v. privát | Kereshető tudásbázis |
| **Tool / connector** | e-mail, DB-elérés | privát v. csoport | Capability + jogosultság |
| **Scratch / munkafájl** | agent saját munkadarabja | privát | **A data plane-ben (sandbox)** él, nem keveredik a kontrollált tudással |

Minden erőforrásnak van: **típusa**, **scope-ja** (globális / csoport / egy-agent), **hozzáférési módja** (olvas / használ), **verziója**, és **agent-kötése**.

#### 4.9.2 Secret-kezelés (kritikus)

A secret (pl. API kulcs) **technikailag sosem kerül a modell kontextusába**. Az agent csak egy **aliast** lát (pl. `accounting_api`); a tényleges értéket a platform **futásidőben, szerveroldalon injektálja** a tool-hívásba. Következmény: prompt injectionnel **nem lehet kicsalni** a kulcsot, mert a modell nem is látja. Ez közvetlen folytatása a 8.2 alapelvnek.

#### 4.9.3 Megosztott vs. privát erőforrás és élő frissítés

- **Megosztott** erőforrás (pl. egy szabályzat) több agentnél van bekötve. Ha a forrás új verzióra vált, **minden kötött agent azonnal az új verzió szerint** működik. Ez a "változtass egy helyen, hasson mindenhol" előnye.
- **Privát** erőforrás (pl. egy adott agent API kulcsa) csak egyetlen agenthez fér hozzá.
- **Magas hatókör = jóváhagyás:** mivel egy megosztott szabályzat módosítása egyszerre sok agent viselkedését változtatja meg, az ilyen változás **jóváhagyási láncon** menjen át (mint a tanítás — 4.6), és **auditesemény** legyen.

#### 4.9.4 Erőforrás-életciklus és visszavonás (finomszemcsés kill-switch)

Az erőforrások **létrehozhatók, verziózhatók, rotálhatók (kulcs), visszavonhatók**. A **revoke** azonnal elveszi az adott agenttől a hozzáférést — ez a 8.8-ban említett vészleállítás **finomszemcsés** változata: nem az egész agentet állítod le, csak egy konkrét képességét/hozzáférését vonod meg incidens esetén.

### 4.10 Folyamatkezelés: ticket-choreográfia + kötelező Playbook

> **Közérthetően:** A "workflow" (munkafolyamat) azt jelenti, hogy egy nagyobb feladat több lépésből áll, amelyeket gyakran több AI-munkatárs vagy ember végez egymás után — pl. az egyik feldolgozza a számlát, a másik ellenőrzi, egy ember pedig jóváhagyja. A cégnek azért fontos, hogy ez a folyamat **áttekinthető, módosítható és ellenőrizhető** legyen: lássák, mi hogyan zajlik, könnyen tudjanak rajta változtatni, és egy auditnak is meg tudják mutatni. A kérdés, amit itt megválaszolunk: kell-e ehhez külön, bonyolult szoftvereszköz? A válasz, hogy nem — és az alábbiakban megmutatjuk, mit javaslunk helyette.

**Alapdöntés: nem kell külön workflow-motor.** A ticket *maga* a folyamat-szubsztrát. Az agent-átadás egyszerűen úgy működik, hogy az agent **utolsó lépése egy új ticket** létrehozása a következő agent/szerep számára. Ezt **choreográfiának** hívjuk (minden agent ismeri a saját következő lépését), és v1-re ez a helyes, egyszerű választás.

#### 4.10.1 A tiszta choreográfia korlátja (governance-kockázat)

Ha a teljes folyamat **kizárólag** az egyes agentek memóriájában/szabályzatában él, akkor:
- a flow megváltoztatásához **több agentet** kell szerkeszteni,
- a végponttól végpontig tartó folyamat **sehol nincs explicit módon** leírva,
- egy auditor kérdésére ("mi a teljes folyamat, ki hagy jóvá hol?") nincs egyetlen tiszta forrás.

Mivel a termék fő ígérete az **átláthatóság**, ezt nem hagyhatjuk implicit állapotban.

#### 4.10.2 Kötelező elem — könnyű, deklaratív Playbook

A **Playbook kötelező erőforrás-típus** (nem motor, csak *leírás*): egy folyamat = melyik **tickettípust** melyik **agent-szerep** kezeli, milyen **elágazásokkal / jóváhagyási pontokkal**. Verziózott és auditált → bármely lefutásra megmondható, **melyik folyamat-verzió** futott. Ez governance-nézetet ad anélkül, hogy nehéz orchestration-réteget hoznánk be.

**Miért kötelező, és nem opcionális:** a termék fő ígérete az átláthatóság (4.10.1). Ha a teljes folyamat csak az egyes agentek memóriájában él implicit módon, akkor egy auditor *"mi a teljes folyamat, ki hagy jóvá hol?"* kérdésére nincs egyetlen tiszta forrás. A Playbook pont ezt a hiányt zárja be, ezért **minden többlépéses folyamatnál kötelező** — ez a governance-sztori egyik tartópillére, nem nice-to-have.

**Bővíthetőség (v1 → upgrade):** a Playbook szándékosan könnyű (deklaratív leírás). Ha egy ügyfélnek később **összetettebb folyamatmodellre** van igénye (pl. BPMN-szerű, explicit elágazás-, párhuzamosság- és kompenzáció-kezelés), a Playbook **felfelé bővíthető** egy gazdagabb folyamatmodellé anélkül, hogy a ticket-alapú végrehajtási mag (4.11) változna. A v1 a könnyű Playbook; a teljes folyamatmodell **opcionális upgrade**, ha a kereslet indokolja. Ez egyben a banki upgrade-path (8.7) felé is nyitva tartja az utat, ahol az explicit folyamatmodell elvárás lehet.

#### 4.10.3 Folyamat-vizualizáció — két nézet

- **Szándékolt folyamat:** a Playbookból / agent-szabályzatokból rajzolt ábra (hogyan *kellene* működnie).
- **Tényleges folyamat:** **az audit-logból automatikusan kinyert** valós ticket-átadási gráf (mi *történt* ténylegesen).

A kettő egymás mellé tétele önmagában governance-feature: megmutatja, **hol tér el a valóság a tervtől**. (A "vizualizáló agent" itt legfeljebb a megjelenítést szépíti — a tényleges gráf adatból, nem leírásból jön, ezért megbízhatóbb.)

#### 4.10.4 Mit szabályoz a Playbook, és mit nem (tisztázás)

A Playbook a folyamatban résztvevő agenteknek **megosztott erőforrásként** adható oda, de pontosan kell látni a szerepét, mert három dolog könnyen összecsúszik:

**Három governance-réteg (ne mossuk össze):**

| Réteg | Mit szabályoz | Hol él |
|---|---|---|
| **Playbook** | A *flow*: tickettípus → szerep, átadások, jóváhagyási kapuk | Megosztott, verziózott erőforrás |
| **Policy / szabályzat** | *Korlátok* a viselkedésen (pl. értékhatár) | Megosztott erőforrás (4.9) |
| **Agent instrukció + memória** | *Hogyan* végzi a tényleges munkát | Agent-privát (4.5, 4.6) |

A Playbook tehát megmondja, **hol áll az agent a folyamatban és kinek ad át** — de nem azt, *hogyan* végezze a feladatot.

**A Playbook NEM az audit-forrás.** A Playbook a *szándékolt terv*; az **audit-log a forrás-igazság arról, ami ténylegesen történt** (4.10.3). Az érték a kettő összevetésében van — ha a Playbook lenne az audit-forrás, pont az "eltérés a tervtől" governance-feature veszne el.

**Puha iránymutatás vs. kemény kikényszerítés (kritikus).** A Playbook szövegként az agent promptjában csak *iránymutatás* — az agent elolvassa és követi. A **kötelező kapukat** azonban a control plane **ticket-állapotgépe** (4.2–4.3) **szerveroldalon, fizikailag** kényszerítse ki, függetlenül attól, mit dönt az agent. Ideális: a Playbook és a kikényszerített állapotgép-konfiguráció **egy közös forrásból** származik (a Playbook generálja / hozzá van kötve a kikényszerített szabályokhoz), hogy ne csússzon szét, amit a Playbook ígér és amit a rendszer betart.

### 4.11 Agent-indítás: eseményvezérelt dispatch (token-takarékos végrehajtási modell)

> **Közérthetően:** Honnan tudja egy AI-munkatárs, hogy van dolga, és mikor lásson neki? A naiv megoldás, hogy folyamatosan kérdezgeti magától, hogy "van feladatom? van feladatom?" — de ez sok AI-nál nagyon drága, mert minden ilyen "ébredés" pénzbe (tokenbe) kerül, akkor is, ha épp nincs munka. Itt azt mutatjuk meg, hogyan érjük el, hogy egy AI-munkatárs **csak akkor induljon el — és csak akkor kerüljön pénzbe —, amikor tényleg van valódi feladata.**

Egy ticket-alapú rendszer "lelke" a kérdés: *honnan tudja egy agent, hogy van dolga?* A naiv válasz egy **heartbeat/polling** — ami nagyszámú agentnél **drága lehet, ha LLM fut benne**. A megoldás kulcselve:

> **Olcsó (nem-LLM) figyelő dönt, drága (LLM) agent csak valódi munkára indul.** A "van-e feladat?" determinisztikus adatbázis-lekérdezés (nulla token); LLM-token kizárólag a tényleges végrehajtáskor megy el.

#### 4.11.1 Az orkesztrátor NEM AI-agent

A dispatch-logika **sima backend szolgáltatás**, nem LLM-agent. Az "orkesztrátor agent" gondolat helyes szándékú, de ha LLM-ben futna a figyelés, az pont a kerülendő üresjárati tokenköltség. Minta: **work queue + worker (producer/consumer)**:

1. Egy ticket végrehajtható állapotba kerül (létrejön / hozzárendelik / `Ready`).
2. A **dispatcher** (determinisztikus kód) kiveszi a `Ready` elemet, és meghívja a hozzárendelt **agent-runtime**-ot.
3. Az agent dolgozik (**itt megy el a token**), frissíti a ticketet, esetleg átadó tickettet hoz létre, majd **leáll**. Üresben sosem fut.

#### 4.11.2 Trigger-stratégia: eseményvezérelt elsődlegesen, cron csak háló

- **Elsődleges — eseményvezérelt (push):** a ticket állapotváltása indítja az agentet. Firestore/Cloud Functions trigger, Postgres `LISTEN/NOTIFY`, vagy job-queue (Pub/Sub, Redis stb.). Heartbeat gyakorlatilag nem is kell.
- **Másodlagos — cron-söprés (safety net):** alacsony frekvenciás, **egy SQL-lekérdezés** (nem LLM!), ami elkapja az esetleg elveszett eseményeket. Mivel nem agent, gyakorlatilag ingyen van. **Tehát nem a heartbeat drága — csak akkor lenne az, ha agentet futtatnál benne.**

#### 4.11.3 A külső/Cowork demó-runtime

Laptopon futó agentet nehéz "pusholni", de ugyanaz az elv: egy **vékony, nem-LLM script** pollozza az API-t (olcsó GET), és **csak találat esetén** indítja a drága LLM-agentet. Így a demó is token-takarékos.

#### 4.11.4 Költségkontroll a végrehajtáson

Agentenkénti **rate-limit**, **max párhuzamos futás**, **debounce/batch** (több ticket egy agentnek → opcionálisan egy futás), prioritásos sor, és per-agent **budget cap** (8.6) — hogy egy elszabadult agent se költhessen korlátlanul. Plusz **ticket-lock / idempotencia** (8.8), nehogy két dispatcher kétszer indítsa ugyanazt.

#### 4.11.5 Mikor indokolt mégis LLM az orkesztrációban?

Csak ha a **routing maga érdemi gondolkodást igényel** (pl. homályos kérés → melyik specialista agent kapja). Még akkor is: **eseményre, ticketenként egyszer**, olcsó/kis modellel — soha nem pollozó ciklusban. A döntések ~90%-át determinisztikus szabály megoldja.

#### 4.11.6 Időzített és ismétlődő végrehajtás

A ticket nem feltétlenül a hozzárendeléskor fut le — **időpont is rendelhető hozzá**, amikor a végrehajtást várjuk. Ez nem külön mechanizmus: az időpont egyszerűen **az egyik feltétel** a végrehajthatóságban.

**Általánosított elv — `Ready` = predikátum.** Egy ticket akkor végrehajtható, ha **minden feltétele teljesült**:

```
végrehajtható = (now >= execute_after)
              ÉS (minden blokkoló ticket kész)
              ÉS (minden jóváhagyási kapu teljesült)
```

Az időpont, a függőségek és a jóváhagyás így **ugyanazon a mechanizmuson** megy; a dispatcher ezt a predikátumot értékeli.

**Időmezők (érdemes szétválasztani):**

| Mező | Jelentés | Hatás |
|---|---|---|
| `execute_after` | Legkorábbi indítás | A ticket eddig `Scheduled` állapotban vár |
| `due_by` / SLA | Határidő | Ha eddig nincs kész → **eszkaláció** (figyelmeztet/átrendel); mérhető SLA-tartás |
| `expires_at` (opc.) | Érvényességi határ | Ha túl késő, ne fusson / törlődjön |

**Technikai megvalósítás:** az időalapú indítás pont a determinisztikus, **nem-LLM** söprés — `WHERE execute_after <= now() AND <egyéb feltételek>`, vagy natív delay-queue / Cloud Tasks `scheduleTime`. Itt a 4.11.2 cron-ja "safety net"-ből **valódi funkcióvá** válik. Nulla token, mert nem agent dönt.

**Ismétlődő (recurring) ütemezés:** egyetlen időponton túl **cron-szerű ismétlés** is (pl. "reconciliation minden nap 6:00"). Ez egy **ticket-sablon**, ami minden periódusban legenerál egy ticket-példányt. Back-office rutinokra (napi/heti zárás, riport) kulcsérték — ütemezett munka, nem csak reaktív.

**Éles üzemi finomságok:**
- **Catch-up policy** ticketenként: kihagyott időablaknál *fusson késve* vagy *ne fusson* (egy órákat késő napi zárás már hibás lehet).
- **Jitter + concurrency-cap (4.11.4):** ha sok ticket ugyanarra az időpontra esik (pl. mind 6:00), kis szórással simítjuk a terhelési csúcsot.
- **Időzóna:** tárolás UTC-ben, megjelenítés lokálisan — ütemezésnél kötelező a korrektséghez.

### 4.12 Integrációs réteg — connector mint újrahasznosítható erőforrás

> **Közérthetően:** Egy AI-munkatárs önmagában keveset ér, ha nem fér hozzá a cég meglévő rendszereihez (könyvelés, levelezés, adatbázis, raktár). Az integráció az a "vezetékrendszer", amin keresztül az agent eléri ezeket. A lényeg: egy rendszert **egyszer kötünk be**, és onnantól **bármelyik agent használhatja** — nem kell minden új agenthez újra megépíteni.

Az integráció nem melléktéma, hanem a megvalósuló üzleti érték egyik fő hordozója. Enterprise és mid-market környezetben a haszon nagy része abból jön, hogy az agent a **már meglévő rendszereket** éri el és köti össze, nem rendszercseréből.

**Architekturális elv: integrálj egyszer, használd sokszor.** A connector a 4.9.1 szerinti **first-class erőforrás** — típusos, verziózott, scope-olt, many-to-many módon agentekhez köthető. Egy bekötött rendszer (pl. egy könyvelő szoftver API-ja) egyetlen connector-erőforrás; ezt több agent is megkapja, és ha a forrás változik, **egy helyen** kell módosítani.

- **Hol él:** a connector *definíciója és jogosultsága* a control plane-ben (governance, audit), a tényleges adatforgalom az execution plane-ben (data plane). Ugyanaz a kontroll/adat szétválasztás, mint a 6. fejezetben.
- **Kredenciál:** a connectorhoz tartozó secret **soha nem a promptban** — alias-szal hivatkozott, a platform futásidőben, szerveroldalon injektálja (4.9.2). Így egy bekötött banki/ERP-kulcs prompt injectionnel sem csalható ki.
- **Capability-alapú elérés:** az agent csak azokat a connectorokat hívhatja, amelyekre **explicit joga van** (8.2); minden hívás naplózott és policy-ellenőrzött.
- **Protokoll-absztrakció:** REST, SOAP, üzenetsor (Kafka/MQ), fájl (S3/SFTP), DB — a konkrét protokoll a connector mögött van elrejtve, az agent egységes interfészt lát. Így a háttérrendszer cseréje nem írja át az agentet (a Model Gateway, 4.7, mintájára).

**Üzleti következmény:** a connector-könyvtár **újrahasznosítható IP**. Az első ügyfélnél megépített integrációk (pl. egy gyakori könyvelő rendszer, e-mail, dokumentumtár) a következő ügyfeleknél már készen vannak — ez alakítja a professional services munkát ismételhető eszközzé, és csökkenti a következő bevezetés idejét és kockázatát.

---

## 5. Execution / Sandbox Plane — 2. alkalmazás részletei

> **Közérthetően:** Ez a fejezet a "munkateret" írja le — a második alkalmazást, ahol az AI-munkatársak a tényleges, cégre szabott munkát végzik. Az előzővel (az őrzött irányítóközponttal) ellentétben ez **szabadon alakítható** az ügyfél igényeire. Itt töltik fel a dokumentumokat, itt jelennek meg az eredmények, és itt vannak a testreszabott felületek. A példánk végig egy könyvelő AI-munkatárs lesz.

### 5.1 Cél

Egy **ügyfélre szabott munkakörnyezet**, amelyben az agentek ténylegesen dolgoznak. Itt is van hozzáférés-kezelés és naplózás, de a lényeg, hogy **szabadon továbbfejleszthető**: az ügyfél munkatársai, az agentek, vagy mi is fejleszthetjük. Ez a tényleges üzleti érték helye.

### 5.2 Működési minta (példa: könyvelő agent)

1. A felhasználó feltölti a számlákat a 2. appba.
2. A könyvelő agent (az 1. appban definiált, API-kulccsal) beolvassa és **elvégzi a könyvelési javaslatot**.
3. Az eredményt **megjeleníti** a 2. appban (testreszabott dashboard).
4. **Tickettet ad** az embernek az 1. appban: lépjen be, nézze át, és **hagyja jóvá** a tényleges könyvelőszoftverbe töltés előtt.
5. Jóváhagyás után történik a tényleges integráció — emberi kapuval.

### 5.3 Kontroll vs. szabadság

A 2. app szabadsága a kulcsdifferenciáló, de **nem lehet a kontrollált történet kiskapuja**. A javasolt elv:

- az **adat és a működési napló** a 2. appban marad (data plane),
- a **konfiguráció, jogosultság, audit, tanítás** az 1. appban él (control plane),
- a 2. app **kódjának változtatása** — különösen ha agent végzi — **jóváhagyási csővezetéken** megy át (fejlesztési ticket → review → merge, lásd 8.4).

#### 5.3.1 Két különböző kontrollszint és felelősséghatár

A két app jóváhagyási csővezetéke **szándékosan eltérő szabadságú**:

| | Control Plane (1. app) | Sandbox (2. app) |
|---|---|---|
| Ki módosíthatja | **Kizárólag mi**, szigorú kontroll alatt | Konfigurálható: a **cég maga is dönthet** |
| Jóváhagyási csővezeték | Rögzített, általunk őrzött | **Szabadon konfigurálható**, akár teljesen céges belső döntés |
| A mi részvételünk | Mindig kötelező | **Opcionális** — a cég jóváhagyhat minket megkerülve |
| Garancia | **Mi vállalunk garanciát** | Csak akkor, ha benne vagyunk a folyamatban |

Ez a felállás teszi tisztává a **felelősséghatárt**: a control plane változatlansága a mi garanciánk alapja (ezért nem kap rá módosítási jogot a használó cég). A sandbox esetében a cég saját maga döntheti el, hogyan és kinek a jóváhagyásával módosítja — ennek megfelelően a felelősség is hozzá kerül, kivéve ha minket bevon a folyamatba. Ezt érdemes a szerződésben is explicit rögzíteni.

#### 5.3.2 Szállítási modell: Build-Operate-Transfer (BOT)

> **Közérthetően:** A célügyfeleinknek általában nincs saját IT- vagy AI-csapatuk, ezért nem tudják sem felépíteni, sem üzemeltetni a megoldást. A BOT azt jelenti, hogy mi **felépítjük**, egy ideig **üzemeltetjük is helyettük**, majd ha készen állnak, **átadjuk** nekik.

A célszegmensünk (mid-market, fintech/PSP — 2. fejezet) tipikusan **nem rendelkezik belső IT/AI-kompetenciával**. Ezért a sandbox (2. app) és az agentek szállítására a természetes modell a **Build-Operate-Transfer**:

- **Build:** mi építjük fel az ügyfélre szabott munkateret, a connectorokat (4.12) és az agenteket.
- **Operate:** egy átmeneti ideig mi is **üzemeltetjük** — figyeljük, hangoljuk, tanítjuk (a control plane jóváhagyott csatornáin keresztül, 4.6).
- **Transfer:** ha az ügyfél felépítette a saját kompetenciáját, az üzemeltetés (vagy annak egy része) **átadható** neki.

Ez illeszkedik az 5.3.1 felelősséghatárhoz: amíg mi üzemeltetünk, a **garancia is nálunk** van; átadás után a felelősség az átadott körben az ügyfélhez kerül. A BOT egyúttal **bevételi modell** is — a control plane licenc/SaaS mellett a sandbox *build + operate* professional services bevétel, a *transfer* pedig opcionális mérföldkő. A fázishatárokat és a felelősség átszállását szerződésben kell rögzíteni.

---

## 6. Adat- és kontrollhatárok (data/control boundary)

> **Közérthetően:** Itt egy egyszerű kérdést válaszolunk meg: mi hol tárolódik? Az érzékeny, ellenőrzött dolgok (ki mit tehet, a naplók, az AI tudása) az őrzött irányítóközpontban; a tényleges munkaadatok (számlák, dashboardok) a rugalmas munkatérben. Ez a szétválasztás a biztonság egyik alapja — és egy fontos szabály: a feltöltött adat (pl. egy számla szövege) az AI számára **adat, nem parancs**.

| Elem | Hol él | Miért |
|---|---|---|
| Agent-konfiguráció, prompt, jogosultság | Control Plane (1) | Auditálható, nem-módosítható mag |
| Agent-memória / tudás (verziózott) | Control Plane (1) | Tanulás csak jóváhagyással |
| Audit & interakciós napló | Control Plane (1) | Tamper-evident, exportálható |
| Modellhívás-napló, token/költség | Control Plane (1) / Gateway | Központi observability |
| Munkaadat (számlák, dokumentumok) | Execution Plane (2) | Ügyfélspecifikus, nagy volumen |
| Testreszabott dashboard, üzleti logika | Execution Plane (2) | Szabadon fejleszthető érték |

**Kritikus elv:** a 2. appból érkező adat (pl. egy feltöltött számla tartalma) az agent számára **adat, nem utasítás**. A jogosultságokat és az engedélyezett műveleteket mindig **szerveroldalon, a control plane-ben** kényszerítjük ki — soha nem a promptban (prompt injection elleni alapelv).

---

## 7. Megfelelőség és audit (selling point)

> **Közérthetően:** A "megfelelőség" (compliance) azt jelenti, hogy a megoldás megfelel a törvényeknek és az iparági szabályoknak. Ez a fejezet megmutatja, hogy amit eddig leírtunk (naplózás, emberi jóváhagyás, ellenőrzés), az pont az, amit a szabályozók is elvárnak az AI-rendszerektől — vagyis a biztonsági felépítésünk egyben **értékesítési érv** is.

A felépítés szinte egy az egyben lefedi azt, amit a szabályozók a magas kockázatú AI-rendszerektől elvárnak: **emberi felügyelet, naplózás/nyomonkövethetőség, transzparencia, kockázatkezelés.**

- **EU AI Act:** a magas kockázatú (Annex III) rendszerek kötelezettségeinek alkalmazását a *Digital Omnibus* megállapodás **2027. december 2-re** halasztotta (a termékbe ágyazott, Annex I rendszereké **2028. augusztus 2-re**). Ez **idő-ablakot ad** arra, hogy a platformot mint "AI Act readiness" eszközt pozícionáljuk — a kötelező naplózás, emberi felügyelet és kockázatkezelés pont a mi alaprétegünk. *(Forrásellenőrzés szükséges éles ügyfélanyagnál, mert a timeline még alakulhat.)*
- **ISO/IEC 42001** (AI menedzsmentrendszer) és **ISO/IEC 27001** (infosec) felé természetes leképezés.
- Fizetési iparágban releváns: **PCI DSS** elvek (adatszegregáció, hozzáférés-kontroll, naplózás), **SoD** (segregation of duties), négy-szem-elv a jóváhagyásnál.

---

## 8. Kockázatok, hiányosságok és továbbfejlesztési javaslatok

> **Közérthetően:** Eddig azt írtuk le, hogyan épül fel a rendszer. Itt őszintén végigvesszük, hol vannak a kockázatok és a buktatók, és mit kell jól megcsinálni ahhoz, hogy ezt egy cégnek bizalommal át lehessen adni. Ez lényegében a "mire figyeljünk" lista.

Ez a fejezet az eredeti koncepció **kritikai kiegészítése** — mit érdemes másképp vagy alaposabban csinálni, hogy ügyfélnek átadható legyen.

### 8.1 Tanítás / memória — ez a legnagyobb kockázat és a legnagyobb érték

Az "agent olvas egy tanítási ticketet és frissíti a memóriáját" csábítóan egyszerű, de éles környezetben **memória-mérgezés** kockázatot hordoz. Javaslatok:
- a memória legyen **verziózott, diffelhető, jóváhagyott** (4.6 szerint),
- minden tudásfrissítés mögött legyen **forrás és jóváhagyó** (provenance),
- bevezetni egy **eval-kaput**: a frissítés ne ronthasson egy regressziós tesztkészleten,
- **rollback** egy kattintással.

> Ez nem extra — ez a termék egyik fő eladható feature-je: "az AI nálunk nem driftel el észrevétlenül".

### 8.2 Prompt injection és eszköz-jogosultság

A 2. appba kerülő dokumentumok (számlák, e-mailek) **támadási felület**: egy rosszindulatú tartalom megpróbálhatja az agentet jogosultság-emelésre vagy káros ticket létrehozására rávenni. Védelem:
- a jogosultságok **szerveroldali kikényszerítése**, soha a promptban,
- **capability-alapú** eszközelérés (az agent csak azt hívhatja, amire explicit joga van),
- kimeneti / művelet-validáció a Gateway-en,
- gyanús minták (jogosultság-emelési kísérlet) **flag-elése** az auditba.

### 8.3 A külső (Cowork) agent-runtime auditvaksága

Pilotra kiváló, de **éles, megbízható működésre nem**: a külső runtime belső lépései (milyen eszközt hív, milyen adatot lát a laptopon) nem auditálhatók, csak a board-interakció. Javaslat:
- explicit különbségtétel **"untrusted external runtime"** vs **"trusted internal runtime"** között,
- a külső kulcsok **erősen szűkített** jogkörrel, rövid élettartammal, **IP-allowlisttel**, rate-limittel,
- éles use case-eknél a runtime a kontrollált környezetbe kerül.

### 8.4 A sandbox ne legyen kiskapu

Ha a 2. appot agentek is fejleszthetik, a "szabadság" könnyen aláássa a kontrollált történetet. Javaslat:
- a 2. app kódváltozása **ugyanazon a jóváhagyási csővezetéken** menjen át (fejlesztési ticket → emberi review → merge), mint bármi más,
- **konténerizált, izolált futtatás**, nincs közvetlen prod-deploy agent kezéből,
- a kódmódosítás is **auditesemény**.

### 8.5 Append-only, tamper-evident audit log

Az enterprise/banki audit nem éri be "van egy log tábla"-szinttel. Javaslat:
- **append-only**, **hash-láncolt** (tamper-evident) naplózás,
- **SIEM-export** (a vállalat saját biztonsági monitorozásába),
- naplóséma: ki/mi (agent-verzió), mit, mikor, milyen modellel, milyen input/output, milyen policy-döntés.

### 8.6 Observability és költségkontroll

Enterprise-ban gyorsan kérdés lesz: *mennyibe kerül ez, és működik-e jól?* Javaslat egy beépített modulra:
- **token- és költségkövetés** agentenként/ticketenként,
- **minőségi metrikák / evalok**, drift-detektálás,
- **guardrail-sértések** dashboardja,
- SLA-k (pl. agent válaszidő, jóváhagyási átfutás).

### 8.7 Platformfüggetlenség — a Firebase csak teszt-host

**Alapelv: a megoldásnak platformfüggetlennek kell lennie.** Ez egy webalkalmazás, amely bármilyen környezetben futtatható — a Firebase csupán egy **kényelmes, ismert teszt-környezet** a prototípushoz, nem architekturális elköteleződés.

Telepítési mátrix az ügyfél típusa szerint (a célszegmens szerint a **felhő az alapértelmezett**, lásd 2. szakasz):

| Ügyféltípus | Deployment | Indok |
|---|---|---|
| **Középvállalat / fintech / PSP (fő célszegmens)** | **Felhő — alapértelmezett** | Gyors deploy, megbízható, elfogadható biztonsági alapszint; ide illik a fürge tanácsadói modell |
| Bank / erősen szabályozott (upgrade-path) | On-prem / dedikált privát felhő | Adat-rezidencia, szabályozás, "az adat nem hagyja el a céget" |

**Tervezési következmény:** a perzisztencia és az infrastruktúra-függő részek legyenek **absztrakció mögött / cserélhetők**. Prototípus Firebase-en, de ne égjenek bele Firebase-specifikus megoldások a control plane magjába — így ugyanaz a kód on-prem (pl. Postgres + self-host) és felhős környezetben is fut. Banki környezetben az on-prem amúgy is kötelező lesz; a platformfüggetlenség garantálja, hogy ne kelljen újraírni.

### 8.8 Amire még érdemes gondolni

- **Multi-tenancy:** a control plane-t több ügyfélnek futtatjuk (platform), vagy ügyfelenként külön telepítés? Ez architekturális és üzleti döntés — az izoláció miatt szabályozott ügyfeleknél gyakran a **single-tenant / dedikált** telepítés a nyerő.
- **Idempotencia és konkurrencia:** mi történik, ha két agent ugyanarra a ticketre mozdul? Kell ticket-lock / optimista konkurenciakezelés.
- **"Kill switch" / emergency stop:** egy agent vagy az összes agent azonnali leállítása (incidens esetén).
- **Human override mindenhol:** bármely automatizált lépés emberi felülbírálhatósága, és ennek naplózása.
- **Disaster recovery / backup** a control plane-re (az audit és a memória elvesztése kritikus).
- **Szerződéses / felelősségi kérdés:** ha egy agent hibázik (rossz könyvelési javaslat, amit jóváhagytak), hol a felelősséghatár? Ezt a jóváhagyási kapuk és a naplók kezelik, de érdemes explicit dokumentálni az ügyfélnek.

---

## 9. Javasolt prototípus-scope (Pilot)

> **Közérthetően:** A teljes elképzelés nagy, ezért nem mindent egyszerre építünk meg. Itt egy reális, lépésekre bontott terv következik egy működő bemutató (prototípus) elkészítésére — nagyjából 3-4 hónap alatt —, amivel egy ügyfélnek kézzelfoghatóan megmutatható, hogy a dolog tényleg működik.

A teljes vízió nagy; egy hihető **proof-of-value** ehhez a vázhoz:

**Fázis 1 — Control Plane mag (4–6 hét):**
- Kanban board + ticket-állapotgép (szerveroldali validáció),
- Agent Registry (létrehozás, alap-konfiguráció, scoped API-kulcs),
- alap RBAC (ember) + agent service account,
- append-only audit log,
- 1 tickettípus interakcióra + 1 tanítási tickettípus jóváhagyással.

**Fázis 2 — Egy valódi use case a Sandboxban (4–6 hét):**
- pl. **könyvelő agent** számlafeldolgozási javaslattal + emberi jóváhagyással,
- Model Gateway külső API-val (Claude),
- külső Cowork agent mint teszt-runtime, hogy a kétféle runtime modellt bizonyítsuk.

**Fázis 3 — Enterprise-readiness demonstráció (3–4 hét):**
- memória-verziózás + rollback demo,
- token/költség observability,
- 1 lokális modell bekötése a Gateway-en (az "adat nem hagyja el a céget" történethez).

**Sikerkritérium:** egy végigvitt, **auditálható** folyamat — feltöltött dokumentumtól az ember által jóváhagyott eredményig —, ahol minden lépés visszakereshető, és bemutatható egy tanítási ciklus jóváhagyással és visszagörgetéssel.

---

## 10. Döntések és nyitott kérdések

**Eldöntött (jelen iteráció):**
- **Platformfüggetlenség kötelező.** Firebase csak teszt-host; bankra on-prem, egyéb cégre hostolt is jó (8.7).
- **Memória-írás zárolása** szerveroldali, aláírt, egyszer használatos write-gate tokennel (4.6.1).
- **Sandbox jóváhagyási csővezeték** szabadon konfigurálható, a cég minket megkerülve is jóváhagyhat — eltérő felelősséghatár és garancia (5.3.1).
- **Külső Cowork-runtime kizárólag demó / fejlesztői teszt**, soha nem éles; akár teljesen kivehető (4.8).
- **Szerveroldali jogosultság-kikényszerítés** a prompt injection ellen — fix alapelv (8.2).
- **Erőforrás-modell:** az agent = identitás + prompt + memória + erőforrások + eszközök + modell; az erőforrás (secret/policy/file/dataset/tool) first-class, típusos, scope-olt, verziózott, many-to-many kötéssel (4.9).
- **Secret sosem a promptban** — alias-szal hivatkozott, szerver injektálja (4.9.2).
- **Folyamatkezelés:** nincs külön workflow-motor; ticket-choreográfia v1-re, **kötelező deklaratív Playbook** a governance-átláthatóságért (később felfelé bővíthető teljes folyamatmodellé, ha van rá igény); vizualizáció a tényleges audit-logból (4.10).
- **Integráció mint 3. pillér:** a connector first-class, újrahasznosítható erőforrás ("integrálj egyszer, használd sokszor"); definíció/jogosultság a control plane-ben, adatforgalom az execution plane-ben (1.1, 4.12).
- **Szállítási modell:** Build-Operate-Transfer (BOT) a belső IT/AI-csapat nélküli ügyfelekre; a felelősség az üzemeltetéssel mozog (5.3.2).
- **Auth-provider:** Clerk prototípusra + hostolt ügyfélre; Keycloak (alt. Zitadel) on-prem/banki útra; humán auth OIDC-absztrakció mögött a cseréhez; agent-authz a saját control plane-ben marad (4.4.1).
- **Agent-indítás:** eseményvezérelt dispatch (nem pollozó); az orkesztrátor **sima kód, nem LLM**; cron csak olcsó safety-net; LLM-token kizárólag valódi feladat végrehajtásakor (4.11).
- **Időzített/ismétlődő végrehajtás:** ticketenként `execute_after` időpont; `Ready` = predikátum (idő + függőség + jóváhagyás); recurring ticket-sablonok; `due_by`/SLA eszkalációval; catch-up policy és jitter (4.11.6).

**Még nyitott (validálandó):**
- Single-tenant vs. multi-tenant a control plane-nél? (Szabályozott ügyfélnél valószínűleg dedikált.)
- Saját agent-orchestration motort építünk, vagy meglévő keretre ülünk rá a control plane mögött?
- Lokális modell célhardver és modellválaszték (mit ígérünk az ügyfélnek)?
- Az első referencia use case és iparág (a fizetési fókusz miatt: reconciliation, chargeback-előkészítés, dokumentum-feldolgozás)?

---

## 11. Példa use case-ek normál (nem banki) vállalatnál

> **Közérthetően:** Eddig az architektúráról volt szó. Itt néhány konkrét, hétköznapi példa következik arra, mit csinálna a rendszer egy átlagos cégnél — nem fizetési óriásnál, hanem egy normál vállalatnál, ahol a fő fájdalom az **általános adminisztráció**. Az első konkrét ügyfél az **Ostoros-Novaj Zrt.** (szántóföldi növénytermesztés és borászat), ahol a belépő cél az adminisztrációs folyamatok támogatása.

Ezek **belépő, alacsony kockázatú use case-ek**: mindegyikben emberi jóváhagyás van (human-in-the-loop), és mindegyik a **meglévő rendszerekre épül**, nem cseréli le azokat (4.12). A cél a gyors, kézzelfogható proof-of-value, nem a teljes automatizálás. A leírások a CLAUDE.md use-case sablonjának tömörített változatát követik.

### 11.1 Bejövő számla- és dokumentum-feldolgozó agent

- **Folyamat / fájdalom:** beszállítói számlák, szállítólevelek, szerződések kézi beolvasása, adatrögzítése és könyvelési előkészítése időigényes és hibázásra hajlamos.
- **AI-megoldás:** az agent beolvassa a feltöltött dokumentumot, kinyeri a mezőket (szállító, összeg, tételek, dátum), összeveti a megrendeléssel/szállítólevéllel, és **könyvelési/jóváhagyási javaslatot** készít.
- **Szükséges adat/rendszer:** dokumentumtár + könyvelő szoftver (connector — 4.12); secret szerveroldali injektálással (4.9.2).
- **Emberi jóváhagyás:** igen — a tényleges könyvelésbe töltés előtt ember nézi át (az 5.2 könyvelő-agent minta).
- **Kockázat/kontroll:** prompt injection a dokumentumból (8.2) → szerveroldali jogosultság-kikényszerítés; minden javaslat naplózott.
- **Metrika:** feldolgozási idő/számla, kézi hibák aránya, jóváhagyási átfutás.
- **Pilot:** ez a leggyorsabban demózható belépő (9. fejezet, Fázis 2).

### 11.2 E-mail- és rendelés-triage agent

- **Folyamat / fájdalom:** a bejövő levelezésből (borrendelések, beszállítói egyeztetés) kézzel kell kibányászni a teendőket és a rendeléseket.
- **AI-megoldás:** az agent figyeli a megadott postafiókot, kinyeri és normalizálja a rendelés-/feladatadatot, **strukturált tickettet vagy rendelést hoz létre**; az alacsony biztonságú eseteket emberhez küldi.
- **Szükséges adat/rendszer:** e-mail connector, opcionálisan értékesítési/raktár-nyilvántartás.
- **Emberi jóváhagyás:** bizonytalan esetekben kötelező; tiszta eseteknél konfigurálható.
- **Kockázat/kontroll:** a levél tartalma **adat, nem utasítás** (6. fejezet); bizalmi (confidence) küszöb a feldolgozásban.
- **Metrika:** automatikusan feldolgozott levelek aránya, válaszidő.

### 11.3 Agrártámogatási és határidő-asszisztens (domain-specifikus)

- **Folyamat / fájdalom:** a szántóföldi gazdálkodáshoz kötődő támogatások (pl. területalapú, agrár-környezetgazdálkodási) dokumentációja és **határidői** szétszórtak; a csúszás közvetlen pénzügyi veszteség.
- **AI-megoldás:** az agent nyilvántartja a releváns támogatási konstrukciók követelményeit és határidőit, **figyelmeztet a közelgő határidőkre** (ütemezett/recurring ticket — 4.11.6), jelzi a hiányzó dokumentumokat, és beadvány-előkészítést támogat.
- **Szükséges adat/rendszer:** belső dokumentumtár + tudásbázis (RAG/dataset erőforrás — 4.9.1); naptár/értesítés.
- **Emberi jóváhagyás:** minden hatósági beadvány ember által ellenőrzött.
- **Kockázat/kontroll:** a támogatási szabályok változnak → a tudás **verziózott és jóváhagyott** (4.6), forrásmegjelölés (provenance) kötelező.
- **Metrika:** elmulasztott határidők száma (cél: 0), előkészítési idő.
- **Megjegyzés:** ez a leginkább iparág-specifikus, ezért a legnagyobb differenciáló érték — de a tényleges folyamatot **szakértői interjún validálni kell** (mi teny, mi feltételezés).

### 11.4 Belső tudás- és dokumentum-asszisztens (RAG)

- **Folyamat / fájdalom:** szabályzatok, beszállítói szerződések, belső eljárások szétszórtak; a válaszkeresés időt visz.
- **AI-megoldás:** az agent a belső dokumentumokból **hivatkozott (citált) választ** ad a munkatársak kérdéseire, standard válaszokat fogalmaz, az új/ismeretlen kérdést **eszkalálja**.
- **Szükséges adat/rendszer:** dokumentumtár → kereshető tudásbázis (knowledge base erőforrás — 4.9.1).
- **Emberi jóváhagyás:** belső segéd use case → alacsony kockázat; a kifelé menő válaszoknál igen.
- **Kockázat/kontroll:** grounded retrieval (forrásmegjelölés) a hallucináció ellen.
- **Metrika:** megválaszolt kérdések aránya, szakértői idő-megtakarítás.

**Általánosítható minta:** a 11.1–11.4 nem Ostoros-Novaj-specifikus — szinte minden normál vállalatnál (gyártó, kereskedő, szolgáltató) ugyanezek a belépő admin use case-ek működnek. Ez adja az **újrahasznosítható use-case katalógus** magját: az itt megépített agent-sablonok és connectorok a következő ügyfeleknél már nagyrészt készen állnak (4.12, 5.3.2). A 11.3 az egyetlen erősen iparág-specifikus elem — pont ez lehet a referenciaérték Ostoros-Novajnál.

---

*Megjegyzés a jelölésekhez: a fenti idővonal- és szabályozási hivatkozások (EU AI Act) friss forrásból ellenőrzendők éles ügyfélanyag előtt, mert a megfelelőségi határidők még változhatnak.*
