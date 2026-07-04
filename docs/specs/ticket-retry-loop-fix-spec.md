# Fejlesztői specifikáció — Folyamat-ticket végtelen retry-loop megszüntetése

Státusz: **implementálva, célzottan verifikálva** · Kód: **Rész A + Rész B kész** · Utolsó folytatás: **2026-07-04** · Kapcsolódó hibajegy: [`docs/bugs/ticket-retry-loop-agent-mismatch.md`](../bugs/ticket-retry-loop-agent-mismatch.md)

## 0. Megvalósítási státusz

Kész:
- [x] `AgentApiKey.expiresAt` nullable mező a Prisma sémában.
- [x] `issueEphemeralKey(agentId, ttlMs)` és idempotens `revokeKey(keyId)` az agent repositoryban.
- [x] `authenticateApiKey` lejárt efemer kulcsot már nem fogad el.
- [x] Dispatcher per-dispatch efemer kulcsot mintáz a ticket saját `agentId`-jához, átadja a launchernek, és completion / reclaim / launch-hiba ágon visszavonja.
- [x] Cloud Run és Docker local launcher futásidejű `harnessAgentApiKey`-t preferál, statikus env fallbackkel.
- [x] `process/route.ts` agent-egyenlőség checkje megmaradt, a permanens hibák strukturált `category` + `code` választ adnak.
- [x] Harness completion séma és job-entrypoint továbbviszi az opcionális `errorCategory` mezőt.
- [x] Dispatcher loop-guard: permanens hiba azonnal `awaiting_human`, tranziens hiba `HARNESS_MAX_RETRIES` után `awaiting_human`.
- [x] `ticket.payload.dispatch.failureCount` kezeli a retry-számlálást, sikeres futás nullázza.
- [x] `dispatch.blocked` audit event bekerült az event-katalógusba.
- [x] Célzott regressziós teszt: `app/scripts/dispatcher-retry-loop.test.ts`.
- [x] Launch-hiba regressziós lefedése: efemer kulcs revoke, lock release, ticket vissza `ready` állapotba.
- [x] Stale reclaim regressziós lefedése: timeout-os dispatch visszavonja az efemer kulcsot és törli az `ephemeralKeyId`-t.
- [x] Heurisztikus permanenshiba-lefedés: kategória nélküli `Agent mismatch` is azonnal `awaiting_human`.
- [x] Sikeres completion regressziós lefedése: `ephemeralKeyId` és `failureCount` törlődik.
- [x] NPM script: `npm run test:dispatcher-retry-loop`.
- [x] Additív DB apply script az `agent_api_keys.expires_at` oszlophoz: `npm run db:apply-agent-api-key-expires-at`.
- [x] Dry-run alapú efemer kulcs prune script: `npm run db:prune-ephemeral-agent-keys` (`-- --apply` kapcsolóval töröl).
- [x] Chat-webhook / proaktív monitor értesítés `dispatch.blocked` esetén: `DISPATCH_BLOCKED_NOTIFY_CHANNEL=chat:<kulcs>` a meglévő allowlistolt `MONITOR_NOTIFY_WEBHOOK_<KULCS>` routingot használja; alapértelmezésben audit-only fallback.
- [x] UI konfiguráció a System → Dispatcher panelen: a `dispatch.blocked` chat webhook csatornakulcsa a `dispatcher.controls.blockedNotifyChannel` platform-settingbe menthető.
- [x] `dispatch.notify.sent` / `dispatch.notify.failed` audit eventek bekerültek az event-katalógusba.

