# Enterprise AI Agent Platform — Tesztterv

**Verziő:** 1.0  
**Dátum:** 2026-06-30  
**Alkalmazás:** Enterprise AI Agent Platform (Control Plane + Sandbox)

---

## 1. Az alkalmazásról — Üzleti összefoglaló

Az **Enterprise AI Agent Platform** egy vállalati szoftver, amellyel mesterséges intelligencia alapú "digitális munkatársakat" (agenteket) lehet létrehozni, irányítani és megfigyelni. Ezek az ágensek emberi felügyelet alatt képesek elvégezni ismétlődő irodai feladatokat — például dokumentumok feldolgozását, adatok összesítését, e-mailek kezelését — miközben minden lépésük naplózva van és jóváhagyható.

A rendszer két fő felületből áll:
- **Control Plane (Irányítópult):** A rendszergazdák és jóváhagyók itt kezelik az ágenseket, szabályokat és jogosultságokat.
- **Sandbox (Munkaterület):** A végfelhasználók itt kommunikálnak az ágensekkel és látják az eredményeket.

---

## 2. Tesztelési előfeltételek

Mielőtt a tesztelést elkezdenéd, győződj meg az alábbiakról:

- [ ] Az alkalmazás fut és elérhető böngészőből
- [ ] Van legalább egy **Admin** jogosultságú felhasználói fiók (teljes hozzáférés)
- [ ] Van legalább egy **Approver** (jóváhagyó) jogosultságú felhasználói fiók
- [ ] Van legalább egy **Operator** (üzemeltetői) jogosultságú felhasználói fiók
- [ ] Van legalább egy **Viewer** (csak olvasó) jogosultságú felhasználói fiók
- [ ] A rendszer adatbázisa **tesztmódban** van (System → DB Mode: TEST), hogy a valódi adatok ne keveredjenek a tesztadatokkal
- [ ] Internet-kapcsolat elérhető (a külső API-összekötőkkel kapcsolatos tesztekhez)

### Tesztfelhasználók (javasolt)

| Felhasználó | E-mail (példa) | Szerepkör |
|-------------|---------------|-----------|
| Admin Teszt | admin@test.local | admin |
| Jóváhagyó Teszt | approver@test.local | approver |
| Üzemeltető Teszt | operator@test.local | operator |
| Olvasó Teszt | viewer@test.local | viewer |

---

## 3. Tesztesetek

A tesztesetek modulonként vannak csoportosítva. Minden tesztesethez meg van adva:
- **Üzleti leírás:** Mit tesztelünk és miért fontos üzleti szempontból
- **Előfeltétel:** Mi szükséges a teszt elvégzéséhez
- **Lépések:** Pontosan mit kell csinálni
- **Elvárt eredmény:** Mi a sikeres teszt jele

---

## 3.1. Modulok tesztsorrendje (ajánlott)

```
IAM (felhasználókezelés)
    ↓
Viselkedési profilok (Behavior Profiles)
    ↓
Ágens-nyilvántartás (Agent Registry)
    ↓
Összekötők (Connectors) + Jóváhagyási workflow
    ↓
Conversation (Chat)
    ↓
Jegyek (Board/Tickets)
    ↓
Playbook (folyamatok)
    ↓
Monitor (proaktív riasztás)
    ↓
Tréning (Memory Training)
    ↓
Audit napló + Governance
    ↓
Rendszervezérlés (System Controls)
```

---

## MODUL 1 — Felhasználókezelés (IAM)

### TC-IAM-01: Felhasználó meghívása és bejelentkezés

**Üzleti leírás:**  
Egy vállalati rendszer esetén nem minden munkavállaló tud önállóan regisztrálni — a rendszergazda meghívón keresztül ad hozzáférést. Ez a teszt ellenőrzi, hogy az Admin képes-e új felhasználókat meghívni, és hogy a meghívott felhasználó tényleg be tud-e lépni a megfelelő jogkörrel.

**Előfeltétel:** Admin jogosultságú felhasználóval bejelentkezve.

**Lépések:**
1. Nyisd meg a Control Plane-t, navigálj az **IAM** menüpontba.
2. Kattints az **"Invite User"** (Felhasználó meghívása) gombra.
3. Add meg a meghívott e-mail-címét: `viewer@test.local`
4. Válaszd a **Viewer** szerepkört.
5. Kattints a **"Send Invite"** gombra.
6. Nyisd meg a meghívott e-mail postaládáját, kattints a meghívó linkre.
7. Regisztrálj az alkalmazásba a meghívó alapján.
8. Lépj be `viewer@test.local` felhasználóval.

**Elvárt eredmény:**
- A meghívó e-mail megérkezik.
- A regisztráció sikeres.
- A Viewer-ként bejelentkezve a felhasználó látja a Control Plane olvasható részeit, de **nem látja az "Invite User" vagy "Create Agent" gombokat** — nincs szerkesztési lehetősége.

---

### TC-IAM-02: Felhasználó felfüggesztése

**Üzleti leírás:**  
Ha egy munkavállaló kilép a cégtől vagy jogtalan hozzáférést szerzett, a rendszergazdának azonnal meg kell tudnia vonni a hozzáférést. A teszt ellenőrzi, hogy a felfüggesztett felhasználó nem tud többé bejelentkezni.

**Előfeltétel:** Admin felhasználóval bejelentkezve. Az `operator@test.local` felhasználó létezik.

