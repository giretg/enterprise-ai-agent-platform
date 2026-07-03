# Feature-spec – Playbook-szerepek összekötése tényleges agentekkel (Role→Agent binding)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.1 (tervezet)
**Dátum:** 2026-07-03
**Forrásdokumentumok:** `AI-Agent-Platform-Feature-Spec-Playbook-DONE.md` (§5 spec, §6.2 szemantikai validáció, §7 compiler/runtime, §8.2 ProcessService, §9.2 Operator UI, §13.2 pinnelés), `AI-Agent-Platform-Feature-Spec-Playbook-Orchestrator-DONE.md` (§2.2 `agent_name` binding), `AI-Agent-Platform-Feature-Spec-AgentRegistry-done.md`, `AI-Agent-Platform-Feature-Spec-IAM-RBAC-done.md`
**Olvasó:** product owner, architect, fejlesztő(k). Feltételezi a Playbook Registry (Fázis 2), a Process runtime, az Agent Registry és az IAM/RBAC alapmodell ismeretét.
**Státusz:** tervezet – önálló feature-spec. A hiányzó láncszemet írja le a jelenlegi kód és a szándékolt működés között.

---

## 0. Mit ad ez a dokumentum

Ez a specifikáció meghatározza, **hogyan kapcsolódjon össze egy absztrakt Playbook-szerep egy tényleges, konkrét agenttel (vagy emberi jóváhagyóval)** a folyamat futása során, és **melyik ponton** történjen ez a kötés.

A jelenlegi állapotban a Playbook a szerepeket absztrakt módon írja le (`agent_role` / `human_role` + elvárt képességek/jogok), de a rendszer sehol nem köti ezeket tényleges szereplőhöz: a folyamat-ticketek `assignee` nélkül jönnek létre, így az „agent elvégzi a lépést” hurok nem záródik be. Ez a dokumentum ezt a hiányt tölti ki.

A javaslat lényege: a **szerep→agent kötés a folyamat-példányosításnál (Folyamatok / „Új folyamat indítása”)** történik, kétszintű feloldással (tenant-szintű alapértelmezés + futásidejű felülírás), megőrizve a Playbook-sablon hordozhatóságát.

---

## 1. Üzleti cél és indoklás

### 1.1 Probléma

- A Playbook **sablon**: leírja, milyen szerep (agent/ember) és milyen képességgel/joggal kell egy lépéshez, de **nem mondja meg, hogy pontosan ki csinálja**.
- Enélkül a folyamat elindul, létrehozza a lépéseket és ticketeket, de az agent-lépések gazdátlanul maradnak – nincs, aki automatikusan elvégezze őket.
- Az operátornak jelenleg nincs eszköze arra, hogy egy adott futáshoz megmondja: „ezt a szerepet a X agent töltse be”.

### 1.2 Cél

Tegyük lehetővé, hogy a folyamat indításakor (a példányosítás pillanatában) **minden agent-szerephez tényleges agent rendelődjön**, úgy, hogy:

- a Playbook-sablon **absztrakt és újrahasználható marad** (nem drótozunk bele konkrét agentet);
- a kötés **auditálható és reprodukálható** (a futás rögzíti, ki dolgozott melyik szerepben);
- ne legyen felesleges operátori teher (legyen értelmes alapértelmezés);
- a **jogosultsági/képességi garanciák** (ki alkalmas egy szerepre) tényleges ellenőrzésre kerüljenek.

### 1.3 Miért a példányosítás a helyes pont

A folyamat-példány már ma is **rögzítési (PIN) pont**: rögzíti, melyik Playbook-verzióval fut végig, és ez a futás végéig nem változik. A „melyik agent tölti be a szerepet” ugyanilyen természetű, futás-specifikus döntés, ezért logikusan ide illeszkedik:

- a sablon hordozhatósága megmarad;
- ugyanaz a Playbook különböző futásokban más agenttel mehet (csapatonként, tenantonként, tesztként);
- a döntés a verzió-PIN mellé kerül, konzisztens reprodukálhatósággal.

---

## 2. Fogalmak

