# Alapvonal: mit hordoz ma a delegációs lánc

> Wayfinder: [Alapvonal: mit hordoz ma a delegációs lánc](https://github.com/giretg/enterprise-ai-agent-platform/issues/54) · szülő: [Agent-hozzáférési gráf](https://github.com/giretg/enterprise-ai-agent-platform/issues/52)
>
> Dátum: 2026-07-19. Forrás: kódbázis (primary), nem spekuláció. A javítás nem ennek a dokumentumnak a dolga.

## 1. Identitás a láncon

### Mit ír az `agent_ask` a ticketre?

[`tool-broker-delegation.ts` `agentAsk`](../../app/src/domain/tool-broker/tool-broker-delegation.ts) (kb. 981–1033):

| Mező | Érték |
| --- | --- |
| `Ticket.createdById` | `systemUserId()` — **nem** a kezdeményező ember |
| `Ticket.tenantId` | csak a **szülő-ticket** `tenantId`-je (`parentTenantId`); ha nincs `input.ticketId`, **`null`**, még ha van `actingTenantId` / conversation is |
| `Ticket.conversationId` (oszlop) | **nincs kitöltve** — a `conversationId` csak a `payload`-ba kerül |
| `payload.delegation` | `true` |
| `payload.requesterAgentId` | a hívó agent (`input.agentId`) |
| `payload.question` / `source` | a kérdés; `source: 'agent_ask'` |
| `payload.parentTicketId` | opcionális, ha volt `input.ticketId` |
| `payload.conversationId` | opcionális, ha volt chat-kontextus |
| `payload` human user id | **nincs** — sem `actingUserId`, sem `runAsUserId` (az utóbbit a `ticket_create` ág másolja szülőből; az `agentAsk` nem) |

### Hol él mégis a humán?

A Broker `invoke` feloldja az acting usert ([`resolveActingUserId`](../../app/src/domain/tool-broker/tool-broker-service.ts) 368–416):

1. run-as a hívó agent saját ticket-payloadjából, vagy
2. `Conversation.createdById`, ha `conversationId` a hívó agent beszélgetése, vagy
3. explicit `input.actingUserId` (nem `external_agent_api` forrásból).

Ez az id:

- bekerül a **`tool.call` / `ToolCall` audit metaadatába** (`acting_user_id` — [`tool-broker-audit.ts`](../../app/src/domain/tool-broker/tool-broker-audit.ts) 64–78), ha a hívás eljut a `recordCall`-ig;
- átadódik a szinkron `delegationProcessor({ …, actingUserId })` hívásnak ([`agentAsk` 1049–1054](../../app/src/domain/tool-broker/tool-broker-delegation.ts));
- **a bekötött processor viszont eldobja**: [`domain/index.ts` 660–662](../../app/src/domain/index.ts) csak `{ ticketId, targetAgentId }`-t használ, és `wikiRuntime.processTicket`-et hív — acting user nélkül.

A célagent futása tehát a ticketből indul: `createdById = system`, payloadban agent-lánc + opcionális `conversationId` / `parentTicketId`.

### Meddig követhető vissza az ember?

| Útvonal | Működik? |
| --- | --- |
| `Ticket.createdById` a delegálás-ticketen | **Nem** — system user |
| `payload.conversationId` → `Conversation.createdById` | **Igen**, ha a chat-útvonal kitöltötte a payloadot (FK-oszlop nélkül is) |
| `payload.parentTicketId` lánc → szülő `createdById` / run-as | **Részben** — ha volt szülő-ticket, és annak createdBy / run-as értelmes |
| Szinkron processor `actingUserId` argumentum | **Nem persistálódik**; a jelenlegi bekötés nem is használja |
| Eredeti `agent_ask` `tool.call` sor `acting_user_id` meta | **Igen**, ha a Broker `invoke` fel tudta oldani az usert a hívás előtt |

**Összegzés (C1 mellett, audit-szempontból):** a lánc **agent-identitást** hordoz (`requesterAgentId` + cél `agentId`). A kezdeményező ember **nem első osztályú mező** a delegálás-ticketen; visszakeresése indirekt (conversation / szülő / tool-call audit), és chat nélküli / async úton könnyen elvész.

### Szomszédos tények (későbbi tiketeknek)

1. **Szinkron vs. async runtime-szakadás.** Chat-szinkron: a bekötött `delegationProcessor` mindig `wikiRuntime.processTicket`-et hív ([`domain/index.ts` 660–662](../../app/src/domain/index.ts)), és eldobja az `actingUserId` / `requesterAgentId` argumentumokat. Async (nincs `conversationId` vagy processor): a ticket `ready` marad, a dispatcher a `payload.source === 'agent_ask'` miatt a **general** runtime-ot választja ([`ticket-process-route.ts` 6–18](../../app/src/lib/ticket-process-route.ts)). Ugyanaz a tool, két végrehajtási út.
2. **Nincs runAs-öröklés.** A `ticket_create` ág másolja a szülő `runAsUserId`-ját; az `agentAsk` nem. A célagent nested tool-hívásai ezért jellemzően acting user nélkül futnak (csak ticket-kontextus).
3. **A gate nem nézi a cél `status`-t** — inactive/draft agent id-vel továbbra is „reachable”, ha a tenant-szabály engedi.
4. A fentiek a #55/#57 chokepoint- és audit-döntéseit érintik, nem authz-modellkérdést.

---

## 2. Az `agent_ask` gate mai szemantikája

Sorrend a Brokerben:

1. **Capability-authz** (`AllowlistAuthorizer`) — fail → `tool.call.denied` + `recordDenied`.
2. **`agentAsk` belső ellenőrzések** — fail → `throw new Error(...)`; a `invoke` catch ága `tool.call` + `status: 'error'`, `policyDecision: 'error'`, majd újra dob ([`tool-broker-service.ts` 302–340](../../app/src/domain/tool-broker/tool-broker-service.ts)).

### Belső gate (sorrendben)

| Feltétel | Hibaüzenet |
| --- | --- |
| üres `question` | `Question is required` |
| `targetAgentId === input.agentId` | `Cannot delegate to the same agent — choose a different targetAgentId` |
| cél agent nincs | `Target agent not found` |
| cél `role === 'orchestrator'` | `Target agent is orchestrator and cannot answer delegated tickets` |
| `!isAgentReachableFromTenant(target.tenantId, effectiveTenantId)` | `Target agent is not reachable from this tenant` |

`effectiveTenantId` = szülő-ticket tenantja, különben `actingTenantId` (a cselekvő user/kontextus tenantja).

### `isAgentReachableFromTenant` ([`tenant-reachability.ts` 9–15](../../app/src/lib/tenant-reachability.ts))

```ts
if (agentTenantId === null) return true          // megosztott platform-agent
return agentTenantId === effectiveTenantId       // saját tenant
```

- Cross-tenant (más `tenantId`) → **soha**.
- `tenantId === null` → **mindig** elérhető bármely effektív tenantból.
- Nincs view/address, nincs él-gráf — csak tenant-határ.

Ugyanez a szabály szűri az `agent_catalog` / `agent_resolve` listákat (`filterAgentsByTenant` + `findMany()` unfiltered, majd filter — [`tool-broker-delegation.ts` 1322–1374](../../app/src/domain/tool-broker/tool-broker-delegation.ts)).

Siker után: interaction ticket `state: 'ready'`, assignee = célagent. Ha van `delegationProcessor` **és** `conversationId` → szinkron várakozás a válaszra; különben azonnal visszaadja a ticket id-t (async / dispatcher útvonal).

`delegation.create` audit **nem** íródik az `agent_ask`-nál (az esemény a katalógusban él, a Playbook/process útvonal használja). Sikeres válasz-visszaadáskor van `delegation.return` (más függvényág).

---

## 3. A prompt-roster útja

### Formázó

[`formatOrgRoster`](../../app/src/lib/agent-org-roster.ts) (23–37): az átadott `Agent[]`-ből az **active** státuszúakat listázza. Soronként: nickname (persona), hivatalos név, **agentId**, szerep, trait. Záró utasítás: nicknév → `agent_catalog` / `agent_resolve`.

### Hívók (egyetlen két hely)

| Hívó | Betöltés | Hol landol |
| --- | --- | --- |
| [`agent-chat-runtime.ts` `buildGatewayMessages` 1813–1818](../../app/src/domain/agent/agent-chat-runtime.ts) | `this.agents.findMany()` **filter nélkül** | system prompt 2. blokkja (`stablePreamble`) |
| [`general-task-runtime.ts` `buildTaskMessages` 834–839](../../app/src/domain/agent/general-task-runtime.ts) | ugyanez | ugyanez |

A repository: [`PostgresAgentRepository.findMany`](../../app/src/repositories/postgres/agent-repository.ts) 23–28 — `tenantId` nélkül `where: undefined` → **minden** agent a DB-ből.

A tool-oldali katalógus (`agent_catalog` / `agent_resolve`) **tenant-szűrt**; a prompt-roster **nem**. Ez a C2 / konzisztencia-invariáns (#55) kiindulópontja.

---

## 4. Három ismert defektus (csak dokumentálás)

### D-A — Cross-tenant agent-névsor a system promptban

- **Hol:** `agent-chat-runtime.ts:1813`, `general-task-runtime.ts:834` — `findMany()` tenant argumentum nélkül, majd `formatOrgRoster`.
- **Hatás:** más tenantek agentjeinek neve, nickneve, persona-traitje és **agentId-ja** bekerül a hívó agent promptjába.
- **Megjegyzés:** a tool-gate (`isAgentReachableFromTenant`) a cross-tenant hívást elutasítja; a szivárgás a **láthatóság / ID-ismeret** síkja (C2: „nem látja, tehát nem tudja az ID-t” nem védelem — itt fordítva: látja, amit nem hívhatna cross-tenantként).

### D-B — Megosztott agent: UI-n láthatatlan, toolból hívható

- **UI:** [`listAgents`](../../app/src/app/actions/platform.ts) 1016–1019 — `findMany({ tenantId: user.activeTenantId })` → Prisma **egzakt** egyenlőség → `tenantId = null` kimarad.
- **Tool:** `isAgentReachableFromTenant(null, *) === true` → `agent_ask` / catalog / resolve beengedi.
- **Hatás:** divergencia a lista és a hívás-gate között; a #79 témája.

### D-C — `agent_ask` elutasítások: nincs dedikált deny-audit

A belső `throw new Error(...)` üzenetek (üres kérdés, self-delegate, not found, orchestrator, not reachable):

- **nem** mennek a capability `recordDenied` / `tool.call.denied` ágon (az authz már átment);
- a catch `tool.call` + `status: 'error'` + `policyDecision: 'error'` sort ír, az üzenet a `resultMeta.error`-ban;
- **nincs** `agent.ask.denied` / `delegation.denied` / él-hivatkozás.

A chartelés „auditnyom nélkül” állítása **szigorúan**: nincs szemantikus deny-esemény. Gyengébben: van generikus error-`tool.call`, de belőle nem rekonstruálható tisztán „megtagadott delegálás” vs. egyéb tool-hiba. A #57 ebből indul.

---

## Gyors referencia a későbbi tiketeknek

| Kérdés | Mai válasz |
| --- | --- |
| User→agent / agent→agent él? | Nincs — csak tenant-reachability |
| Prompt roster forrása | Unfiltered `findMany` + `formatOrgRoster` |
| Tool roster forrása | Ugyanaz a `findMany`, majd `filterAgentsByTenant` |
| Emberi principal a delegálás-ticketen | Nincs; indirekt követés (legjobb: eredeti `tool.call` `acting_user_id` + opcionális conversation) |
| Szinkron végrehajtás | Mindig wiki runtime (processor wiring) |
| Async végrehajtás | General runtime (`source: 'agent_ask'`) |
| `delegation.create` az `agent_ask`-on | Nem |
| Fail-closed gráf kapcsoló | Nincs (C4 default nyitott a jövőbeli modellben) |