**Lépések:**
1. Navigálj az **IAM** menüpontba.
2. Keresd meg az `operator@test.local` felhasználót a listában.
3. Kattints a felhasználó neve melletti **"Suspend"** (Felfüggesztés) gombra.
4. Erősítsd meg a felfüggesztést a felugró ablakban.
5. Jelentkezz ki az admin fiókból.
6. Próbálj bejelentkezni `operator@test.local` felhasználóval.

**Elvárt eredmény:**
- A felfüggesztés után a felhasználó státusza **"suspended"**-re változik a listában.
- A bejelentkezési kísérlet sikertelen: a rendszer hibaüzenetet jelenít meg ("Your account has been suspended" vagy hasonló).
- A felfüggesztett felhasználó aktív session-jei (ha volt) érvényteleníthetők.

---

### TC-IAM-03: Szerepkör korlátozásainak ellenőrzése (negatív teszt)

**Üzleti leírás:**  
Egy Viewer jogosultságú felhasználó csak olvashatja az adatokat, de nem módosíthatja azokat. Ez a teszt azt ellenőrzi, hogy a rendszer megakadályozza-e a jogtalan módosításokat.

**Előfeltétel:** `viewer@test.local` felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj az **Agents** (Ágensek) menüpontba.
2. Kattints bármely ágens nevére.
3. Keresd a **"Edit"** vagy **"Suspend"** gombot.

**Elvárt eredmény:**
- Az "Edit", "Suspend", "Retire" gombok vagy **nem jelennek meg**, vagy **le vannak tiltva** (szürke, kattinthatatlan).
- Ha valamilyen módon mégis megpróbálsz módosítani (pl. URL manipulációval), a rendszer **403 Forbidden** hibát ad vissza.

---

## MODUL 2 — Viselkedési profilok (Behavior Profiles)

### TC-BP-01: Viselkedési profil létrehozása

**Üzleti leírás:**  
Egy vállalatnál elvárás, hogy az összes mesterséges intelligencia alapú munkatárs ugyanolyan hangnemben és stílusban kommunikáljon — pl. mindig formálisan, magyarul, tömören fogalmazzon és mindig hivatkozzon forrásokra. A "Viselkedési profil" (Behavior Profile) egy megosztható sablon, amelyet több ágensnek is be lehet állítani, így nem kell minden ágensnek egyenként megadni ezeket a szabályokat.

**Előfeltétel:** Admin felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Behavior Profiles** menüpontba.
2. Kattints a **"New Profile"** gombra.
3. Add meg a profil nevét: `Formális Magyar Profil`
4. A leírás mezőbe írd: `Mindig formális, magyarul kommunikál, tömör válaszokat ad, mindig megnevezi a forrásait.`
5. A profil szövegébe írd be a tényleges viselkedési utasítást (pl.):
   ```
   Mindig formális, udvarias hangnemben kommunikálj magyarul. Válaszaid legyenek tömörek és strukturáltak. Minden állításodnál jelöld meg a forrást. Kerüld az informális szóhasználatot és az emotikonokat.
   ```
6. Kattints a **"Save Draft"** gombra.
7. Kattints a **"Submit for Approval"** gombra.
8. Jelentkezz be Approver felhasználóval, és hagyd jóvá a profilt.

**Elvárt eredmény:**
- A profil megjelenik a listában `draft` → `approved` státuszban.
- A jóváhagyás után a profil kiválasztható ágensekhez rendeléskor.
- A profil verziószáma `v1` lesz.

---

### TC-BP-02: Viselkedési profil frissítése és verziózás

**Üzleti leírás:**  
Ha a vállalat kommunikációs irányvonalai változnak (pl. mostantól angolul kell kommunikálni), a profilt frissíteni kell anélkül, hogy a korábban rögzített viselkedés elveszne. A verziózás biztosítja, hogy mindig visszanézhető legyen, mikor és hogyan változott a profil.

**Előfeltétel:** Az előző tesztesetben (`TC-BP-01`) létrehozott profil jóváhagyott állapotban van.

**Lépések:**
1. Navigálj a **Behavior Profiles** menüpontba.
2. Nyisd meg a `Formális Magyar Profil` profilt.
3. Kattints az **"Edit / New Version"** gombra.
4. Módosítsd a szöveget: változtasd a "magyarul" szót "angolul"-ra.
5. Kattints a **"Save Draft"** majd **"Submit for Approval"** gombra.
6. Approver felhasználóval hagyd jóvá.

**Elvárt eredmény:**
- A profil most `v2` verziót mutat.
- A verziótörténetben látható mind a `v1`, mind a `v2` szövege.
- Az ágensek, amelyek korábban `v1`-et használtak, **nem frissültek automatikusan** — a frissítés kézzel kezdeményezhető.

---

## MODUL 3 — Ágens-nyilvántartás (Agent Registry)

### TC-AR-01: Új ágens létrehozása (draft)

**Üzleti leírás:**  
Egy új "digitális munkatárs" (ágens) létrehozásakor megadjuk, ki ő, mit csinál és hogyan viselkedik. Amíg az ágens nincs aktiválva, addig nem végezhet el valódi feladatokat — ez az előkészítési fázis.

**Előfeltétel:** Admin felhasználóval bejelentkezve. A `Formális Magyar Profil` jóváhagyott állapotban van.

**Lépések:**
1. Navigálj az **Agents** menüpontba.
2. Kattints a **"New Agent"** gombra.
3. Töltsd ki az alábbi mezőket:
   - **Name:** `Számlafeldolgozó Ágens`
   - **Role:** `worker` (munkavégző)
   - **Role Instruction:** `Te egy számla-feldolgozó asszisztens vagy. Feladatod bejövő számlák adatainak kinyerése és validálása.`
   - **Behavior Profile:** Válaszd ki a `Formális Magyar Profil`-t
   - **Model:** Hagyd az alapértelmezett beállítást
