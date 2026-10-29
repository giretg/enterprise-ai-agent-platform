# Enterprise AI Agent Platform

A platform domain language for governed AI coworkers, their durable instructions, project continuity, and approval-controlled change.

## Tanítás és tudás

**Betanított működési szabály**:
Az agent tartós, agent-szintű munkavégzési utasítása, amely minden releváns futásban érvényes.
_Avoid_: memóriaelem, projektmemória, tudástári tény

**Projekt**:
A tenanton belüli tároló egy ügy vagy munka folytonosságára. Összefogja a közös munkafájlokat és az agent projektmemóriáját.
_Avoid_: checkout-mappa, beszélgetés, tudástár

**Munkafájl**:
A munka terméke egy projekten: terv, jegyzet, tábla, piszkozat. Az agent szabadon írja; a promptba nem kerül be magától.
_Avoid_: tudástári dokumentum, projektmemória, checkout-fájl

**Projektmemória**:
Egy agent adott projekthez tartozó, jóváhagyott folytonossági tudása: döntések, nyitott feladatok, megállapítások és átadási állapot.
_Avoid_: betanított szabály, tudástár, beszélgetési előzmény, munkafájl

**Beszélgetőpartner**:
A tenant-felhasználó, akinek a hívásán az emlék vagy a naplóbejegyzés keletkezett. A szerver pecsételi; a modell nem nevezi meg.
_Avoid_: szerző, actor név a modelltől

**Memóriaírási mód**:
Agent-beállítás a projektmemória írására: jóváhagyás (alap) vagy közvetlen. A betanított működési szabályt nem nyitja ki.
_Avoid_: durable_memory_approval_policy, operator_can_activate

**Tudástár**:
Forrásdokumentumokból származó, kereshető és lehetőleg hivatkozható szervezeti vagy szakterületi tudás.
_Avoid_: memória, betanított szabály

**Beszélgetési munkakontextus**:
Az aktuális beszélgetés vagy futás ideiglenes előzménye, amely önmagában nem tartós tudás.
_Avoid_: tartós memória, projektmemória

## Tanítási folyamat

**Tanítási ticket**:
Egy készülő következő betanított-szabály verzió jóváhagyási és auditfolyamata. Egy ticketen belül több javaslat-revízió lehet, de egyszerre csak a legutolsó jóváhagyható.
_Avoid_: memória-verzió, önálló szabályelem

**Javasolt szabályverzió**:
Az aktív betanított működési szabályok teljes, még nem aktív utódállapota.
_Avoid_: diff, új memóriaelem

**Javaslat-revízió**:
Ugyanazon készülő szabályverzió immutábilis változata; egy új revízió felváltja a korábbi jóváhagyhatóságát, de nem törli annak auditnyomát.
_Avoid_: új memória-verzió, új ticket

**Tartós memória-jóváhagyási szabály**:
Az agent-szintű szabály, amely meghatározza, ki aktiválhat user által kezdeményezett betanított-szabály vagy projektmemória-változást, és szükséges-e független jóváhagyó.
_Avoid_: tanítási jogosultság, közös memória

**Négy szem elv**:
Olyan agent-szintű jóváhagyási követelmény, amelynél a legutolsó javaslat-revízió kezdeményezője nem lehet annak aktiválója.
A v1.1.1-től a termékfelületen **szünetel** (MemoryTraining spec §4.5.1): a mező a sémában megmarad, a default és a UI `false`, mert a jelenlegi tanítási folyamat mellett zsákutcába zárná a ticketet.
_Avoid_: approver szerep, kettős kattintás

## Skillek

**Skill-fajta**:
A skill katalógusbeli besorolása: tenant (csak a saját tenantban), kiadott (platform-kurált csomag, tenant-agentekhez rendelhető) vagy rendszer (platform belső, csak a megadott rendszer-agenthez köthető).
_Avoid_: láthatósági szint, audience, superadmin-skill

**Rendszer-skill**:
Platform belső skill, amely csak a hozzá tartozó rendszer-agenten jelenik meg és oda rendelhető. A tenant admin a matching agenten látja, más agentre nem teheti.
_Avoid_: global skill, platform skill

**Kiadott skill**:
Platform-admin által kiadott, tenantoknak olvasható, de nem szerkeszthető skill, amelyet a tenant admin a saját (nem rendszer-) agentjeihez rendelhet.
_Avoid_: global pack, published catalog item

## Hermes kliens

**Hermes Bot csatlakozó**:
A munkatárs gépén lévő vékony Hermes-profil (név, MCP URL, `X-Excellence-Agent-Id`). Szerep, skill, memória és céges tények élőben a platform `get_definition` válaszából jönnek — a lemezre nem másolódnak.
_Avoid_: checkout-mappa, helyi skill-másolat, szinkronizált SOUL-briefing

## Konnektor-szintek

**Platform-szintű konnektor-beállítás**:
Amit a platform üzemeltetője (superadmin) egyszer állít be, hogy egy konnektorfajta egyáltalán létrehozható legyen: pl. a közös Google OAuth alkalmazás vagy a Google Ads developer token. Nem cégadat; a tenant nem látja és nem pótolhatja.
_Avoid_: tenant OAuth app, cég-szintű developer token

**Fiókkötés**:
A tenant admin döntése arról, hogy egy konnektor a cég MELYIK külső fiókját érheti el (Google Ads fiók, GA4 property, Search Console property). Futásidejű határ: az agent csak a kötött fiók(ok)ra hívhat. Módosítása nem vonja vissza a felhasználók belépését.
_Avoid_: platform-fiók, alapértelmezett fiók, account scope

**Felhasználói belépés (grant)**:
Egy tenant-felhasználó saját hitelesítése egy delegált konnektorhoz (pl. a saját Google-fiókjával). Ezzel a felhasználó jogosultsága érvényesül: csak akkor ér el adatot, ha a saját fiókjának is van hozzáférése a kötött cégfiókhoz.
_Avoid_: tenant-token, közös fiók

## AI-adattárház

**Adattárház**:
A cég saját, elkülönített adatterülete (v1: külön PostgreSQL-séma), ahová Excel-táblák töltődnek, és ahonnan az AI munkatársak strukturált lekérdezéssel olvasnak.
_Avoid_: adatbázis-hozzáférés, SQL-konzol

**Importterv**:
Deklaratív javaslat (`warehouse.import_plan/v1`): melyik munkalap, melyik oszlop melyik mezőbe, milyen típussal és üzleti jelentéssel. Az AI javasolja, a platform ellenőrzi és hajtja végre.
_Avoid_: import-szkript, generált kód

**Importrecept**:
Egy már közzétett importterv a fájl szerkezeti ujjlenyomatához kötve; az ugyanilyen szerkezetű következő fájl AI nélkül töltődik be vele.

**Kivétel (adattárház)**:
Emberi döntésre váró tétel: bizonytalan / nem talált kapcsolat, hibás érték, ismétlődő azonosító. Bizonytalan egyezésből soha nem lesz magától kapcsolat.