Verifikáció:
- [x] `npm run --prefix app test:dispatcher-retry-loop` — utolsó futás: 2026-07-04, sikeres.
- [x] `npx tsc --noEmit` az `app` könyvtárból — utolsó futás: 2026-07-04, sikeres.
- [x] `npm run --prefix app db:generate` — utolsó futás: 2026-07-04, sikeres; Prisma 7 config-deprecation warninggal.
- [x] `npm run --prefix app db:prune-ephemeral-agent-keys` — utolsó futás: 2026-07-04, dry-run sikeres; ha a DB-n még nincs `expires_at`, érthető skip üzenettel áll meg.
- [x] `npm run --prefix app lint -- scripts/prune-ephemeral-agent-keys.ts scripts/apply-agent-api-key-expires-at.ts` — utolsó futás: 2026-07-04, sikeres.
- [x] `npm run --prefix app lint -- src/domain/dispatcher/dispatcher-service.ts src/domain/dispatcher/dispatch-alert-notifier.ts src/domain/index.ts src/lib/audit/event-catalog.ts scripts/dispatcher-retry-loop.test.ts` — utolsó futás: 2026-07-04, sikeres.
- [x] `npm run --prefix app lint -- src/app/control-plane/system/dispatcher-control-panel.tsx src/domain/platform-settings/platform-settings-service.ts src/domain/dispatcher/dispatch-alert-notifier.ts src/domain/index.ts src/app/actions/platform.ts src/lib/validators/actions.ts scripts/dispatcher-retry-loop.test.ts` — utolsó futás: 2026-07-04, sikeres.
- [ ] `npm run --prefix app lint` teljes repóra futtatva egy meglévő, nem kapcsolódó hibán bukik:
  `app/src/components/playbooks/playbook-spec-editor.tsx:69 react-hooks/set-state-in-effect`.

---

## 1. Kontextus és probléma

Chatből indított Folyamat belépő tickete végtelenül pörög `Ready → Feldolgozás → Ready` között,
percenként újra, soha nem lép előrébb, nincs hibaállapot és nincs értesítés.

A kivizsgálás **két, egymástól független** gyökérokot erősített meg:

### 1.1 RC#1 — Agent-identitás mismatch (tervezési hézag, NEM konfig-típushiba)

A hibajegy „adat/konfig eltérésnek" keretezte, de a kód mást mutat: ez **strukturális** hiba.

- A harnesst a dispatcher **egyetlen, rendszerszinten megosztott** `HARNESS_AGENT_API_KEY`-jel indítja
  ([`harness-run-env.ts:82`](../../app/src/domain/dispatcher/harness-run-env.ts)). Ez a kulcs az
  `authenticateApiKey`-ben **pontosan egy** agenthez van kötve
  ([`agent-repository.ts:700`](../../app/src/repositories/postgres/agent-repository.ts)); dev-ben ez a
  `.seed-demo-api-key`, egy konkrét seed-worker agenté.
- A Folyamat belépő tickete viszont a `roleBindings[roleKey]`-ből kap agentet
  ([`process-service.ts:704`](../../app/src/domain/playbook/process-service.ts)) — ez **bármelyik** agent lehet.
- A `POST /api/v1/harness/tickets/[id]/process` végpont
  ([`process/route.ts:33`](../../app/src/app/api/v1/harness/tickets/[id]/process/route.ts)) megköveteli, hogy
  `body.agentId (== AGENT_ID env) === auth.agentId (== a kulcs agentje)`. Ez **garantáltan** elbukik minden
  olyan Folyamatnál, aminek a szerepe nem a harness-kulcs agentjéhez van kötve → állandó 403 → végtelen retry.
- A `tool:invoke` scope-ot **minden** worker megkapja
  ([`agent-repository.ts:15-19`](../../app/src/repositories/postgres/agent-repository.ts)), így az egyenlőség-check
  ma az egyetlen védelem az ellen, hogy egy agent kulcsa más agent ticketjét dolgozza fel — emiatt a checket
  **nem elég csak eltávolítani**.

**A megosztott kulcs downstream is torzít.** A harness ugyanezt a kulcsot viszi a model gateway-hez és a
tool broker-hez is, és a gateway mindent `auth.agentId`-ra köt — modelConfig, napi **budget**, token-**usage**,
model-call **audit** ([`gateway/.../route.ts:46,86,103`](../../app/src/app/api/v1/gateway/v1/chat/completions/route.ts)).
Egy megosztott „act-as-any-agent" identitás tehát a valódi ticket-agent helyett a harness-agentre írná a költést
és a jogosultság-érvényesítést → hibás audit + jogosultság-eszkaláció.

### 1.2 RC#2 — Nincs retry-limit / hibaállapot / láthatóság

A `completeHarnessRun` minden `failed` harness-futást feltétel nélkül `ready`-be tesz vissza
([`dispatcher-service.ts:210-220`](../../app/src/domain/dispatcher/dispatcher-service.ts)), amit a
`dispatchReadyBatch` a következő ciklusban azonnal újra felvesz. Nincs:
- retry-számláló / max-retry küszöb,
- terminal hiba-/beavatkozás-állapot,
- tranziens (5xx/timeout, érdemes újrapróbálni) vs. permanens (4xx auth/config, sosem javul retry-ra) megkülönböztetés,
- riasztás/log a néma pörgésről.

