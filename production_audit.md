# Production Audit napló

Napi éles-környezeti biztonsági és megbízhatósági audit. Minden bejegyzés egy
vizsgált scope-ot, a coverage-t, a bizonyított findingokat, a javításokat, az
ellenőrzéseket és a residual riskeket rögzíti. Cél: bizonyítható kockázatcsökkenés
és növekvő audit-coverage.

---

## 2026-09-05 — Agent-chat stream API: work-project kulcs validáció

**Scope:** `POST /api/v1/agent-chat/stream` (`app/src/app/api/v1/agent-chat/stream/route.ts`)
— a webes chat-felület egyetlen kliens-vezérelt fordulóindító végpontja. Kockázati
alapon választva: ez a legnagyobb támadási felületű, autentikált, kliens-adatot
(`projectKey`, `content`, `taskBriefing`, `attachmentDocumentIds`) az agent-runtime-ba
továbbító ingress, és a `projectKey` a **memória + audit hatóköre**.

**Coverage:** a `projectKey` teljes ingress-felülete végignézve (API-route + a
`app/src/app/actions/` server-action írási útvonalak), valamint a downstream memória-
és audit-felhasználás (`memory-runtime-helper`, `memory-*-service`, `inputRef: project:<key>`).
A route egyéb bemenetei (consequence-approval folytatás, connector-grant folytatás,
task-only kapu, aktív-forduló 409, SSE keep-alive/`after` életciklus) áttekintve —
ezeken nem találtam új bizonyítható findingot ebben a körben.

### Finding (CONFIRMED) — validálatlan `projectKey` → árva memória/audit névtér

A stream-route a kliens `projectKey`-jét **validáció nélkül** adta tovább az agent-
fordulónak. A `projectKey` a munkatárs-memória lekérés/írás szűrője és az audit
`inputRef` (`project:<key>`) hatóköre. A ticket- és server-action útvonalak már a
`workProjects.assignableKey(tenantId, key)` kapun mennek át; ez a route volt az
**egyetlen** API-ingress, amely megkerülte azt.

- **Hatás:** egy ismeretlen vagy archivált kulccsal a chat-felületről új,
  nyomon követhetetlen memória-szeletet lehetett nyitni a tenanten belül (adat-
  integritás / auditálhatóság sérül). Tenant-határ nem sérült: az `assignableKey`
  a `findByKey(tenantId, key)`-t használja, így másik tenant kulcsa „nem található".
- **Súlyosság:** közepes (adat-integritás / audit-scope, nem cross-tenant szivárgás).

### Javítás

`app/src/app/api/v1/agent-chat/stream/route.ts`: nem-folytatás fordulónál a route
mostantól a `services.workProjects.assignableKey`-t hívja:
- ismeretlen / archivált / érvénytelen kulcs → `400 invalid_work_project` (forduló nem indul),
- foglalt/üres kulcs → `Általános` gyűjtőre normalizál,
- a tovább adott érték a validált, normalizált kulcs (`assignedProjectKey`).

Root-cause szintű: minden `projectKey` ingress most ugyanazon a kapun megy át.

### Ellenőrzések

- `scripts/work-project.test.ts` — kiegészítve a stream-route validáció regressziós
  assertjével (assignableKey-hívás, `invalid_work_project` hiba, `assignedProjectKey`
  továbbadása). Teljes fájl zöld.
- `tsc --noEmit` tiszta; `eslint` tiszta a módosított fájlokra.
- Független `/code-review` (Standards + Spec): _lásd lentebb_.

### PR

- **#430** — `fix(chat): validate work project keys at API boundary`
  (branch `fix/chat-work-project-validation`, commit `d13484223`).

### /code-review eredmény (Matt Pocock skill, 2 párhuzamos axis)

- **Standards:** nincs hard violation; a változás **javítja** a konformitást
  (`AGENTS.md` „mindkét úton működjön" elv — a chat-út most ugyanazt a kaput
  használja, mint a ticket/server-action út). Csak triviális judgement-call
  smell-ek (a régi inline feltétel felemelése egy helyre = szándékos cleanup;
  a teszt forrás-string regex asszertjei a fájl meglévő stílusa).
- **Spec:** követelmények teljesülve, root cause a határon javítva, nincs scope
  creep. A route az **egyetlen** app-szintű `sendMessageStream` hívó — nincs
  ungated testvér-ingress. A `assigned.key` (nem a nyers input) továbbadása
  tiszteletben tartja a foglalt-kulcs normalizálást (agent-memory §2.1
  `__general__` szentinel, nincs null-kulcs).

### Residual risk / következő audithoz

- **Defense-in-depth (opcionális, YAGNI-ból most kihagyva):** az
  `agent-chat-runtime.ts` `setProjectKey` sink továbbra is közvetlenül veszi a
  `params.projectKey`-t, `assignableKey` nélkül. Gyakorlatban zárt (az egyetlen
  nem-megbízható hívó most kapuzott), de egy jövőbeli hívó újranyithatná — érdemes
  runtime-szintű kapuval megerősíteni, ha újabb ingress kerül be.
- **Continuation-on-archived él (scope-on kívül):** ha egy beszélgetés projektjét a
  létrehozás UTÁN archiválják, a folytatás továbbra is a már-archivált névtérbe ír
  (a névtér már létezett; a folytatás nem küld `projectKey`-t).
- A `content` és `taskBriefing.*` mezők tartalom-validációja/hossz-plafonja külön
  vizsgálandó (DoS / prompt-méret) — nem része ennek a körnek.
- `attachmentDocumentIds` és `processInputPayload` bizalmi-határa (IDOR/tenant-scope
  a downstream `sendMessageStream`-ben) — jövőbeli scope.
- Nem-web ingress-ek (agent API-kulcs, csatorna-integrációk, monitor-eszkaláció)
  `projectKey`/scope kezelése — jelen körben nem érintett, ellenőrizendő, hogy ezek
  egyáltalán fogadnak-e projektkulcsot.
