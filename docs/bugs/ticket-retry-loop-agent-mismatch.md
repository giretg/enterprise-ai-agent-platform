# Bug: Folyamat-ticket végtelen Ready↔Feldolgozás pörgés harness hiba esetén

## Tünet

Egy chatből indított Folyamat belépő ticketje végtelenül ismétli:

```
Ready → Feldolgozás ("dispatcher start")
Feldolgozás → Ready ("harness failed: Agent mismatch for harness process")
```

percenként újra, soha nem jut előrébb, nincs hibaállapot, nincs értesítés.

## Megfigyelt konkrét eset

- Az agent (roleBindings alapján feloldott agentId) kapta a ticketet.
- A dispatcher elindította a harnesst, ami **más agent API-kulcsával** jelentkezett be, mint amire a ticket ki volt osztva.
- A callback végpont ezt 403-mal elutasítja, a dispatcher pedig ezt egyszerű tranziens hibaként kezeli.

## Root cause #1 — Agent mismatch a harness indításnál (a validáció jó, egy adat-/konfigurációs eltérés a hiba)

`app/src/app/api/v1/harness/tickets/[id]/process/route.ts:32-35`

```ts
const agentId = body.agentId?.trim() || auth.agentId
if (agentId !== auth.agentId) {
  return jsonError('Agent mismatch for harness process', 403)
}
```

Ez a check helyesen működik: megakadályozza, hogy egy adott agentnek szánt harness egy másik agent nevében járjon el. A tényleges hiba a mögötte lévő adatban van:

- **`auth.agentId`**: a harness Bearer-tokenjéből (`HARNESS_AGENT_API_KEY`) feloldott agent-azonosító. Ez a kulcs **rendszerszinten, minden tickethez megosztva van beállítva** ([harness-run-env.ts:60,82](app/src/domain/dispatcher/harness-run-env.ts)) — nem ticket-specifikus.
- **`body.agentId`**: a ticket saját, roleBindings-ből feloldott agentje, amit a dispatcher `AGENT_ID` env-ként ad át a harnessnek ([dispatcher-service.ts:337](app/src/domain/dispatcher/dispatcher-service.ts:337)).

Ha a `HARNESS_AGENT_API_KEY` az adatbázisban **más agenthez van regisztrálva**, mint amit a ticket roleBindings-e feloldott, a két érték sosem fog egyezni — ez minden retry-nál elbukik, tehát garantáltan ez okozza a végtelen pörgést.

Kivizsgálandó:
1. Melyik agenthez van ténylegesen regisztrálva a `HARNESS_AGENT_API_KEY` az adatbázisban (`agent-api-key.ts` — kulcs → agent leképezés).
2. Melyik agentet old fel a Folyamat roleBindings-e az adott lépéshez (`agent-chat-runtime.ts` ~569, `processService.resolveAgentForRole`).
3. A kettő miért tér el — rossz kulcs-regisztráció, vagy rossz roleBindings-konfiguráció a Playbookban.

## Root cause #2 — Nincs retry-limit / hibaállapot a state machine-ben

`app/src/domain/dispatcher/dispatcher-service.ts:210-220`

```ts
if (input.status === 'failed' && unlocked.state === 'in_progress') {
  final = await this.tickets.update(input.ticketId, { state: 'ready' })
  await this.tickets.recordTransition({
    note: input.error ? `harness failed: ${input.error}` : 'harness failed',
  })
}
```

Minden harness-hiba — függetlenül a jellegétől — visszateszi a ticketet `ready`-be, amit a dispatcher a következő ciklusban azonnal újra felvesz. Nincs:
- retry-számláló / max-retry küszöb,
- külön terminal `failed`/`error` állapot,
- dead-letter vagy emberi beavatkozást kérő ág,
- megkülönböztetés tranziens hiba (pl. átmeneti hálózati hiba — érdemes újrapróbálni) és permanens/konfigurációs hiba (pl. agent mismatch — sosem oldódik meg magától retry-ra) között.

## Javasolt javítás (kivizsgálandó, nem eldöntött)

1. **Retry-limit bevezetése** a `TicketStateMachine`/dispatcher szintjén: számláló a tranzíciós history-ban vagy külön mezőben, N sikertelen próba után átmenet egy explicit hibaállapotba (pl. `failed` vagy `blocked`), ne `ready`-be.
2. **Hibaosztályozás**: a harness failure reason alapján (pl. 4xx auth/config hiba vs. 5xx/timeout) eldönteni, hogy retry-elhető-e egyáltalán, vagy azonnal hibaállapotba kell vinni.
3. **Root cause a mismatch-re**: megtalálni, hol/miért kerül rossz agent-identitás a harness indításba a ticket agentjéhez képest, és hogy ez race condition, stale roleBindings, vagy konfigurációs hiba.
4. **Láthatóság**: a végtelen pörgés jelenleg csendben történik — legalább logolás/riasztás kellene N retry után, mielőtt a felhasználó észreveszi az Állapot-előzményekben.

## Érintett fájlok

- `app/src/app/api/v1/harness/tickets/[id]/process/route.ts:32-35`
- `app/src/domain/dispatcher/dispatcher-service.ts:210-220`, `:318`
- `app/src/domain/agent/agent-chat-runtime.ts:599-670` (ticket létrehozás, roleBindings feloldás)