---

## 2. Célok és nem-célok

### Célok
1. Több-agentes Folyamat belépő tickete helyesen fusson le — a harness a **ticket saját agentjének** identitásával.
2. A budget/tool-authz/audit **végig a helyes agentre** menjen (biztonság + auditálhatóság — ez volt a kiemelt igény).
3. Bármilyen jövőbeli **permanens** harness-hiba se okozhasson néma végtelen pörgést: N próba után explicit,
   emberi beavatkozást kérő állapot + riasztás.
4. **Nulla új kézi karbantartási teendő** a felhasználónak/adminnak; a kulcs-életciklus teljesen automatikus.

### Nem-célok
- A harness/Goose recept vagy a wiki-runtime belső logikájának átírása.
- A roleBindings feloldás (`resolveAgentForRole`) megváltoztatása.
- Retry-backoff finomhangolása időzítés szintjén (a meglévő dispatch-ciklus marad); csak a limit + állapot kell.
- Új általános „service account" jogosultsági réteg bevezetése (a `harness:process`-szerű „act-as-any" scope
  szándékosan **elvetve** — lásd 4. §).

---

## 3. Választott megközelítés (összefoglaló)

| Rész | Gyökérok | Döntés |
|------|----------|--------|
| **A** | RC#1 | **Per-dispatch efemer agent-identitás.** A dispatcher a `ticket.agentId`-hez rövid életű, `active` API-kulcsot mintáz, ezt adja át `HARNESS_AGENT_API_KEY`-ként, és a completion/reclaim/launch-hiba ágon **visszavonja**. A `process/route.ts` egyenlőség-checkje így magától igazzá válik, védelemnek megmarad. |
| **B** | RC#2 | **Loop-guard + hibaosztályozás.** A `completeHarnessRun` a hiba jellege szerint dönt: permanens → azonnal `awaiting_human` + riasztás; tranziens → `ready` + retry-számláló, N után szintén `awaiting_human`. |

A két rész **független**, külön PR-ben is szállítható; javasolt sorrend: előbb **B** (azonnal megállítja a néma
pörgést, kis kockázat), majd **A** (a valódi ok, nagyobb felület).

---

## 4. Miért „A" és nem a megosztott service-kulcs

Vizsgált alternatíva: dedikált `harness:process` scope, amivel a megosztott kulcs bármely agent ticketjét
feldolgozhatja (a ticket saját `ticket.agentId`-je ellenében). **Elvetve**, mert:

- A downstream gateway/tool-broker `auth.agentId`-ra köt → a költség/jogosultság/audit a harness-agentre kerülne,
  nem a valódira. Ez pont a kiemelt célt (auditálhatóság) rontaná.
- „Act-as-any-agent" kulcs blast radius-a az összes agent összes ticketje.

A per-dispatch efemer kulcs ezt a torzulást **gyökerénél** oldja: minden downstream hívás a helyes agent-identitást
viszi, mert a kulcs eleve a `ticket.agentId`-hez tartozik.

---

## 5. Rész A — Per-dispatch efemer agent-identitás (RC#1)

### 5.1 Kulcs-életciklus (koncepció)

```
dispatchReadyTicket(ticket):
  ...lock megszerzése után, launch ELŐTT:
  ephemeralKey = agents.issueEphemeralKey(ticket.agentId)      // raw kulcs + keyId, TTL-lel
  try:
    launcher.launch({ ..., harnessAgentApiKey: ephemeralKey.rawKey, ephemeralKeyId: ephemeralKey.id })
  catch launchError:
    agents.revokeKey(ephemeralKey.id)                          // takarítás launch-hibánál
    releaseDispatchLock + state:ready ...

completeHarnessRun(...):
  ...a lock feloldása után:
  if ticket.payload.ephemeralKeyId: agents.revokeKey(ephemeralKeyId)

reclaimStaleDispatches(...):
  ...timeout-os visszavételkor:
  if ticket.payload.ephemeralKeyId: agents.revokeKey(ephemeralKeyId)
```

- **Hol tároljuk a `ephemeralKeyId`-t?** A ticket `payload`-jában (`payload.dispatch.ephemeralKeyId`), a `lockToken`
  mellett, mert a completion/reclaim úgyis a ticketből dolgozik. Nincs séma-migráció ehhez.