4. Kattints a **"Create"** gombra.

**Elvárt eredmény:**
- Az ágens megjelenik a listában `draft` státuszban.
- Az ágens adatlapján látható az összes megadott adat.
- Az ágens jelenleg **nem dispatacheable** (nem indítható el feladattal).

---

### TC-AR-02: Ágens aktiválása

**Üzleti leírás:**  
Csak az aktivált ágensek fogadhatnak feladatokat. Az aktiválás egy tudatos döntés, amellyel megerősítjük, hogy az ágens konfiguráció helyes és kész az éles használatra.

**Előfeltétel:** A `Számlafeldolgozó Ágens` `draft` státuszban van.

**Lépések:**
1. Navigálj az **Agents** menüpontba.
2. Nyisd meg a `Számlafeldolgozó Ágens` adatlapját.
3. Kattints az **"Activate"** gombra.
4. Erősítsd meg a felugró ablakban.

**Elvárt eredmény:**
- Az ágens státusza `draft` → `active`-ra változik.
- Az aktív ágensek listájában megjelenik.
- Az ágens most már kaphat feladatokat és indítható Conversation-ből.

---

### TC-AR-03: Ágens felfüggesztése és újraaktiválása

**Üzleti leírás:**  
Ha egy ágensben problémát észlelünk (pl. hibás válaszokat ad), gyorsan le kell tudni állítani anélkül, hogy az összes beállítását elveszítenénk. A felfüggesztett ágens szünetel, de újra aktiválható.

**Előfeltétel:** A `Számlafeldolgozó Ágens` `active` státuszban van.

**Lépések:**
1. Navigálj az **Agents** menüpontba, nyisd meg az ágenst.
2. Kattints a **"Suspend"** gombra.
3. Erősítsd meg a felfüggesztést.
4. Ellenőrizd, hogy a státusz `suspended`-re változott.
5. Kattints a **"Reactivate"** gombra.
6. Erősítsd meg az újraaktiválást.

**Elvárt eredmény:**
- Felfüggesztés után: státusz = `suspended`, az ágens nem kaphat új feladatokat.
- Újraaktiválás után: státusz = `active`, az ágens ismét fogadhat feladatokat.
- A felfüggesztés és újraaktiválás esemény megjelenik az **Audit Log**-ban.

---

### TC-AR-04: Ágens nyugdíjazása (retire) — visszafordíthatatlan lépés

**Üzleti leírás:**  
Ha egy ágensre már nincs szükség, véglegesen ki lehet vonni a forgalomból. A nyugdíjazás visszafordíthatatlan — a régi konfiguráció megmarad archívumban, de az ágens soha nem aktiválható újra.

**Előfeltétel:** A `Számlafeldolgozó Ágens` `suspended` státuszban van.

**Lépések:**
1. Navigálj az **Agents** menüpontba, nyisd meg az ágenst.
2. Kattints a **"Retire"** gombra.
3. A megerősítő ablakban írd be az ágens nevét (ha a rendszer kéri).
4. Kattints a **"Confirm Retire"** gombra.

**Elvárt eredmény:**
- Az ágens státusza `retired`-re változik.
- Az ágens eltűnik az aktív listából, de megtalálható az archívumban.
- A **"Reactivate"** gomb nem érhető el többé.
- Kísérlet feladat kiosztására a retired ágensnek → a rendszer hibaüzenetet jelenít meg.

---

## MODUL 4 — Összekötők (Connectors)

### TC-CON-01: HTTP API összekötő létrehozása manuálisan

**Üzleti leírás:**  
Az ágensek külső rendszerekkel (pl. ERP, CRM, számlázó rendszer) csak előre definiált és jóváhagyott összekötőkön keresztül kommunikálhatnak. Ez biztosítja, hogy az ágens ne hívjon meg jogtalan API-kat. Ez a teszt egy egyszerű HTTP API összekötő kézi konfigurálását ellenőrzi.

**Előfeltétel:** Admin felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Connectors** menüpontba.
2. Kattints a **"New Connector"** gombra.
3. Válaszd a típust: **`http_api`**
4. Töltsd ki:
   - **Name:** `Teszt API`
   - **Base URL:** `https://jsonplaceholder.typicode.com`
   - **Auth Mode:** `none` (nincs hitelesítés)
   - **Description:** `Nyilvános teszt API fejlesztési célokra`
5. Kattints a **"Save Draft"** gombra.
6. Kattints a **"Validate"** gombra — a rendszer teszteli a kapcsolatot.
7. Ha a validálás sikeres, kattints az **"Activate"** gombra.

**Elvárt eredmény:**
- Az összekötő `draft` → `validated` → `active` státuszon megy keresztül.
- Az aktív összekötő megjelenik a listában.
- Az ágensek jogosultsági beállításainál már kiválasztható ez az összekötő.

---

### TC-CON-02: Összekötő blokkolása (negatív teszt — SSRF védelem)

**Üzleti leírás:**  
Biztonsági szempontból az ágensek nem érhetnek el belső hálózati erőforrásokat (pl. `localhost`, `10.x.x.x`, `192.168.x.x` belső IP-tartományok). Ez az SSRF (Server-Side Request Forgery) nevű támadástípus ellen véd. A rendszernek automatikusan blokkolnia kell az ilyen kísérleteket.

**Előfeltétel:** Admin felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Connectors** menüpontba.
2. Kattints a **"New Connector"** gombra.
3. Válaszd a típust: **`http_api`**
4. A **Base URL** mezőbe írd: `http://localhost:8080`
5. Kattints a **"Save Draft"** majd a **"Validate"** gombra.

