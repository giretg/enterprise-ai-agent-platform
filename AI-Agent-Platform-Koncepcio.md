# Kontrollált Enterprise AI Agent Platform — Koncepció

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.8 — döntések lezárva: multi-tenant architektúra, modellstratégia (OpenAI előfizetés + Gemini API), pilot use case (belső tudás-asszisztens / llm-wiki), elhalasztott komponensek (sensitivity router, policy engine, memory substrate/retrieval, saját model hosting), Sandbox App Container / App Registry réteg
**Dátum:** 2026-06-15
**Státusz:** Döntések lezárva — MVP-tervezésre és fejlesztésindításra kész

> **Változásnapló (v0.3 → v0.4):** a `marveen-osszehasonlitas-es-tanulsagok.md` elemzés alapján beépítve a [github.com/Szotasz/marveen](https://github.com/Szotasz/marveen) projekt kilenc átvehető mintája — a *mechanizmust* átvéve, az *automatizmust* a governance-kapuink alá hajtva. Érintett fejezetek: 4.5 (szerep/viselkedés szétválasztás), 4.6 (hibrid memória-retrieval + reflexió mint tanítási-ticket feeder), 4.8.3 és 4.8.6 (progressive disclosure + recipe-katalógus), 4.10.5 (delegálási státusz-réteg), 4.11 (scheduler-robusztusság + proaktív monitor), 5.3.3 (spec-vezérelt szállítás), 11.5 (proaktív monitor use case).

> **Változásnapló (v0.4 → v0.5):** üzleti döntéshozóknak szóló bevezető hozzáadva; a zsargon-heavy részeknél magyarázó átvezetések és értelmező mondatok pontosítva; friss külső hivatkozások beépítve az AI-agent, MCP, Goose, EU AI Act, OWASP, NIST, ISO/IEC 42001, PCI DSS és DORA témákhoz; a pilot-scope kiegészítve MVP-tervezési döntésekkel, elfogadási kritériumokkal, mérési modellel és hiánylistával. **Forrásellenőrzés dátuma:** 2026-06-14.

> **Változásnapló (v0.6 → v0.7):** döntések beépítve a törzsszövegbe a releváns fejezetekbe (nem külön táblázatba). Érintett helyek: (1) **8.8** — multi-tenant by design, dedikált instance upgrade-path; (2) **4.7** — modellstratégia: OpenAI előfizetés + Gemini API first, saját hosting = 2. fázis; (3) **4.7.2** — sensitivity-aware router elhalasztott tervként jelölve; (4) **4.8.2** — OpenCode fallback eltávolítva, Goose az egyedüli harness; (5) **4.8.3** — per-ticket Cloud Run Job mint eldöntött alapértelmezés; (6) **4.8.4** — Goose MCP extension-k mint Tool Broker implementáció; (7) **4.6.2** — memory retrieval hibrid keresés elhalasztott tervként jelölve; (8) **4.13** — adopt-tábla frissítve: sensitivity router, policy engine, memory substrate mind elhalasztott; (9) **9.1** — modellstratégia sor tisztítva; (10) **9.3** — első pilot = belső tudás-asszisztens (llm-wiki); (11) **10.** — átstrukturálva: 10.A = validálandó spike-ok, 10.B = elhalasztott döntések táblázattal.

> **Változásnapló (v0.5 → v0.6):** az 5. fejezet (Execution / Sandbox Plane) kibővítve azzal a koncepcióval, hogy a munkatér nem csak megjeleníti az agentek munkáját, hanem **agent-által fejleszthető alkalmazásplatform** — egy Canvas-szerű, de valódi, perzisztens appokat futtató felület, ahol az AI igény szerint épít és karbantart belső alkalmazásokat (pl. CRM, ha a cégnek nincs). A keret kulcsa a **scratchpad-pozicionálás**: a sandbox hivatalosan AI-munkafelület, nem a cég éles infrastruktúrája — a kockázat az ismert, vállalható „Excel-szintű" kockázat (Excel-analógia), nem éles rendszer SLA. Az enterprise-megfelelést **governance-by-construction** (beépített alapelvek + elfogadási kapu), **scratchpad-szintű mentés/verziózás** (git-szerű projekt, test→live promóció, kód-vs-adat snapshot) és **graduation/kiszervezés** (egy gombos export a cég saját rendszerébe) adja, GDPR-feldolgozói caveattel. Új/átírt alfejezetek: 5.4 (kettős sík + Canvas-keret + „szabadság a kerítésen belül"), 5.5 (scratchpad-pozicionálás, Excel-felelősséghatár, GDPR-caveat), 5.6 (governance-by-construction: állandó system prompt + elfogadási kapu + kritikussági szintezés L0–L3) és 5.6.1 (a két audit-szint összekapcsolása auditori nézőpontból: kerítés-audit a control plane-ben + sandbox-belső audit, a graduation mint audit-érési trigger), 5.7 (verziózás, mentés, test→live promóció), 5.8 (graduation/kiszervezés + a sandbox-vízió). A 6. fejezet adat-/kontrollhatára frissítve a scratchpad-kerettel.

> **Változásnapló (v0.7 → v0.8):** az 5. fejezet önálló **Sandbox App Container / App Registry** réteggel bővült (5.9). Ez explicitté teszi, hogyan lesz az agent-fejleszthető sandboxból tényleges, nyilvántartott, preview-olható, verziózott és exportálható alkalmazásréteg. A Goose Apps / MCP Apps mintájából a mechanizmust vesszük át (AI által létrehozott, elkülönített mini-app, iframe/sandbox preview, letölthető artefakt), de enterprise környezetben saját registry, policy, audit, export és graduation-kapuk alá tesszük. Az MVP-ben ebből csak egy nagyon vékony, levágható stretch-szelet javasolt: A0 single-file HTML riportnézet + preview + download/export, nem teljes többfájlos app-platform.

> A fejezetek elején **"Közérthetően"** dobozok segítenek azoknak, akik nem járatosak az AI-agentek világában: ezek egyszerű nyelven, hasonlatokkal mondják el, miről szól az adott rész. Az alábbi fogalomtár a leggyakoribb szakszavakat magyarázza.

---

## 0. Üzleti bevezető döntéshozóknak

> **Közérthetően:** Ez a rész azoknak szól, akik nem AI- vagy IT-szakértők, de üzleti döntést kell hozniuk arról, érdemes-e AI agent platformot építeni vagy bevezetni. A lényeg: az AI agent nem egyszerű chatbot. Nem csak válaszol, hanem a vállalat meglévő rendszereiben előkészít, ellenőriz, javasol, feladatot nyit, dokumentumot dolgoz fel, és jóváhagyás után akár műveletet is indíthat. A mi koncepciónk központi állítása az, hogy ezt csak kontrolláltan, auditálhatóan és költségmérhetően szabad vállalati környezetbe engedni.

### 0.1 Mi az AI agent?

