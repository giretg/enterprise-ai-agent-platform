# AI Agent Platform — Feature Spec: Hozzáférés-policy és Governed Action-ok (jóváhagyás-kapuzott képesség-hívás)

> Státusz: **draft** (grill-elt design, kód még nincs). Dátum: 2026-07-13.
> Kiváltó use-case: a KeyOps/ZPK payShield HSM-agent (lásd [ZPK-KeyOps-Gap-Analysis](AI-Agent-Platform-Feature-Spec-ZPK-KeyOps-Gap-Analysis.md)), de ez a spec **kulcskezelés-független, általános platform-képesség**. A KeyOps ennek csak egy konfigurációja.

## Problem Statement

A platform ma nem tud biztonságosan olyan folyamatot futtatni, amelyben egy **agent kezdeményez** egy nagy kockázatú külső műveletet, de a végrehajtást egy **ember hagyja jóvá**, és a jóváhagyás után a művelet **determinisztikusan, pontosan a jóváhagyott formában** fut le. Két hiány áll ennek útjában:

1. **Nincs finomhangolt, erőforrás-szintű hozzáférés-policy.** A tenant-role-ok (`admin/approver/operator/viewer`) durvák: nem lehet beállítani, hogy egy user csak bizonyos agenteket lásson, csak a saját ticketjeit lássa, vagy csak jóváhagyni tudjon. A szerepek közti feladatmegosztás (kérelmező ≠ jóváhagyó) nem kikényszeríthető.
2. **Nincs jóváhagyás-kapuzott, determinisztikus képesség-hívás.** A Governed Flow Builderben van `await_human` kapu, de nincs olyan lépés, amely (a) egy **reference-only** tervet köt egy gated képességhez, (b) a jóváhagyás pillanatában **feladat-szétválasztást (SoD) + friss step-up-ot** kényszerít, és (c) jóváhagyáskor **LLM nélkül**, a befagyasztott tervhez kötve elindítja a külső hívást.

A cél a KeyOps use-case-ből jött (PM kér ZPK-t → KMO jóváhagy → a payShield HSM-modul végrehajt), de a hiány generikus: bármely magas-kockázatú külső művelet (fizetés, jogosultság-változás, kulcsművelet, visszafordíthatatlan API-hívás) ugyanezt a mintát igényli.

## Solution

Öt, egymásra épülő **generikus platform-képességet** vezetünk be. A domain-specifikus munka (Key Registry, bináris HSM-tool, command-template-ek) **külön modulban** marad, amelyet a platform generikus connectoron / MCP-n ér el — így a platform kód kulcskezelés-független.

### A hiányzó platform-képességek

1. **Resource-scope authorization policy** — szerepenként (UI-ból) állítható, user-szinten felülírható policy, három dimenzióval:
   - `agent-scope`: mely agenteket lát / melyikkel **indíthat** folyamatot (`all` \| allow-lista `{view, initiate}`);
   - `ticket-scope`: mely ticketeket lát (`own` = requester==user \| `all` \| `by-status`, pl. csak `READY_FOR_APPROVAL`);
   - `action-set`: mit tehet (`initiate, answer_clarification, approve, reject, request_clarification, execute, view_audit`).
   - **Hibrid default:** a nem-korlátozott szerep `all` (kompatibilitás), a `restricted`-re állított szerep allow-lista + **fail-closed**.
   - Kikényszerítés **server-side** (nem UI-elrejtés): agent-lista/indítás az API-n, ticket-lekérdezés a repository query-szinten, approval-akció a governance-guardon, `execute` a tool-broker capability-gate-en.

2. **Governed action step** a Governed Flow Builderben — jóváhagyás-kapuzott, reference-only képesség-hívás (a részletes szemantika lentebb).

3. **Step-up / reverification** (Clerk) — magas `riskTier` esetén friss újra-hitelesítés a jóváhagyás pillanatában, az approval-rekordhoz + plan-hash-hez kötve (`mfa_step_up_event_id`).

