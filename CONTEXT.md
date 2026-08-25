# Enterprise AI Agent Platform

A platform domain language for governed AI coworkers, their durable instructions, project continuity, and approval-controlled change.

## Tanítás és tudás

**Betanított működési szabály**:
Az agent tartós, agent-szintű munkavégzési utasítása, amely minden releváns futásban érvényes.
_Avoid_: memóriaelem, projektmemória, tudástári tény

**Projektmemória**:
Egy agent adott projekthez tartozó, jóváhagyott folytonossági tudása: döntések, nyitott feladatok, megállapítások és átadási állapot.
_Avoid_: betanított szabály, tudástár, beszélgetési előzmény

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
_Avoid_: approver szerep, kettős kattintás