Egy **AI agent** olyan digitális munkavégző komponens, amely egy feladatot nem egyetlen válasszal próbál lezárni, hanem több lépésben dolgozik rajta. Értelmezi a célt, adatot kér be, dokumentumot olvas, eszközöket hív, részfeladatokat végez, majd eredményt vagy javaslatot ad vissza. A modern agent-platformok ezért az agentet jellemzően **utasításokkal, eszközökkel, állapottal, guardrail-ekkel és átadási mechanizmusokkal** írják le; ezt a megközelítést használja például az [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/agents/) és a [Microsoft Foundry Agent Service](https://learn.microsoft.com/en-us/azure/foundry/agents/overview) is.

Egy egyszerű chatbot fő kérdése: *"Mit válaszoljak?"* Egy AI agent fő kérdése: *"Milyen lépéseket kell végrehajtanom ahhoz, hogy a feladat üzletileg használható állapotba kerüljön?"* Ez a különbség üzletileg kritikus, mert a vállalatoknál az érték nem a beszélgetésből, hanem a folyamatokban végzett munkából jön: dokumentumok feldolgozásából, eltérések megtalálásából, döntés-előkészítésből, rendszerek összekapcsolásából és visszakövethető jóváhagyásból.

Az agentet érdemes úgy elképzelni, mint egy **digitális munkatársat szűk, jól definiált munkakörrel**. Például:

- egy számlafeldolgozó agent beolvassa a számlát, kinyeri a mezőket, összeveti a rendelési adatokkal, és könyvelési javaslatot készít;
- egy reconciliation agent eltéréseket keres két tranzakciós lista között, magyarázatot készít, és a bizonytalan tételeket emberhez küldi;
- egy belső tudás-asszisztens szabályzatokból keres, de forráshivatkozással válaszol, hogy ellenőrizhető legyen, mire alapozta a választ;
- egy proaktív monitor agent figyeli a határidőket vagy eltérésjelzőket, és csak akkor nyit feladatot, ha tényleg beavatkozás kell.

### 0.2 Mire jó vállalati környezetben?

Az AI agent akkor hasznos, ha van egy ismétlődő, adatigényes, részben szabályalapú, de emberi értelmezést is igénylő folyamat. Tipikus példa: dokumentum-feldolgozás, e-mail triage, ügyfélszolgálati előkészítés, pénzügyi egyeztetés, chargeback/dispute előkészítés, settlement/reconciliation, belső szabályzat-keresés vagy határidő-monitorozás.

Fontos: az agent nem attól enterprise-ready, hogy "okosabb", hanem attól, hogy **beilleszthető a vállalati működésbe**. Ez azt jelenti, hogy:

- csak a neki engedélyezett adatokhoz és rendszerekhez fér hozzá;
- minden lépése naplózott és visszakereshető;
- a kritikus döntéseknél emberi jóváhagyás kell;
- mérhető a pontosság, a költség, a hibaarány, a latency és az üzleti hatás;
- leállítható, korlátozható, visszagörgethető, ha hibázik vagy megváltozik a környezet.

Ez a koncepció ezért nem "AI varázslatként" kezeli az agentet, hanem **vállalati működési szereplőként**: identitással, jogosultsággal, feladatkártyával, auditnyommal és jóváhagyási szabályokkal.

### 0.3 Mit tud a dokumentumban leírt megoldás?

A javasolt megoldás egy **Kontrollált Enterprise AI Agent Platform**. A termék célja, hogy az AI agentek ne elszigetelt demók vagy egyéni laptopon futó asszisztensek legyenek, hanem vállalati szabályok szerint futó, mérhető és ellenőrizhető digitális munkatársak.

A platform három fő komponensből áll:

1. **Control Plane — irányítóközpont.** Itt élnek a szabályok, agent-konfigurációk, jogosultságok, auditnaplók, jóváhagyási láncok, modellhívás-kontrollok és eszközhozzáférések. Ez a bizalmi réteg. A vállalat és az auditor itt látja, ki mit csinált, milyen agent-verzióval, milyen adatok alapján.
2. **Execution / Sandbox Plane — üzleti munkatér.** Itt vannak az ügyfélspecifikus képernyők, feltöltött dokumentumok, dashboardok, üzleti adatok és integrációk. Ez a réteg adja a testreszabott üzleti értéket.
3. **Harness — agent-futtató motor.** Ez indítja és futtatja az agentet. A döntés a jelen koncepcióban a [Goose](https://goose-docs.ai/) használata, mert nyílt forráskódú, MCP-natív, modellfüggetlen agent-motor, és illik a kontrollált runtime modellbe. A Goose projekt az [Agentic AI Foundation](https://aaif.io/projects/goose/) alatt is szerepel; a Linux Foundation a [formation announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) szerint a goose-t nyílt, local-first agent frameworkként pozicionálja.

A három komponens üzleti értelme egyszerű: **a kontroll nem keveredik össze a testreszabott üzleti munkával**. A Control Plane marad stabil, auditálható és szállítói garancia alatt; a Sandbox rugalmasan alakítható az ügyfél folyamataira; a Harness pedig kontrollált környezetben futtatja az agenteket.

### 0.4 Miért nem elég egy chatbot vagy egy RPA?

Egy chatbot tipikusan beszélget. Egy RPA robot tipikusan előre leírt, determinisztikus kattintási vagy adatmozgatási lépéseket hajt végre. Az AI agent a kettő között és felett helyezkedik el: képes szöveget értelmezni, kontextust keresni, bizonytalan adatot kezelni, eszközöket hívni, döntési javaslatot készíteni, és a feladatot átadni embernek vagy másik agentnek.

Ez viszont kockázatosabb is. Ha egy agent eszközöket használhat, akkor hozzáférhet e-mailhez, fájlhoz, adatbázishoz, ERP-hez vagy banki API-hoz. Ezért a dokumentumban leírt platform fő innovációja nem maga az, hogy "van AI", hanem az, hogy **az AI cselekvőképessége kontrollált**:

- a modellhívás a **Model Gateway**-en megy át;
- az eszköz- és rendszerhívás a **Tool Broker**-en megy át;
- az agent nem kap nyers secretet vagy jelszót;
- a magas kockázatú lépés ticketen és emberi jóváhagyáson keresztül történik;
- az audit-log nem utólagos adminisztráció, hanem a működés alapmechanizmusa.

### 0.5 Hogyan néz ki egy üzleti folyamat a platformban?

Egy tipikus folyamat így néz ki:

1. A felhasználó feltölt egy dokumentumot vagy létrehoz egy feladatot.
2. A Control Plane ellenőrzi, hogy a feladat típusa, a felhasználó és a kijelölt agent jogosult-e a műveletre.
3. A dispatcher elindítja az agentet a kontrollált harnessben.
4. Az agent a Tool Brokeren keresztül olvas adatot vagy hív rendszert, a Model Gateway-en keresztül használ AI-modellt.
5. Az agent javaslatot, kivonatot, egyeztetési eredményt vagy kódváltozást készít.
6. Ha a lépés üzletileg kockázatos, a rendszer emberi jóváhagyási tickettet nyit.
7. Jóváhagyás után történik meg a tényleges rendszerbe írás vagy lezárás.
8. Minden esemény auditnaplóba kerül: agent-verzió, modell, eszközhívás, döntés, jóváhagyó, időpont, költség.

Ez a ticket-alapú működés azért fontos, mert az üzleti vezető számára így az AI nem egy láthatatlan háttérfolyamat, hanem **felügyelhető munkaáramlás**.

### 0.6 Mit kap az ügyfél?

Az ügyfél nem egy általános AI-chatfelületet kap, hanem egy olyan platformot, amelyre konkrét üzleti folyamatok építhetők:

- **AI-munkatársakat** definiált szerepekkel, jogosultságokkal és modellel;
- **agent-registryt**, ahol látszik, melyik agent mire való és milyen verzióban fut;
- **Kanban/ticket boardot**, ahol emberi és agent-munka együtt követhető;
- **auditnaplót**, ami bizonyítja, mi történt;
- **modell- és költségkontrollt**, hogy ne szaladjon el a tokenköltség;
- **integrációs réteget**, amely a meglévő rendszereket köti össze az agentekkel;
- **tanítási és memória-kezelési folyamatot**, ahol az agent tudása csak jóváhagyással változik;
- **pilot/MVP keretet**, amely először szűk, mérhető proof-of-value folyamatot épít, nem teljes vállalati átállást.

### 0.7 Mire kell vigyázni?

Az AI agenteknél a legnagyobb kockázat nem az, hogy rossz választ adnak, hanem hogy **rossz választ rossz jogosultsággal összekötve műveletté alakítanak**. Ezért kell külön kezelni:

- a prompt injectiont és a külső dokumentumokból érkező rejtett utasításokat (OWASP: [LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/));
- az érzékeny információ kiszivárgását (OWASP: [LLM02 Sensitive Information Disclosure](https://owasp.org/www-project-top-10-for-large-language-model-applications/));
- az agent túlzott önállóságát és túl széles eszközjogait (OWASP: [LLM06 Excessive Agency](https://owasp.org/www-project-top-10-for-large-language-model-applications/));
- a tanítás/memória mérgezését és kontrollálatlan driftjét;
- a költségelszállást és üresjárati agent-futásokat;
- a megfelelőségi kérdéseket: GDPR, EU AI Act, PCI DSS, DORA, belső audit, vendor risk.

Ezért a dokumentum alapelve: **az agent javasolhat és előkészíthet, de kritikus üzleti vagy szabályozási hatású lépést csak kontrollált, jóváhagyott csatornán tehet.**

### 0.8 Mi az MVP-szintű cél?

Az első MVP nem a teljes platform. Az első MVP célja egy szűk, végigvihető, mérhető folyamat, amely bizonyítja a fő értékállítást:

> **Feltöltött dokumentumtól vagy üzleti eseménytől indulva az AI agent kontrolláltan dolgozik, emberi jóváhagyást kér, majd auditálható eredményt ad — mindezt mérhető költséggel, mérhető pontossággal és visszakereshető naplóval.**

MVP-re akkor alkalmas a koncepció, ha a dokumentum a következőket már explicit tartalmazza: kiválasztott első use case, felhasználói szerepek, adatforrások, integrációk, kockázati osztályozás, human-in-the-loop pontok, mérőszámok, elfogadási kritériumok, demó-forgatókönyv, biztonsági minimumok, és egy döntés arról, mi mock, mi valódi backend, és mi marad későbbre. A 12. fejezet ezt külön checklistként bontja ki.

---

### 0.9 Fogalmak röviden (akinek újak az AI-agentek)

- **AI-agent (AI-munkatárs):** olyan AI-program, amely nem csak válaszol, hanem *feladatokat is elvégez* (pl. elolvas egy számlát, javaslatot készít, létrehoz egy feladatot). Úgy érdemes elképzelni, mint egy digitális alkalmazottat.
- **Prompt (alapprompt):** az az utasítás/leírás, amely megmondja az AI-munkatársnak, ki ő és mi a dolga — gyakorlatilag a "munkaköri leírása".
- **Memória / tudás:** amit az AI-munkatárs "tud" a feladatáról; ez frissíthető (tanítható), de nálunk csak ellenőrzött módon.
- **Token:** az AI-használat elszámolási egysége — leegyszerűsítve minden AI-"gondolkodás" tokenbe, azaz **pénzbe** kerül. Ezért fontos, hogy az AI ne fusson feleslegesen.
- **Ticket:** egy feladatkártya egy táblán (mint a Trello/Jira), amelyen a munka látható és követhető.
- **Control plane (irányítóközpont):** az 1. alkalmazás — az őrzött rész, amely a szabályokat, jogosultságokat és naplózást kezeli.
- **Sandbox / execution plane (munkatér):** a 2. alkalmazás — a szabad rész, ahol a tényleges munka (adat, dashboard, üzleti logika) zajlik.
- **Harness (agent-futtató motor):** a 3. komponens — az a külön szerver, amely ténylegesen "elindítja és gondolkodtatja" az AI-munkatársat: kezeli az eszközhívásait, a fájl- és kódműveleteit. Nem az 1. és nem a 2. app része. **A kiválasztott harness a [Goose](https://goose-docs.ai/)** (nyílt forráskódú, MCP-natív agent-motor; lásd 4.8).
- **MCP (Model Context Protocol):** nyílt szabvány, amellyel az AI-agent egységes módon ér el külső eszközöket/rendszereket. Az [MCP hivatalos bevezetője](https://modelcontextprotocol.io/docs/getting-started/intro) szerint úgy érdemes elképzelni, mint egy standard csatlakozót az AI-alkalmazások és az adatforrások/eszközök között. A Goose minden eszköze ún. *extension* (MCP-szerver) — nálunk ezek mind a Tool Brokeren keresztül kötődnek be (4.8.4).
- **Recipe (Goose-recept):** a Goose deklaratív, paraméterezhető feladatleírása — nálunk ez a tickettípushoz kötött agent-utasítás technikai hordozója (4.8.3).
- **Governance:** "kormányzás" — annak biztosítása, hogy minden szabályozottan, ellenőrizhetően és naplózva történjen.
- **Audit / audit-log:** visszakereshető napló mindenről, ami történt — ez bizonyítja utólag, ki mit csinált.
- **Human-in-the-loop:** "ember a hurokban" — a fontos döntéseket ember hagyja jóvá, mielőtt élesben megtörténnének.
- **API-kulcs:** egyfajta digitális belépőkártya, amellyel egy program (vagy AI-munkatárs) hozzáfér a rendszerhez.
- **RAG (knowledge base):** módszer, amellyel az AI egy dokumentum-/tudásbázisból keres ki releváns információt, mielőtt válaszol.
- **Prompt injection:** támadás, amikor egy feldolgozandó szövegbe (pl. egy számlába) rejtett utasítást csempésznek, hogy az AI-t félrevezessék.
- **Embedding / vektorkeresés:** számokká alakított jelentés — a szöveget egy "jelentés-koordinátává" fordítjuk, így a rendszer nem csak szó szerinti egyezést, hanem *hasonló jelentésű* tartalmat is megtalál. A keresésnél a kulcsszavas és a vektoros találatokat ötvözzük (hibrid keresés).
- **Salience (fontosság):** minden memória-elemhez tartozó "súly"; a gyakran használt tudás felértékelődik, a régóta nem használt elhalványul, de nem törlődik — így a fontos információ kerül előre a visszakereséskor.
- **Heartbeat (proaktív monitor):** csendes háttér-figyelés, amely magától nem zavar, csak akkor nyit feladatot / küld jelzést, ha tényleg fontos esemény történik (pl. közelgő határidő, eltérés egy egyeztetésnél).

---

## 1. Vezetői összefoglaló

> **Közérthetően:** Egy szigorúan őrzött "irányítóközpontot" és egy szabad "munkateret" építünk, plusz egy motort, amely a kettő között ténylegesen futtatja az AI-"munkatársakat". Az irányítóközpont felügyeli, mit csinálhatnak az AI-munkatársak, és mindent naplóz; a munkatérben végzik a tényleges feladatokat; a motor ("harness") pedig az, ami őket elindítja és dolgoztatja. A lényeg: a szabályok és az ellenőrzés egy zárt helyen vannak, a tényleges munka pedig egy rugalmas helyen — így a megoldás egyszerre biztonságos és testreszabható.

A koncepció lényege egy **AI agent platform, amely szétválasztja a *kormányzást* (governance) és a *végrehajtást* (execution)**. Ez a szétválasztás technikailag **három komponensben** valósul meg:

1. **Control Plane — "AI Governance & Orchestration Hub"** (1. alkalmazás)
   Egy szigorúan kontrollált, általunk szállított és karbantartott alkalmazás, amely a Kanban-board / ticket modellen keresztül vezérli az AI agentek és emberek munkáját. Itt történik minden hozzáférés-kezelés, jogosultságkezelés, naplózás, audit, agent-életciklus-menedzsment, tanítás és többszintű jóváhagyás; itt él a **Model Gateway** (modellhívások) és a **Tool Broker** (eszköz-/MCP-hívások) is. Ez a platform a vállalat **megbízhatósági és megfelelőségi (compliance) garanciája**: nem módosítható kontrollálatlanul, minden agent-interakció és tanulási esemény auditálható.

2. **Execution / Sandbox Plane — "Agent Workspace"** (2. alkalmazás)
   Egy ügyfélre szabott, szabadon továbbfejleszthető környezet (UI + adat), amelyben az 1. alkalmazásban definiált agentek munkája megjelenik: dashboardok, adatbázisok, feltöltött dokumentumok és a cég saját, agentekkel is fejleszthető kódbázisa. Ezt az ügyfél, az agentek és mi is fejleszthetjük — itt jön létre a tényleges, testreszabott üzleti érték.

3. **Harness — agent-futtató motor** (3. komponens)
   Egy külön, kontrollált szerver-réteg, amely az agenteket ténylegesen futtatja (reasoning-loop, eszközhívás, fájl- és kódműveletek). A modellt a Model Gateway-en, az eszközöket a Tool Brokeren át hívja, és minden műveletét a control plane-be naplózza. Nem az 1. és nem a 2. app része — saját életciklussal és infrastruktúrával (lásd 3. és 4.8 fejezet).

A **kulcsgondolat**: a kontroll és az audit egy zárt, nem-módosítható rétegben él, miközben az üzleti érték és az innováció egy nyitott, rugalmas rétegben születik, és a kettő között egy kontrollált runtime dolgozik. A rétegek szándékosan külön vannak választva — ez teszi a megoldást egyszerre **enterprise-grade-dé és eladhatóvá**.

### 1.1 A termék három értékpillére

A *fenti három a technikai felépítés* (miből áll a rendszer). Az **üzleti érték** szempontjából a terméket szintén három pillér hordozza — ez egy másik nézet, ne keverjük össze a komponensekkel:

1. **Kontroll** — a governance, audit és jogosultság zárt, nem-módosítható magja (Control Plane, 4. fejezet).
2. **Végrehajtás** — az ügyfélre szabott, szabadon fejleszthető munkatér, ahol a tényleges üzleti érték keletkezik (Execution Plane, 5. fejezet).
3. **Integráció** — a meglévő vállalati rendszerekhez (ERP, könyvelés, e-mail, dokumentumtár, adatbázis, bank/PSP-API) való kapcsolódás (4.12). Architekturálisan **nem önálló komponens, hanem egy first-class, újrahasznosítható, governance alá vont képesség**, amely mindhárom komponenst átfogja: *egyszer integrálunk, minden agent használja*. Enterprise (és mid-market) környezetben az érték nagy része nem az agent "okosságából", hanem abból jön, hogy az agent **eléri és összeköti a már meglévő rendszereket** — rendszercsere nélkül.

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

A kontroll és a végrehajtás szétválasztása természetes módon ad **kétféle bevételi forrást**:

| Réteg | Jellege | Bevételi modell |
|---|---|---|
| Control Plane (1. app) | Termékesített, újrahasznosítható platform | Licenc / SaaS / éves előfizetés + támogatás |
| Execution Plane (2. app) | Ügyfélspecifikus, testreszabott | Tanácsadói / fejlesztői projektbevétel (professional services) |

Ez egészséges felállás: a platform ismételhető és skálázható, a sandbox pedig magas marzsú, ügyfélre szabott munka.

---

## 3. Rendszerarchitektúra áttekintés

> **Közérthetően:** Ez a fejezet madártávlatból mutatja a három komponenst és azt, hogyan kommunikálnak: az őrzött irányítóközpontot (1. app), az agentet futtató motort (harness, 3. komponens) és a munkateret (2. app). A lényeg, hogy az AI-munkatársak minden modell- és eszközhívása két átjárón (Model Gateway, Tool Broker) megy keresztül, így minden mozdulatuk naplózódik.

### 3.1 A három komponens és a harness mint külön szerver-réteg

> **Közérthetően:** Az alábbi ábra a három komponens kapcsolatát mutatja. A harness az a motor, amely ténylegesen "elindítja és gondolkodtatja" az AI-munkatársat. A marveen-ben ezt a Claude Code adja egy gépen; nálunk ez egy **saját, kontrollált szerver** lesz, amely a control plane és a munkatér között dolgozik.

A platform **három komponensből** áll. Az execution plane Next.js appja (Firebase App Hosting / Cloud Run) **csak UI + data plane** (dashboard, feltöltés, REST API) — request/response, állapotmentes. Az agentek **nem ebben futnak**: a **harness** egy külön, hosszan futó / job-alapú szerver, amelyet a dispatcher (4.11) indít, és amely a reasoning-loop, a tool-execution, az MCP-kliens és a fájl-/kódműveletek motorja. Ez **NEM** a control plane és **NEM** az execution plane Next.js appjának része — harmadik komponens, saját életciklussal és infrastruktúrával (lásd 4.8).

```
            ┌─────────────────────────────────────────────────┐
            │  CONTROL PLANE (1. app) — governance, audit,     │
            │  IAM, Playbook, DISPATCHER (4.11),               │
            │  MODEL GATEWAY (4.7) + TOOL BROKER (4.8.4)        │
            └───────┬───────────────────────────────┬─────────┘
                    │ (1) dispatch: "fuss ezen        │ minden modell- és
                    │     a ticketen"                 │ eszközhívás ezen
                    ▼                                 │ a két átjárón megy
            ┌───────────────────────┐                │ → naplózva, szabályokkal kontrollálva
            │  HARNESS (3. komp.)   │◀───────────────┘
            │  agent-futtató motor  │   modell ← Model Gateway
            │  = GOOSE (AAIF/LF)    │   eszköz ← Tool Broker (MCP)
            │  core loop + provider │
            │  abstr. + MCP exten-  │─────────────┐
            │  sions + recipe,      │  dolgozik   │
            │  headless (goose run) │  a 2. appon ▼
            └───────────────────────┘
                                      ┌───────────────────────────┐
                                      │  EXECUTION / SANDBOX (2.app)│
                                      │  Next.js @ Firebase/CloudRun│
                                      │  UI + data plane +          │
                                      │  a cég saját, fejleszthető  │
                                      │  kódbázisa (git)            │
                                      └───────────────────────────┘
```

**A három komponens felelőssége:**

- **Control Plane (1. app):** governance, audit, jogosultság, dispatcher, **Model Gateway** (modellhívások) és **Tool Broker** (eszköz-/MCP-hívások) — *mi szállítjuk, zárt.*
- **Execution Plane (2. app):** ügyfélre szabott UI + adat + **a cég saját, agentekkel is fejleszthető kódbázisa** — *dedikált, céges rész.*
- **Harness (3. komponens):** az agent-futtató motor, amely a 2. app kódján/adatán dolgozik, a modellt a Model Gateway-en, az eszközöket a Tool Brokeren át hívja, és minden műveletét a control plane-be naplózza — *kontrollált runtime.*

> **Kulcsfelismerés a 8.3-ra:** még ha a kész harness belső működésébe nem is látunk minden részletében, attól, hogy **minden modellhívás a Model Gateway-en és minden eszközhívás a Tool Brokeren** keresztül megy, visszanyerjük annak auditálhatóságát, ami üzletileg és compliance szempontból számít — *milyen adathoz fért hozzá, milyen műveletet tett, mennyit költött*. Ez teszi a kész, nyílt forráskódú harnesst (Goose) is enterprise-kompatibilissé.

---

### 3.2 Tool-használati kommunikációs folyamatok (ki kivel beszél, hol az engedélyezés)

> **Közérthetően:** Itt megmutatjuk, *mi történik lépésről lépésre*, amikor egy AI-munkatárs valamilyen eszközt használ — pl. amikor egy feltöltött Excel-táblát kell feldolgoznia, vagy amikor az interneten kell keresnie. A lényeg: az AI-munkatárs (Goose) **soha nem ér el közvetlenül se adatot, se internetet** — minden kérése két "kapun" megy át (Model Gateway a gondolkodáshoz, Tool Broker az eszközökhöz), ahol ellenőrzik, hogy szabad-e, beillesztik a jelszót, és mindent naplóznak. Az alábbi ábrákon a **🔒 jelek az engedélyezési pontok** — ahol a rendszer eldönti, hogy egy lépés végrehajtható-e.

#### 3.2.1 Alapelv — a harness be van zárva két átjáró közé

A Goose önmagában (alapértelmezésben) képes lenne közvetlenül fájlt olvasni, parancsot futtatni és internetre kimenni (a beépített *developer* extension és tetszőleges MCP-extension révén). **Nálunk ezt szándékosan letiltjuk:** a harness konténerének kimenő hálózati szabálya **alapból mindent tilt, és csak konkrétan engedélyezett célokat enged** (`deny-by-default egress`, 4.8.3), és a Goose-nak **csak két kimenő útvonala van**:

```
   GOOSE (harness)
     │  modellhez  ─────────────►  MODEL GATEWAY (4.7)   ──►  LLM (külső API v. lokális)
     │             ◄─────────────                         ◄──
     │  eszközhöz  ─────────────►  TOOL BROKER (4.8.4)    ──►  connector / fájl / web / DB
     │   (MCP)     ◄─────────────   (MCP-proxy)            ◄──
     └── egyéb kimenő hálózat:  ❌ TILTVA (deny-by-default egress)
```

Minden eszköz a Goose számára egy MCP-extension — de ezek **mind a Tool Broker MCP-végpontjára** mutatnak, nem közvetlen szerverekre. Így a Goose natív MCP-támogatása változtatás nélkül használható, de a kontroll a brokerben marad. **A Goose provider-rétege ugyanígy egyetlen végpontra — a Model Gateway-re — van kötve**, nem közvetlenül a modell-szolgáltatókra; a modellválasztás a Gateway-en belül dől el (lásd lentebb).

**A Model Gateway belseje (modellhívás-útvonal, 4.7.1–4.7.2):** itt látszik, *hol* hívódik a modell és *mi dönti el, melyik*:

```
  GOOSE ── prompt ──►  MODEL GATEWAY
                         │
                         │ [opc.] 🔒 SENSITIVITY-AWARE ROUTER (4.7.2) — LOKÁLIS vizsgálat
                         │    ├─ tiszta?        → engedi a routingot tovább
                         │    ├─ érzékeny (PII)?→ KÉNYSZER: lokális modell (nem megy ki)
                         │    └─ tiltott?       → BLOKK / emberi jóváhagyás + audit-flag
                         │
                         │ 🔒 ROUTING-DÖNTÉS (4.7.1, szerveroldali, prioritás):
                         │    1) ticket-szintű felülírás (pl. coding → erős modell)
                         │    2) agent-konfiguráció (Agent Registry, 4.5)
                         │    3) globális policy / költség-fallback
                         │
                         │ 🔒 GUARDRAIL + napló (token/költség, kimenet-validáció)
                         ▼
              ┌──────────────────────┬───────────────────────┐
              ▼                      ▼                       ▼
        KÜLSŐ API              LOKÁLIS / ON-PREM        (fallback /
        (Claude, OpenAI)       modell (Ollama, GPU-szerv) olcsóbb modell)
```

A lényeg: **az agent nem dönti el, melyik modell hívódik** — csak elküldi a promptot a Gateway-nek; a választást a Gateway szabályai (és opcionálisan a tartalom érzékenysége) határozzák meg, szerveroldalon, naplózva.

**Az engedélyezés három szintje (kívülről befelé):**

| Szint | Hol dől el | Mit ellenőriz | Kemény/puha |
|---|---|---|---|
| 🔒 **Ticket-állapotgép** | Control Plane (4.2–4.3) | Egyáltalán elindulhat-e a munka; jóváhagyási kapuk; human-in-the-loop | **Kemény** (szerveroldali) |
| 🔒 **Tool Broker capability** | Control Plane (4.8.4, 8.2) | Ez az agent-verzió hívhatja-e ezt a konkrét eszközt; alapból tiltott, csak explicit engedéllyel mehet | **Kemény** (szerveroldali) |
| 🔒 **Model Gateway — routing + guardrail** | Control Plane (4.7.1) | Melyik modell hívódik (ticket/agent/policy); PII-szűrés, tiltott tartalom, kimenet-validáció, költségkeret | **Kemény** (szerveroldali) |
| 🔒 **Sensitivity-aware router** (opcionális) | Control Plane / Gateway (4.7.2) | Lokális tartalomvizsgálat: érzékeny adat → lokális modell / blokk; mielőtt külső modellhez menne | **Kemény** (szerveroldali, opc.) |
| `GOOSE_MODE` (auto/approve/smart_approve) | Harness (Goose) | Belső, eszközhívás előtti megerősítés | **Puha** (defense-in-depth) |

> **Fontos (4.10.4 elv folytatása):** a Goose beépített `GOOSE_MODE` jóváhagyása hasznos *kiegészítő* réteg, de **nem** erre épül a garancia — mert a harness belső működését nem tekintjük elsődleges compliance-forrásnak. Az **érdemi engedélyezést a Control Plane kényszeríti ki szerveroldalon** (ticket-állapotgép + Tool Broker capability + Model Gateway guardrail), függetlenül attól, mit dönt a Goose belül.

#### 3.2.2 Folyamat A — a user feltölt egy Excel-táblát, és kéri, hogy az agent dolgozzon vele

Példa: a user feltölt egy `forgalom.xlsx`-et, és kéri, hogy a könyvelő agent egyeztesse a banki kivonattal (reconciliation).

```
 USER     EXECUTION    CONTROL PLANE (1.app)       GOOSE         MODELL
          (2.app)      [Gateway+Broker+állapotgép] (harness)     (külső API /
                                                                  lokális)
  │ feltölt   │               │                       │             │
  │ xlsx      │               │                       │             │
  ├──────────►│ data plane     │                       │             │
  │🔒1 RBAC: tölthet-e fel?    │                       │             │
  │           │ ticket:        │                       │             │
  │           │ "egyeztesd"    │                       │             │
  │           ├───────────────►│🔒2 tickettípus +      │             │
  │           │ (fájl = alias)  │  hozzárendelés; Ready │             │
  │           │               ├── dispatch ───────────►│ goose run   │
  │           │               │🔒3 agent capability    │ (recipe)    │
  │           │               │◄── MCP: olvasd a fájlt ─┤ reasoning   │
  │           │               │ TOOL BROKER             │             │
  │           │               │🔒4 capability + secret  │             │
  │           │◄─ fájl-bájtok ─┤  + napló                │             │
  │           │               ├── fájltartalom ────────►│             │
  │           │               │◄── modellhívás (prompt) ┤ "elemezd"   │
  │           │               │ MODEL GATEWAY (4.7)     │             │
  │           │               │🔒5a [opc.] sensitivity- │             │
  │           │               │  router: PII? → lokálra │             │
  │           │               │  kényszerít (4.7.2)     │             │
  │           │               │🔒5b routing-döntés: me- │             │
  │           │               │  lyik modell? (4.7.1) + │             │
  │           │               │  guardrail+token/költség│             │
  │           │               │═ routolt prompt ════════╪════════════►│ modell
  │           │               │◄════ válasz ════════════╪═════════════┤ fut
  │           │               ├── elemzés ─────────────►│ kész → ír a │
  │           │◄─ eredmény ────┤◄── átadó ticket ────────┤ data plane- │
  │           │ (scratch)      │ "Awaiting Human"        │ be + leáll  │
  │◄ dashboard│               │                       │             │
  │ +jóváhagy.│🔒6 human-in-the-loop: rendszerbe-írás   │             │
  │           │  CSAK jóváhagyás után (Tool Brokeren át) │             │

  Jelmagyarázat: ═══╪═══►  = modellhívás, amelyet a MODEL GATEWAY routol
  a kiválasztott modellhez. A nyíl áthalad a Goose sávján, de NEM a Goose
  beszél a modellel — a Gateway brokerálja, naplózza és (opc.) szűri.
```

A folyamat lényege: a feltöltött fájl **soha nem közvetlenül** kerül a Goose-hoz, hanem a Tool Brokeren át (🔒4); a **modell maga önálló szereplő** (jobb szélső sáv), de a Goose nem közvetlenül hívja — a **Model Gateway** routol hozzá (🔒5a/5b), így a prompt érzékenység-szűrésen és modellválasztáson megy át, mielőtt elhagyná a kontrollált határt. A tartalom a modellnél **adat, nem parancs** (6./8.2); az érdemi (rendszerbe-író) lépés pedig **emberi kapun** megy (🔒6).

#### 3.2.3 Folyamat B — az agentnek az interneten kell keresnie

Példa: egy beadvány-előkészítő agentnek utána kell néznie egy aktuális jogszabályi határidőnek.

```
 GOOSE (harness)      CONTROL PLANE              INTERNET     MODELL
                      [Tool Broker + Gateway]                 (külső/lokális)
  │ reasoning: "kell      │                        │            │
  │  web-keresés"         │                        │            │
  │ egress? ❌ TILT       │ (konténer nem tud      │            │
  │ (4.8.3 deny-default)  │  kimenni, csak a        │            │
  │                       │  brokerig jut el)       │            │
  ├─ MCP web_search(q) ──►│                        │            │
  │                       │🔒A capability: van     │            │
  │                       │  "web_search" joga?    │            │
  │                       │  nincs → BLOKK + flag   │            │
  │                       │🔒B allowlist + rate-    │            │
  │                       │  limit + budget         │            │
  │                       ├── egress-proxy ───────►│            │
  │                       │◄── találatok ───────────┤            │
  │                       │🔒C napló: query + meta  │            │
  │◄─ találatok (ADAT) ───┤                        │            │
  │ web = ADAT, nem       │                        │            │
  │  utasítás (6., 8.2)   │                        │            │
  ├─ modellhívás (prompt)►│ MODEL GATEWAY           │            │
  │                       │🔒 [opc.] sensitivity-   │            │
  │                       │  router (4.7.2) +       │            │
  │                       │  routing (4.7.1) +      │            │
  │                       │  guardrail + költség    │            │
  │                       │═ routolt prompt ════════╪═══════════►│ modell
  │                       │◄════ válasz ════════════╪════════════┤ fut
  │◄─ válasz ─────────────┤                        │            │
  │ feldolgozza → ticket- │                        │            │
  │  eredmény; magas       │                        │            │
  │  kockázatú lépés →     │                        │            │
  │  emberi ticket         │                        │            │

  Jelmagyarázat: ═══╪═══►  = modellhívás, amelyet a MODEL GATEWAY routol.
  Az INTERNET és a MODELL két külön külső szereplő; a Goose egyikkel sem
  beszél közvetlenül — a webet a Tool Broker, a modellt a Gateway brokerálja.
```

A kulcs: a Goose **sem az internettel, sem a modellel nem beszél közvetlenül** — a webet a Tool Broker (🔒A/B/C), a modellt a Model Gateway (🔒 router+routing) brokerálja, mindkettő a Control Plane-ben. A kimenő hálózat alapból tiltott (`deny-by-default egress`, 4.8.3); a web-tartalom **adat, nem utasítás** (6./8.2), így a weben keresztüli prompt injection ellen is véd.

#### 3.2.4 Összefoglaló — az engedélyezési pontok egy helyen

| Jel | Engedélyezési pont | Hol kényszerül ki | Mire véd |
|---|---|---|---|
| 🔒1 | Ember-RBAC (feltöltés/művelet) | Control Plane / IAM (4.4) | Jogosulatlan hozzáférés |
| 🔒2 | Tickettípus + hozzárendelés + állapotgép | Control Plane (4.2–4.3) | Nem engedett munka indítása |
| 🔒3 | Agent-capability (erőforrásra) | Control Plane (4.9) | Agent túlterjeszkedése |
| 🔒4 | Tool Broker — capability + secret-injektálás | Control Plane (4.8.4, 4.9.2) | Kulcs-szivárgás, jogosulatlan eszközhívás |
| 🔒5a | Sensitivity-aware router (opcionális) | Control Plane / Gateway (4.7.2) | Érzékeny adat kijutása külső modellhez (→ lokálisra kényszerít / blokkol) |
| 🔒5b | Model Gateway — routing-döntés + guardrail + költség | Control Plane (4.7.1) | Rossz/drága modellválasztás, PII-szivárgás, drift, túlköltés |
| 🔒6 | Human-in-the-loop jóváhagyás | Control Plane (4.10) | Magas kockázatú rendszerbe-írás |
| 🔒A/B/C | Web: capability + allowlist/rate-limit + napló | Tool Broker (4.8.4) | Kontrollálatlan internet-elérés, weben át jövő támadás |

Mindkét folyamatban közös: **a Goose csak a két átjárón keresztül kommunikál**, minden lépés naplózott (8.5), és a külső adat (fájl, web) **adat, nem parancs** (6.).

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

**Külső hivatkozások a döntéshez:** a Clerk dokumentációja szerint az Enterprise SSO SAML- és OIDC-alapú identity provider kapcsolatokkal használható ([Clerk Enterprise SSO docs](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview)). A Keycloak saját dokumentációja szerint standard OpenID Connect, OAuth 2.0 és SAML protokollokra épül, self-hostolt identity serverként ([Keycloak](https://www.keycloak.org/), [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html)). Ezért a döntés nem "Clerk vs. Keycloak" termékhitvita, hanem deployment-kérdés: gyors hostolt prototípushoz Clerk, on-prem/szabályozott környezethez Keycloak.

**Két architekturális szabály, hogy a csere fájdalommentes legyen:**

1. **Humán auth standard OIDC-absztrakció mögött** → a Clerk ↔ Keycloak csere ne igényelje az app újraírását. (A Clerk **nem self-hostolható**, ezért on-premre eleve nem alkalmas.)
2. **Agent-authz NEM a külső auth-providerben.** Az agentek nem humán felhasználók, hanem API-kulcsos service account-ok (4.4, 4.9) → a finomszemcsés jogosultság (ticket-jogok, erőforrás-hozzáférés, jóváhagyási láncok) a **saját control plane-ben** él. Előny: a Clerk per-MAU díja csak az emberekre vonatkozik (az agentek nem drágítják), és a governance-logika auditálhatóan nálunk marad.

*(Megjegyzés: a Clerk SAML/SCIM tier-besorolása a források szerint ellentmondó és gördülő kiadásban van — éles döntés előtt a friss árazás közvetlen ellenőrzése szükséges.)*

#### 4.4.2 Emberi hozzáférés-kezelés — deny-by-default + admin-vezérelt onboarding

> **Közérthetően:** Ahhoz, hogy a rendszer zárt és megbízható legyen, nem elég, hogy be lehet lépni — az is kell, hogy **alapból senki ne lásson és ne tehessen semmit**, amíg egy admin külön engedélyt nem ad neki. Olyan ez, mint egy beléptetőkártya egy banki épülethez: a kártya önmagában csak azonosít, de hogy melyik ajtó nyílik ki vele, azt a biztonsági admin állítja be. Új belépő addig csak egy "várj a jóváhagyásra" képernyőt lát.

A humán hozzáférés alapelve a **deny-by-default**: ami nincs explicit engedélyezve, az tiltott. Ugyanez a logika érvényes az agentek eszközjogaira is (8.2). Az **autentikációt** (ki ő) az auth-provider (Clerk/Keycloak) adja a 4.4.1 absztrakció mögött; az **autorizációt** (mit szabad neki) a control plane dönti el, auditálhatóan. Így a Keycloak-csere (banki upgrade-path, 8.7) ezt a réteget nem érinti.

A felhasználónak két jellemzője van: egy **szerepkör** (admin / approver / operator / viewer — 4.3) és egy **státusz** (`pending` / `active` / `suspended`). A kettő együtt dönt a hozzáférésről:

- **Admin-meghívás (elsődleges út):** az admin egy **lejáró, egyszer beváltható meghívóval** hív be valakit, már a kívánt szerepkörrel. A meghívó ugyanazt a token-filozófiát követi, mint a tanítás write-gate-je (4.6.1): aláírt, rövid életű, nem visszajátszható. A beváltás összeköti az auth-identitást az előre kiosztott szereppel — a felhasználó rögtön `active`.
- **Önregisztráció (másodlagos, opcionális):** ha valaki magától regisztrál, a fiókja `pending` státuszban, **szerepkör nélkül** jön létre → **semmihez nem fér hozzá**, csak egy "admin-jóváhagyásra vár" képernyőt lát. Az admin szerepkör-kiosztással teszi `active`-vá. Opcionális **domain-allowlist** szűri, ki regisztrálhat egyáltalán.
- **Offboarding / felfüggesztés:** a `suspended` státusz azonnal megvonja a hozzáférést (a humán megfelelője a 4.9.4 finomszemcsés kill-switchnek), miközben a felhasználói rekord és az auditnyom megmarad (non-repudiation).

**Védőkorlátok:** az utolsó aktív admin nem fokozható le és nem zárható ki (lock-out elleni biztosíték); admin a saját szerepét/státuszát nem írhatja át (a négy-szem-elv minimuma, 7.). **Minden hozzáférési esemény** (meghívás, beváltás, szerepkiosztás, felfüggesztés) **hash-láncolt auditesemény** — így a *"ki adott kinek jogot, mikor"* compliance-kérdés bizonyíthatóan megválaszolható.

**Hol valósul meg:** ennek az alapból tiltó, admin által engedélyező user-provisioningnak a kemény, szerveroldali kikényszerítése a **Fázis 2** (governance) része — a Fázis 1 csak a szerepkör-mezőt vezeti be, a tényleges hozzáférés-kaput a Fázis 2 zárja be.

**Fázis 3 terv — erőforrás-szintű emberi hozzáférés:** a 4 szerepkörnél finomabb láthatóság, ahol egy felhasználó csak bizonyos **agenteket, Playbookokat vagy ticket-típusokat** lát/kezel (pl. egy ügyfél-osztály csak a saját agentjeit). Ezt a meglévő erőforrás-modell (4.9.1) és jóváhagyási láncok emberi oldalra történő kiterjesztése adja — multi-tenant és nagyobb szervezeteknél válik fontossá, ezért a valódi use case élesedéssel (integráció, több felhasználói csoport) együtt, a Fázis 3-ban épül ki.

### 4.5 Agent Registry & életciklus

> **Közérthetően:** Itt "születik meg" egy AI-munkatárs. Megadjuk, mi a feladata, mihez férhet hozzá, melyik AI-modellt használja. És akárcsak egy alkalmazottnál, itt is van életciklus: felvétel, betanítás, munkába állás, felügyelet, és ha kell, "nyugdíjazás". Minden korábbi változata el van mentve, hogy később pontosan vissza lehessen nézni, melyik verzió mit csinált.

Egy AI munkatárs létrehozása itt történik. Egy agent rekord tartalmazza:

- nevét, szerepét, feladatleírását (system prompt / instrukció),
- jogosultságkészletét (mihez fér hozzá a boardon és a 2. appban),
- **modell-konfigurációját** (lásd 4.7),
- memória-/tudásállapotát (verziózva),
- API-kulcsait (scoped, rotálható).

**Az instrukció két rétege — szerep vs. viselkedés (marveen-minta).** Az agent-instrukciót érdemes két, külön verziózott részre bontani (a marveen `CLAUDE.md` / `SOUL.md` szétválasztásának higiéniai mintájára): (1) **szerep-instrukció** — *mi a feladata és hogyan végzi* (a tényleges munkavégzés leírása); (2) **viselkedés-profil** — *milyen hangnemben, milyen kommunikációs és formázási szabályokkal* dolgozik (pl. tényközpontú, tömör, magyar nyelv, citálási kötelezettség). Enterprise-ban a "személyiség" másodlagos, de a szétválasztás akkor is hasznos: a viselkedés-profil **megosztott, újrahasznosítható erőforrásként** (4.9.1) köthető több agentre (egységes céges hangnem és output-szabvány), miközben a szerep-instrukció agent-egyedi marad. Mindkettő külön verziózott és a write-gate (4.6.1) hatálya alá esik — vagyis a hangnem/output-szabvány módosítása is jóváhagyott, auditált változás, nem ad-hoc prompt-átírás.

Az életciklus: **Létrehozás → Konfiguráció → Teszt/Eval → Élesítés → Monitorozás → Nyugdíjazás.** Minden agent **verziózott**: bármely lezárt ticketre visszakereshető, melyik agent-verzió, milyen modellel, milyen memóriaállapottal dolgozott (reprodukálhatóság).

### 4.6 Tanítás és memória — jóváhagyott tudásfrissítés

> **Közérthetően:** Hogyan "tanul" egy AI-munkatárs? Úgy, hogy frissítjük a tudását (a "memóriáját"). Ez kényes pont: ha bárki, bármikor, ellenőrzés nélkül átírhatná, a munkatárs megbízhatatlanná válna. Ezért nálunk a tanulás olyan, mint egy hivatalos dokumentum módosítása: javaslat születik, valaki jóváhagyja, és csak utána lép életbe — ráadásul bármikor visszavonható, ha mégsem vált be.

A tanítás a platform legérzékenyebb és legértékesebb mechanizmusa, ezért kontrollált:

1. Egy **tanítási ticket** *javasolt* tudásfrissítést hordoz (új tény, szabály, példa, korrekció).
2. A javaslat **nem kerül azonnal élesbe** — a memória **verziózott**, a frissítés egy *diff* (mi változna).
3. A diff **jóváhagyási láncon** megy át (ember vagy magasabb jogú szerep), opcionálisan **eval-kapun** (a frissített agent nem romlik-e egy tesztkészleten).
4. Jóváhagyás után a memória új verzióra promótálódik; **bármikor visszagörgethető** (rollback).

Ez egyszerre véd a **memória-mérgezés** (prompt/knowledge poisoning) ellen és ad teljes auditnyomot a "hogyan tanult az agent" kérdésre — ami szabályozott környezetben aranyat ér.

**Az írás mellett az olvasás is része a képnek (retrieval + working memory).** A fentiek azt írják le, *hogyan íródik* a memória (kontrollált, jóváhagyott). Ahhoz, hogy a sztori teljes legyen, két dolgot itt is rögzítünk:

- **Retrieval (hogyan kerül a jóváhagyott memória a kontextusba):** MVP-ben a memória kicsi, ezért **egészében beinjektáljuk** az agent kontextusába futásidőben (a `MemoryStore` csereponton át — 4.13). Ha egy ügyfélnél a tudás nagyra nő, ugyanez a cserepont enged áttérni *relevancia-alapú visszakeresésre* (lásd 4.6.2). A retrieval mindig **olvasás** — a write-gate nem érinti.
- **Working / epizodikus memória (a ticket-futáson belül):** a Goose-session munkamemóriája (a 4.8.3 efemer munkaterületén) **csak az adott ticket végrehajtásáig él**, és **nem keveredik** a kontrollált, hosszú távú tudással: alapból eldobódik a futás végén. Ami belőle megőrzendő tanulság, az **csak tanítási ticketként, jóváhagyással** kerülhet át a tartós memóriába (4.6.1). Így a "gyors, futásidejű jegyzet" és a "kontrollált tudás" szándékosan külön réteg.

#### 4.6.1 Memória-írás zárolása szerveroldali aláírt tokennel (write-gate)

A memória felülírása **csak a platform által, kontrollált csővezetéken** történhet — soha nem egy agent saját döntéséből, és főleg nem egy külső beszélgetés/prompt hatására. A mechanizmus:

- Amikor a platformon **tanítási ticket** jön létre, az alkalmazás **maga generál** hozzá egy **egyedi, egyszer használatos, aláírt tokent** (write-gate kód), amely **az adott ticketre és az adott memória-verzióra van kötve**.
- A memória-író szolgáltatás **csak ezt a tokent fogadja el**: token nélkül (vagy hibás/lejárt/már felhasznált tokennel) **nem ír memóriát**. Így egy másik forrásból ("tanulj meg ezt…" típusú külső prompt) **nem lehet** az agentet tanulásra rávenni.
- **Kulcsfontosságú finomítás (biztonsági okból):** a tokent **a platform tartja szerveroldalon**, az agent **nem birtokolja és nem adja tovább** — különben egy prompt injection ki tudná csalni vagy újra le tudná játszani. A modell legfeljebb *javasol* egy tudásfrissítést (tartalom), de a **tényleges írást a platform végzi**, miután a javaslat átment a jóváhagyáson, és a platform a saját tokenjével engedélyezi.
- A token **egyszer használatos** és **a jóváhagyott diffhez kötött** — így a write nem hamisítható és nem ismételhető.

> Gyakorlatban: a "titkos kód" = a platform által kiállított, aláírt, egyszer használatos *capability*, amely egy konkrét, jóváhagyott tanítási tickethez és memória-verzióhoz tartozik. Ez teszi a tanulást **nem hamisíthatóvá** — pontosan az a garancia, ami egy banknak kell.

#### 4.6.2 Memória-olvasás (retrieval): hibrid keresés salience-szel — elhalasztott terv

> **Közérthetően:** A 4.6.1 azt írta le, *hogyan íródik* a memória (kontrolláltan, jóváhagyással). Itt arról van szó, *hogyan találja meg* az agent a sok jóváhagyott tudásból azt a keveset, ami az adott feladathoz kell. A belső tudás-asszisztens pilotban a memória kicsi, ezért **egyszerű teljes beinjektálással** indul; a hibrid keresés csak akkor kerül terítékre, ha a tudásbázis mérete vagy egyedi ügyfélkérés indokolja (lásd Elhalasztott döntések, 10.B).

A retrieval **tisztán olvasás**: nem érinti a write-gate-et (4.6.1), kizárólag azt dönti el, a *már jóváhagyott* memóriából mi kerüljön be az agent kontextusába futásidőben. A `MemoryStore` cserepont (4.13) mögött a kiépítési sorrend:

1. **MVP — teljes beinjektálás.** Kis memóriánál a teljes (jóváhagyott) tudás bemegy a kontextusba. Egyszerű, determinisztikus, semmilyen keresési hiba nem rejt el releváns tudást.
2. **Skálázódáskor — relevancia-alapú hibrid keresés** (a marveen működő mintája alapján). Három, egymást kiegészítő réteg:
   - **Kulcsszavas full-text keresés** (pl. SQLite FTS5): gyors, pontos a konkrét terminusokra (számlaszám, főkönyvi szám, ügyfélnév).
   - **Vektor- / szemantikus keresés** *lokális* embeddinggel (pl. Ollama + `nomic-embed-text`): a hasonló *jelentésű* tudást is megtalálja, akkor is, ha más szóval van leírva.
   - **Hibrid összefűzés Reciprocal Rank Fusion-nal (RRF):** a kétféle találati listát egy rangsorba olvasztja — a gyakorlatban ez ad jobb eredményt, mint bármelyik önmagában.
3. **Salience (fontosság) súlyozás:** minden memória-elem kap egy fontossági súlyt; a gyakran visszakeresett tudás felértékelődik, a régóta nem használt fokozatosan **elhalványul (decay), de soha nem törlődik automatikusan**. A retrieval a salience-t is figyelembe veszi a rangsorolásnál.

**Miért illik ez pont a mi modellünkbe:**

- A retrieval **olvasás-oldali**, ezért **ortogonális a write-gate-tel**: a marveen a jó *olvasást* adja, mi a kontrollált *írást* — a kettő ütközés nélkül kombinálható.
- A **lokális embedding** egybevág az "adat nem hagyja el a céget" sztorival (4.7.2, 8.7): a jelentés-vektorok számítása helyben történik, nem megy ki külső szolgáltatóhoz.
- Az embedding-számítás **a Tool Brokeren át** (4.8.4), explicit eszközjoggal és napló-kontroll alatt fut — nem közvetlen, kontrollálatlan hívás (szemben a marveen közvetlen megoldásával).
- A salience-decay determinisztikus, **nem-LLM** mechanizmus (nulla token), így olcsón fut a háttérben — illeszkedik a token-ökonómiához (4.11).

**Auditálhatóság:** a retrieval **maga is naplózható esemény** — visszakereshető, hogy egy adott ticket-futásnál *melyik memória-verziókat és -elemeket* húzta be az agent a kontextusába. Ez a reprodukálhatóság (4.5) része: nem csak az látszik, *melyik* memória-verzió volt érvényes, hanem az is, *mit olvasott ki belőle* ténylegesen.

#### 4.6.3 Reflexió mint tanítási-ticket feeder (governance-konform "öntanulás")

> **Közérthetően:** A marveen egyik legerősebb képessége, hogy az agensek **maguktól tanulnak** a munkájukból: ha észrevesznek egy ismétlődő mintát, automatikusan új "képességet" (skillt) hoznak létre vagy javítják a meglévőt. Ez nagyon hasznos — *de* nálunk pont az a tilos, hogy az agent kontroll nélkül módosítsa önmagát. A megoldás: a hasznos *mechanizmust* átvesszük, de nem hagyjuk, hogy magától életbe lépjen. Az agent **javasol**, az ember (vagy a jóváhagyási lánc) **dönt**.

A marveen automatikus öntanulása (auto-skill generálás triggerekre — 5+ eszközhívásos feladat, hiba utáni sikeres recovery, felhasználói korrekció; skill-patch; skill-factory meta-skill) a mi koncepciónk szerint **közvetlen formában tilos**, mert jóváhagyás nélkül változtatja meg az agentet (2., 8.1). A *mechanizmus* azonban átvehető, ha **bekötjük a write-gate elé** mint javaslat-generátort:

1. **Reflexiós trigger.** A ticket-futás végén (vagy a Goose-session lezárásakor) egy **determinisztikus feltétel** dönt, érdemes-e reflexióra: pl. szokatlanul sok eszközhívás, hiba utáni recovery, felhasználói korrekció, ismétlődő minta. Ez **nem pollozó** — eseményhez kötött, ticketenként legfeljebb egyszer fut (token-ökonómia, 4.11).
2. **Javaslat, nem írás.** A reflexió kimenete **kizárólag egy javasolt tudásfrissítés vagy recipe-finomítás** (diff), amely **automatikusan tanítási tickettet hoz létre** (4.6) — semmi nem íródik a memóriába vagy a recipe-be ezen a ponton.
3. **A meglévő kapu fut tovább.** Innen a 4.6.1 write-gate folyamata megy: jóváhagyási lánc → opcionális eval-kapu → verzió-promóció a platform aláírt tokenjével → rollback-lehetőség.

**Mit nyerünk vele:** megkapjuk a marveen "az agent tanul a munkájából, és egyre jobb lesz" élményét, **anélkül, hogy feladnánk a fő differenciátorunkat** ("az AI nálunk nem driftel el észrevétlenül", 8.1). A különbség egyetlen, de döntő architekturális elv:

| | marveen | A mi modellünk |
|---|---|---|
| Mit csinál a reflexió | **közvetlenül megírja/patcheli** a skillt | **tanítási tickettet javasol** |
| Mikor lép életbe | azonnal, automatikusan | csak **jóváhagyás után** |
| Visszavonható | nincs explicit rollback | **verziózott + rollback** (4.6.1) |
| Auditnyom | nincs | minden javaslat és döntés naplózott |

Ez egyúttal a demó tanítási ciklusát (MVP-terv 3., 6. lépés) teszi élővé: a korrekció nem külső kézi beavatkozás, hanem az agent saját, reflexióból született javaslata, ami a kapun megy át.

### 4.7 Model Gateway — modellabsztrakció

> **Közérthetően:** A "Model Gateway" egy univerzális adapter az AI-motorok felé. Az AI-munkatárs nem közvetlenül beszél a háttérben dolgozó AI-modellel (pl. Claude, vagy egy saját, helyben telepített modell), hanem ezen az adapteren keresztül. Előnye: bármikor lecserélhető, melyik modellt használja (akár külső, akár saját), és egy helyen mérhető a költség, valamint itt kényszeríthetők ki a biztonsági szűrők.

Az agentek **nem közvetlenül** hívnak modellt, hanem egy belső **Model Gateway**-en keresztül. Ez:

- absztrahálja, hogy az adott agent **külső API**-t (pl. Claude, OpenAI) vagy **lokálisan telepített modellt** használ-e,
- agentenként konfigurálható (API-kulcs, modell, paraméterek),
- **központilag naplózza** a prompt/response párokat, a token- és költségadatokat,
- egységesen alkalmazza a **guardrail**-eket (PII-szűrés, tiltott tartalom, kimeneti validáció).

**Modellstratégia (eldöntött):** az első körben használt modellek az **OpenAI előfizetés** (ChatGPT Plus/Teams — nem API-alapú integráció) és a **Gemini API**. Saját model hosting nem cél az első pilotban; ez **2. fázis, csak konkrét ügyfélkérés esetén** kerül terítékre. A Gateway architektúra ezt a döntést bármikor változtatás nélkül követi: az "adat nem hagyja el a céget" sztori egyelőre az API-szintű adatkezelési feltételeken alapul; saját modellnél a Gateway routing-szabálya változik, az agentek kódja nem.

A hosszú távú vízió: nagyvállalatnál egy **külön szerverre telepített, csak a cég számára elérhető lokális modell**, amelyhez senki külső nem fér hozzá az adatokkal. A Gateway teszi lehetővé, hogy ugyanaz az agent külső modellről átálljon lokálisra a kód módosítása nélkül.

#### 4.7.1 Hol hívódik a modell, és mi dönti el, melyik modell? (a routing-pont)

> **Közérthetően:** Amikor az AI-munkatársnak "gondolkodnia" kell, küld egy kérést a Model Gateway-nek. A Gateway az a **belső telefonközpont**, amely eldönti, *melyik* AI-motort kapcsolja — egy külsőt (pl. Claude) vagy a cég saját, helyben futó modelljét —, beilleszti a megfelelő API-kulcsot, naplóz, majd visszaadja a választ. Az agent maga **nem tudja és nem dönti el**, melyik modellhez megy a kérése; ezt a Gateway szabálya dönti.

A Goose **provider-rétege** nem közvetlenül a modell-szolgáltatókra, hanem **egyetlen végpontra — a Model Gateway-re — van konfigurálva** (OpenAI-kompatibilis / belső API). Így minden "gondolkodási" kérés (a reasoning-loop minden lépése) a Gateway-en megy át. A **routing-döntés a Gateway-ben, szerveroldalon** születik, az alábbi prioritással:

1. **Ticket-szintű felülírás** (ha a tickettípus vagy a Playbook konkrét modellt ír elő — pl. „coding ticket → erős coding-modell", 4.8.2).
2. **Agent-konfiguráció** (az Agent Registry, 4.5, alapértelmezett modellje).
3. **Globális policy / fallback** (pl. költségplafonnál olcsóbb modellre vált, vagy külső kiesésnél lokálisra).

A döntés bemenetei tehát: *melyik agent-verzió, milyen tickettípus, milyen policy, milyen költségkeret van érvényben* — mind a Control Plane-ből, determinisztikusan. A modellhívás maga az egyetlen pont, ahol a tartalom (prompt) elhagyhatja a kontrollált határt egy külső modell felé — **ezért itt a legfontosabb a 4.7.2 szűrő.**

#### 4.7.2 Érzékenység-tudatos modellválasztó (sensitivity-aware router) — elhalasztott terv

> **Közérthetően:** Mielőtt egy kérés külső AI-hoz menne, jó lenne előbb **helyben megnézni, mi van benne** — és ha érzékeny adatot tartalmaz (személyes adat, banki azonosító, titok), akkor **ne engedjük ki külső szolgáltatóhoz**, hanem irányítsuk a cég saját, helyi modelljéhez (vagy állítsuk meg). Ez egy erős védelmi réteg lenne — de **egyelőre nem implementáljuk**: a döntés szerint csak konkrét ügyfélkérés vagy szabályozói elvárás esetén kerül megvalósításra (lásd Elhalasztott döntések, 10.B).

A Gateway routing-döntése elé beilleszthető egy **lokálisan futó osztályozó (pre-flight classifier)**, amely a kimenő promptot/payloadot **még a modellválasztás előtt megvizsgálja**, és csak feltétel teljesülése esetén enged egyik vagy másik irányba:

- **Lokálisan fut** (nem-LLM mintaillesztés/NER, vagy egy kis **lokális** modell) — maga a vizsgálat **nem szivárogtat** ki adatot.
- **Mit néz:** PII, banki/kártyaadat (PAN, IBAN), titkok, ügyfél-azonosító, szabályozott adatosztály — konfigurálható szabályokkal és adat-címkékkel.
- **Mit dönt (policy-vezérelt):**
  - *tiszta* (nincs érzékeny adat) → engedi a külső modellt (olcsóbb/erősebb),
  - *érzékeny* → **kötelezően a lokális/on-prem modellre** routol (az adat nem hagyja el a céget),
  - *túl kockázatos / tiltott osztály* → **blokkol vagy emberi jóváhagyást kér** (human-in-the-loop), és auditba flag-eli.
- **Redakció opció:** bizonyos eseteknél nem blokkol, hanem **maszkolja/tokenizálja** az érzékeny mezőket, és csak a redaktált promptot engedi külső modellhez (a válaszban visszaállítva).

Ez a router a 8.2 (prompt injection / adatszivárgás) és a 8.7 ("az adat nem hagyja el a céget") sztorit kapcsolja össze: a deployment-szintű "lokális modell" ígéret mellé **tartalom-szintű, bizonyítható garanciát** ad. Megvalósításként a Gateway egy köztes lépése — ugyanaz a determinisztikus, szerveroldali kikényszerítés elve, mint a Tool Brokernél (4.8.4). **Ez a komponens belátható időn belül nem kerül implementálásra** — szabályozott ügyfélnél (bank/PSP), ahol a tartalom-szintű garancia elvárás, akkor döntünk a konkrét megvalósításról.

### 4.8 Agent-runtime és harness (a végrehajtó motor)

> **Közérthetően:** A "harness" az a motor, amely az AI-munkatársat ténylegesen futtatja: fogadja a feladatot, gondolkodtatja a modellt, meghívja az eszközöket, fájlokat és kódot szerkeszt, majd leáll. A marveen-ben ezt a Claude Code adja egy gépen. Nálunk ez egy **saját, kontrollált szerver** (3.1), és a **kiválasztott motor a Goose** — egy nyílt forráskódú, MCP-natív, modell-független agent-motor. A kódolás (mert a cég a saját rendszerét is fejlesztheti az agentekkel) nem a Goose belső erősségén múlik, hanem azon, hogy a Goose-hoz **erős coding-modellt kapcsolunk** a Model Gateway-en át (lásd 4.8.2). Itt indokoljuk meg a Goose-választást, és írjuk le, milyen szerver kell hozzá.

#### 4.8.1 Követelmények a harness-szel szemben

A koncepció egészéből levezetett kemény elvárások:

1. **Nyílt forráskódú**, kereskedelmi beágyazást engedő licenc. A zárt megoldások (pl. Claude Agent SDK) **kiesnek**: drágák, a szállító modelljéhez kötöttek, és nem futtathatók tetszőleges (lokális) modellen. A drágaság/megbízhatatlanság fő oka amúgy is a **modell**, nem a harness — ezért a harness feladata, hogy *szabadon cserélhető* modellt adjon.
2. **Modell-agnoszticitás + routing:** minden agent (sőt ideálisan minden ticket) **külön modellt** kaphasson — külső API vagy **lokálisan hostolt** modell — a Model Gateway-en (4.7) keresztül. Ez a jelenlegi "agentenként modellválasztás" kiterjesztése ticket-szintre.
3. **Kódolásban használható:** hosszú távon a cég a saját (2. app) területét az agentekkel is fejleszti. A Goose általános agent (nem coding-specialista), ezért a coding-erősséget **nem a harness loopja, hanem a Model Gateway-en (4.7) routolt erős coding-modell + coding-fókuszú MCP-extension-ök** adják (lásd 4.8.2 gap-mitigáció). A coding így *képesség-szintű* követelmény, amit modellválasztással és eszközökkel elégítünk ki.
4. **Headless / beágyazható szerver-mód:** API-n vezérelhető, mert a **dispatcher hajtja** (4.11), nem ember ül a terminál előtt.
5. **MCP-támogatás:** a connector-modellünk (4.12) MCP-re épül; a harness natívan beszéljen MCP-t.
6. **Audit-/kontroll-kapcsolódási pontok:** a belső lépések (modell- és eszközhívás) kivezethetők a control plane naplójába — ezt a Model Gateway + Tool Broker biztosítja (3.1, 8.3, 8.5).

#### 4.8.2 Döntési mátrix

A jelölteket a fenti kritériumokra súlyozva pontoztuk (1–5; a kódolás-erősség és a beágyazhatóság kapja a legnagyobb súlyt, mert ezek a termék-kritikus, kötelező elemek):

| Kritérium (súly) | OpenCode | Codex CLI | Goose | Saját loop* |
|---|---|---|---|---|
| Kódolás-erősség (25%) | 5 | 5 | 3 | 2 |
| Modell-agnoszticitás + routing, lokális is (20%) | 5 | 3 | 5 | 5 |
| Headless / beágyazható szerver-mód (20%) | 5 | 3 | 4 | 5 |
| MCP-támogatás (10%) | 4 | 4 | 5 | 4 |
| Licenc beágyazásra (10%) | 5 (MIT) | 5 (Apache-2.0) | 5 (Apache-2.0) | 5 (saját) |
| Audit-/kontroll-kapcsolódási pontok (10%) | 3 | 3 | 4 | 5 |
| Neutralitás / fenntarthatóság (5%) | 3 | 2 | 5 | 5 |
| **Súlyozott összpont (max 5,0)** | **4,6** | **3,75** | **4,2** | **4,15** |

*Saját loop = vékony, saját agent-loop egy könnyű frameworkön (pl. Vercel AI SDK, LangGraph, Pydantic AI) + MCP-kliens.

**Döntés: Goose.** A mátrix nyers pontszámán az OpenCode vezet (4,6 vs 4,2), elsősorban a kódolás-specializáció miatt. A **stratégiai döntés mégis a Goose**, mert a termék fő differenciátora nem a coding-él, hanem a **kontrollált, auditálható, vendor-független governance** (2. és 7. fejezet) — és ezen a tengelyen a Goose erősebb illeszkedés. A Goose hivatalos dokumentációja CLI-t, desktopot és API-t említ, valamint általános célú, eszközökkel bővíthető agentként írja le ([Goose docs](https://goose-docs.ai/)); az AAIF projektoldala szintén nyílt, több LLM-mel használható agentként pozicionálja ([AAIF Goose](https://aaif.io/projects/goose/)).

- **Vendor-neutralitás mint compliance-eszköz.** A Goose az **Agentic AI Foundation (Linux Foundation)** alá került → szabályozott/banki beszerzésnél (8.7 upgrade-path) a "nem egyetlen cég kontrollálja" sztori önmagában értékesítési érv. A Linux Foundation bejelentése a goose-t nyílt, local-first agent frameworkként írja le, MCP-alapú integrációval ([Linux Foundation announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)). Apache-2.0, kereskedelmi beágyazás engedett.
- **MCP-natív a magjában.** A Goose minden eszköze *extension* (MCP-szerver) → a Tool Broker (4.8.4) mint MCP-proxy **változtatás nélkül** illeszkedik; nincs külön adapterréteg.
- **Headless + recipe = dispatcher-barát.** A `goose run` non-interaktív mód (`--no-session`, `GOOSE_MODE`, text/json/stream-json kimenet) pont a dispatcher (4.11) mögé való; a **recipe** (deklaratív, paraméterezhető feladatleírás) a tickettípus-szintű agent-utasítás természetes hordozója.
- **Provider-absztrakció + lokális modell.** Bármely LLM, beleértve a lokálisat (Ollama) → az "adat nem hagyja el a céget" történet (4.7, 8.7) natívan megvan.
- **Beépített jóváhagyási mód** (`GOOSE_MODE=approve/smart_approve`) → defense-in-depth a szerveroldali kapuk mellé (3.2.1).

**A coding-gap mitigációja** (mert a Goose nem coding-specialista): a kódfeladatoknál (a) a **Model Gateway-en erős coding-modellt routolunk** az adott tickethez (modell-agnoszticitás, 4.7), (b) **coding-fókuszú MCP-extension-öket** kötünk be a Tool Brokeren át, és (c) a kódhandoff a git-branch → emberi review → merge csővezetéken megy (4.8.3, 8.4), ami a harness nyers coding-erősségét kevésbé kritikussá teszi. A Goose az egyedüli harness — a coding-erő a modellválasztáson, nem külön harness-váltáson múlik.

**A többi jelölt szerepe a Goose-döntés mellett:**

- **OpenCode — [DÖNTVE: nem használjuk].** Kódolásban erős, de a döntés szerint nincs OpenCode fallback. A coding-erőt a Model Gateway-en routolt modellválasztással oldjuk meg (4.7.1), nem külön harness-váltással.
- **Saját loop — a legjobb audit/kontroll** (white-box), hosszú távú / hibrid opció magas-audit, egyszerűbb folyamat-ticketekre — de teljes harnessként rövid távon túl drága.
- **Codex CLI — kiesett.** A legkevésbé neutrális (OpenAI-hangolt), ami pont a Goose melletti fő érv (neutralitás) ellen hat.

> **Caveat:** a pontszámok szakértői becslések, és a döntés a Goose mellett **stratégiai** (governance-illeszkedés), nem nyers-pont alapú. Éles indulás előtt **gyakorlati spike** kell: a Goose valós kódolási minősége a routolt modellel, lokális modell tool-use megbízhatósága, a `goose run`/recipe beágyazása a dispatcher mögé, a developer-extension lezárása (3.2.1), és költség/eval mérés (10. fejezet).

#### 4.8.3 Harness-infrastruktúra (milyen szerver kell)

A harness **külön szerver-komponens** (3.1), nem a Next.js request-útvonala. A Goose egyetlen, statikusan linkelt **Rust-bináris** → könnyű konténerizálni, gyors hidegindítás, kicsi image. Két futtatási formája van, mindkettő illeszkedik a modellünkhöz:

- **Headless `goose run` (ticketenkénti Cloud Run Job — eldöntött alapértelmezés):** a dispatcher (4.11) egy `Ready` ticketnél elindít egy Cloud Run Jobot; a konténer mountolja/klónozza a 2. app repóját, betölti a **tickethez tartozó recipe-t** (tickettípus-szintű utasítás), lefuttatja a Goose-t a végéig (`--no-session`, `GOOSE_MODE` szerint; kódfeladatnál **branchre commitol**), strukturált (json/stream-json) kimenetet ad, majd kilép. A Cloud Run Jobs dokumentációja szerint a job olyan konténerfuttatásra való, amely lefut és kilép, nem állandó HTTP-kiszolgálásra ([Cloud Run Jobs](https://docs.cloud.google.com/run/docs/create-jobs)) — ezért illeszkedik a ticketenkénti agent-futáshoz. Pay-per-run, scale-to-zero — pontosan a "drága LLM csak valódi munkára indul" elv.
- **Perzisztens `goosed` szerver (min-instance ≥ 1) / VM / GKE:** a Goose háttér-daemonja (API) interaktív vagy hosszú dev-sessionhöz, magas áteresztéshez — "always-on worker". A saját (2. app) UI ráépíthető a Goose API-jára, ha interaktív munkaélmény kell.
- **On-prem konténer (banki upgrade-path, 8.7):** ugyanaz a Goose-konténer a cég saját adatközpontjában; a provider-absztrakcióval **lokális modellre** (Ollama) állítva az adat és a modell **nem hagyja el a céget**. Apache-2.0 + AAIF/Linux Foundation → a beszerzés és a self-host jogtisztán megoldható.
- **Izoláció + a developer-extension lezárása (8.4, 3.2.1) — Goose-specifikus kritikus lépés:** minden futás saját konténerben, **efemer munkaterülettel**; a kimenő hálózat alapból tiltott, és csak a Model Gateway / Tool Broker irányába engedett. A Goose alapból tartalmaz egy **developer extension-t shell-hozzáféréssel** és tetszőleges MCP-extension köthető be — ezt **konfigurációval le kell zárni**: a Goose csak a Tool Broker MCP-végpontját lássa extensionként, a shell/fájl-művelet csak a sandbox efemer munkaterületére korlátozódjon, közvetlen rendszer- és internet-elérés nélkül. A harness írhat kódot, de **közvetlenül nem deploy-olhat**.
- **Git-alapú handoff (5.3, 8.4):** a coding agent a sandbox repóban **branchre commitol** → fejlesztési ticket → emberi review → merge. Sosem közvetlen prod-deploy az agent kezéből.
- **Trusted internal runtime (8.3):** ez a kontrollált felhős/on-prem Goose a "megbízható belső runtime" — szemben a laptop-Coworkkal (4.8.5).
- **Erőforrás-szétválasztás:** a Goose-konténer CPU/RAM-igénye ≠ a **lokális modell GPU-igénye**. Ha lokális LLM kell, az **külön (GPU-)szerver** a Model Gateway mögött — ne keverd a harness-szel.

**Recipe ↔ Playbook elhatárolás (Goose-specifikus tisztázás):** a Goose-recipe a *tickettípus szintű, „hogyan végezd” utasítás* technikai hordozója (agent-privát, 4.10.4) — **nem** a folyamat-flow. A több agentet átfogó *flow* továbbra is a Control Plane **Playbookja** (4.10.2), a kötelező kapukat pedig a **ticket-állapotgép** kényszeríti ki szerveroldalon. Vagyis a recipe a Goose belső munkavégzését írja le, a kemény governance a Control Plane-ben marad.

#### 4.8.4 Tool Broker — eszköz-/MCP-átjáró (a Model Gateway tükörképe)

> **Közérthetően:** Ahhoz, hogy egy AI-munkatárs hasznos legyen, eszközöket kell tudnia használni: emailt olvasni, adatbázist lekérdezni, fájlt szerkeszteni. A Goose ezt natívan tudja (MCP-extension-ökön át) — DE ha közvetlenül kötnénk rá a valódi rendszerekre, elveszne a kontroll: a jelszavak a futtatókörnyezetbe kerülnének, és nem lenne egységes napló arról, mit csinált. A **Tool Broker** egy átjáró, amin **minden eszközhívás átmegy** — ő dönti el, mit szabad, ő teszi be a jelszót, és ő naplóz mindent.

A 4.7 Model Gateway a *modellhívásokat* brokerálja; a **Tool Broker** ugyanezt teszi az *eszköz-, MCP- és connector-hívásokkal*. Ez a két átjáró együtt zárja be a 8.3-ban felvetett auditláthatósági problémát: a harness belső döntési folyamata lehet részben fekete doboz, de **amihez hozzáfér és amit tesz, az mind a két átjárón keresztül naplózott és szabályokkal kontrollált**.

Miért nem köthet a harness közvetlenül a rendszerekre (mint a marveen):

- a **valódi kredenciálok** a runtime-ba kerülnének (sérti a 4.9.2 "secret sosem a promptban/runtime-ban" elvet),
- nincs **központi eszközjog-kikényszerítés** (mit hívhat ez az agent),
- az eszközhívások **nem auditálhatók** egységesen.

**Megvalósítás (eldöntött):** a Goose natív MCP extension-konfigurációját használjuk — a Goose extension-jai a Tool Broker MCP-végpontjára mutatnak. Saját MCP-proxy réteget csak ott írunk, ahol a Goose képességei nem fednek le valami szükségeset. Ez az architektúra változtatás nélkül illeszkedik, mert a Goose minden eszköze eleve MCP-n keresztül dolgozik.

Ezért minden eszközhívás a control plane által üzemeltetett brokeren megy át:

- **Eszközjog-kikényszerítés (8.2):** az agent csak azokat a tool-okat/connectorokat éri el, amelyekre **explicit joga van**; minden más alapból tiltott.
- **Secret-injektálás (4.9.2):** a broker **futásidőben, szerveroldalon** teszi a valódi kredenciált az alias mögé; a harness és a modell sosem látja → prompt injectionnel nem csalható ki.
- **Naplózás + policy:** minden hívás (melyik agent-verzió, melyik tool, milyen argumentum, milyen eredmény) append-only auditba (8.5); kimeneti / művelet-validáció, guardrail.
- **Protokoll-absztrakció (4.12):** a broker mögött REST/SOAP/MQ/DB/MCP — a harness egységes **MCP-interfészt** lát; a háttérrendszer cseréje nem írja át az agentet.
- **Rate-limit / budget / kill-switch (4.9.4, 8.8):** eszköz-szintű korlát és **azonnali visszavonás** incidens esetén.

**Megvalósítás:** a Tool Broker egy **MCP-proxy/gateway**. A Goose-nak úgy tűnik, mintha közvetlen MCP-szerverekhez (extension-ökhöz) csatlakozna, de valójában a broker MCP-végpontjára köt, amely a kontrollok (eszközjog, secret, policy, napló) után továbbít a tényleges connectorokhoz. Az [MCP](https://modelcontextprotocol.io/docs/getting-started/intro) célja éppen az, hogy az AI-alkalmazások egységes módon érjenek el adatforrásokat, eszközöket és workflow-kat; nálunk ezt a szabványosítást nem közvetlen hozzáférésre, hanem kontrollált brokerelt hozzáférésre használjuk. Így a Goose **natív MCP-támogatása változtatás nélkül használható** (a Goose extension-konfigurációja egyszerűen a brokerre mutat), miközben a governance a brokerben marad.

**Két átjáró, egy elv:**

| Átjáró | Mit brokerál | Fő kontrollok |
|---|---|---|
| **Model Gateway** (4.7) | modellhívások | modell-routing, költség/token, naplózás, guardrail |
| **Tool Broker** (4.8.4) | eszköz-/MCP-/connector-hívások | eszközjog, secret-injektálás, naplózás, rate-limit/kill |

A harness (3. komponens) e két átjáró **között** ül: a dispatcher indítja, a modellt a Model Gateway-en, az eszközöket a Tool Brokeren át hívja, és minden a control plane auditjába folyik.

#### 4.8.5 Külső (Cowork) teszt-runtime — csak demó

Tesztelési célból az agent **futtatókörnyezete lehet a platformon kívül** (pl. egy laptopon futó Claude Cowork agent). Ekkor a platformon létrehozzuk az agentet, **scoped API-kulcsot** generálunk neki, és a külső agent ezzel **olvas a boardról** és **hozhat létre tickettet**.

**Fontos korlát (lásd 8.3):** itt csak a *board-interakciók* auditálhatók, az agent belső működése nem (nincs Model Gateway / Tool Broker a hurokban). Ezért ez **kizárólag demó / fejlesztői-teszt** minta — **soha nem éles enterprise működés**. Az éles utat a 4.8.1–4.8.4 (saját, kontrollált harness + gateway-ek) adja; ez a teszt-runtime akár teljesen kivehető az éles termékből.

#### 4.8.6 Recipe-katalógus és progressive disclosure (token-hatékony betöltés)

> **Közérthetően:** Egy AI-munkatárs annyit tud, amennyi "munkaköri leírás" és háttértudás belefér a fejébe egyszerre — és minden, amit beleteszünk, pénzbe (tokenbe) kerül, akkor is, ha épp nem használja. Két dolgot veszünk át a marveen-ből: (1) a tudást/utasítást **rétegekben** töltjük be, hogy csak az menjen a kontextusba, ami épp kell; (2) az újrahasznosítható "munkaköri leírásokat" (recipe-ket) **egy közös, verziózott könyvtárba** tesszük, amit több ügyfélnél is fel tudunk használni.

**Progressive disclosure — háromszintű betöltés (marveen-minta).** A Goose-recipe-k (4.8.3) és a RAG/tudásbázis (4.9.1) betöltése ne "mindent egyszerre" legyen, hanem szintekben — ez közvetlenül a 4.11 token-ökonómia elvét szolgálja:

- **Szint 0 — index:** csak a recipe/skill *neve + rövid leírása* (mikor kell használni). Ez mindig a kontextusban van, olcsón.
- **Szint 1 — teljes recipe:** a teljes utasítás csak akkor töltődik be, ha az adott tickettípushoz / feladathoz **releváns**.
- **Szint 2 — segédanyagok:** scriptek, hivatkozott dokumentumok, példák — csak konkrét szükséglet esetén.

Így a "drága LLM csak valódi munkára indul" (4.11) mellé bekerül a **"a kontextusba is csak a szükséges tudás kerül"** elv — mindkettő a token-, és így a költségkontrollt szolgálja, ami enterprise-ban gyorsan kérdés lesz (8.6).

**Recipe-katalógus mint újrahasznosítható, governance alá vont IP.** A tickettípus-szintű recipe-k (4.8.3) ne ügyfél-egyedi, szétszórt fájlok legyenek, hanem egy **verziózott, scope-olt, agentekhez köthető könyvtár** — pontosan a connector-könyvtár (4.12) mintájára ("egyszer megépítjük, sok ügyfélnél használjuk"). Tulajdonságai:

- **Verziózott és auditált:** bármely lefutásra megmondható, *melyik recipe-verzió* futott (reprodukálhatóság, 4.5).
- **Import/export** (a marveen `.skill` csomag-mintájára): egy recipe **hordozható egységként** átvihető ügyfelek és környezetek között → ebből lesz az **iparági sablon-csomag** (pl. fizetési reconciliation recipe-készlet, dokumentum-feldolgozó recipe-k).
- **Governance alatt:** a recipe-k változása ugyanúgy a write-gate / jóváhagyási logika alá esik, mint a memória (4.6) és a megosztott erőforrások (4.9.3) — egy megosztott recipe módosítása sok agent viselkedését érinti, ezért jóváhagyás-köteles és auditesemény.

**Üzleti olvasat:** a recipe-katalógus a connector-könyvtárral együtt a professional services munkát **ismételhető termék-IP-vé** alakítja: az első ügyfélnél kidolgozott recipe-k a következőnél már készen állnak, csökkentve a bevezetés idejét és kockázatát (5.3.2 BOT-modell).

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

**Alapdöntés: nem kell külön workflow-motor.** A ticket *maga* a folyamat alaprétege: minden munka, átadás és jóváhagyás ticketként jelenik meg. Az agent-átadás egyszerűen úgy működik, hogy az agent **utolsó lépése egy új ticket** létrehozása a következő agent/szerep számára. Ezt **choreográfiának** hívjuk (minden agent ismeri a saját következő lépését), és v1-re ez a helyes, egyszerű választás.

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

#### 4.10.5 Delegálási státusz-réteg — megfigyelhető átadás a choreográfia mellé

> **Közérthetően:** A choreográfia (4.10) azt jelenti, hogy minden AI-munkatárs maga adja át a stafétát a következőnek egy új feladatkártyával. Ez működik, de menet közben nehéz látni, "ki vár épp kire". A marveen erre egy egyszerű, jól megfigyelhető mintát ad: minden átadásnak van **státusza** (elküldve / megérkezett / kész / hibázott). Ezt érdemes átvenni, hogy az átadások *futásidejű* állapota egy pillantásból látszódjon.

A tiszta choreográfia (4.10) korlátja (4.10.1), hogy a *futásidejű* átadási állapot nem explicit. A marveen `agent_messages` mintája (from / to / tartalom + **státusz**: pending → delivered → done / failed + eredmény) ezt teszi láthatóvá. Átvéve, de a mi modellünkbe illesztve:

- **Nem helyettesíti a tickettet, hanem kíséri.** Az átadás továbbra is **ticket** (ez a naplózott, kemény interfész — 4.2); a delegálási státusz egy **megfigyelhetőségi réteg** a ticket-átadási élen, nem külön, kontrollon kívüli üzenetcsatorna.
- **Megfigyelhetőség, nem governance-kapu.** A státusz a "ki vár kire most" kérdést egy lekérdezésből megválaszolja, és táplálja a tényleges-folyamat gráfot (4.10.3) — de a **kötelező kapuk** továbbra is a ticket-állapotgépben élnek (4.10.4), nem itt.
- **Marveen-eltérés (kontroll):** a marveen `tmux send-keys`-szel közvetlenül egy másik agent munkamenetébe írja az üzenetet — ez nálunk **nem** megengedett (közvetlen, kontrollálatlan beavatkozás). Az átadás kizárólag a ticket-mechanizmuson és a Tool Brokeren át történik, naplózva.

Ez kis ráfordítású kiegészítés, amely a choreográfia egyszerűségét megtartja, de orvosolja a fő hátrányát — anélkül, hogy a Playbook (4.10.2) explicit folyamat-leírását vagy a szerveroldali kapukat kiváltaná.

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

- **Elsődleges — eseményvezérelt (push):** a ticket állapotváltása indítja az agentet. Firestore/Cloud Functions trigger, Postgres `LISTEN/NOTIFY`, vagy job-queue (Pub/Sub, Redis stb.). A Firestore/Cloud Functions eseményindítás és a Postgres `LISTEN`/`NOTIFY` is bevett minta az állapotváltozásra reagáló backend-folyamatokra ([Firestore triggers](https://firebase.google.com/docs/functions/firestore-events), [PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html), [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)). Heartbeat gyakorlatilag nem is kell.
- **Másodlagos — cron-söprés (safety net):** alacsony frekvenciás, **egy SQL-lekérdezés** (nem LLM!), ami elkapja az esetleg elveszett eseményeket. Mivel nem agent, gyakorlatilag ingyen van. **Tehát nem a heartbeat drága — csak akkor lenne az, ha agentet futtatnál benne.** Időzített vagy késleltetett indításhoz Cloud Tasks is használható, amely a dokumentáció szerint ütemezett kézbesítést, retry-t, rate-limitet és deduplikációt is támogat ([Cloud Tasks overview](https://docs.cloud.google.com/tasks/docs/dual-overview)).

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

#### 4.11.7 Proaktív monitor (heartbeat) — szűrt, csendes figyelés

> **Közérthetően:** Eddig a rendszer **reaktív** volt: akkor dolgozott, ha kapott egy feladatot. De a legtöbb cégnek olyan AI is kell, amely **magától észreveszi, ha valami baj van** — pl. közeleg egy határidő, eltérés van egy egyeztetésben, vagy gyűlik egy postafiók. A trükk, hogy ez ne legyen se drága, se zavaró: a figyelő **csendes** (alapból nem szól), és csak akkor nyit feladatot vagy küld jelzést, ha tényleg fontos dolgot talál. Ezt a mintát a marveen "heartbeat"-jéből vesszük át.

A koncepció alap-modellje reaktív (4.11.1: olcsó figyelő dönt, drága agent csak valódi munkára indul). A marveen heartbeat-je egy értékes, **proaktív** mintát ad hozzá, amely **eladható termék-feature** a mid-market szegmensnek: "az agent figyeli a postaládát / a reconciliation-eltéréseket / a határidőket, és magától nyit tickettet, ha beavatkozás kell."

**Hogyan illeszkedik a token-ökonómiához (4.11.1 elv megtartása):** a monitor **kétlépcsős**, hogy ne fusson drága LLM üresben:

1. **Olcsó, nem-LLM adatgyűjtés és szűrés (a "heartbeat" mag):** egy determinisztikus, ütemezett söprés (4.11.6) összegyűjti a jeleket (közelgő határidők, nyitott/várakozó ticketek, eltérés-számlálók, postafiók-darabszám), és egy **konfigurálható szűrőfeltétel** dönti el, van-e említésre méltó. Ez nulla LLM-token.
2. **Drága LLM csak releváns jelnél:** ha a szűrő "fontosat" talál, **akkor** indul agent — vagy közvetlenül **tickettet nyit** a boardon (a board marad az elsődleges, auditált felület), vagy összefoglalót készít.

**Szűrési elv (marveen-minta, enterprise-ra hangolva):** a "csak ha fontos" küszöb **konfigurálható** (pl. munkaidőn kívül csak kritikus jelzés; csak bizonyos súlyosság felett értesít). A cél a **riasztás-fáradtság** elkerülése: a csendes alapállapot a feature lényege, nem mellékhatás.

**Kötelező kontrollok (a marveen-től itt térünk el):**
- A monitor-agent kimenete és minden eszközhívása **a Tool Brokeren és a Model Gateway-en át** megy (4.7, 4.8.4) — nincs közvetlen rendszer- vagy értesítés-elérés.
- A proaktívan nyitott ticket **ugyanaz a naplózott, jóváhagyás-köteles entitás**, mint bármely más — a "proaktív" csak az *indítás* módja, a governance nem lazul.
- **Költségkorlát:** a monitor frekvenciája és per-futás budget-je a 4.11.4 / 8.6 keretében korlátozott; a kétlépcsős felépítés tartja alacsonyan a tokenköltséget.
- **Értesítési csatorna:** a jelzés mehet e-mailben/chaten (akár Telegram-szerű csatornán) *kiegészítésként*, de az **elsődleges, auditált felület a board** marad — az értesítés csak figyelemfelhívás a ticketre.

Ez a minta közvetlenül megerősíti a 11. fejezet több use case-ét (e-mail-triage, agrár határidő-asszisztens — lásd a 11.5 új use case-t is).

**Éles üzemi finomságok (a marveen schedule-runner működő mintái alapján):**
- **Catch-up ablak újraindítás után:** ha a rendszer (vagy a dispatcher) leállt, induláskor egy **korlátozott catch-up ablak** (pl. az utolsó X perc) elkapja a leállás alatt kimaradt, esedékes ütemezett ticketeket — ezek **késve, de lefutnak**. Ablakon kívül a catch-up policy dönt.
- **Catch-up policy** ticketenként: kihagyott időablaknál *fusson késve* vagy *ne fusson* (egy órákat késő napi zárás már hibás lehet).
- **Dupla-fires védelem (kritikus):** az ütemezett indításnál garantálni kell, hogy ugyanaz a periódus-példány **ne fusson kétszer** (pl. ha az eseményvezérelt trigger és a cron-söprés is elkapja, vagy két dispatcher-példány versenyez). Mechanizmus: **utolsó-futás nyilvántartás periódusonként** + **ticket-lock / idempotencia-kulcs** (4.11.4, 8.8) — a kettő együtt zárja ki a duplázódást.
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

### 4.13 Build vs. Adopt — saját megoldás alapból, opcionális adopt-path később

> **Közérthetően:** Több olyan kész, nyílt forráskódú "dobozos" megoldás létezik a piacon, amely az itt leírt feladatok egy részét (szabály-kikényszerítés, memóriakezelés) elvégzi. A kérdés: ezeket építsük-e be, vagy írjuk meg saját, egyszerűbb változatban? A döntésünk: **alapból mindent saját, egyszerű megoldással építünk meg**, mert a célügyfeleink nagy része nem bank, és nekik ez bőven elég. A kész külső modulokat **csak akkor** hozzuk be, ha egy konkrét ügyfél mérete vagy szabályozása tényleg megköveteli — és lehet, hogy soha. A titok az, hogy a saját megoldásainkat **csereszabatos "csatlakozók" mögé** tesszük, így a későbbi csere — ha egyáltalán kell — ne igényelje az egész rendszer átírását.

**Alapelv: a termék magja saját, lean megoldás — a külső modulok opcionálisak és kizárólag későbbi, ügyfél-indokolt bővítmények.** Ez a 8.7 platform-/infra-absztrakció elvének kiterjesztése a governance és a memória rétegre. Fontos elvárás kettő: (1) a felsorolt külső OSS-modulok **alapból NEM részei a terméknek** — sem a Fázis 1–3 prototípusnak (9.), sem az alap-szállításnak; (2) a fő célszegmensünk (mid-market, fintech/PSP — nem bank, 2.) elvárásait a **saját megoldások várhatóan teljes mértékben kielégítik**, ezért nagyon valószínű, hogy ezekre a külső modulokra a legtöbb ügyfélnél **soha nem lesz szükség**. Az adopt-path tehát opció, nem terv — és nem is jövőbeli kötelezettség.

**A bővítési cserepontok — ezek a saját megoldásaink, alapból a termék részei:**

A két központi átjáró (Model Gateway, 4.7; Tool Broker, 4.8.4), az Agent Registry (4.5) és a memória-szolgáltatás (4.6) már **maguk a cserepontok**. Ez azt jelenti, hogy a termék magja saját marad, de néhány komponens mögött tudatosan egyetlen, jól definiált interfész van. Két konkrét cserepontot érdemes néven nevezni és kódszinten is egyetlen pont mögé zárni, hogy a saját megoldás később *opcionálisan* cserélhető legyen:

- **`authorize(agent, tool, args)` — egyetlen policy-döntési pont** a Tool Brokerben. MVP-ben ez egy egyszerű, szerveroldali allowlist / `if`-ellenőrzés (deny-by-default, 8.2). Mivel minden eszközhívás úgyis ezen az egy függvényen megy át, később *opcionálisan* kicserélhető egy policy-as-code motorra anélkül, hogy az agentekhez vagy a boardhoz hozzá kéne nyúlni.
- **`MemoryStore` interfész — egyetlen memória-hozzáférési pont** a memória-szolgáltatás mögött. MVP-ben ez egy verziózott fájl/DB-rekord + a write-gate (4.6.1) az írás-oldalon, és teljes beinjektálás az olvasás-oldalon. Mivel a memória írása-olvasása ezen az egy interfészen át történik, az **olvasás-oldal skálázáskor** a saját, lean hibrid keresésünkre vált (FTS5 + lokális vektor + RRF + salience, 4.6.2), és **csak ha egyáltalán kell**, *opcionálisan* egy gazdagabb külső memória-réteg tehető alá.

**Elhalasztott adopt-célok (alapból NEM a termék részei — belátható időn belül saját megoldás marad, csak konkrét ügyfélkérés esetén döntünk):**

| Cserepont (saját, alap) | MVP-megoldás (alap, mindig saját) | Elhalasztott adopt-cél | Mi indokolná (trigger) |
|---|---|---|---|
| Policy (`authorize()`, 4.8.4) | allowlist / `if`-ellenőrzés | [OPA](https://openpolicyagent.org/docs) / [Cedar](https://docs.cedarpolicy.com/) policy-as-code | sok agent+tool, ABAC, banki audit-elvárás |
| Memória-réteg (`MemoryStore`, 4.6) | verziózott fájl/DB + write-gate; retrieval MVP-ben teljes beinjektálás | Zep/Graphiti (temporal, provenance) + hibrid keresés | nagy skála + "mikor mi volt igaz" temporal igény |
| Sensitivity router (4.7.2) | nincs — API szintű adatkezelési feltételek az alap | lokális pre-flight classifier (NER / kis modell) | szabályozott ügyfél, ahol tartalom-szintű garancia elvárás |
| Governance-csomag (4.4/4.8.4/8.5) | saját RBAC + hash-láncolt audit | MS Agent Governance Toolkit (referencia/benchmark) | OWASP Agentic megfelelés kötelező elvárás |
| Model Gateway (4.7) | vékony saját adapter | LiteLLM / Portkey | sok provider + összetett költség-routing |

**Üzleti olvasat:** mivel a célügyfeleink jellemzően **nem bankok**, a fenti jobb oldali oszlop nagy valószínűséggel **kihasználatlan opció marad** — a saját, lean megoldások adják a teljes terméket. Az adopt-path értéke nem az, hogy be fogjuk vezetni, hanem hogy a **banki upgrade-path (8.7) felé nyitva tartja az utat** anélkül, hogy az MVP-be felesleges súlyt vagy külső függőséget tennénk. A cserepontok miatt a "ha mégis kell" eset nem jelent újraírást — de a kiindulás és az alapértelmezés mindig a saját megoldás.

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

#### 5.3.3 Reprodukálható, spec-vezérelt szállítás (marveen-módszertan)

> **Közérthetően:** A marveen egy érdekes módszertani ötletet is ad: a teljes rendszerét egyetlen, részletes "építsd fel nulláról" leírásból (specifikációból) reprodukálni lehet. Tanácsadó cégként ez nekünk értékes munkamódszer: ha a szállításunk nem szétszórt, kézi lépések halmaza, hanem **leírásból (újra)építhető**, akkor gyorsabb, ismételhetőbb és átadhatóbb (BOT-transfer, 5.3.2).

A marveen `REBUILD_PROMPT_V3.md`-je egy teljes, deklaratív "spec-as-prompt": a rendszer nem kézi, megismételhetetlen lépésekből, hanem egy **strukturált specifikációból reprodukálható**. Ezt **szállítási módszertanként** érdemes átvenni, nem termék-feature-ként:

- **Deklaratív szállítási csomag:** az ügyfél-sandbox (2. app), a connectorok (4.12) és az agent-/recipe-készlet (4.8.6) leírása legyen olyan **spec + recipe-katalógus**, amelyből a környezet **reprodukálhatóan (újra)építhető** — nem egyedi, kézi konfigurációk halmaza.
- **Illeszkedés a recipe-filozófiához:** ez a 4.8.6 recipe-katalógus természetes folytatása — a "munkaköri leírások" deklaratívak és hordozhatók, így a teljes ügyfél-felállás is az.
- **BOT-előny (5.3.2):** a reprodukálható spec a *Transfer* fázist teszi olcsóbbá és kockázatmentesebbé — az ügyfél (vagy egy másik csapat) a leírásból átveszi az üzemeltetést, nem "fekete dobozt" örököl.
- **Fontos elhatárolás (kontroll):** ez **fejlesztési/szállítási** eszköz, nem az éles futás része. A reprodukálható build outputja is a kontrollált architektúrába (Control Plane + gateway-ek) kerül; a spec-vezérelt szállítás nem kerüli meg a governance-t, csak a *felépítést* teszi ismételhetővé.

---

### 5.4 Az execution plane mint agent-által fejleszthető alkalmazásplatform

> **Közérthetően:** Eddig úgy írtuk le a munkateret, mint ahol az agentek munkája *megjelenik* (dashboard, feltöltés, eredmény). A valódi elképzelés ennél tágabb: a munkatér egy olyan **alkalmazásplatform, amelyet maguk az agentek építenek és tartanak karban** az ügyfél egyedi igényei szerint. Ha egy agent feladata napi riport készítése, akkor a riport-felület *itt jön létre és itt szabható testre*. Ha a cégnek nincs CRM-je, az agent **építhet egyet** ide, és **karban is tarthatja**. Vagyis az agentnek nem csak *olvasási* joga van a cég adataihoz: ha az adatra épülő alkalmazás kell, az itt fejleszthető le — kontrolláltan.

Az execution plane kettős természetű, és ezt érdemes explicitté tenni:

1. **Adat- és megjelenítési sík (data plane):** ide kerülnek a feltöltött dokumentumok, a behúzott üzleti adatok és a kész eredmények — ahogy az 5.2 könyvelő-példa is mutatja.
2. **Agent-fejleszthető alkalmazássík (application plane):** itt az agentek **új alkalmazás-funkciókat hoznak létre és tartanak karban** — riport-generátorokat, dashboardokat, adatbeviteli űrlapokat, sőt teljes belső eszközöket (pl. egy egyszerű CRM), ha az ügyfélnek nincs ilyenje.

Ez a kettősség adja a termék egyik legnagyobb üzleti húzóerejét: az ügyfél nem kész, merev szoftvert vásárol, hanem **egy folyamatosan, igény szerint fejlődő munkateret**, amelyben az AI nem csak dolgozik az adaton, hanem **fel is építi azt a felületet/alkalmazást, amelyen a munka történik**.

**Gondolj rá úgy, mint egy Canvas-ra** (ahogy a Claude vagy a ChatGPT Canvas-a): egy felület, amely adatokat jelenít meg, és akár frissülő űrlapokat is mutat. A különbség — és ez a termék valódi megkülönböztetője —, hogy ez a felület **nem csak dokumentumot vagy kódrészletet mutat, hanem valódi, adattal feltöltött, perzisztens alkalmazásokat futtat**, amelyeket az AI épít és tart karban. Épp ezért **nem lehet megakadályozni**, hogy idővel fontos funkciók és adatok is itt szülessenek — ezt nem is akarjuk megakadályozni, hanem **tisztán pozicionáljuk és bekereteljük** (5.5).

A koncepció eddigi alapelve nem sérül, csak pontosul: **a sandboxon belül az AI viszonylag szabadon dolgozhat, a kerítés átlépése viszont kontrollált marad.** Az agent a sandbox saját kódján és adatán korlátok nélkül építhet és módosíthat, de:

- a két átjáró (Model Gateway, Tool Broker) és a deny-by-default egress **továbbra is érvényes** — a *külső* éles rendszerbe írás, az internet, a secretek és az agent **saját governance-a** (jogosultság, audit, prompt, memória) a kerítésen *kívül* vannak, és ezek kontrolláltak;
- amit az AI a sandboxban épít, az **verziózott, menthető és visszaállítható** (5.7);
- amit az AI épít, annak **eleve meg kell felelnie a beépített minőségi alapelveknek** (governance-by-construction, 5.6).

Ez a határvonal a lényeg: a szabadság a kerítésen *belül* van. Az agent építhet egy CRM-et a sandboxban, de nem írhatja át, hogy ki hagyhatja jóvá a külső rendszerbe menő műveleteit, és nem nyúlhat a saját governance-ához.

### 5.5 A sandbox mint scratchpad — pozicionálás és felelősséghatár

> **Közérthetően:** Itt tisztázzuk a legfontosabb üzleti és jogi kérdést: mi *ez* hivatalosan? A válasz: egy **scratchpad** — munkafelület, ahol az AI dolgozik és adatot jelenít meg —, **nem** a cég hivatalos, éles infrastruktúrája. Olyan, mint amikor egy munkatárs Excelben vezet valamit: nagyon hasznos, de mindenki tudja, hogy ez nem a hivatalos rendszer. Aki a sandboxban készült dolgot a cég valódi rendszerévé akarja tenni, az kiexportálja magának.

A sandbox **hivatalos pozíciója: AI-munkafelület (scratchpad), nem a cég éles infrastruktúrájának része.** Ezt jogi és kommunikációs szinten egyértelművé tesszük, mert ez oldja fel a szabadság és a felelősség közötti feszültséget — nem mérnöki túlbiztosítással, hanem **tiszta keretezéssel**.

**Felelősség-analógia (Excel):** ha a cég üzletileg fontos adatot vagy funkciót tart a sandboxban, **ugyanazt a kockázatot vállalja, mint amikor egy munkatárs Excelben vezeti a CRM-et** — ez egy ismert, megszokott, vállalható kockázat, amit minden compliance-szervezet ért. Mi *nem* ígérünk a sandboxra éles rendszer szintű SLA-t vagy rendszer-of-record garanciát. Ez a keret teszi lehetővé, hogy az AI a sandboxban viszonylag korlátok nélkül dolgozhasson.

**A belső munka szabad, a kerítés átlépése kontrollált** (az 5.4 elv konkretizálása):

| Művelet | Hol | Kontroll |
|---|---|---|
| Az AI ír a sandbox saját adatába / kódjába | sandboxon belül | **szabad**; verziózott + menthető (5.7), beépített alapelvek (5.6) |
| Az AI külső rendszer-of-recordba ír (ERP, bank, könyvelés) | kerítésen kívül | **human-in-the-loop** (4.10), Tool Broker capability (4.8.4) |
| Az AI internetet / secretet ér el | kerítésen kívül | Tool Broker allowlist + deny-by-default egress (3.2.3, 4.8.4) |

**GDPR — fontos elhatárolás:** a „scratchpad, nem éles rendszer" pozicionálás megvéd minket az *üzemeltetési, rendelkezésre állási és adatvesztési* felelősségtől (mint az Excel: ha elveszik a fájl, az a cégé). **De a GDPR nem a címkétől függ:** ha valódi személyes adat (ügyfélnevek, e-mailek) van a sandboxban és mi hostoljuk/feldolgozzuk, akkor jogilag valószínűleg **adatfeldolgozók** vagyunk, a cég pedig **adatkezelő** — DPA, törlési kötelezettség kérésre, és az adat lokációja (joghatóság) itt is érvényes. A felelősség nem tűnik el a „scratchpad" címkétől, csak a megfelelő félhez kerül; ezt a szerződésben explicit rögzítjük.

### 5.6 Governance-by-construction — a fejlesztő AI állandó alapelvei

> **Közérthetően:** Nem kívülről figyeljük, hogy az AI jól dolgozik-e, hanem **eleve úgy építtetjük vele a dolgokat, hogy jók legyenek.** Ehhez a fejlesztő AI-nak van egy állandó „munkavédelmi szabályzata" (system prompt), amely minden építésnél emlékezteti, milyen elveknek kell megfelelnie. És mivel a puszta utasítás kevés, egy **automatikus ellenőrzés** is megnézi, hogy a kész dolog tényleg megfelel-e.

A minőséget nem a sandboxra utólag aggatott kontrollal érjük el, hanem **a megépített artefaktba építve**. Ennek két fele van:

- **Policy as prompt — állandó system prompt a fejlesztő AI-nak.** A fejlesztő AI minden építésnél egy rögzített alapelv-csomagot kap, pl.: üzletkritikus modulnál legyen **sorszintű változásnapló** (ki/mi, mikor, régi → új érték — AI és ember műveletére egyaránt); legyen **export-funkció** (teljes adat + séma, nyílt formátumban); legyen **hozzáférés-naplózás**; és **hordozhatóan** épüljön (standard stack), hogy a későbbi kiszervezés (5.8) olcsó legyen.
- **Policy as test — elfogadási kapu.** A system prompt megmondja a szabványt, de **nem ez a garancia** — ez ugyanaz az elv, mint a Goose belső jóváhagyásánál (3.2.1): a harness/AI belső viselkedésére nem építünk compliance-garanciát. Ezért a go-live előtt egy **elfogadási kapu** (automatikus ellenőrzés és/vagy emberi review) **bizonyítja**, hogy a modul tényleg tartalmazza az elvárt tulajdonságokat (van változásnapló-tábla, működik az export, van hozzáférés-napló). Egy rossz generálás, prompt injection vagy modell-drift így nem csúsztathat ki csendben egy hiányos modult.

**Kritikussági szintezés — ne kapjon minden artefakt teljes terhet.** Egy eldobható riport nem ugyanaz, mint egy CRM. A fejlesztő AI (vagy egy gyors osztályozó lépés) eldönti, mennyire üzletkritikus, amit épít, és csak akkor aktiválja a nehéz alapelv-csomagot:

| Szint | Mit épít / üzemeltet | Példa | Aktivált alapelvek |
|---|---|---|---|
| **L0 — Megjelenítés** | eredményt mutat, nem ír adatot | dashboard | alap napló |
| **L1 — Adatművelet** | meglévő app adatát írja | napi riport, rekordfrissítés | sorszintű napló + visszafordíthatóság |
| **L2 — App-építés** | új funkció vetett építőelemekből | új dashboard, űrlap | + elfogadási kapu, test→live promóció (5.7) |
| **L3 — Kritikus modul** | üzletkritikus belső rendszer | CRM (ha a cégnek nincs) | + teljes változásnapló, export, hozzáférés-napló, hordozhatóság |

**Vetett építőelemek (low-code blueprint):** L2-től az AI ne a semmiből generáljon kódot, hanem **governance alá vont, újrahasznosítható komponensekből** építkezzen (adattábla, űrlap, dashboard, riport-generátor, connector-hívás). Ez csökkenti a támadási felületet és a hibalehetőséget, gyorsítja a review-t, és illeszkedik a 4.8.6 recipe-katalógus filozófiájához.

#### 5.6.1 Két audit-szint — hogyan áll össze a „minden auditált" ígéret (auditornak)

> **Közérthetően:** A koncepció elején (1., 4.1) azt ígértük, hogy minden agent-művelet naplózott és visszakereshető. A sandbox-szabadság ezt látszólag fellazítja — pedig nem. Csak arról van szó, hogy **kétféle audit dolgozik együtt**: a kerítésen *kívüli* dolgokat a control plane naplózza szigorúan, a kerítésen *belüli* munkát pedig a modulba beépített napló + a sandbox verziózása fedi le. A kettő határa a „kerítés" (5.4).

A doksi központi ígérete (1., 4.1, 8.5) — *minden lényeges művelet attribútálható és naplózott* — a sandbox-keretben **két egymást kiegészítő szinten** valósul meg, és együtt teljes lefedést ad:

| Audit-szint | Mit fed le | Hol | Hogyan kényszerül ki |
|---|---|---|---|
| **Kerítés-audit (control plane)** | minden kerítés-átlépés: modellhívás (Model Gateway), eszköz-/külső hívás (Tool Broker), külső rendszer-of-record írása, secret-használat, emberi jóváhagyás | Control Plane append-only, tamper-evident napló (8.5) | **kemény, szerveroldali** kikényszerítés (3.2.1) |
| **Sandbox-belső audit** | a kerítésen belüli munka: kritikus modul adatváltozásai (ki/mi, mikor, régi → új) + a kód és az adat visszaállíthatósága | a modulba beépített változásnapló (5.6) + sandbox git-verzió/snapshot (5.7) | **governance-by-construction + elfogadási kapu** (policy as test) |

Egy auditor szemszögéből ez azért elég, mert **semmilyen üzletileg vagy szabályozásilag kritikus művelet nem marad nyom nélkül**: ami elhagyja a kerítést (külső adat, külső írás, költés, jóváhagyás), azt a control plane keményen naplózza; ami a kerítésen belül történik egy kritikus modulban, azt a beépített változásnapló rögzíti, és a sandbox verziózása bármikor visszaállíthatóvá teszi. A scratchpad „szabad" része pedig per definíció **nem éles rendszer** (5.5) — ott a könnyebb, beépített szint arányos és elegendő.

**Őszinte elhatárolás (és egyben a graduation-trigger):** a sandbox-belső audit a *beépített naplóra és az elfogadási kapura* támaszkodik, nem control-plane szintű, kemény kikényszerítésre. Amíg tehát egy modul a sandboxban él, az ott folyó adatváltozások audit-szintje „scratchpad-szintű" — erős és gyakorlatban elég, de **nem** control-plane garancia. Ha egy adott rendszerre a cégnek **control-plane szintű, kikényszerített adat-audit** kell (pl. szabályozói elvárás miatt), az pontosan a **graduation (5.8) jele**: a modult ki kell vinni a sandboxból a kontrollált éles környezetbe. Így az audit-igény nem feszíti szét a scratchpad-keretet, hanem természetes érési útvonalat ad.

### 5.7 Verziózás, mentés, test→live promóció (a sandbox mint git-projekt)

> **Közérthetően:** A sandboxot úgy kezeljük, mint egy GitHub-projektet: minden változás verziózva van, és bármikor visszaállítható egy korábbi állapot. Új funkciót először egy „test" környezetben épít meg az AI, és csak utána kerül „élesbe" — emberi rábólintással.

Bár a sandbox „csak" scratchpad (5.5), a mentést, verziózást és visszaállíthatóságot **mi biztosítjuk alap-szolgáltatásként** — ez az a biztonsági háló, ami az Excel-analógiát tisztességessé teszi (egy Excel-fájlt is szoktak menteni).

- **Git-szerű verziózás:** a sandbox kódját verziózzuk; minden agent-változás diffelhető és visszagörgethető.
- **Két környezet:** **test-sandbox** (itt az AI szabadon épít és kísérletezik) és **live-sandbox** (amit emberek használnak). Új igény → a test-ben épül meg → onnan kerül élesbe.
- **Emberi go-live kapu:** a test → live léptetés emberi „mehet" kattintással történik (ugyanaz az elv, mint a „ne merge-elj automatikusan main-re"). A test-ben szabad a kéz; a live az a felület, amire emberek támaszkodnak — a promóció auditesemény.
- **Kód vs. adat szétválasztása (fontos):** a git a *kódot* verziózza, de a felhalmozott élő adat (pl. CRM-sorok) **nem git**. Egy rossz deploy visszavonása nem veheti el a tegnap rögzített adatokat → a **kód restore** (verzió/rollback) és az **adat snapshot** (időzített, point-in-time mentés) **két külön sín**.
- **Költség/observability:** a build és a futás tokent/compute-ot fogyaszt — ez a 8.6 mérési alaplapon megjelenik.

### 5.8 Életciklus: graduation (kiszervezés) és a sandbox-vízió

> **Közérthetően:** A vízió az, hogy ez a sandbox idővel minden cégben egyre fontosabb lesz, mert bármilyen új ötletet itt a legegyszerűbb megvalósítani. Ha egy funkció „megérik", a cég kiszervezheti magának, és onnantól a saját, hivatalos rendszerének része lesz — nincs bezártság.

**A vízió:** a sandbox idővel a cégeknél egyre kritikusabb szerepbe nő, mert minden új folyamat-igényt itt a legegyszerűbb megvalósítani (nincs külön beszerzés, fejlesztőcsapat, projekt — csak megkéred az AI-t). Ez a „sticky" hatás a termék egyik fő üzleti ereje.

**De ez koncentrációs / lock-in félelmet kelt** az ügyfélben („akkor minden az Excellence Pay sandboxán múlik"). Erre a válasz a **graduation (kiszervezés)**, és ezt **first-class feature-ként, bizalmi differenciátorként** kommunikáljuk:

- Az érett, bevált funkciót a cég **kiexportálja** (kód + adat + séma, lehetőleg egy gombbal — ezt a hordozhatóság-alapelv teszi lehetővé, 5.6) a **saját környezetébe**, és onnantól az a cég normál, hivatalos rendszerének része. A felelősség és a garancia is átszáll (illeszkedik a BOT-transfer-hez, 5.3.2).
- A graduation **csak akkor olcsó**, ha a modul **hordozhatóan épült a kezdetektől** — ezért a hordozhatóság a fejlesztő AI állandó alapelve (5.6), nem utólagos átírás. Így az ügyfél nem „fekete dobozt" örököl (5.3.3).
- **Az export legyen valóban triviális** (egy gomb, teljes adat + kód + séma) — különben a „bármikor kiveheted" ígéret üres, és súrlódás-alapú lock-in lesz belőle. Az Excel azért tisztességes analógia, mert egy Excel-fájlt csak átmásolsz; a sandbox-exportnak ugyanennyire könnyűnek kell lennie.

**Üzenet az ügyfélnek:** soha nem vagy bezárva. A sandboxban gyorsan és szabadon születik az érték; ami beválik és kritikussá válik, azt **bármikor kiviheted a saját rendszeredbe**. Addig a sandbox kockázata az ismert, vállalható „Excel-szintű" kockázat — de nálunk **verziózva, menthetően** (5.7) és **adatvédelmi feldolgozói kötelezettséggel** (5.5), nem pedig egy megosztott táblázat ad-hoc bizonytalanságával.

### 5.9 Sandbox App Container / App Registry

> **Közérthetően:** Ha az AI a sandboxban nem csak válaszokat ad, hanem alkalmazásokat is épít, akkor kell egy hely, ahol ezek az alkalmazások élnek. Ez az **App Registry**: egy belső alkalmazás-katalógus, ahol minden AI által létrehozott mini-appnak van neve, verziója, preview-ja, jogosultsága, exportja és auditnyoma. A felhasználó nem "valahol a chatben" kap egy kódrészletet, hanem egy különálló, megnyitható, kipróbálható és letölthető sandbox appot.

A Goose-ban látott minta értékes, de enterprise termékként nem önmagában elég: a Goose képes AI által készített, elkülönített mini-appokat megjeleníteni és helyben tárolni, de a mi platformunkban ez nem maradhat lokális desktop-funkció vagy ad-hoc HTML-fájl. A mechanizmust átvesszük, a kontrollt saját rétegbe tesszük:

- **App Registry:** tenanthez és sandboxhoz kötött katalógus az AI vagy ember által létrehozott appokról.
- **App Container:** izolált futtatási/preview keret, amelyben az app megnyílik, de nem kap automatikus hozzáférést secretekhez, internethez vagy külső rendszerekhez.
- **App Artifact:** az app tényleges hordozható csomagja: kezdetben egy HTML-fájl, később többfájlos projekt, build-output, Docker-csomag vagy Git repository.
- **App Version:** minden módosítás verziózott, diffelhető, visszaállítható és exportálható.
- **App Policy:** deklarálja, milyen szintű az app (A0-A3), milyen adatot olvas/ír, milyen connectorokat használhat, kell-e emberi go-live kapu.
- **App Export / Graduation:** az app letölthető, majd érettségtől függően átadható a cég saját környezetébe.

**Szintmodell az App Registryben:**

| Szint | App típusa | Példa | Futás / export |
|---|---|---|---|
| **A0 — Single-file app** | önálló HTML/CSS/JS, nincs backend, nincs külső dependency | generált wiki-riport önálló HTML-nézete, kalkulátor, vizualizáció | külön originről kiszolgált sandboxed iframe preview + `.html` letöltés |
| **A1 — Static app bundle** | többfájlos frontend build, statikus assetekkel | belső dashboard, többnézetes riport | statikus hosting + `.zip` export |
| **A2 — Sandbox data app** | sandbox-natív adatmodellt olvas/ír | mini CRM, ügylista, státusztábla | app bundle + schema + adat snapshot export |
| **A3 — Integrated app** | Tool Broker connectoron át külső rendszerhez kapcsolódik | ERP-előkészítő, számla-egyeztető | approval-köteles futás + graduation csomag |

**MVP-hez illeszkedő stretch minimum:** az első verzióban nem kell teljes A1-A3 platform, és az App Registry nem része a kontrollált agent-futás mag-bizonyításának. Ha a kritikus út (különösen a Goose/Model Gateway/Tool Broker integráció) stabilan halad, demó-bónuszként elég egy **A0 App Registry**, amely a wiki-pilot riportgenerálásának természetes kimenete: egy önálló, megnyitható HTML riportnézet.

- app létrehozása névvel, leírással, kritikussági szinttel;
- egyetlen HTML/CSS/JS artefakt tárolása;
- preview külön, cookieless originről kiszolgált sandboxed iframe-ben;
- verziószám és `created_by` / `created_by_agent` metaadat;
- letöltés `.html` fájlként;
- audit: `sandbox_app.create`, `sandbox_app.version`, `sandbox_app.preview`, `sandbox_app.export`, `sandbox_app.access_denied`.

Ez már demonstrálja a Goose-szerű élményt: az AI létrehoz egy különálló, megnyitható appot, a felhasználó kipróbálja, majd letöltheti. Közben a mi architektúránkban marad: a létrehozás tickethez/agenthez köthető, a preview izolált, az export naplózott, és később ugyanebből nőhet ki a többfájlos, adatmodelles, graduálható app-platform.

**Tool Broker felől nézve** az AI nem közvetlenül ír fájlrendszert vagy deployol. Csak kontrollált eszközöket hívhat:

```text
sandbox_app.create({ name, description, level }) -> { appId }
sandbox_app.update_artifact({ appId, html, changeSummary }) -> { version }
sandbox_app.preview({ appId, version }) -> { previewUrl }
sandbox_app.export({ appId, version }) -> { artifactRef, checksum }
```

**Biztonsági alapelv:** az App Container alapból nem kap hálózatot, secretet vagy connector-hozzáférést. Ez nem pusztán attól igaz, hogy iframe-ben fut, hanem attól, hogy a preview **külön originről** jön, a frame `sandbox="allow-scripts"` beállítást kap **`allow-same-origin` nélkül**, és a preview válaszon szigorú CSP van (minimum: `default-src 'none'; connect-src 'none'`; az inline futáshoz kontrollált `script-src` policy). Így az AI által generált JS nem éri el a platform sessionjét, API-jait vagy connectorait, és külső `<script src=...>` / hálózati hívás sem működik. Ha egy app külső adatot akar használni, azt csak explicit App Policy + Tool Broker capability + audit mellett teheti. Az exportált `.html` már a cég/felhasználó saját környezetében fut: ott a kockázata olyan, mint bármely letöltött HTML fájlé, ami illeszkedik az Excel-szintű scratchpad felelősséghatárhoz.

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
| **Agent által írt sandbox-natív adat** (pl. CRM-rekordok) | Execution Plane (2) | Az agent szabadon írja/karbantartja a kerítésen belül; üzletadat, nem kontroll-mag |
| **Sandbox-kód + git-history, test/live környezet** | Execution Plane (2) | Verziózott; live-ba csak emberi go-live kapuval (5.7) |
| **Sandbox mentés / verzió / snapshot (mi biztosítjuk)** | Sandbox-szolgáltatás | A scratchpad biztonsági hálója: kód-rollback + adat point-in-time (5.7) |
| **Sandbox App Registry metaadat** | Execution Plane (2) / Sandbox-szolgáltatás | App-katalógus: név, verzió, policy, export státusz, létrehozó agent/felhasználó (5.9) |
| **Sandbox app artefaktum** (HTML / bundle / export csomag) | Execution Plane (2) | Hordozható, letölthető app-csomag; preview izolált külön origin + CSP + sandboxed iframe mellett (5.9) |

**Kritikus elv:** a 2. appból érkező adat (pl. egy feltöltött számla tartalma) az agent számára **adat, nem utasítás**. A jogosultságokat és az engedélyezett műveleteket mindig **szerveroldalon, a control plane-ben** kényszerítjük ki — soha nem a promptban (prompt injection elleni alapelv).

**A scratchpad-keret hatása a határra (v0.6, lásd 5.5–5.8):** az agent a sandboxban nem csak olvas, hanem **szabadon ír is** — de a sandbox **hivatalosan scratchpad, nem a cég éles infrastruktúrája** (a kockázat „Excel-szintű", nem éles rendszer SLA). A *kerítésen belüli* írás (sandbox-natív adat és kód) szabad; a *kerítés átlépése* — külső rendszer-of-record írása (ERP, bank), internet, secret, az agent saját governance-a — továbbra is kontrollált (4.8.4, 4.10). Az enterprise-megfelelést nem külső, control-plane-ből ráhúzott adat-audit adja, hanem **(1) governance-by-construction** (a kritikus modulba beépített változásnapló/export/hozzáférés-napló + elfogadási kapu, 5.6), **(2) a sandbox mentése/verziózása** mint alap-szolgáltatás (5.7), és **(3) graduation** — ha a cég valódi rendszerré akarja tenni, kiexportálja a saját környezetébe (5.8). Személyes adat esetén a GDPR-feldolgozói kötelezettség a „scratchpad" címkétől függetlenül érvényes (5.5).

---

## 7. Megfelelőség, audit és külső kontrollkeretek

> **Közérthetően:** A "megfelelőség" (compliance) azt jelenti, hogy a megoldás megfelel a törvényeknek és az iparági szabályoknak. Ez a fejezet megmutatja, hogy amit eddig leírtunk (naplózás, emberi jóváhagyás, ellenőrzés), az pont az, amit a szabályozók is elvárnak az AI-rendszerektől — vagyis a biztonsági felépítésünk egyben **értékesítési érv** is.

A felépítés szinte egy az egyben lefedi azt, amit a szabályozók a magas kockázatú AI-rendszerektől elvárnak: **emberi felügyelet, naplózás/nyomonkövethetőség, transzparencia, kockázatkezelés.**

**Fontos elhatárolás:** ez a dokumentum nem jogi megfelelőségi vélemény. A cél az, hogy a termékarchitektúra eleve úgy épüljön fel, hogy később jogi, audit- vagy security review-ban ne kelljen alapvető kontrollokat utólag hozzátoldani.

- **EU AI Act:** az EU AI Act fokozatosan lép alkalmazásba. A Bizottság tájékoztató oldala szerint a tiltott gyakorlatok és AI literacy kötelezettségek 2025. február 2-től, a GPAI-szabályok 2025. augusztus 2-től alkalmazandók; a Digital Omnibus politikai megállapodása alapján a standalone high-risk rendszerek céldátuma **2027. december 2.**, a termékbe ágyazott high-risk rendszereké **2028. augusztus 2.** ([European Commission AI Act timeline](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai), [Council press release, 2026-05-07](https://www.consilium.europa.eu/en/press/press-releases/2026/05/07/artificial-intelligence-council-and-parliament-agree-to-simplify-and-streamline-rules/)). Ez **időablakot ad** arra, hogy a platformot "AI Act readiness" eszközként pozícionáljuk: a naplózás, emberi felügyelet, kockázatkezelés és transzparencia nem extra modul, hanem a működési alapréteg.
- **NIST AI RMF:** a [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) önkéntes keretrendszerként a megbízható AI-rendszerek kockázatkezelését támogatja. A mi leképezésünk: `Govern` = Control Plane + policy + szerepkörök; `Map` = use case / adat / kockázat feltérképezés; `Measure` = evalok + observability; `Manage` = jóváhagyás, rollback, kill switch, incident kezelés.
- **ISO/IEC 42001 és ISO/IEC 27001:** az [ISO/IEC 42001](https://www.iso.org/artificial-intelligence/ai-management-systems) AI management system irányba ad menedzsmentrendszer-logikát, az ISO/IEC 27001 pedig információbiztonsági kontrollkörnyezetet. A platform szempontjából a fontos üzenet: agent-registry, változáskezelés, auditnapló, hozzáférés-kezelés, vendor risk és monitorozás dokumentálható kontrollként jelenjen meg, ne csak technikai implementációként.
- **PCI DSS:** fizetési és bankkártyás környezetben a [PCI DSS](https://www.pcisecuritystandards.org/standards/pci-dss/) alapelvei — hozzáférés-kontroll, naplózás, adatszegregáció, cardholder data védelme — közvetlenül relevánsak. A platformban ezért a PAN/kártyaadat ne kerüljön modellkontextusba, a secret-injektálás szerveroldali legyen, és minden tool-hívás auditált legyen.
- **DORA:** pénzügyi szervezeteknél a [Digital Operational Resilience Act](https://www.eiopa.europa.eu/digital-operational-resilience-act-dora_en) ICT risk management, incident response, harmadik fél kockázat és működési reziliencia szempontból releváns. A platform DORA-kompatibilitási iránya: disaster recovery, audit export, provider-függőség kezelése, modell-/tool-szolgáltató kiesési terv, és világos incident playbook.
- **OWASP GenAI/LLM kockázatok:** a [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/) külön kockázatként kezeli többek között a prompt injectiont, sensitive information disclosure-t, supply chain problémákat, insecure output handlinget és excessive agency-t. Ezek nem külön "security appendix" témák: a Model Gateway, Tool Broker, capability-k, human-in-the-loop kapuk és deny-by-default működés pontosan ezekre a kockázatokra ad architekturális választ.

**Compliance üzenet ügyfélnek:** a platform nem azt ígéri, hogy minden szabályozási kérdést automatikusan megold. Azt ígéri, hogy a kritikus kontrollpontok — ki fér hozzá, mit lát az agent, milyen eszközt hív, ki hagyott jóvá, milyen modell futott, mennyibe került, visszagörgethető-e — már az MVP-től mérhető és dokumentálható módon jelennek meg.

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

A 2. appba kerülő dokumentumok (számlák, e-mailek) **támadási felület**: egy rosszindulatú tartalom megpróbálhatja az agentet jogosultság-emelésre vagy káros ticket létrehozására rávenni. Az OWASP ezt külön kockázatként kezeli: a [Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) lényege, hogy a felhasználói vagy külső input nem kívánt módon módosítja a modell viselkedését; az [Excessive Agency](https://owasp.org/www-project-top-10-for-large-language-model-applications/) pedig azt írja le, amikor a modell túl széles eszköz- vagy döntési jogot kap. Védelem:
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

MVP-szinten nem kell teljes, külső WORM-tárolós auditarchitektúra, de már az első valódi pilotban legyen meg a minimális, később bővíthető séma: immutable audit event ID, actor, agent-version, ticket-id, tool/model call, policy decision, input/output referencia, timestamp, hash-previous. Így az audit nem csak "logolás", hanem későbbi compliance-bizonyíték alapja.

### 8.6 Observability és költségkontroll

Enterprise-ban gyorsan kérdés lesz: *mennyibe kerül ez, és működik-e jól?* Javaslat egy beépített modulra:
- **token- és költségkövetés** agentenként/ticketenként,
- **minőségi metrikák / evalok**, drift-detektálás,
- **guardrail-sértések** dashboardja,
- SLA-k (pl. agent válaszidő, jóváhagyási átfutás).

MVP-nél a minimum nem egy teljes AIOps rendszer, hanem egy **mérési alaplap**: ticketenként token/költség, futási idő, siker/hiba státusz, emberi visszadobási arány, agent-javaslat pontossága, jóváhagyási átfutás. Ha ezek nincsenek, nem tudjuk bizonyítani, hogy az AI üzleti értéket termel, vagy csak látványos demó.

### 8.7 Platformfüggetlenség — a Firebase csak teszt-host

**Alapelv: a megoldásnak platformfüggetlennek kell lennie.** Ez egy webalkalmazás, amely bármilyen környezetben futtatható — a Firebase csupán egy **kényelmes, ismert teszt-környezet** a prototípushoz, nem architekturális elköteleződés.

Telepítési mátrix az ügyfél típusa szerint (a célszegmens szerint a **felhő az alapértelmezett**, lásd 2. szakasz):

| Ügyféltípus | Deployment | Indok |
|---|---|---|
| **Középvállalat / fintech / PSP (fő célszegmens)** | **Felhő — alapértelmezett** | Gyors deploy, megbízható, elfogadható biztonsági alapszint; ide illik a fürge tanácsadói modell |
| Bank / erősen szabályozott (upgrade-path) | On-prem / dedikált privát felhő | Adat-rezidencia, szabályozás, "az adat nem hagyja el a céget" |

**Tervezési következmény:** a perzisztencia és az infrastruktúra-függő részek legyenek **absztrakció mögött / cserélhetők**. Prototípus Firebase-en, de ne égjenek bele Firebase-specifikus megoldások a control plane magjába — így ugyanaz a kód on-prem (pl. Postgres + self-host) és felhős környezetben is fut. Banki környezetben az on-prem amúgy is kötelező lesz; a platformfüggetlenség garantálja, hogy ne kelljen újraírni.

### 8.8 Amire még érdemes gondolni

- **Multi-tenancy [DÖNTVE]:** az alapértelmezett deployment **by-design multi-tenant** (megosztott control plane, logikai izoláció tenant-szinten) — ez elegendő az ügyfélkör nagy részének. Szabályozott ügyfél (bank, erősen auditált PSP) dedikált példányt kaphat (8.7 upgrade-path); ezt az üzleti igény, nem az alapértelmezés dönti el. Ezért az architektúra elejétől multi-tenant elsőként tervezett, tenant-izolációval a control plane-ben (adatszegregáció, API-kulcs scope, audit-szétválasztás).
- **Idempotencia és konkurrencia:** mi történik, ha két agent ugyanarra a ticketre mozdul? Kell ticket-lock / optimista konkurenciakezelés.
- **"Kill switch" / emergency stop:** egy agent vagy az összes agent azonnali leállítása (incidens esetén).
- **Human override mindenhol:** bármely automatizált lépés emberi felülbírálhatósága, és ennek naplózása.
- **Disaster recovery / backup** a control plane-re (az audit és a memória elvesztése kritikus).
- **Szerződéses / felelősségi kérdés:** ha egy agent hibázik (rossz könyvelési javaslat, amit jóváhagytak), hol a felelősséghatár? Ezt a jóváhagyási kapuk és a naplók kezelik, de érdemes explicit dokumentálni az ügyfélnek.

---

## 9. Javasolt prototípus-scope (Pilot)

> **Közérthetően:** A teljes elképzelés nagy, ezért nem mindent egyszerre építünk meg. Itt egy reális, lépésekre bontott terv következik egy működő bemutató (prototípus) elkészítésére — nagyjából 3-4 hónap alatt —, amivel egy ügyfélnek kézzelfoghatóan megmutatható, hogy a dolog tényleg működik.

**Fontos különbség: mockup, MVP és pilot nem ugyanaz.** A mockup kattintható, vizuális validáció: eladja és teszteli a történetet, de nem bizonyít működést. Az MVP már valódi, szűk működő szelet: legalább egy agent, egy adatforrás, egy kontrollált futás, egy emberi jóváhagyás és egy auditálható eredmény. A pilot az MVP ügyfélkörnyezetben történő validálása mérőszámokkal, valós felhasználókkal és működési felelősséggel.

| Szint | Mit bizonyít | Mi lehet mock | Mi legyen valódi |
|---|---|---|---|
| **0. Mockup** | Érthető-e a sales-sztori és a workflow | backend, LLM, integráció, auth | képernyőfolyam, demó-adat, UI-logika |
| **1. MVP** | Működik-e a kontrollált agent-futás egy keskeny use case-en | néhány integráció / ritka edge case | ticket, audit, agent-run, modellhívás, jóváhagyás, mérés |
| **2. Pilot** | Van-e mérhető üzleti érték ügyfélkörnyezetben | kevésbé kritikus automatizált lépések | éles adatkezelési szabályok, hozzáférés, monitoring, support |

A teljes vízió nagy; egy hihető **proof-of-value** ehhez a vázhoz:

**Fázis 1 — Control Plane mag (4–6 hét):**
- Kanban board + ticket-állapotgép (szerveroldali validáció),
- Agent Registry (létrehozás, alap-konfiguráció, scoped API-kulcs),
- alap RBAC (ember) + agent service account,
- append-only audit log,
- 1 tickettípus interakcióra + 1 tanítási tickettípus jóváhagyással.

**Fázis 2 — Egy valódi use case a Sandboxban (4–6 hét):**
- pl. **könyvelő agent** számlafeldolgozási javaslattal + emberi jóváhagyással (a 3.2.2 folyamat szerint),
- **Goose harness** headless `goose run` módban, Cloud Run Jobként a dispatcher mögött (4.8.3); a tickethez tartozó recipe-vel,
- Model Gateway külső API-val (Claude) + **Tool Broker mint MCP-proxy**, amelyre a Goose extension-konfigurációja rámutat (3.2.1, 4.8.4),
- a Goose developer-extension lezárása + deny-by-default egress igazolása (3.2.1),
- külső Cowork agent mint teszt-runtime, hogy a kétféle runtime modellt bizonyítsuk.

**Fázis 3 — Enterprise-readiness demonstráció (3–4 hét):**
- memória-verziózás + rollback demo,
- token/költség observability,
- 1 lokális modell bekötése a Gateway-en (a Goose provider-rétegén, az "adat nem hagyja el a céget" történethez).

**Sikerkritérium:** egy végigvitt, **auditálható** folyamat — feltöltött dokumentumtól az ember által jóváhagyott eredményig —, ahol minden lépés visszakereshető, és bemutatható egy tanítási ciklus jóváhagyással és visszagörgetéssel.

### 9.1 MVP minimum — mit kell a tervnek eldöntenie

Az MVP-terv akkor elég konkrét fejlesztésindításhoz, ha az alábbi kérdésekre nem csak elvi, hanem döntött válasz van:

| Döntési terület | MVP-ben eldöntendő | Miért fontos |
|---|---|---|
| **Első use case** | Számlafeldolgozás, reconciliation, chargeback-előkészítés vagy agrár határidő-asszisztens? | A képernyők, adatok, evalok és integrációk ettől függenek |
| **Felhasználói szerepek** | Admin, approver, operator, viewer; agent service account | Jogosultság és demo-flow nélkül nem tesztelhető |
| **Adatforrások** | Milyen dokumentum / táblázat / e-mail / API az input? | A security és retrieval döntések alapja |
| **Integrációs mélység** | Valódi connector, file-upload, mock API vagy manuális export/import? | Ez határozza meg az MVP idő- és kockázati profilját |
| **Agent-futás** | Goose `goose run` Cloud Run Jobként, vagy első körben szimulált agent-run? | Elválasztja a mockupot a működő MVP-től |
| **Modellstratégia** | **Első körben OpenAI előfizetés (nem API) + Gemini API. Saját model hosting = 2. fázis, egyedi ügyfélkérés esetén.** | Költség, latency és adatvédelmi ígéret |
| **Human-in-the-loop pontok** | Melyik lépésnél kötelező emberi jóváhagyás? | A "kontrollált autonómia" itt válik valósággá |
| **Audit minimum** | Milyen események kerülnek naplóba, milyen mezőkkel? | Későbbi compliance és hibakeresés alapja |
| **Mérőszámok** | Időmegtakarítás, pontosság, visszadobási arány, költség/ticket, átfutási idő | Enélkül a PoV nem bizonyít üzleti értéket |
| **Go/no-go kapu** | Milyen eredménynél folytatjuk production irányba? | Megakadályozza a végtelen pilotot |

### 9.2 MVP elfogadási kritériumok

Az első működő MVP akkor tekinthető késznek, ha:

- a kiválasztott use case-re végigmegy egy teljes folyamat inputtól jóváhagyott eredményig;
- legalább egy agent ténylegesen fut kontrollált runtime-ban, vagy ha ez szándékosan későbbi fázis, akkor a dokumentum ezt mockként jelöli;
- minden agent-művelet tickethez kötött és visszakereshető;
- van legalább minimális Model Gateway napló: modell, token/költség, futási idő, státusz;
- van legalább minimális Tool Broker vagy connector audit: milyen erőforrást hívott, milyen jogosultsággal;
- a kritikus üzleti lépés emberi jóváhagyáson megy át;
- a hibás vagy bizonytalan eset emberhez eszkalálódik;
- a demó végén megmutatható, hogy melyik agent-verzió, melyik memória/recipe-verzió és melyik input alapján született az eredmény;
- van egy rövid mérési riport: pontosság, átfutási idő, visszadobási arány, költség/ticket, kvalitatív user feedback.

### 9.3 Első pilot — Belső tudás-asszisztens (llm-wiki) **[DÖNTVE]**

**Döntés:** az első pilot a **belső tudás-asszisztens**, nem dokumentumfeldolgozás. A pilot feladata:

1. **Belső tudásbázis (llm-wiki) létrehozása és karbantartása** — a szervezet belső szabályzatai, folyamatleírásai, eljárásrendei, értesítők és egyéb dokumentumok strukturált, kereshető formában elérhetők; az asszisztens ezekből ad hivatkozott választ.
2. **Felhasználói elvárás szerinti jelentések készítése** — az asszisztens nem csak kérdés-válasz módban működik, hanem igény szerint összefoglalókat, riportokat, tematikus kivonatolást is képes önállóan előállítani a belső tudásbázisból.

**Miért ez az első pilot:**

- minden belső csapatnak szüksége van rá (nincs ügyfél-specifikus scope, könnyen indítható);
- természetes human-in-the-loop pont: a tudásbázis-frissítés jóváhagyott, tanítási ticketen megy (4.6);
- alacsony kockázat — kifelé nem ír, csak belső adatból olvas, és citált választ ad;
- mérhető: megválaszolt kérdések aránya, válaszminőség (emberi értékelés), időmegtakarítás, forrás-lefedettség;
- demonstrálja a RAG + grounded retrieval + tanítási ciklus hármast valós, szervezeti adatokon;
- természetes bővítési irány: proaktív figyelő (11.5), majd dokumentumfeldolgozás (11.1), reconciliation (9.3.1).

**Modellstratégia a pilotnál [DÖNTVE]:** első körben **OpenAI előfizetés** (ChatGPT Plus / Teams — nem API), és **Gemini API**. Saját model hosting nem cél az első pilotban; ez **csak 2. fázis, egyedi ügyfélkérés esetén** kerül terítékre. Az "adat nem hagyja el a céget" sztori egyelőre az API-szintű adatkezelési feltételeken alapul.

**Sikerkritérium (9.2 szerint):** egy munkatárs kérdést tesz fel; az asszisztens citált, ellenőrizhető választ ad a belső dokumentumokból; a forráshivatkozás visszakereshető; egy tanítási ticketen keresztül bővíthető a tudás, és a bővítés jóváhagyott + auditált. Emellett az asszisztens legalább egy előre definiált sablonú jelentést tud generálni a tudásbázisból emberi kérésre.

*(A korábban javasolt bejövő számla- és dokumentumfeldolgozó agent a természetes **második pilot** — a belső tudásbázis felépülése után az is gyorsabban indul, mert a platform infrastruktúrája már áll.)*

---

## 10. Nyitott kérdések és elhalasztott döntések

> **Közérthetően:** A lezárt döntések a releváns fejezetekbe épültek be. Ez a fejezet két dolgot tartalmaz: (A) amit még technikai spike-kal vagy ügyfélinterjún kell validálni, és (B) azok a tervek, amelyeket szándékosan halasztottunk el — nem vesznek el, de belátható időn belül nem implementáljuk őket.

### 10.A Validálandó (spike / ügyfélinterjú)

- **Goose-on belüli spike-ok:** a routolt modell valós kódolási minősége; lokális modell tool-use megbízhatósága a Goose provider-rétegén; `goose run`/recipe beágyazása a dispatcher mögé; a developer-extension lezárásának (3.2.1) tesztje.
- **Goose-verziókövetés / supply-chain:** verzió-pinnelés, image-aláírás (SBOM), frissítési policy — szabályozott ügyfélnél elvárás lehet.
- **Recipe-katalógus operatív részletei (4.8.6):** recipe-csomag formátuma, progressive disclosure küszöbök, első iparági sablon-csomagok köre.
- **`GOOSE_MODE` policy:** alapértelmezett jóváhagyási mód tickettípusonként (`auto` / `approve` / `smart_approve`).
- **Második referencia use case és iparág** — a belső tudás-asszisztens pilot után: reconciliation, chargeback-előkészítés, dokumentumfeldolgozás (9.3).

### 10.B Elhalasztott döntések

Ezek a tervek megmaradnak az architektúrában mint lehetséges irányok, de **belátható időn belül nem implementáljuk** őket — saját megoldás marad alapértelmezésben. Az adott komponens csak akkor kerül terítékre, ha konkrét ügyfélkérés vagy szabályozói elvárás indokolja.

| Komponens | Alapértelmezett (saját) | Elhalasztott irány | Trigger |
|---|---|---|---|
| **Sensitivity-aware router** (4.7.2) | Nincs — API szintű adatkezelési feltételek az alap | Lokális pre-flight classifier (NER / kis modell) a kimenő prompt vizsgálatára | Szabályozott ügyfél, ahol tartalom-szintű PII/kártyaadat-garancia elvárás |
| **Külső policy engine** (4.13) | Allowlist / `if`-ellenőrzés (`authorize()`) | OPA / Cedar policy-as-code | Sok agent+tool kombináció, ABAC, banki audit-elvárás |
| **Memory substrate** (4.13) | Verziózott fájl/DB + write-gate | Zep / Graphiti (temporal, provenance) | Nagy skála + "mikor mi volt igaz" temporal igény |
| **Memory retrieval — hibrid keresés** (4.6.2) | Teljes beinjektálás (kis memóriánál) | Hibrid FTS5 + lokális vektor + RRF + salience | Tudásbázis mérete nő, vagy relevancia-alapú szűrés szükséges |
| **Saját model hosting** (4.7) | OpenAI előfizetés + Gemini API | Lokális GPU-szerver (Ollama) a Model Gateway mögött | 2. fázis: konkrét ügyfélkérés, "az adat nem hagyja el a céget" elvárás |

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

### 11.5 Proaktív monitor-agent (határidő- és eltérés-figyelő)

- **Folyamat / fájdalom:** a fontos jelek (közelgő határidők, reconciliation-eltérések, gyűlő, feldolgozatlan levelek, elakadt feladatok) szétszórtak; ember csak akkor veszi észre, ha már baj van, vagy folyamatos kézi ellenőrzést igényel.
- **AI-megoldás:** **csendes, proaktív figyelés** (4.11.7): determinisztikus, nem-LLM söprés gyűjti a jeleket és szűr; csak ténylegesen fontos esemény esetén **nyit tickettet** a boardon (és opcionálisan küld értesítést). A drága LLM csak releváns jelnél indul.
- **Szükséges adat/rendszer:** a figyelt forrásokhoz connector (naptár, e-mail, könyvelő/ERP, a board maga); minden hívás a Tool Brokeren át (4.8.4).
- **Emberi jóváhagyás:** a proaktívan nyitott ticket ugyanúgy a jóváhagyási/feldolgozási folyamatba kerül; a "proaktív" csak az indítás módja.
- **Kockázat/kontroll:** riasztás-fáradtság ellen **konfigurálható küszöb** (csak fontosnál szól); költségkorlát a monitor frekvenciáján és per-futás budget-jén (4.11.4, 8.6); az értesítés csak figyelemfelhívás, az auditált felület a board.
- **Metrika:** elkapott vs. elmulasztott fontos esemény, false-positive (felesleges) jelzések aránya, reakcióidő.
- **Megjegyzés:** ez a minta keresztbe-erősíti a 11.2 (e-mail-triage) és 11.3 (határidő-asszisztens) use case-eket — gyakran azok proaktív "motorjaként" működik.

**Általánosítható minta:** a 11.1–11.4 nem Ostoros-Novaj-specifikus — szinte minden normál vállalatnál (gyártó, kereskedő, szolgáltató) ugyanezek a belépő admin use case-ek működnek. Ez adja az **újrahasznosítható use-case katalógus** magját: az itt megépített agent-sablonok és connectorok a következő ügyfeleknél már nagyrészt készen állnak (4.12, 5.3.2). A 11.3 az egyetlen erősen iparág-specifikus elem — pont ez lehet a referenciaérték Ostoros-Novajnál.

---

## 12. Mit érdemes még beleírni, hogy a dokumentum MVP-tervezésre alkalmas legyen?

> **Közérthetően:** A koncepció most már jól leírja, *mit* akarunk építeni és *miért*. MVP-tervezéshez azonban kell még egy fejlesztésindító réteg: pontosan melyik folyamatot építjük meg először, milyen adatokkal, milyen képernyőkkel, milyen mérőszámokkal, és mi számít késznek. Ez a fejezet a koncepcióból backlog- és projektterv-alapot csinál.

### 12.1 MVP-tervezési hiánylista

Az alábbi elemeket érdemes a következő iterációban külön, döntött formában hozzáírni. Ezek nem új architekturális ötletek, hanem a meglévő koncepció fejlesztésindító konkretizálásai.

| Terület | Mit kell beleírni | Kimenet |
|---|---|---|
| **MVP célhipotézis** | Egy mondatban: milyen üzleti eredményt bizonyít az MVP? | Pl. "A számlafeldolgozási előkészítés 50%-kal gyorsabb, auditálható jóváhagyással." |
| **Első use case kiválasztása** | Pontosan melyik folyamat, melyik ügyféltípus, melyik fájdalompont | MVP use case one-pager |
| **As-is folyamat** | Hogyan zajlik ma a folyamat emberrel, Excelben, e-mailben, ERP-ben | Rövid folyamatábra + fájdalompontlista |
| **To-be agent flow** | Hol dolgozik az agent, hol dönt ember, hol történik rendszerbe írás | Ticket-flow / Playbook-váz |
| **Felhasználói szerepek** | Admin, approver, operator, viewer; melyik mit lát és mit tehet | RBAC mátrix |
| **Adatleltár** | Milyen dokumentum, mező, személyes adat, üzleti titok, kártyaadat jöhet be | Data inventory + sensitivity labels |
| **Integrációs térkép** | Milyen rendszerekhez kell csatlakozni most és később | Connector backlog |
| **Mock vs. real határ** | Mi szimulált, mi valódi backend, mi valódi LLM, mi valódi connector | Scope contract |
| **Biztonsági minimum** | Secret-kezelés, egress, audit, human approval, rate limit, kill switch | MVP security baseline |
| **Eval és mérés** | Milyen tesztkészleten mérjük a pontosságot és hibákat | Eval plan + acceptance thresholds |
| **Költségmodell** | Várható token/futás, futásszám/nap, modellköltség, infra | Cost envelope |
| **Üzemeltetési modell** | Ki figyeli, ki javítja, ki tanítja, ki hagy jóvá változást | RACI + support modell |
| **Go/no-go döntés** | Milyen mérési eredménynél folytatjuk production irányba | Pilot exit criteria |

### 12.2 Javasolt MVP one-pager sablon

Minden MVP-jelölt use case-hez legyen egy egyoldalas leírás az alábbi szerkezettel:

1. **Üzleti probléma:** mi fáj ma, mennyibe kerül, milyen kockázatot okoz.
2. **Jelenlegi folyamat:** szereplők, rendszerek, kézi lépések, tipikus hibák.
3. **Agent-feladat:** pontosan mit készít elő / ellenőriz / javasol az agent.
4. **Emberi döntési pont:** hol kötelező jóváhagyás, ki hagyhat jóvá.
5. **Adatok és integrációk:** inputok, outputok, rendszerek, érzékeny adatok.
6. **Kontrollok:** RBAC, Tool Broker capability, Model Gateway routing, audit, rollback.
7. **Mérőszámok:** üzleti KPI, minőségi KPI, költség KPI, compliance KPI.
8. **MVP scope:** in scope / out of scope / későbbi fázis.
9. **Elfogadási kritérium:** objektív feltétel, amely alapján késznek tekinthető.
10. **Fő kockázatok:** technikai, adatvédelmi, üzleti, működési kockázat és mitigáció.

### 12.3 Első MVP backlog javaslat

**Epik 1 — Control Plane minimum**

- ticket board és ticket-részlet;
- ticket-állapotgép szerveroldali validációval;
- agent registry egy agenttel;
- alap RBAC: admin / approver / operator / viewer;
- append-only audit event modell;
- Model Gateway wrapper minimális token/költség naplóval.

**Epik 2 — Sandbox use case**

- dokumentumfeltöltés vagy adatsor-import;
- számla/dokumentum feldolgozási dashboard;
- stretch: generált riport önálló A0 HTML sandbox appként, preview + `.html` export (5.9);
- agent-javaslat megjelenítése forrással és indoklással;
- jóváhagyásra küldés;
- jóváhagyott eredmény lezárása.

**Epik 3 — Agent runtime**

- Goose container alap;
- `goose run` ticketenkénti indítás;
- recipe betöltés tickettípus alapján;
- Tool Broker első, szűkített connectorral;
- egress deny-by-default teszt;
- strukturált run output visszaírása ticketre.

**Epik 4 — Governance és mérés**

- human-in-the-loop jóváhagyási kapu;
- audit nézet;
- token/költség dashboard minimum;
- hibás/bizonytalan eset eszkaláció;
- egyszerű eval dataset és manuális értékelési felület;
- tanítási ticket első verziója rollback-demóval.

### 12.4 MVP mérési modell

Az MVP üzleti értékét négy dimenzióban kell mérni:

| Dimenzió | Példa metrika | Cél az első MVP-ben |
|---|---|---|
| **Hatékonyság** | feldolgozási idő / dokumentum, manuális lépések száma | csökkenés kimutatása kis mintán |
| **Minőség** | mezőkinyerési pontosság, emberi visszadobási arány | hibák láthatóvá tétele, nem eltüntetése |
| **Kontroll** | jóváhagyott vs. automatikus lépések, audit teljessége | minden kritikus lépés visszakereshető |
| **Költség** | tokenköltség / ticket, runtime költség / nap | költségplafon és trend látható |

Ezt már az MVP-ben rögzíteni kell, mert a tanácsadói értékesítésnél a következő kérdés nem az lesz, hogy "működik-e az AI?", hanem az, hogy **mennyit javít a folyamaton, mennyiért, milyen kockázattal**.

### 12.5 Ügyfélinterjú kérdések MVP előtt

Az MVP scope véglegesítése előtt legalább ezekre a kérdésekre kell választ kapni:

- Melyik folyamatban van ma a legtöbb kézi munka, hiba vagy átfutási idő?
- Milyen dokumentumokból/adatokból dolgozik a folyamat?
- Ki dönt ma, ki ellenőriz, ki vállalja a felelősséget?
- Melyik lépés nem automatizálható teljesen jogi vagy üzleti okból?
- Melyik rendszerbe kell írni, és hol elég csak javaslatot készíteni?
- Van-e személyes adat, kártyaadat, banki adat vagy üzleti titok az inputban?
- Mi számít sikernek 30, 60 és 90 nap után?
- Milyen audit vagy compliance kérdésre kell bizonyítékot adni?
- Ki lesz az üzleti owner, a technical owner és a jóváhagyó?

### 12.6 Javasolt következő dokumentumok

A koncepció mellé érdemes külön elkészíteni:

- **MVP use case one-pager** az első kiválasztott folyamatról;
- **MVP product requirements document (PRD)** képernyőkkel, szerepekkel, in/out scope-pal;
- **MVP technical design** konkrét komponensekkel, API-kkal, adatmodellel;
- **Security & compliance baseline** minimális kontrollokkal;
- **Eval plan** tesztadatokkal és elfogadási küszöbökkel;
- **Demo script / sales narrative** 3-5 perces végigkattintható történettel;
- **Pilot commercial offer**: scope, időzítés, felelősségek, díjazás, go/no-go pont.

Ezekkel a koncepció már nem csak inspirációs anyag, hanem ügyfélbeszélgetésből fejlesztésbe fordítható tanácsadói munkaanyag.

---

*Megjegyzés a jelölésekhez: a fenti idővonal- és szabályozási hivatkozások friss forrásból ellenőrizve: 2026-06-14. Éles ügyfélanyag, szerződés vagy compliance-állítás előtt a jogszabályi státuszt újra ellenőrizni kell.*
