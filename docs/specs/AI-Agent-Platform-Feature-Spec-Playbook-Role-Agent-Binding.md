# Feature-spec – Playbook → Folyamat → Futás életciklus (Playbook processz-modell)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.2 (tervezet – teljes újrakeretezés)
**Dátum:** 2026-07-03
**Forrásdokumentumok:** `AI-Agent-Platform-Feature-Spec-Playbook-DONE.md` (§5 spec, §6.2 szemantikai validáció, §7 compiler/runtime, §8.2 ProcessService, §9.2 Operator UI, §13.2 pinnelés), `AI-Agent-Platform-Feature-Spec-Playbook-Orchestrator-DONE.md` (§2.2 `agent_name` binding), `AI-Agent-Platform-Feature-Spec-AgentRegistry-done.md`, `AI-Agent-Platform-Feature-Spec-IAM-RBAC-done.md`, `AI-Agent-Platform-Feature-Spec-Proactive-Monitor` (ütemezett triggerek), `provisioning` (draft→validál→jóváhagyás mintázat)
**Olvasó:** product owner, architect, fejlesztő(k). Feltételezi a Playbook Registry (Fázis 2), a Process runtime, az Agent Registry, a Proaktív Monitor és az IAM/RBAC alapmodell ismeretét.
**Státusz:** tervezet – önálló feature-spec. A **hiányzó életciklust** írja le a Playbook (recept) és a tényleges, agentekkel és emberekkel futó folyamat között.

**Megvalósítási állapot (2026-07-03):** a **Fázis 1** (adat + spec alap), a **Fázis 2** (Folyamat-réteg + indítás), a **Fázis 4 API-része**, a **Monitor-cron triggerintegráció**, a **ticket-trigger backend/action/UI**, a **chat-trigger runtime/API + Folyamat-választó UI + LLM slot-filling fallback**, a **roster-leépítés**, a **blocked riasztó-adapter**, a **Folyamat-összeállító UI alapútvonala** és a **Playbook-szerző agent (§6, WP-10)** kész — a §4.1 szerep→agent kötés a Folyamaton, a §4.2 `agent_role` roster-írás tiltása, a §4.4/§4.5 futásidejű feloldás + `blocked` + best-effort webhook/audit-only riasztás, a §4.7 prompt-rétegzés, a §4.8 alkalmasság, a Folyamat/trigger REST API, a publikált Playbook-verzióból Folyamat-draft létrehozása, szerep→agent kötés, config-rések, triggercsatolás, aktiválás, a Futás-nézet meta/blokk-ok megjelenítése, a Monitor sweep→Futás indítás, a ticket `fieldMap`→Futás indítás, a chat `slotNames`/alias→Futás indítás és a Playbook-szerző agent (NL leírás → validált draft, propose-not-apply, sosem publikál) implementálva és tesztelve. **A négy trigger (§9 DoD) mind kész. A §9 DoD listája teljes egészében kész.** Részletes WP-szintű bontás: `AI-Agent-Platform-Dev-Spec-Playbook-Role-Agent-Binding.md` → „Megvalósítási állapot".

---

## 0. Mit ad ez a dokumentum

A korábbi 0.1-es verzió egy szűk problémát célzott: „hogyan kötődjön egy absztrakt Playbook-szerep egy konkrét agenthez a **példányosításnál**". A tervezés során kiderült, hogy a valódi hiány ennél tágabb, és a kötés helye is más:

**A platform ma nem ismeri a réteget a Playbook (absztrakt recept) és a Futás (egyetlen lefutás) között.** Emiatt nincs válasz arra, hogy:

- hogyan lesz egy receptből tényleges, konkrét agentekhez és emberekhez rendelt, indítható folyamat;
- hogyan **indul** egy folyamat a gyakorlatban (nyilván nem JSON-fájl kézi átadásával, hanem chatből, ticketből vagy ütemezetten);
- hogyan készül el egyáltalán a Playbook, ha a felhasználó nem fog JSON-t szerkeszteni.