4. **On-behalf-of identitás-átadás** — a platform átadja az acting-user identitását a külső képességnek (modul), hogy a modul user-szintű jogot (pl. `execute_hsm_tool`) tudjon kényszeríteni. Mechanizmus nagyrészt megvan (delegált-OAuth / Bearer-injekció a `http_api` connectoron), **bekötés** kell.

5. **Érzékeny-válasz adat-minimalizálás a connector-határon** — a külső képesség/modul csak **nem-érzékeny referenciát** ad vissza (státusz, `registry_key_id`, `operation_id`); az érzékeny adat (pl. kulcs-cryptogram) a modulban marad, és a modul bocsátja ki az azt hordozó értesítéseket. A platform sensitivity-routere csak **backstop**, nem az elsődleges kontroll.

### A Governed Action Step szemantikája

Egy tool-lépés a kanavászon, amely:

- egy **reference-only** tervet céloz egy gated képességre (a bemenet egy referencia — pl. `ticket_id` —, nem a nyers művelet-paraméterek);
- **emberi approval-kapuval** rendelkezik, amelynek jogosultsági horgonya **capability + risk-osztály + SoD** (nem a hozzárendelés);
- jóváhagyáskor **determinisztikusan** (LLM nélkül), **aszinkron** meghívja a célzott képességet a **befagyasztott terv-referenciával**;
- az eredményt rögzíti, és átadja egy **closure-lépésnek** (nem-érzékeny, agenttel megfogalmazható narratíva + értesítés-trigger).

A kapu **automatikusan megjelenik** a lépésen, ha a célzott képesség gated (a `riskTier`-ből levezetve), a kanavászon **látható**, és a jóváhagyó szerep **felülírható**.

## Rögzített invariánsok

1. **SoD:** `approver ≠ createdById` — a kérelmező sosem hagyhatja jóvá a sajátját.
2. **Jog-horgony:** az approval-jog **capability + risk-osztály + SoD**; a `assigneeId` **csak routing/inbox**, nem jogforrás.
3. **Osztály-levezetés:** a ticket kockázati/művelet-osztálya **determinisztikusan** a terv célzott gated-capability `riskTier`-jéből jön (a Folyamat előre is deklarálhatja korai routinghoz); az intake puha, **nem** jogforrás. Alul-osztályozás lehetetlen, mert az osztály a platform által számolt függvény, nem LLM-állítás; egy nem-gated tervet célzó út inert (nem tudja a nagy-kockázatú műveletet elvégezni).
4. **Trigger:** determinisztikus platform-hook jóváhagyáskor (**LLM nincs a triggerben**), aszinkron (`EXECUTION_STARTED` → dispatcher → eredmény → closure); az agent csak utólag, a nem-érzékeny closure/notify-ra.
5. **Kapu megjelenése:** automatikus a `riskTier`-ből + **látható + felülírható** a kanavászon (convention over configuration, de nem rejtett).
6. **Step-up:** magas tier → friss újra-hitelesítés kötelező a jóváhagyáskor, a tierből levezetve, az approval-rekordhoz + plan-hash-hez kötve.
7. **Approval-inbox:** osztály-szintű jóváhagyási sor (az osztály `approve`-jogú userei látják a `READY_FOR_APPROVAL` ticketeket), nem egyénhez rendelt.

### A végrehajtási képesség szerződése (a modul oldalán kikényszerítve)

A platform reference-only hív; a **modul a végső hatóság** és fail-closed újra-ellenőriz:

- ticket létezik + `APPROVED`; approval érvényes, ehhez a tickethez tartozik, van friss step-up esemény;
- **plan-hash** újraszámítás a befagyasztott tervből → egyeznie kell az approval-lal (integritás);
- előfeltételek **még mindig állnak** (frissesség);
- acting-user user-szintű joga (on-behalf-of);
- **idempotencia** (a művelet nem automatikusan idempotens): a modul execution-rekordot vezet; `IN_PROGRESS`/`SUCCEEDED`/`UNCERTAIN`/`FAILED_TERMINAL` esetén **nem futtat újra**; bizonytalan (timeout) eredmény → `UNCERTAIN`, **nincs auto-retry**, emberi egyeztetés;
- a modul **atomikusan** írja a saját nyilvántartását, és ő bocsátja ki az érzékeny értesítést.