**Elvárt eredmény:**
- A validálás **azonnal sikertelen** egy hibaüzenettel, amely jelzi, hogy belső hálózati cím nem engedélyezett.
- Az összekötő nem kerül `validated` státuszba.
- Ugyanez történik `http://10.0.0.1`, `http://192.168.1.1`, `http://169.254.169.254` esetén is.

---

### TC-CON-03: Felhasználói OAuth jogosultság (per-user grant)

**Üzleti leírás:**  
Bizonyos összekötők (pl. Gmail, naptár) esetén az ágens a felhasználó nevében cselekszik — ez azt jelenti, hogy a felhasználónak egyszer be kell jelentkeznie az adott szolgáltatásba, és engedélyt kell adnia az ágensnek a nevében való cselekvésre. Ez a teszt ellenőrzi ezt a folyamatot.

**Előfeltétel:** Létezik egy `user_delegated` (felhasználói delegálás) módú összekötő (pl. Gmail). Operator felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Connectors** menüpontba.
2. Keresd meg a Gmail típusú összekötőt.
3. Kattints az **"Authorize for Me"** (Saját jogosultság engedélyezése) gombra.
4. A felugró OAuth ablakban jelentkezz be a Google-fiókodba és fogadd el az engedélyeket.
5. Zárd be az OAuth ablakot, térj vissza az alkalmazásba.

**Elvárt eredmény:**
- A rendszer visszajelez, hogy az engedélyezés sikeres volt.
- A "My Grants" (Saját jogosultságok) listában megjelenik a Gmail összekötő `active` státuszban.
- Az ágens mostantól a te nevedben küldhet e-maileket (megfelelő jóváhagyással).

---

## MODUL 5 — Kommunikáció ágensekkel (Conversation Session)

### TC-CS-01: Alapvető chat indítása ágenssei

**Üzleti leírás:**  
A végfelhasználók a Sandbox felületen tudnak kommunikálni az ágensekkel, mintha egy intelligens asszisztenssel csevegnének. Minden üzenetváltás naplózva van és visszakereshető. Ez a teszt az alapvető chat-funkció működését ellenőrzi.

**Előfeltétel:** Legalább egy `active` státuszú ágens létezik. Operator felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Sandbox** felületre.
2. Válaszd ki a `Számlafeldolgozó Ágens`-t (vagy bármely aktív ágenszt).
3. A szövegmezőbe írd be: `Szia! Kérlek mutasd be, mire vagy képes.`
4. Nyomj Entert vagy kattints a küldés gombra.
5. Várd meg az ágens válaszát.
6. Írj még egy üzenetet: `Köszönöm, ez hasznos volt.`

**Elvárt eredmény:**
- Az első üzenet megjelenik a chat ablakban.
- Az ágens néhány másodpercen belül válaszol.
- A válasz hangvétele megfelel a hozzárendelt Viselkedési profilnak (pl. formális, magyar).
- A második üzenet elküldése után az ágens megőrzi a kontextust (emlékszik az előző kérdésre).
- A chat történet megmarad, ha frissíted az oldalt.

---

### TC-CS-02: Jegyalapú jóváhagyás kérése chaten keresztül

**Üzleti leírás:**  
Bizonyos műveletek elvégzéséhez az ágensnek emberi jóváhagyásra van szüksége (pl. e-mail küldése valakinek). Ilyenkor az ágens automatikusan létrehoz egy "jegyet" (ticketet), és jelzi a felhasználónak, hogy jóváhagyás szükséges. Ez a teszt ellenőrzi ezt a folyamatot.

**Előfeltétel:** Az ágens konfigurálva van Gmail összekötővel, amely jóváhagyást igényel e-mail küldésnél.

**Lépések:**
1. Navigálj a **Sandbox** felületre, nyisd meg az ágens chat-et.
2. Írd be: `Kérlek küldj egy e-mailt a test@example.com címre azzal, hogy "Teszt üzenet az ágenstől".`
3. Figyeld az ágens válaszát.
4. Ha az ágens jelzi, hogy jóváhagyás szükséges, navigálj a **Board** (Jegyek) menüponthoz Approver felhasználóval.
5. Keresd meg az újonnan létrehozott jegyet.
6. Ellenőrizd a tartalmát, majd kattints az **"Approve"** gombra.

**Elvárt eredmény:**
- Az ágens az e-mail küldés helyett jegyet hoz létre és tájékoztatja a felhasználót.
- A Board felületen megjelenik az új jegy `awaiting_human` állapotban.
- Jóváhagyás után az e-mail elküldésre kerül (vagy szimulált módon naplózódik tesztkörnyezetben).
- Az Audit Log-ban látható a jegy, a jóváhagyás és az e-mail küldés eseménye.

---

### TC-CS-03: Régi üzenet tartalmának törlése (GDPR)

**Üzleti leírás:**  
Az adatvédelmi jogszabályok (GDPR) alapján a felhasználónak joga van kérni személyes adatai törlését. Az alkalmazás ezt úgy oldja meg, hogy az üzenet tartalmát törli, de a naplóbejegyzés metaadatai (pl. mikor történt az üzenetváltás) megmaradnak az audit célokra. Ez a teszt ezt a funkcionalitást ellenőrzi.

**Előfeltétel:** Létezik egy legalább 5 üzenetből álló korábbi chat-session.