- **Scope:** az efemer kulcs a `serviceAccountScopesForRole(agent.role)` scope-jait kapja — pontosan azt, amit az
  agent amúgy is kapna. Nincs privilégium-emelés.
- **A kulcs raw értéke** csak a launch env-be kerül (`HARNESS_AGENT_API_KEY`), sehol máshol nem naplózzuk
  (az audit metadata **csak a `keyId`-t** rögzítse, sose a raw kulcsot).

### 5.2 Séma-változás — `AgentApiKey.expiresAt` (opcionális, ajánlott)

A jelenlegi `ApiKeyStatus { active | revoked }` és a `status:'active'` szűrésű
`authenticateApiKey` mellett a TTL kikényszerítéséhez:

```prisma
model AgentApiKey {
  ...
  expiresAt  DateTime?    @map("expires_at") @db.Timestamptz   // ÚJ, nullable → visszafelé kompatibilis
}
```

- `authenticateApiKey`: a `status:'active'` mellé `AND (expiresAt IS NULL OR expiresAt > now())` feltétel.
  A meglévő (nem-efemer) kulcsok `expiresAt = NULL` → változatlanul érvényesek.
- Az efemer kulcs `expiresAt`-ja pl. `now + HARNESS_DISPATCH_TIMEOUT_MS` (a stale-reclaim küszöb, ma 1 800 000 ms),
  hogy egy összeomlott, completion nélküli harness kulcsa **magától** lejárjon, még mielőtt a reclaim visszavonná.
- **Alternatíva séma-migráció nélkül:** kizárólag a revoke-ra hagyatkozunk (completion + reclaim + launch-hiba).
  Ez lefedi a normál és a timeout-os ágat is; a TTL csak a „reclaim még nem futott le, de a folyamat már crashelt"
  szűk ablakra ad plusz védelmet. **Döntés: `expiresAt`-tal, mert olcsó és bezárja az ablakot.**

### 5.3 Repository — új metódusok (`AgentRepository`)

```ts
// Rövid életű, active kulcs mintázása a megadott agenthez. A raw kulcs csak itt látható.
issueEphemeralKey(agentId: string, opts?: { ttlMs?: number }):
  Promise<{ id: string; rawKey: string; scopes: string[] }>

// Idempotens visszavonás (már revoked/hiányzó kulcsra no-op, nem dob).
revokeKey(keyId: string): Promise<void>
```

- `issueEphemeralKey` a `rotateApiKey` mintáját követi (`cp_sk_ + randomBytes(16)`, `bcrypt.hash`,
  `serviceAccountScopesForRole(agent.role)`), de **nem** revokálja az agent többi aktív kulcsát (nem rotáció),
  és beállítja az `expiresAt`-ot.
- Interfész-frissítés: [`repositories/interfaces`](../../app/src/repositories/interfaces) `AgentRepository` típus
  + a Postgres implementáció + a tesztekben használt in-memory/fake repo.

### 5.4 Dispatcher wiring

- `HarnessLauncher.launch` input kiegészül: a launcher a `harnessAgentApiKey`-t **futásidőben** kapja
  (ma a `cloud-run-job-launcher.ts:45` és `docker-local-harness-launcher.ts:46` `process.env.HARNESS_AGENT_API_KEY`-ből
  olvassa be **statikusan**). Két lehetőség:
  1. `DispatcherService` átadja a `launch(...)`-nak a friss `harnessAgentApiKey`-t, és a launcher ezt preferálja a
     statikus env fölött. **(ajánlott)**
  2. A launcher marad env-alapú — elvetve, mert épp az env-statikusság a hiba forrása.
- A statikus `HARNESS_AGENT_API_KEY` env **fallbackként megmarad** (docker-local dev, smoke-scriptek,
  nem-Folyamat wiki-flow), de a Folyamat-dispatch az efemer kulcsot használja.

### 5.5 `process/route.ts` — nincs gyengítés

Az efemer kulccsal `auth.agentId === ticket.agentId === body.agentId`, így a
[`process/route.ts:33`](../../app/src/app/api/v1/harness/tickets/[id]/process/route.ts) egyenlőség-check
**változatlanul marad** és mostantól helyesen zöld. Megmarad védelemként a nem-Folyamat / hibás hívásokra.

---

## 6. Rész B — Loop-guard + hibaosztályozás (RC#2)

### 6.1 Célállapot: `awaiting_human` (nincs új enum)