| Fogalom | Jelentés |
|---|---|
| **Playbook-szerep (role)** | Absztrakt szereplő a specben: `key`, `type` (`agent_role` / `human_role`), `requiredCapabilities`, `requiredPermissions`. |
| **Szerep-kötés (role binding)** | Egy `role.key → konkrét szereplő` leképezés. Agent-szerepnél egy agent, emberi szerepnél jellemzően jogosultsági szerep (nem konkrét személy). |
| **Tenant-roster** | Tenant-szintű, perzisztens alapértelmezett szerep-kötés (újrahasználható futások között). |
| **Futásidejű override** | Egy adott folyamat-indításnál megadott, csak arra a futásra érvényes szerep-kötés. |
| **Alkalmas agent** | Olyan aktív agent, amelynek képességei (Capability = engedélyezett tool-ok) lefedik a szerep `requiredCapabilities` listáját, és azonos tenanthoz tartozik. |

---

## 3. Hatókör

### 3.1 Benne van

- Agent-szerepek (`agent_role`) összekötése konkrét agenttel a folyamat-indításnál.
- Kétszintű feloldás: tenant-roster (alapértelmezés) + futásidejű override.
- A kötés rögzítése a folyamat-példányon (audit, reprodukálhatóság).
- A szerep-kötés érvényesítése a lépés-ticketek létrehozásakor (a ticket tényleges `agent`-hez kerül).
- A képességi/jogosultsági alkalmasság ellenőrzése a választható agentekre.

### 3.2 Nincs benne (nem ennek a specifikációnak a tárgya)

- Konkrét emberi felhasználó kötése egy `human_role`-hoz indításkor. Az emberi jóváhagyás továbbra is **jogosultság-alapú** a kapunál (bárki, akinek megvan a `requiredPermissions` joga). Lásd §4.3.
- Az agent tényleges végrehajtó hurokja (dispatcher → agent-runtime → kimenet). Ez külön, kapcsolódó feladat; itt csak az előfeltételét (a ticket tényleges agenthez kötése) teremtjük meg.
- Több agent egy szerepben, terheléselosztás, automatikus dispatch-idejű választás (lásd §7 Alternatívák).
- Playbook grafikus szerkesztő, párhuzamos ágak (a Playbook fő-spec nyitott döntései szerint kizárva).

---

## 4. Funkcionális követelmények

### 4.1 Szerep-kötés a folyamat indításakor

- A „Folyamatok / Új folyamat indítása” felületen a Playbook kiválasztása után a rendszer **kilistázza a Playbook publikált verziójának `agent_role` szerepeit**.
- Minden agent-szerephez **agent-választó** jelenik meg, amely **csak az alkalmas agenteket** kínálja fel (§2 „alkalmas agent”).
- Minden agent-szerep-választó **alapból a tenant-roster értékével** van kitöltve, ha van ilyen; az operátor felülírhatja erre a futásra.
- Az indítás **nem engedélyezett**, amíg minden kötelező agent-szerephez nincs érvényes, alkalmas agent kötve (kivéve, ha a §7 szerinti automatikus feloldás aktív).

### 4.2 Tenant-szintű alapértelmezett kötés (roster)

- Az adminnak legyen lehetősége tenant-szinten `role.key → agent` alapértelmezést beállítani (szerepenként egy agent).
- A roster **több Playbookon átívelő**: ha több Playbook ugyanazt a szerep-kulcsot használja, a roster közös alapértelmezésként szolgálhat (a konkrét szemantikát a bevezetés finomíthatja: globális vagy Playbook-specifikus roster).
- A roster kizárólag alkalmas agentet fogadhat el.

### 4.3 Emberi szerepek kezelése

- `human_role` szerephez indításkor **nem kötelező** konkrét személyt rendelni.
- Az emberi lépés / jóváhagyási kapu továbbra is **jogosultság-alapú**: a lépést/kaput bárki kezelheti, akinek megvan a szerep `requiredPermissions` joga (a kapu-döntés a meglévő runtime-logika szerint role/permission alapján enged).
- Opcionálisan (későbbi bővítés) megengedhető emberi szerep konkrét felhasználóhoz vagy szűkebb csoporthoz kötése – ez nem része ennek az alap-verziónak.