## User Stories

1. Platform-adminként szerepenként be akarom állítani, hogy egy user mely agenteket lássa és melyikkel indíthasson folyamatot, hogy a kérelmező csak a beviteli agentet érje el.
2. Platform-adminként be akarom állítani, hogy egy szerep csak a **saját** ticketjeit lássa, hogy a kérelmezők ne lássák egymás kéréseit.
3. Jóváhagyóként csak a **jóváhagyásra váró** (`READY_FOR_APPROVAL`) ticketeket akarom látni egy osztály-szintű sorban, hogy ne kelljen keresgélnem.
4. Biztonsági felelősként azt akarom, hogy a kérelmező **soha** ne hagyhassa jóvá a saját kérését, hogy a négy-szem elv kikényszerüljön.
5. Folyamat-szerzőként azt akarom, hogy egy gated képességet célzó lépés **magától** jóváhagyás-kapuzottá váljon és a kanavászon látszódjon, hogy ne felejthessem el a kaput.
6. Folyamat-szerzőként a jóváhagyó szerepet **felül akarom tudni írni** egy adott folyamatra, hogy a levezetett alapot finomíthassam.
7. Jóváhagyóként a döntés pillanatában **friss újra-hitelesítést** akarok, hogy egy nyitva felejtett session ne hagyhasson jóvá helyettem.
8. Platform-üzemeltetőként azt akarom, hogy a jóváhagyás **pontosan a bemutatott tervet** engedélyezze, és ha a terv változik, az engedély érvénytelen legyen.
9. Platform-üzemeltetőként azt akarom, hogy a jóváhagyás után a végrehajtás **LLM nélkül, determinisztikusan** induljon, hogy ne legyen elmaradó/kései/dupla hívás.
10. Agent-fejlesztőként azt akarom, hogy az agent az érzékeny adatot **ne is kapja meg** — a modul csak nem-érzékeny referenciát adjon vissza —, hogy a kulcsanyag ne utazzon a platformon át.
11. Compliance-felelősként a teljes láncot (kérés → osztály → jóváhagyó + step-up → végrehajtás → eredmény → lezárás) auditálni akarom, hogy rekonstruálható legyen.
12. Platform-adminként azt akarom, hogy a policy **kevés helyen** konfigurálódjon (szerep-policy egyszer, capability-gating egyszer), a többi **levezetett** legyen, hogy ne legyen bonyolult üzemeltetni.
13. Platform-üzemeltetőként azt akarom, hogy egy **bizonytalan** (timeout) végrehajtás ne induljon újra automatikusan, hanem emberi egyeztetésre várjon, hogy ne jöjjön létre dupla művelet.
14. Folyamat-futtatóként azt akarom, hogy ugyanez a garancia az **ad-hoc** (chatben feladott) ticketre is érvényes legyen, ne csak a strukturált Folyamatra.

## Implementation Decisions

A grillezés során rögzített döntések (a `## Rögzített invariánsok` normatív; itt az indoklás):