**Lépések:**
1. Navigálj a **Sandbox** felületre, nyisd meg a meglévő chat-session-t.
2. Keresd meg a harmadik üzenetet.
3. Kattints az üzenet melletti törlés ikonra (szemetes, kukac, vagy "Delete content").
4. Erősítsd meg a törlést.

**Elvárt eredmény:**
- Az üzenet **tartalma** törlődik (üres szöveg vagy "[Tartalom törölve]" jelölés jelenik meg).
- Az üzenet **metaadatai** (időbélyeg, ki küldte) megmaradnak.
- A többi üzenet érintetlen marad.
- Az Audit Log rögzíti a törlési eseményt.

---

## MODUL 6 — Jegykezelés (Board / Tickets)

### TC-BRD-01: Jegy manuális létrehozása és státuszváltás

**Üzleti leírás:**  
A jegykezelő rendszer (Board) egy Kanban-tábla, ahol a feladatok, jóváhagyások és munkálatok nyomon követhetők. Egy feladatot kézzel is létrehozhat az üzemeltető, nem csak az ágens generálhat jegyet. Ez a teszt a jegy életciklusát (létrehozás → jóváhagyás → elvégzés) teszteli.

**Előfeltétel:** Operator felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Board** menüpontba.
2. Kattints a **"New Ticket"** gombra.
3. Töltsd ki:
   - **Title:** `Teszt jegy — manuális`
   - **Type:** `interaction`
   - **Description:** `Ez egy manuálisan létrehozott teszt jegy.`
   - **Assign to Agent:** Válaszd a `Számlafeldolgozó Ágens`-t
4. Kattints a **"Create"** gombra.
5. A jegy megjelenik `backlog` állapotban.
6. Kattints a jegyre, majd kattints a **"Mark Ready"** gombra.
7. Approver felhasználóval lépj be, keresd meg a jegyet és kattints az **"Approve"** gombra.

**Elvárt eredmény:**
- A jegy `backlog` → `ready` → `approved` állapoton keresztül halad.
- Minden státuszváltás naplózva van.
- Jóváhagyás után a jegy feldolgozásra kerül (az ágens megkapja a feladatot).

---

### TC-BRD-02: Jegy visszautasítása

**Üzleti leírás:**  
Ha az Approver úgy ítéli meg, hogy egy feladat nem megfelelő (pl. hibás adatok, jogtalan kérés), vissza tudja utasítani a jegyet. A visszautasítás indokát rögzíteni kell, hogy az eredeti kérelmező értesüljön a döntés okáról.

**Előfeltétel:** Létezik egy `ready` állapotú jegy. Approver felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Board** menüpontba.
2. Nyisd meg a `ready` állapotú jegyet.
3. Kattints a **"Reject"** gombra.
4. Add meg a visszautasítás okát: `A kért adatok hiányosak, kiegészítés szükséges.`
5. Kattints a **"Confirm Reject"** gombra.

**Elvárt eredmény:**
- A jegy státusza `rejected`-re változik.
- A visszautasítás oka látható a jegy részleteinél.
- Az eredeti kérelmező értesítést kap (ha értesítés van konfigurálva).
- A `rejected` jegyből nem lehet újra `approved` jegy — új jegyet kell létrehozni.

---

## MODUL 7 — Playbook (Folyamatdefiníciók)

### TC-PB-01: Playbook létrehozása és publikálása

**Üzleti leírás:**  
A Playbook egy strukturált, lépésről lépésre definiált folyamat, amelyet az ágensek és emberek együtt hajtanak végre. Például: "Számlafeldolgozási folyamat" — az ágens kinyeri az adatokat, egy ember ellenőrzi, az ágens könyveli. A Playbook publikálása után megváltoztathatatlan (immutable), hogy az archiválhatóság biztosított legyen.

**Előfeltétel:** Admin felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Playbooks** menüpontba.
2. Kattints a **"New Playbook"** gombra.
3. Add meg a nevet: `Számlafeldolgozási Folyamat`
4. Adj hozzá lépéseket:
   - **1. lépés:** Role = `worker`, Action = `Számla adatainak kinyerése`, Timeout = `10 perc`
   - **2. lépés (Gate):** Type = `human_approval`, Role = `approver`, Blocking = `true`
   - **3. lépés:** Role = `worker`, Action = `Számla könyvelése az ERP-be`
5. Kattints a **"Save Draft"** gombra.
6. Kattints a **"Validate"** gombra — ellenőrzi a folyamat helyességét.
7. Kattints a **"Publish"** gombra és erősítsd meg.

**Elvárt eredmény:**
- A Playbook `draft` → `validated` → `published` állapoton halad keresztül.
- A publikált Playbook szerkeszthetetlen (az "Edit" gomb eltűnik vagy le van tiltva).
- A Playbook tartalmaz egy verziószámot (pl. `v1`) és publikálási dátumot.

---

### TC-PB-02: Playbook-folyamat elindítása és nyomon követése

**Üzleti leírás:**  
A Playbook elindításakor egy "folyamatpéldány" (Process Instance) jön létre, amely nyomon követi, hogy hol tart a folyamat, ki a következő felelős, és mikor lett elvégezve minden lépés.

**Előfeltétel:** A `Számlafeldolgozási Folyamat` Playbook `published` állapotban van.

**Lépések:**
1. Navigálj a **Playbooks** menüpontba.
2. Nyisd meg a `Számlafeldolgozási Folyamat` Playbook-ot.
3. Kattints a **"Start Process"** (Folyamat indítása) gombra.
4. Töltsd ki a szükséges induló adatokat (pl. számla száma: `INV-2026-001`).
5. Kattints a **"Confirm Start"** gombra.
6. Navigálj a **Board** menüpontba — látnod kell az első lépéshez tartozó jegyet.
7. Várd meg (vagy szimuláld), hogy az ágens elvégezze az első lépést.
8. Approver felhasználóval hagyd jóvá a 2. lépés (Human Approval Gate) jegyét.
9. Ellenőrizd, hogy a 3. lépés automatikusan elkezdődik.