A `TicketState` enumban **nincs** `blocked`/`failed`
([`schema.prisma:225-233`](../../app/prisma/schema.prisma)); a meglévő **`awaiting_human`** pontosan a
„megakadt, ember kell" szemantika. **Döntés: `awaiting_human`-ba visszük**, nincs séma-migráció, és a
meglévő UI/„Állapot-előzmények" már kezeli ezt az állapotot.
(Ha később kell dedikált `blocked`, az külön, additív enum-bővítés.)

### 6.2 Retry-számlálás: tranzíciós historyból (migráció nélkül)

Nincs `attemptCount` oszlop a `Ticket`-en. A `TicketTransition` history-ból számoljuk a **legutóbbi sikeres
előrelépés óta** felhalmozott `... → ready` (`note: harness failed…`) átmeneteket:

```
attempts = count(transitions where toState='ready' AND note LIKE 'harness failed%'
                 AND createdAt > lastForwardProgressAt)
```

- Küszöb: `HARNESS_MAX_RETRIES` env (default pl. **3**).
- **Alternatíva:** `payload.dispatch.failureCount` inkrementálása a `completeHarnessRun`-ban (egyszerűbb olvasás,
  szintén migráció nélkül). **Döntés: `payload.dispatch.failureCount`**, mert determinisztikus és nem függ a
  transition-note szövegétől; a history a `note`-tal amúgy is auditálja.

### 6.3 Hibaosztályozás: permanens vs. tranziens

A `completeHarnessRun` `input.error` ma szabad szöveg (a harness a
[`job-entrypoint.ts:170-172`](../../app/src/harness/job-entrypoint.ts) `e.message`-ét küldi tovább). Robusztus
osztályozáshoz **strukturált jelzés** kell:

1. **Forrás (ajánlott):** a `process/route.ts` a permanens hibáknál (403 mismatch, „not assigned", scope-hiány)
   adjon vissza gépi kategóriát: `{ success:false, error, category:'permanent', code:'AGENT_MISMATCH' }`.
   A harness a completionben adja tovább: a `harnessCompletionSchema`
   ([`validators/actions`](../../app/src/lib/validators/actions.ts)) kap egy opcionális
   `errorCategory: 'permanent' | 'transient'` mezőt; a `job-entrypoint` a process-válasz `category`-jét viszi bele.
2. **Fallback (ha nincs kategória):** heurisztika a `completeHarnessRun`-ban — HTTP 4xx / az ismert permanens
   üzenetminták (`Agent mismatch`, `not assigned`, `Missing scope`, `Missing harness env`) → `permanent`;
   minden más (5xx, timeout, hálózati) → `transient`.

Osztályozás → állapot:

| Kategória | Viselkedés |
|-----------|-----------|
| `permanent` | **Azonnal** `awaiting_human` (retry nélkül) + `dispatch.blocked` audit + riasztás. |
| `transient` | `ready` + `failureCount++`; ha `failureCount >= HARNESS_MAX_RETRIES` → `awaiting_human` + riasztás; egyébként retry a következő ciklusban. |

Sikeres futás (`succeeded`) nullázza a `failureCount`-ot.

### 6.4 Láthatóság / riasztás

- Új audit-event: `dispatch.blocked` (`policyDecision:'blocked'`, metadata: `category`, `failureCount`,
  `error`, `keyId`) — az `AuditLog/Observability` event-katalógusba felvenni.
- A meglévő `dispatch.error` audit megmarad a tranziens próbákra.
- Ha van értesítő-adapter (lásd `[[proactive-monitor-build]]` chat-webhook governance): N-próba/`blocked` esetén
  opcionális notifikáció — külön, feature-flag mögött, hogy ne spammeljen.

---

## 7. Adatmodell-változások összegzés

| Változás | Típus | Kötelező? |
|----------|-------|-----------|
| `AgentApiKey.expiresAt` (nullable) | Prisma migráció (additív) | Rész A — ajánlott (nélküle csak revoke-ra hagyatkozunk) |
| `ticket.payload.dispatch.{ephemeralKeyId, failureCount}` | JSON payload, nincs séma | Rész A + B — igen |
| `harnessCompletionSchema.errorCategory?` | zod séma bővítés | Rész B — ajánlott (nélküle csak heurisztika) |

**Nincs** új `TicketState` enum-érték és **nincs** új scope.

---

## 8. Érintett fájlok (várható)

**Rész A**
- `app/prisma/schema.prisma` — `AgentApiKey.expiresAt` + migráció
- `app/src/repositories/interfaces` — `issueEphemeralKey`, `revokeKey` a típusba
- `app/src/repositories/postgres/agent-repository.ts` — implementáció + `authenticateApiKey` `expiresAt` szűrő
- `app/src/domain/dispatcher/dispatcher-service.ts` — mint/pass/revoke a dispatch/complete/reclaim/launch-hiba ágon
- `app/src/domain/dispatcher/cloud-run-job-launcher.ts`, `docker-local-harness-launcher.ts` — a `harnessAgentApiKey`
  futásidejű átvétele az env-statikus helyett (env fallback marad)
- (test) in-memory/fake agent repo a dispatcher tesztekhez

**Rész B**
- `app/src/domain/dispatcher/dispatcher-service.ts` — `completeHarnessRun` osztályozás + loop-guard + `failureCount`
- `app/src/lib/validators/actions.ts` — `harnessCompletionSchema.errorCategory?`
- `app/src/app/api/v1/harness/tickets/[id]/process/route.ts` — strukturált permanens hibakód a válaszban
- `app/src/harness/job-entrypoint.ts` + `wiki-ticket-process.ts` — a `category` továbbadása a completionben
- audit event-katalógus (`AuditLog/Observability`) — `dispatch.blocked`

---

## 9. Tesztterv

**Rész A**
1. `issueEphemeralKey` → `authenticateApiKey` a friss raw kulccsal a helyes `agentId`-t adja; lejárt `expiresAt`
   után `null`-t.
2. `revokeKey` idempotens (kétszeri hívás nem dob), utána az auth `null`.
3. Dispatch happy-path: a launch a ticket-agenthez mintázott kulcsot kapja; completion után a kulcs `revoked`.
4. Launch-hiba: a kulcs azonnal `revoked`, ticket `ready`.
5. Stale-reclaim: timeout-os visszavételkor a kulcs `revoked`.
6. **Regresszió (a bug reprodukciója):** olyan Folyamat, aminek roleBindings-e ≠ a régi statikus harness-agent →
   a belépő ticket **egyszer** lefut és előrelép (nincs 403/mismatch, nincs pörgés).

**Rész B**
7. Permanens hiba (`category:'permanent'` vagy mismatch-üzenet) → `awaiting_human` **első** próbára, `dispatch.blocked`
   audit keletkezik, nincs retry.
8. Tranziens hiba `HARNESS_MAX_RETRIES`-szor → minden próbánál `ready`, a küszöbnél `awaiting_human` + riasztás.
9. `failureCount` nullázódik sikeres futás után (nem cipel át korábbi tranziens hibákat).
10. Kategória nélküli completion → heurisztika helyesen osztályoz (mismatch→permanent, timeout→transient).

---

## 10. Rollout, kompatibilitás, kockázatok

- **Visszafelé kompatibilis:** `expiresAt` nullable (meglévő kulcsok érintetlenek); a statikus
  `HARNESS_AGENT_API_KEY` fallback marad; nincs törő enum/scope-változás.
- **Sorrend:** Rész B önmagában szállítható és azonnal megállítja a néma pörgést (kis kockázat). Rész A a valódi ok.
- **Kulcs-tábla növekedés:** dispatch-enként 1 revoked sor. Kezelés: `expiresAt` + dry-run alapú prune script:
  `npm run db:prune-ephemeral-agent-keys` (`-- --apply` kapcsolóval töröl).
- **Felhasználói karbantartás:** **nincs.** A kulcs-életciklus teljesen automatikus (mint → revoke a
  completion/reclaim/lejárat ágon).
- **Döntés:** `errorCategory` strukturált jelzés bekerült; a dispatcher megtartja a heurisztikus fallbacket is.

---

## 11. Döntési napló

1. `AgentApiKey.expiresAt` bekerült nullable mezőként; dedikált Prisma migration fájl helyett explicit additív apply script készült, mert a repó nem tartalmaz `prisma/migrations` struktúrát.
2. `HARNESS_MAX_RETRIES` default értéke **3**.
3. `errorCategory` strukturált jelzés bekerült a completion-láncba, heurisztikus fallbackkel.
4. `blocked` esetén ebben a körben audit-event a riasztási csatorna; chat-webhook/proaktív monitor integráció későbbi, külön feature-flagelt munka.
5. Revoked/expired efemer kulcsokra dry-run alapú prune script készült; alapértelmezett retention: **7 nap**.