- **D1 — SoD kikényszerítés.** `approver ≠ createdById` kemény invariáns; az approval külön képesség, nem jár a tulajdonlással. *Indok:* a KeyOps teljes modellje a kérelmező≠jóváhagyó elven áll.
- **D2 — Jog-horgony = capability + osztály + SoD.** A hozzárendelés csak routing. *Indok:* a hozzárendelés integritása nem megbízható az ad-hoc úton (self-assign/haver-routing); a valódi kényszer a végrehajtási capability-chokepoint (tool-broker gate + modul re-verify).
- **D3 — Osztály determinisztikus levezetése a `riskTier`-ből (+ opcionális Folyamat-előredeklaráció).** *Indok:* az intake puha marad; az alul-osztályozás lehetetlen, mert az osztály a célzott képességből számolt.
- **D4 — Determinisztikus trigger jóváhagyáskor, LLM nélkül; agent csak utólag closure/notify.** *Indok:* a modul úgyis re-verifikál + idempotens, az agent a triggerben csak fölösleges nem-determinizmust adna. Az agent eredeti motivációja (nyilvántartás-kitöltés) elesett, mert a **modul** írja a nyilvántartást.
- **D5 — Kapu automatikus + látható + felülírható.** *Indok:* a teljesen automatikus „mágia" nem áttekinthető, a kézi huzalozás felejthető; a látható-levezetett kapu biztonságos **és** felhasználóbarát.
- **D6 — Friss step-up a jóváhagyáskor, tierből levezetve, Clerk reverification-ből.** *Indok:* ez zárja be az approval-integritást (session-eltérítés az egyetlen maradó rés); generikus, nem KeyOps-kód.
- **D7 — Osztály-szintű jóváhagyási sor.** *Indok:* következik a D2-ből; az ad-hoc utat is tisztán fedi.

## KeyOps referencia-konfiguráció

A generikus képességek KeyOps-leképezése (a domain a modulban):

| KeyOps szerep | `agent-scope` | `ticket-scope` | `action-set` |
|---|---|---|---|
| **PM** | csak az intake/Sec-Officer agent: `initiate` | `own` | `initiate`, `answer_clarification` |
| **KMO / Approver** | tágabb / `all` | `all` + approval-sor (`READY_FOR_APPROVAL`) | `approve`, `reject`, `request_clarification`, `execute`, `view_audit` |

- A **HSM Manager** és a **Department Head** privilegizált governance-e (120p aktivációs ablak, KMO-kinevezés) a **modulban** marad, nem ebben a platform-authz-ban.
- A végrehajtási képesség = a modul reference-only connectora/MCP-je (`keyops_execute_ticket(ticket_id)`); a modul re-verifikál + idempotens + írja a Key Registryt + kibocsátja a kulcs-cryptogramot hordozó értesítést.

## Vállalt eltérés a KeyOps-spectől

A Clerk-választással a KeyOps-**a-platformon** *nem* a payShield-spec §11 szerinti on-prem, self-contained, corporate-IdP-független appliance. Ez tudatos kompromisszum (általános platform Clerk identitással + MFA-val + reverification-nel). Ha a szigorú on-prem appliance külön követelmény, azt külön kell kezelni (az identitás a modulba csúszik).

## Out of Scope (a modulban, nem platform-munka)

Key Registry domain, payShield bináris TCP/IP HSM-tool, HSM command-katalógus/template-ek, HSM Manager / Department Head privilegizált governance, LAK/TOTP-seed HSM-védelem, a kulcsanyagot hordozó érzékeny értesítések kibocsátása.

## Build-időben ellenőrizendő tények (nem döntések)

- a gate-réteg olvassa-e már a `riskTier`-t az `await_human` kiváltásához (ha igen, ez annak kiterjesztése, nem új mechanizmus);
- a Folyamat-runtime tud-e LLM nélküli tool-lépést futtatni (a `board_write`/tool-lépés mintája alapján valószínű);
- a Clerk reverification API elérhető-e és a step-up-esemény id beköthető-e az approval-rekordba;
- a ticket `createdById`/requester mező az `own`-scope-hoz — **megvan** (a séma tartalmazza `createdById` + `assigneeType`/`assigneeId`).

## Javasolt fejlesztési sorrend

1. Resource-scope authorization policy (adatmodell + server-side kikényszerítés a négy chokepointon + minimál UI).
2. Governed action step a Governed Flow Builderben (reference-only kötés + automatikus-látható-felülírható kapu + determinisztikus on-approve trigger).
3. Step-up integráció (Clerk reverification → approval-rekord kötés).
4. On-behalf-of identitás-átadás bekötése a végrehajtási connectorra + érzékeny-válasz minimalizálás ellenőrzése.
5. KeyOps referencia-konfiguráció rákötése (a modul mint külön app).