**Elvárt eredmény:**
- A folyamat `created` → `running` → `awaiting_human` → `running` → `completed` állapoton halad.
- A Process Instance részletes nézetében látható minden lépés státusza és időbélyege.
- A befejezett folyamatnál minden lépés `completed` jelölést kap.

---

## MODUL 8 — Proaktív Monitor (Riasztások)

### TC-MON-01: Backlog-monitor létrehozása

**Üzleti leírás:**  
A Proaktív Monitor automatikusan figyeli a rendszer állapotát és szükség esetén riaszt. Például: ha a Kanban-táblán 10-nél több feldolgozatlan jegy halmozódik fel, automatikusan értesítést küld a felelősöknek. Ez a teszt egy ilyen monitor beállítását és működését ellenőrzi.

**Előfeltétel:** Admin felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **Monitors** menüpontba.
2. Kattints a **"New Monitor"** gombra.
3. Töltsd ki:
   - **Name:** `Jegy-halmozódás Riasztás`
   - **Type:** `board_backlog`
   - **Threshold:** `5` (ha több mint 5 jegy van backlog-ban)
   - **Schedule:** `Every 15 minutes` (15 percenként ellenőriz)
   - **Action:** `Create escalation ticket` (jegy létrehozása riasztásként)
   - **Cooldown:** `2 hours` (2 óráig nem riaszt újra)
4. Kattints a **"Save"** gombra.
5. Kattints a **"Test Run"** (Tesztfuttatás) gombra a monitor manuális kipróbálásához.

**Elvárt eredmény:**
- A monitor mentés után aktív állapotban van.
- A "Test Run" során a rendszer megvizsgálja a backlog tartalmát.
- Ha a feltétel teljesül (5+ jegy): riasztási jegy jön létre a Board-on.
- Ha a feltétel nem teljesül: a monitor jelzi, hogy "No signal detected" (nincs riasztás).

---

### TC-MON-02: Monitor cooldown (ismétlés gátlás) ellenőrzése

**Üzleti leírás:**  
Ha egy riasztási feltétel folyamatosan fennáll, a monitor nem bombázza folyamatosan a csapatot értesítésekkel — a "cooldown" idő lejártáig vár az újabb riasztással. Ez a teszt azt ellenőrzi, hogy ez a mechanizmus működik.

**Előfeltétel:** Az előző tesztesetben (`TC-MON-01`) a monitor riasztást küldött.

**Lépések:**
1. A monitor riasztása után azonnal futtasd le újra a **"Test Run"**-t.
2. Ellenőrizd a monitor futási naplóját (Run History).

**Elvárt eredmény:**
- A második futás nem hoz létre új riasztási jegyet.
- A futási naplóban megjelenik: "Signal suppressed: cooldown active" (vagy hasonló üzenet).
- Csak a cooldown idő (2 óra) lejárta után hozna létre új riasztást.

---

## MODUL 9 — Tréning / Memóriakezelés (Memory Training)

### TC-TRN-01: Ágensz emlékezet frissítési kérelem jóváhagyása

**Üzleti leírás:**  
Az ágensek idővel "tanulhatnak" — frissíthetik a tudásbázisukat. Ez azonban soha nem történhet automatikusan: minden memóriafrissítéshez ember jóváhagyása szükséges. A jóváhagyó pontosan látja, mi változna a régi és az új tudásbázis között. Ez a teszt a tréning-jóváhagyási folyamatot ellenőrzi.

**Előfeltétel:** Létezik egy `active` ágensz, és van legalább egy függőben lévő tréning-kérelem (Training Ticket).

**Lépések:**
1. Navigálj a **Training** menüpontba.
2. Válaszd ki a `Számlafeldolgozó Ágens`-t.
3. Keresd meg a függőben lévő memóriafrissítési kérelmet.
4. Kattints rá, és ellenőrizd a **"Diff"** nézetet (mi változna: régi szöveg piros, új szöveg zöld).
5. Ha a változás megfelelőnek tűnik, kattints az **"Approve"** gombra.
6. Ha a változás nem megfelelő, kattints a **"Reject"** gombra és add meg az indokot.

**Elvárt eredmény:**
- A Diff nézet egyértelműen mutatja az eltéréseket (régi vs. új).
- Jóváhagyás után az ágens memóriája frissül az új verzióra (verziószám nő).
- Visszautasítás után a korábbi memóriaverzió marad érvényes.
- Az ágens **nem tudja jóváhagyni a saját tréning-kérelmét** — a rendszer megakadályozza.

---

### TC-TRN-02: Memóriaverzió visszaállítása (rollback)

**Üzleti leírás:**  
Ha kiderül, hogy egy jóváhagyott memóriafrissítés hibás volt (pl. rosszul fogalmazott szabályt tartalmaz), vissza lehet állítani az előző verzióra. Ez a biztonsági háló megakadályozza, hogy egy rosszul tréningezett ágens tartósan hibásan működjön.

**Előfeltétel:** Az ágensnek legalább 2 memóriaverziója van (v1 és v2).

**Lépések:**
1. Navigálj a **Training** menüpontba.
2. Válaszd ki az ágenszt.
3. Kattints a **"Version History"** fülre.
4. Keresd meg a `v1` verziót.
5. Kattints a **"Rollback to v1"** gombra.
6. Erősítsd meg a visszaállítást.

