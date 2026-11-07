# PR-kockázat

Minden PR pontosan egy színt kap. A szín a legrosszabb következményt méri, ha a változás hibás, és azt, hogy ez teljesen helyreállítható-e. A méret nem számít.

Besorolás: a piros listával kezdd, az első találat dönt. Kétség esetén a magasabb színt válaszd. A feature flag nem csökkenti a színt: a szín a bekapcsolt állapotot méri.

Helyreállítható: a kód visszaállítása vagy egy kapcsoló után minden a korábbi állapotba kerül, adatjavítás és ügyfél-értesítés nélkül. A migráció a build elején lefut, ezért a kód visszaállítása a sémát nem állítja vissza.

## Piros: legalább egy igaz

1. Hozzáférés: belépés, szerepkör, tenant-elválasztás, agent-jogosultság, jóváhagyási kapu, titkok és titkosítás.
2. Audit: mi kerül naplóba, a napló lánca, megőrzése.
3. Adat: személyes vagy céges adat új helyre kerül, vagy új helyen tárolódik (AI-szolgáltató, külső rendszer, napló).
4. Önállóság: az agent új külső műveletet végezhet, vagy új esemény indíthatja emberi jóváhagyás nélkül.
5. Visszafordíthatatlan: mező vagy tábla törlése, átnevezése, tömeges adatmódosítás, a régi kódot törő séma.
6. Közös útvonal: agent-futás, MCP, Model Gateway, platform-chat, deploy és migrációs folyamat, ha a hiba minden tenantot egyszerre érint.
7. Költség: az AI-költség felső korlát nélkül nőhet.
8. Külső szerződés: meglévő MCP-eszköz vagy telepített kliens működése törik.

## Sárga: nem piros, és legalább egy igaz

- Meglévő funkció viselkedése változik, vagy új funkció érhető el.
- Agent-utasítás, eszközleírás vagy modell-beállítás változik.
- Hozzáadó migráció, amellyel a régi kód is hibátlanul fut.
- Függőség, környezeti változó vagy CI-beállítás változik.

## Zöld: az összes igaz

- A futó alkalmazás logikája és adatai változatlanok.
- A változás dokumentáció, teszt, belső eszköz vagy tisztán megjelenés.
- Nincs benne migráció, konfiguráció vagy függőség.

## A PR leírásában

A kiváltó ok a lista pontja, amely a színt eldöntötte.

```markdown
**Kockázat:** piros – 3. Adat: a hang-átirat az AI-naplóba kerül
```

Piros PR-nál írd mellé a feature flag nevét, vagy azt, miért nincs flag.