### 4.4 Feloldási sorrend (a lépés-ticket létrehozásakor)

A rendszer a következő prioritással oldja fel a lépés `assignedRole`-ját tényleges agentre:

```
1. futásidejű override (a folyamat-példány szerep-kötése)
2. tenant-roster alapértelmezés
3. (opcionális) automatikus, képesség-alapú választás
4. nincs kötés → a ticket assignee nélkül marad, és a folyamat jelzi a hiányt
```

### 4.5 Alkalmassági (validációs) szabályok

Egy agent akkor köthető egy `agent_role`-hoz, ha:

- **aktív** (nem retired/suspended);
- **azonos tenanthoz** tartozik (tenant-izoláció);
- **képességei lefedik** a szerep `requiredCapabilities` listáját (a hiányzó képesség tiltó hiba).

Emberi szerepnél az érintett jogosultságoknak (`requiredPermissions`) **létezniük kell az IAM/RBAC modellben** (ezt a Playbook-validáció publikáláskor már ellenőrzi; itt a futásidejű oldal is támaszkodik rá).

### 4.6 Reprodukálhatóság és audit

- A folyamat-példány **rögzíti a teljes szerep-kötést** (melyik szerephez melyik agent), a verzió-PIN mellé.
- Az indítási audit-eseménybe bekerül a kötés (mely szerep → mely agent), hogy utólag bizonyítható legyen, ki dolgozott a futásban.
- A kötés a futás alatt **nem változik** (a PIN filozófiával összhangban); esetleges csere külön, auditált művelet lehet (későbbi bővítés).

### 4.7 Hibakezelés

- Ha egy szerephez nincs alkalmas agent a tenantnál, az indító felület **egyértelmű hibaüzenettel** jelezze (és irányítson az Agent Registry / roster beállítás felé).
- Ha az operátor olyan agentet próbál kötni, amely időközben inaktívvá vált, az indítás **elutasításra** kerül alkalmassági hibával.

---

## 5. Felhasználói folyamat (indítás)

1. Az operátor a „Folyamatok” oldalon kiválaszt egy **publikált** Playbookot.
2. A rendszer megjeleníti a Playbook `agent_role` szerepeit, mindegyikhez egy alkalmas-agent választóval, a roster-alapértelmezéssel előkitöltve.
3. Az operátor szükség szerint **felülírja** az egyes szerepekhez rendelt agenteket erre a futásra.
4. Az operátor megadja a **bemeneti payload**-ot (a folyamat kezdő adatait).
5. Indításkor a rendszer:
   - validálja a kötéseket (alkalmasság, tenant, aktív állapot);
   - PIN-eli a Playbook-verziót és a szerep-kötést;
   - létrehozza a belépő lépést és a hozzá tartozó ticketet, immár a **feloldott tényleges agenthez** rendelve.
6. Az operátor a folyamat-nézetben követi az előrehaladást; minden lépés-ticket a szerepéhez rendelt tényleges agenthez tartozik.

---

## 6. Adat- és integrációs vázlat (nem kötelező részletezettségű)

> Ez a szakasz a fejlesztői bekötés irányát adja meg; a végleges séma a megvalósításkor véglegesül.

- **Folyamat-példány kiegészítése**: a példány tároljon egy szerep-kötés leképezést (`role.key → agentId`), a verzió-PIN mellett.
- **Tenant-roster tárolás**: perzisztens `role.key → agentId` alapértelmezés tenantonként.
- **Folyamat-indító szerződés (ProcessService.startProcess)**: fogadjon opcionális szerep-kötést; végezze el az alkalmassági validációt; a kötést mentse a példányra és az auditba.
- **Lépés-ticket létrehozás**: a lépés `assignedRole`-ját a §4.4 sorrend szerint oldja fel konkrét agentre, és a ticketet ehhez az agenthez rendelje (a jelenlegi „assignee nélküli” állapot helyett).
- **Alkalmassági forrás**: az agent-képességek (engedélyezett tool-ok) és a szerep `requiredCapabilities` összevetése – ugyanaz a logika, amit a Playbook-validáció szemantikai rétege (§6.2) előirányoz.
- **Indító UI**: a kiválasztott Playbook publikált specjéből olvassa ki az `agent_role` szerepeket, és szerepenként kínáljon fel alkalmas-agent listát.