Ez a dokumentum bevezeti a **háromszintű modellt** (Playbook → Folyamat → Futás), rögzíti, hogy a szerep→agent kötés a **Folyamat** rétegben történik, meghatározza a **triggereléset** (chat / ticket / Monitor-cron / kézi), és leírja a **Playbook-szerző agentet**, amely természetes nyelvből állít elő validált Playbook-draftot.

---

## 1. A háromszintű modell (a dokumentum gerince)

| Szint | Mi ez | Ki készíti | Kód ma |
|---|---|---|---|
| **1. Playbook** (recept) | Absztrakt, újrahasználható munkafolyamat: lépések, absztrakt szerepek, kapuk, delegációs élek, **sablonos utasítások tipizált résekkel**. Nem ismeri a konkrét világot. | Architect / owner, **a Playbook-szerző agent segítségével** (§6) | `PlaybookVersionV2` ✅ |
| **2. Folyamat** (konfigurált definíció) | A receptre ráhúzva: **szerep→agent kötés**, a **konfig-rések** kitöltése, a **triggerek** csatolása, a **trigger-input → deklarált rés** leképezés. Nevesített, **playbook-verzióra PIN-elt**, újrahasználható. | Ember (operátor/admin), űrlapon, jóváhagyással | `ProcessDefinition` ✅ (API + összeállító UI alapútvonal kész) |
| **3. Futás** (run) | Egyetlen tényleges lefutás egy triggerből, futás-bemenettel. | Trigger (chat / ticket / Monitor / kézi) | `ProcessInstance` ✅ (UI-nyelven „Futás") |

### 1.1 Terminológiai figyelmeztetés (kötelező olvasmány a fejlesztőnek)

A kód ma `ProcessInstance`-t / „Process"-t használ **egyetlen futásra**. Ebben a specben a **„Folyamat" a 2. szint** (konfigurált definíció), a **„Futás" a 3. szint**. A kettő nem ugyanaz. A megvalósításnál:

- **Playbook** = `PlaybookV2` / `PlaybookVersionV2` (marad).
- **Folyamat** = **új entitás** (kód-javaslat: `ProcessDefinition`).
- **Futás** = a meglévő `ProcessInstance`, UI-nyelven „Futás".

A `PlaybookAssignment` séma-tábla (jelenlegi `assignmentType`/`assignmentKey`/`isDefault`) a korábbi „roster" csökevénye — a megvalósításnál el kell dönteni: átfunkcionáljuk a Folyamat tárolására, vagy megszűnik (§4.2, §6).

### 1.2 A kötés helye: miért a Folyamat, nem a Futás

- A **Folyamat** a természetes PIN-pont: rögzíti a playbook-verziót **és** a szerep→agent kötést, és ez futásról futásra változatlan.
- Ugyanabból a Playbookból **több Folyamat** készülhet (pl. „Kódreview" A-csapat agentjeivel napi cronnal, illetve B-csapatéval ticketből) — a kötés a Folyamaton él, nem globális tenant-táblán.
- A **Futás** már csak *feloldja* a Folyamat kötéseit; a nem-interaktív triggerek (cron, ticket) így ember nélkül is determinisztikusan feloldódnak.

---

## 2. Fogalmak

| Fogalom | Jelentés |
|---|---|
| **Playbook-szerep (role)** | Absztrakt szereplő a receptben: `key`, `type` (`agent_role` / `human_role`), `requiredCapabilities`, `requiredPermissions`. |
| **Tipizált rés (input slot)** | A lépés-utasítás sablonjának nevesített változója: `name`, `type` (incl. `freeform`), `required`, **forrás**: `config` (a Folyamat tölti) vagy `trigger` (a futás-bemenet tölti). |
| **Szerep-kötés (role binding)** | `role.key → konkrét agent` leképezés, a **Folyamaton** rögzítve. |
| **Folyamat (Process Definition)** | Konfigurált, nevesített, playbook-verzióra PIN-elt definíció: szerep-kötések + konfig-rés értékek + trigger-kötések. |
| **Trigger** | A Futás indítási módja: **Folyamatok-UI (teszt/kézi)**, **ticket**, **chat**, **Monitor-cron**. Egy Folyamathoz több trigger is tartozhat. |
| **Futás (Run)** | Egyetlen lefutás; a Folyamat kötéseivel, a triggerből érkező futás-bemenettel. |
| **Alkalmas agent** | Aktív agent, azonos tenant, amelynek képességei (engedélyezett tool-ok) **lefedik** a szerep `requiredCapabilities` listáját. |
| **Effektív prompt** | Egy agent-lépés tényleges promptja: `agent-perszóna (additív) + lépés-utasítás (sablon a résekkel kitöltve) + futás-input`. |

---

## 3. Hatókör

### 3.1 Benne van

- A **Folyamat** réteg mint önálló entitás: szerep→agent kötés, konfig-rések, trigger-kötések, playbook-verzió-PIN.
- **Tipizált input-rések** a Playbook lépéseiben (config vs. trigger forrással), és a **prompt-rétegzés** szabályai.
- A **négy belépési pont** (Folyamatok-UI, ticket, chat, Monitor-cron) és triggertípusonként az **input-feloldás**.
- **Cron-triggerelés a meglévő Proaktív Monitorral** (nem új scheduler), megelőző kapuval és futásidejű `blocked`+riasztással.
- A szerep-kötés érvényesítése a lépés-ticketek létrehozásakor (a ticket tényleges agenthez kerül).
- A **Playbook-szerző agent** (Playbook-szint): természetes nyelv → validált Playbook-draft + read-only folyamat-diagram; minden jóváhagyás emberé.

### 3.2 Nincs benne (tudatosan)

- **Folyamat-szintű szerző-agent** (v1). A Folyamatot ember rakja össze űrlapon; ha később lenne rá agent, az is csak draftol, jóváhagyás emberé.
- Konkrét emberi **felhasználó** kötése `human_role`-hoz indításkor. A `human_role` marad **jogosultság-alapú** a kapunál (§4.3).
- Az agent tényleges végrehajtó hurokja (dispatcher → agent-runtime → kimenet). Ez külön feladat; itt csak az előfeltételét (ticket tényleges agenthez kötve) teremtjük meg.
- Több agent egy szerepben, terheléselosztás, dispatch-idejű automatikus választás (§7).
- Playbook grafikus **szerkesztő**, párhuzamos ágak. (A folyamat **read-only megrajzolása** benne van, a drag-and-drop editor nincs.)

---

## 4. Funkcionális követelmények

### 4.1 Szerep-kötés a Folyamat összeállításánál (nem a Futásnál)

- A **Folyamat összeállítása** felületen az operátor kiválaszt egy **publikált Playbook-verziót**, és a rendszer kilistázza annak `agent_role` szerepeit.
- Minden agent-szerephez **agent-választó** jelenik meg, amely **csak az alkalmas agenteket** kínálja (§2 „alkalmas agent").
- Az operátor kitölti a **konfig-réseket** (a lépés-utasítások `config` forrású változóit) és csatolja a **triggereket** (§4.4).
- A Folyamat **mentése/jóváhagyása emberi aktus**. Aktiválni csak akkor lehet, ha minden kötelező agent-szerephez alkalmas agent van kötve, minden kötelező konfig-rés kitöltve, és a csatolt triggerek átmennek a megelőző kapun (§4.5).

### 4.2 A tenant-roster megszűnik

A 0.1-es tenant-szintű `role.key → agent` roster **elhal**: a kötés a Folyamaton él. Ha később kell tenant-szintű alapértelmezés (kényelmi előkitöltés a Folyamat összeállításakor), az kizárólag **javaslat**, nem futásidejű feloldási forrás.

### 4.3 Emberi szerepek kezelése

- `human_role`-hoz nem kötelező konkrét személyt rendelni.
- Az emberi lépés / jóváhagyási kapu **jogosultság-alapú**: bárki kezelheti, akinek megvan a szerep `requiredPermissions` joga.
- Opcionálisan a Folyamat rögzíthet a lépéshez kiegészítő információt (leírás, elvárás), de ez nem konkrét felhasználó-kötés.

### 4.4 Triggerelés és input-feloldás

Egy Futás négyféle triggerből indulhat; egy Folyamat **több triggert** is vihet (pl. éjszakai Monitor-cron *és* napközbeni ticket-indítás). A futás-résekhez (`trigger` forrású inputok) triggertípusonként másképp jut hozzá a rendszer:

| Trigger | Hogyan kapja a futás-inputokat | Megjegyzés |
|---|---|---|
| **Folyamatok-UI (kézi/teszt)** | Az operátor űrlapon kitölti a deklarált mezőket. | Elsődlegesen tesztelésre. |
| **Ticket** | A kiválasztott Folyamat input-deklarációjából **dinamikus űrlap** renderelődik a ticketen (kötelező + opcionális mezők). A trigger-ticket lesz a Futás `rootTicketId`-ja. | A trigger-ticket ≠ a Futás által gyártott lépés-ticketek. |
| **Chat** | A Folyamat kiválasztásakor az LLM **megkapja a kitöltendő mezőket**, kinyeri őket az üzenetből, és a hiányzó kötelezőkre **visszakérdez**. A Futás `conversationId`-vel linkelt. | A chat **csak trigger-felület**, nem végrehajtási közeg (§4.6). |
| **Monitor-cron** | Nincs ember; az inputok **ember nélkül feloldhatók** (configból vagy kontextusból, pl. „utolsó 24 óra commitjai" = `now()`-ból). | A cron a meglévő **Proaktív Monitor** (§4.5), nem új scheduler. |

**Feloldási sorrend a lépés-ticket létrehozásakor** (egyszerűsödött a 0.1-hez képest):

```
1. a Folyamat szerep-kötése (mindig ez az elsődleges és egyetlen forrás)
2. ha nincs érvényes, alkalmas kötés → a Futás `blocked`, és riasztás megy a felelősnek
```

### 4.5 Cron-kapu, megelőző validáció és futásidejű blokk

- **Megelőző kapu (config-idő, hangosan):** amikor egy Folyamathoz **Monitor-cron triggert** kötnek, a rendszer validál: minden kötelező futás-input ember nélkül feloldható-e? Ha nem, **a cron nem csatolható** — a hiba a szerkesztőasztalnál csattan, nem futáskor. A validáció **triggerenként** fut (egy Folyamat cron-triggere elbukhat, miközben a ticket-triggere érvényes).
- **Futásidejű elakadás (megengedő, de sosem néma):** config-időben nem minden szűrhető ki (lejárt API-kulcs, üres adatforrás). Ha futáskor egy input vagy erőforrás nem oldható fel, a Futás **`blocked`** állapotba kerül és **kötelezően riasztást** küld egy felelősnek (admin/owner). **Néma, gazdátlan megállás tilos.**

### 4.6 A Futás közege és a chat-viselkedés

- A Futás **aszinkron ticket-gráf**: lépés-ticketek, delegációs élek, kapuk. Ez a végrehajtási közeg.
- A **chat és a ticket csak trigger-felület.** Chat esetén az a modell, hogy a beszélgetés (a) kinyeri a futás-inputot, (b) létrehozza a Futást (`conversationId` linkkel), (c) a Futás a háttérben, tickettekben fut — akkor is, ha a Folyamat első lépése más agenthez van kötve, mint akivel a user chatel. A chatben **státusz / kapu-kérdés / eredmény** jelenik meg; a szálat nem „veszi át" egy másik agent.

### 4.7 Prompt-rétegzés (a lépés effektív promptja)

Az utasítás a **Playbookban** él (nem a Folyamaton), sablonként, tipizált résekkel — **B-út**:

- **Alap-utasítás:** a Playbook lépése hordozza (pl. „kérdezd le a cég adatait és készíts riportot {{sablon}} alapján a következő cégről: {{cég}}").
- **Rések forrása:** `config` (pl. `sablon` = a Folyamat tölti) vagy `trigger` (pl. `cég` = a futás-bemenet tölti).
- **Perszóna additív:** effektív prompt = `agent-perszóna + lépés-utasítás + futás-input`. A perszónát **nem írjuk felül** — pont azért választunk konkrét agentet, mert a feladathoz kellő tudás/eszköz/hozzáférés az agentben van.
- **Precedencia ütközésnél:** a **lépés-utasítás mérvadó arra, hogy MIT csináljon** (a feladat tartalma), a **perszóna** az identitásra / eszközökre / stílusra. Valódi tartalmi ütközésnél a Playbook lépés-utasítása nyer.

### 4.8 Alkalmassági (validációs) szabályok

Egy agent akkor köthető egy `agent_role`-hoz, ha **aktív** (nem retired/suspended), **azonos tenant**, és **képességei lefedik** a szerep `requiredCapabilities` listáját (a hiányzó képesség tiltó hiba). Ha a kötött agent időközben inaktívvá válik, a Folyamat aktiválása / a Futás indítása alkalmassági hibával elutasításra kerül. Emberi szerepnél a `requiredPermissions`-nek léteznie kell az IAM/RBAC modellben (publikáláskor a Playbook-validáció már ellenőrzi).

### 4.9 Reprodukálhatóság és audit

- A **Folyamat** rögzíti a playbook-verzió-PIN-t és a teljes szerep-kötést + konfig-rés értékeket.
- A **Futás** rögzíti, melyik Folyamatból, melyik triggerből, milyen futás-bemenettel indult; az indítási audit-eseménybe bekerül a Folyamat, a trigger és a kötés.
- A kötés a Futás alatt **nem változik**; a Folyamat playbook-verziójának cseréje **tudatos, külön aktus** (§4.10).

### 4.10 Verziórögzítés és -követés

- A Folyamat **egy konkrét playbook-verzióra** PIN-el.
- Új playbook-verzió publikálásakor a Folyamat **nem ugrik automatikusan** — tudatosan kell áthúzni, mert az új verzió új szereplőket/réseket hozhat, ami **újrakötést** igényelhet. Az áthúzás a Folyamat szerkesztésének és újra-jóváhagyásának minősül.

### 4.11 Hibakezelés

- Ha egy szerephez nincs alkalmas agent a tenantnál, a Folyamat-összeállító felület **egyértelmű hibával** jelez, és az Agent Registry felé irányít.
- Megelőző cron-kapu bukása esetén a cron-csatolás elutasításra kerül, a hiányzó/felold­hatatlan inputok megnevezésével.
- Futásidejű `blocked`: kötelező riasztás + a Futás nézetben látható elakadás-ok.

---

## 5. Felhasználói folyamatok

### 5.A Playbook szerzése (beszélgetéssel)

1. A felhasználó a Playbook-szerző agentnek **természetes nyelven** elmondja, milyen folyamatot képzel el.
2. Az agent (bekötve: ismeri a képesség-vokabulárt és az elérhető agenteket) **validált draftot** állít elő: lépések, szerepek, kapuk, delegációs élek, tipizált rések. A kimenet átmegy a meglévő `playbook-validator` + compileren; a beszélgetés a validációs hibákon **visszacsatol**.
3. Az agent **megrajzolja** a folyamatot (read-only diagram), a user pontosít.
4. A user **menti** (draft-verzió), majd egy jogosult ember **jóváhagyja / publikálja**. Az agent **soha nem publikál**.
5. Meglévő Playbook szerkesztése ugyanígy: a beszélgetés **új draft-verziót** szül a meglévő verzió-életcikluson **belül**; végül ember nyomja meg a mentést.

### 5.B Folyamat összeállítása (ember)

1. Az operátor kiválaszt egy **publikált Playbook-verziót**.
2. Szerepenként **alkalmas agentet** köt; kitölti a **konfig-réseket**; csatol egy vagy több **triggert** (ticket / chat / Monitor-cron / kézi), és megadja a **trigger-input → deklarált rés** leképezést (ticket mező-térkép, chat-mezőlista, cron-kontextus).
3. A rendszer futtatja a **megelőző kaput** (alkalmasság, kötelező rések, cron-feloldhatóság triggerenként).
4. Ember **jóváhagyja** a Folyamatot; ettől kezdve indítható.

### 5.C Futás indítása (trigger)

1. Trigger érkezik (chat-hivatkozás / ticket-kiválasztás / Monitor-cron / kézi teszt).
2. A rendszer feloldja a futás-inputokat (§4.4), validálja őket a deklarált rések ellen, PIN-eli a Folyamatot és a playbook-verziót, és létrehozza a belépő lépés-ticketet a **feloldott tényleges agenthez** rendelve.
3. A Futás aszinkron halad; kapuk emberi jóváhagyással; elakadás → `blocked` + riasztás. A haladás a Futás-nézetben (és chat-trigger esetén a beszélgetésben, státuszként) követhető.

---

## 6. A Playbook-szerző agent

- **Hatókör:** csak a **Playbook-szint** (1. szint). Természetes nyelv → validált Playbook-draft + diagram. A Folyamat-szintet (2.) v1-ben ember állítja össze.
- **Bekötött, nem üres LLM:** ismeri a képesség-vokabulárt és — a Folyamat-fázis támogatásához, ha később kiterjesztjük — az Agent Registryt és a Monitor-listát. (v1-ben a Playbook absztrakt marad, konkrét agentet nem drótoz.)
- **Governance:** draftol a meglévő `draft → validál → ember jóváhagy → publish` láncba. **Sosem keletkezik futtatható artefaktum emberi kapu nélkül.** Ugyanaz a mintázat, mint a provisioning agentnél.
- **Kimenet minősége:** nem „JSON-formázás" — a draft tipizált réseket, éleket, kapukat, képesség-igényeket hordoz, és a validátoron/​compileren átmegy, mielőtt menthető lenne.

---

## 7. Adat- és integrációs vázlat (nem kötelező részletezettségű)

> A fejlesztői bekötés irányát adja; a végleges séma a megvalósításkor véglegesül.

- **Új entitás – Folyamat (`ProcessDefinition`):** `playbookVersionId` (PIN), `role.key → agentId` kötések, `config`-rés értékek, trigger-kötések (típus + input-térkép), tenant, státusz (draft/active/archived), audit.
- **`PlaybookVersionV2` bővítése:** a lépések **tipizált input-deklarációja** (name/type/required/source) és a **sablonos lépés-utasítás** a spec részévé válik.
- **`ProcessInstance` (Futás):** kap egy `processDefinitionId` hivatkozást; a `startedByType` (`user`/`agent`/`system`), `conversationId`, `rootTicketId`, `inputPayload` mezők már léteznek — ezeket most töltjük meg értelmesen.
- **Lépés-ticket létrehozás:** a `ProcessStepInstance.assignedAgentId` a **Folyamat kötéséből** töltődik (a jelenlegi `assigneeId: null` helyett).
- **Trigger-integrációk:** ticket-oldali dinamikus űrlap a Folyamat input-deklarációjából; chat-oldali slot-filling; **Monitor** mint cron-trigger-forrás, amely a cron-kontextust futás-inputként adja át.
- **`PlaybookAssignment`:** eldöntendő — a Folyamat tárolására átfunkcionálni, vagy megszüntetni (a roster elhalt).

---

## 8. Alternatívák és mérlegelés

| Kötési pont | Előny | Hátrány | Döntés |
|---|---|---|---|
| Sablonba drótozva (design-time, `agent_name`) | Egyszerű, explicit | Nem hordozható; minden agent-változásnál módosítás | Elvetve |
| Tenant-roster (globális alapértelmezés) | Kevés operátori döntés | Nem elég rugalmas; a Folyamat réteg kiváltja | **Elvetve** (roster elhal) |
| **Folyamat-rétegű kötés (ez a javaslat)** | Rugalmas, auditálható, PIN-konzisztens, sablon-hordozható, nem-interaktív triggerekhez ember nélkül feloldható | Külön Folyamat-összeállító aktus kell | **Ajánlott** |
| Dispatch-időben, automatikus képesség-illesztéssel | Teljes automatizmus | Kevésbé kiszámítható | Opcionális későbbi 3. szint |

---

## 9. Definition of Done (javasolt)

- ✅ Létezik a **Folyamat** entitás: playbook-verzió-PIN + szerep→agent kötés + konfig-rések + trigger-kötések, draft/active/archived életciklussal és emberi jóváhagyással.
- ✅ A Playbook lépései **tipizált input-réseket** és **sablonos utasítást** hordoznak; a rések forrása (config/trigger) deklarált.
- ✅ A **négy trigger** működik; a futás-inputok triggertípusonként helyesen oldódnak fel; a chat csak trigger-felület. **Státusz:** manual indítás, Monitor-cron sweep→Futás, ticket-trigger backend/action/UI, valamint chat-trigger runtime/API + Folyamat-választó UI + LLM slot-filling fallback kész.
- ✅ A **Monitor-cron** trigger a megelőző kapun átmegy; a meglévő Monitor sweep `contextMap` alapján Futást indít; futásidejű elakadás → `blocked` + audit + best-effort riasztó adapter; néma megállás nincs.
- ✅ A lépés-ticketek a Folyamat kötéséből **tényleges agenthez** jönnek létre.
- ✅ Az effektív prompt a §4.7 rétegzés szerint áll össze (perszóna additív, lépés-utasítás mérvadó a feladatra).
- ✅ A **Playbook-szerző agent** természetes nyelvből validált draftot + diagramot állít elő; minden jóváhagyás emberé; a szerkesztés a verzió-életcikluson belül új draftot szül.
- ✅ A Folyamat, a trigger és a kötés megjelenik az indítási audit-eseményben és a Futás-nézetben.
- ✅ A Folyamat-összeállító UI alapútvonala kész: publikált Playbook-verzió választása, alkalmas-agent választók, config-rések, triggercsatolás, aktiválás.
- ✅ Az emberi szerepek jóváhagyása jogosultság-alapú marad a kapunál.

---

## 10. Nyitott döntések

| ID | Kérdés | Javasolt döntés |
|---|---|---|
| RB-2 | Kell-e indításkor emberi szerephez konkrét felhasználót kötni? | Nem a v1-ben; marad jogosultság-alapú a kapunál. |
| RB-3 | Megengedjük-e egy szerephez több agentet (terheléselosztás)? | Nem a v1-ben; egy szerep = egy agent Folyamatonként. |
| RB-4 | Bevezessük-e a dispatch-idejű automatikus választást? | Opcionális későbbi 3. szint; a Folyamat-kötés mindig elsőbbség. |
| PB-1 | A `PlaybookAssignment` tábla sorsa? | ✅ Eldöntve és implementálva: nem funkcionál át Folyamattá; külön `ProcessDefinition` tábla van, az `agent_role` roster-írás tiltott. |
| PB-2 | Prompt-réteg tartalmi ütközésének élesetei (a §4.7 precedencián túl)? | Nyitva; mérés alapján finomítjuk. |
| PB-3 | Chatben a státusz/kapu felszínre hozásának UX-e? | Nyitva; a Futás-státusz a beszélgetésben jelenjen meg, részletek a Futás-nézetben. |
| PB-4 | Folyamat-szintű szerző-agent? | Későbbi bővítés; ha lesz, csak draftol, jóváhagyás emberé. |
| PB-5 | Tenant-szintű kötés-javaslat (kényelmi előkitöltés a Folyamat-összeállításnál)? | Opcionális; kizárólag javaslat, nem futásidejű feloldási forrás. |