**Elvárt eredmény:**
- Az ágens aktív memóriaverziója visszaáll `v1`-re.
- A `v2` verzió nem törlődik, hanem `rolled_back` státuszba kerül (megmarad az archívumban).
- A visszaállítás eseménye megjelenik az Audit Log-ban.

---

## MODUL 10 — Audit Napló (Audit Log)

### TC-AUD-01: Esemény keresés és szűrés az Audit Log-ban

**Üzleti leírás:**  
Egy vállalati rendszerben minden fontos eseményt naplózni kell — ki tett mit, mikor. Az Audit Log (ellenőrzési napló) a megfelelőség (compliance) és az incidenskezelés alapja. Ez a teszt ellenőrzi, hogy a korábbi tesztesetek eseményei naplózva vannak és kereshetők.

**Előfeltétel:** Az előző tesztesetek futtatása megtörtént (legalább TC-AR-02 és TC-BRD-01).

**Lépések:**
1. Navigálj az **Audit Log** menüpontba.
2. A szűrő mezőkben állítsd be:
   - **Actor:** `admin@test.local`
   - **Action:** `agent.activated`
   - **Date range:** Mai nap
3. Kattints a **"Search"** gombra.
4. Ellenőrizd, hogy az ágens aktiválásának eseménye megjelenik.
5. Kattints az eseményre a részletes nézet megnyitásához.

**Elvárt eredmény:**
- A keresési eredmény tartalmazza az ágens aktiválásának eseményét.
- Az esemény részletei tartalmazzák: ki hajtotta végre (actor), mikor (timestamp), melyik objektumra vonatkozott (target).
- Az Audit Log szűrhető aktor, eseménytípus, cél és dátum szerint.

---

### TC-AUD-02: Hash-lánc integritás ellenőrzése

**Üzleti leírás:**  
Az Audit Log minden bejegyzése egy kriptográfiai "lánccal" van összekötve az előző bejegyzéssel. Ez biztosítja, hogy senki ne tudjon utólag törölni vagy módosítani bejegyzéseket anélkül, hogy az ne lenne kimutatható. Ez a teszt az integritásellenőrzési funkciót teszteli.

**Előfeltétel:** Admin felhasználóval bejelentkezve. Az Audit Log tartalmaz legalább 10 bejegyzést.

**Lépések:**
1. Navigálj az **Audit Log** menüpontba.
2. Keresd meg az **"Verify Chain Integrity"** (Lánc-integritás ellenőrzése) gombot.
3. Kattints rá.
4. Várd meg az ellenőrzés eredményét.

**Elvárt eredmény:**
- A rendszer ellenőrzi az összes hash-lánc-összefüggést.
- Az eredmény: "Chain integrity verified: OK" (Lánc integritása ellenőrizve: rendben).
- Ha valamilyen manipuláció történt volna: "Chain integrity BROKEN at entry #X" hibaüzenet jelenne meg.

---

## MODUL 11 — Governance Dashboard

### TC-GOV-01: Használati metrikák megtekintése

**Üzleti leírás:**  
A vállalati vezetők és IT-üzemeltetők számára fontos, hogy lássák: mennyi AI-kapacitást (LLM token) használnak fel, mibe kerül az AI-használat, és mennyire hatékonyan dolgoznak az ágensek. A Governance Dashboard ezeket az adatokat aggregálva mutatja.

**Előfeltétel:** Admin felhasználóval bejelentkezve. Legalább néhány chat-üzenetváltás (modellfuttatás) megtörtént.

**Lépések:**
1. Navigálj a **Governance** menüpontba.
2. Állítsd be az időtartomány szűrőt: **"Last 7 days"** (Utolsó 7 nap).
3. Nézd meg az alábbi mutatókat:
   - Token felhasználás (input + output)
   - Becsült költség (USD)
   - Modell-hívások száma
   - Eszköz-hívás megtagadások száma (tool call denials)
4. Kattints a **"Download Report"** (Jelentés letöltése) gombra.

**Elvárt eredmény:**
- A dashboard mutatja a tényleges felhasználási adatokat.
- A letöltött jelentés (Markdown vagy PDF formátum) tartalmazza az összes mutatót.
- Az adatok konzisztensek az Audit Log bejegyzéseivel.

---

## MODUL 12 — Rendszervezérlés (System Controls)

### TC-SYS-01: Adatbázis tesztmód váltás

**Üzleti leírás:**  
A rendszer kétféle módban üzemelhet: éles módban (production), ahol a valódi üzleti adatok vannak, és tesztmódban, ahol a fejlesztők és tesztelők biztonságosan próbálhatnak ki funkciókat anélkül, hogy az éles adatokat veszélyeztetnék. Ez a teszt a módváltás funkcionalitását ellenőrzi.

**Előfeltétel:** Admin felhasználóval bejelentkezve.

**Lépések:**
1. Navigálj a **System** menüpontba.
2. Ellenőrizd az aktuális DB módot (Production vagy Test).
3. Ha **Production** módban van: kattints a **"Switch to Test Mode"** gombra és erősítsd meg.
4. Ellenőrizd, hogy a felület jelzi a tesztmódot (pl. sárga/narancs fejléc sáv).
5. Váltj vissza **Production** módba.

**Elvárt eredmény:**
- A módváltás sikeres és azonnal hatályba lép.
- Tesztmódban: a felület egyértelmű vizuális jelzést ad (pl. "TEST MODE" felirat, eltérő színű fejléc).
- A módváltás eseménye megjelenik az Audit Log-ban.
- Tesztmódban létrehozott adatok nem jelennek meg Production módban.