---

## 7. Alternatívák és mérlegelés

| Kötési pont | Előny | Hátrány |
|---|---|---|
| **Sablonba drótozva (design-time, `agent_name`)** | Egyszerű, explicit | A sablon nem hordozható; minden agent-változásnál módosítani kell |
| **Tenant-roster (perzisztens alapértelmezés)** | Kevés operátori döntés, újrahasználható | Kevésbé rugalmas futásonként; önmagában nem elég |
| **Példányosításnál (ez a javaslat)** | Rugalmas, auditálható, PIN-konzisztens, sablon-hordozható | Futásonként döntést igényel – ezt a roster-alapértelmezés enyhíti |
| **Dispatch-időben, automatikus képesség-illesztéssel** | Teljes automatizmus, nincs operátori döntés | Kevésbé explicit/kiszámítható; „melyik agentet” kérdést a rendszer dönti el |

**Ajánlás:** a példányosításkori kötés a fő megoldás, **tenant-roster alapértelmezéssel**; a dispatch-idejű automatikus választás opcionális 3. szintként bevezethető (§4.4 3. lépés) a teljes automatizmushoz.

---

## 8. Kapcsolat a meglévő működéssel (miért ez a hiányzó láncszem)

- A Playbook-spec már ma is absztrakt szerepeket definiál (`assignedRole` → `roles[]`), de a szerep→agent feloldás sehol nem történik meg.
- A Playbook-validáció szemantikai rétege **előirányozza** az alkalmasság-ellenőrzést („van legalább egy aktív, alkalmas agent a szerephez”), de ez a rész jelenleg nincs használatban.
- A folyamat-runtime a lépés-ticketeket **agent nélkül** hozza létre, ezért az agent-lépések nem futnak le automatikusan.
- Ez a feature a **példányosításnál** zárja be a kötést, ezzel megteremtve az előfeltételét annak, hogy az agent-lépések tényleges agenthez kerüljenek (és később automatikusan végrehajthatók legyenek).

---

## 9. Definition of Done (javasolt)

- A folyamat-indító felület a kiválasztott Playbook agent-szerepeihez alkalmas-agent választót kínál, roster-alapértelmezéssel.
- Az indítás validálja és PIN-eli a szerep-kötést; alkalmatlan/hiányzó kötésnél egyértelmű hibával elutasít.
- A belépő és a további lépés-ticketek a feloldott tényleges agenthez kötve jönnek létre.
- A szerep-kötés megjelenik az indítási audit-eseményben és a folyamat-nézetben.
- Tenant-roster kezelhető (alapértelmezések beállítása szerepenként).
- Az emberi szerepek jóváhagyása változatlanul jogosultság-alapú marad a kapunál.

---

## 10. Nyitott döntések

| ID | Kérdés | Javasolt döntés |
|---|---|---|
| RB-1 | A tenant-roster globális vagy Playbook-specifikus legyen? | Indulásnak globális (szerep-kulcs szerinti); Playbook-specifikus felülírás később. |
| RB-2 | Kell-e indításkor emberi szerephez konkrét felhasználót kötni? | Nem az alap-verzióban; marad jogosultság-alapú a kapunál. |
| RB-3 | Megengedjük-e egy szerephez több agentet (terheléselosztás)? | Nem az alap-verzióban; egy szerep = egy agent futásonként. |
| RB-4 | Bevezessük-e a dispatch-idejű automatikus választást? | Opcionális 3. szint; a kézi override mindig elsőbbséget élvez. |
| RB-5 | Cserélhető-e a kötés futás közben? | Alapból nem (PIN); ha kell, külön auditált művelet legyen. |