---

### TC-SYS-02: Dispatcher kikapcsolása

**Üzleti leírás:**  
A Dispatcher az a komponens, amely az ágensek feladatait kiosztja és futtatja. Szükség esetén (pl. karbantartás, incidens) az Admin kikapcsolhatja az egész Dispatcher-t, hogy az ágensek ne indítsanak új feladatokat. Ez a teszt ezt az vészleállítási funkciót ellenőrzi.

**Előfeltétel:** Admin felhasználóval bejelentkezve. A Dispatcher jelenleg aktív.

**Lépések:**
1. Navigálj a **System** menüpontba.
2. Keresd meg a **Dispatcher Controls** szekciót.
3. Kattints a **"Disable Dispatcher"** gombra.
4. Erősítsd meg a letiltást.
5. Próbálj meg egy ágensnek feladatot kiosztani (pl. jegy jóváhagyásával).
6. Ellenőrizd a jegy állapotát — nem szabad, hogy feldolgozásra kerüljön.
7. Kapcsold vissza a Dispatcher-t a **"Enable Dispatcher"** gombbal.

**Elvárt eredmény:**
- A kikapcsolás után a Dispatcher státusza "Disabled" (letiltva).
- Új feladatok nem kerülnek feldolgozásra (a jegy `approved` állapotban marad, nem lép `in_progress`-be).
- Az újraengedélyezés után a várakozó feladatok ismét feldolgozásra kerülnek.

---

## 4. Tesztelési mátrix

Az alábbi táblázat összefoglalja, hogy melyik tesztet melyik felhasználói szerepkörrel kell futtatni:

| Teszteset | Admin | Approver | Operator | Viewer |
|-----------|:-----:|:--------:|:--------:|:------:|
| TC-IAM-01 | ✅ (meghívó) | | | ✅ (bejelentkezés) |
| TC-IAM-02 | ✅ | | | |
| TC-IAM-03 | | | | ✅ |
| TC-BP-01 | ✅ (létrehozás) | ✅ (jóváhagyás) | | |
| TC-BP-02 | ✅ (szerkesztés) | ✅ (jóváhagyás) | | |
| TC-AR-01 | ✅ | | | |
| TC-AR-02 | ✅ | | | |
| TC-AR-03 | ✅ | | | |
| TC-AR-04 | ✅ | | | |
| TC-CON-01 | ✅ | | | |
| TC-CON-02 | ✅ | | | |
| TC-CON-03 | | | ✅ | |
| TC-CS-01 | | | ✅ | |
| TC-CS-02 | | ✅ (jóváhagyás) | ✅ (chat) | |
| TC-CS-03 | | | ✅ | |
| TC-BRD-01 | | ✅ (jóváhagyás) | ✅ (létrehozás) | |
| TC-BRD-02 | | ✅ | | |
| TC-PB-01 | ✅ | | | |
| TC-PB-02 | | ✅ (jóváhagyás) | ✅ (indítás) | |
| TC-MON-01 | ✅ | | | |
| TC-MON-02 | ✅ | | | |
| TC-TRN-01 | | ✅ | | |
| TC-TRN-02 | | ✅ | | |
| TC-AUD-01 | ✅ | | | |
| TC-AUD-02 | ✅ | | | |
| TC-GOV-01 | ✅ | | | |
| TC-SYS-01 | ✅ | | | |
| TC-SYS-02 | ✅ | | | |

---

## 5. Eredmény rögzítése

Minden tesztesethez töltsd ki az alábbi táblázatot:

| Teszteset ID | Futtatás dátuma | Tesztelő neve | Eredmény | Megjegyzés |
|--------------|----------------|---------------|----------|------------|
| TC-IAM-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-IAM-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-IAM-03 | | | ⬜ PASS / ⬜ FAIL | |
| TC-BP-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-BP-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-AR-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-AR-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-AR-03 | | | ⬜ PASS / ⬜ FAIL | |
| TC-AR-04 | | | ⬜ PASS / ⬜ FAIL | |
| TC-CON-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-CON-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-CON-03 | | | ⬜ PASS / ⬜ FAIL | |
| TC-CS-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-CS-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-CS-03 | | | ⬜ PASS / ⬜ FAIL | |
| TC-BRD-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-BRD-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-PB-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-PB-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-MON-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-MON-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-TRN-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-TRN-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-AUD-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-AUD-02 | | | ⬜ PASS / ⬜ FAIL | |
| TC-GOV-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-SYS-01 | | | ⬜ PASS / ⬜ FAIL | |
| TC-SYS-02 | | | ⬜ PASS / ⬜ FAIL | |

---

## 6. Ismert kizárások és megjegyzések

- **Connector OAuth (TC-CON-03):** Teszt-OAuth kiszolgáló szükséges, valódi Google/Microsoft hitelesítés nélkül csak szimulálható.
- **E-mail küldés (TC-CS-02):** Tesztkörnyezetben az e-mail küldés szimulált (sandbox mode), valódi e-mail nem megy ki.
- **Audit hash-lánc (TC-AUD-02):** Ez a funkció csak production-szintű adatbázisnál tesztelható érdemben; SQLite-on futó dev-módban az értéke korlátozott.
- **Modell-hívások:** LLM API kulcs nélkül a chat-válaszok nem működnek; mock módban tesztelhető.
- **TC-AR-04 (Retire):** Ennek futtatása után az ágenst nem lehet visszaállítani — csak akkor futtasd, ha biztosan nem kell többé az a tesztágens.
