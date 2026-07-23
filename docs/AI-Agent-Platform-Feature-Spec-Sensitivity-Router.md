# Feature-spec — Érzékenység-tudatos Router és PII-Guardrail (Sensitivity-Aware Router)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-22
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, §3.2.1 engedélyezés három szintje, §4.7 Model Gateway, §4.7.1 routing-döntés, §4.7.2 sensitivity-aware router, §0.7 prompt injection / sensitive disclosure, §8.6 költségkontroll), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (§5.4 Model Gateway, §2.3 ModelProvider absztrakció)
**Olvasó:** fejlesztő(k). Feltételezi a Model Gateway, a `ModelProvider` interfész, a `ModelGateway.call()` és az append-only audit ismeretét.
**Státusz:** Fázis 2 — specifikált, nem implementált. A koncepcióban végig „elhalasztott tervként" jelölve (§4.7.2); ez a dokumentum a dev-ready lebontása.

---

## 0. Mit ad ez a dokumentum

A platform fő érték-állítása a **kontrollált, auditálható autonómia**, és ezen belül a legerősebb compliance-érv: **az érzékeny adat (PII, banki/fizetési információ) ne hagyja el ellenőrizetlenül a céget**. A koncepció §3.2.1 az engedélyezés rétegei között külön szerepelteti a `🔒 Sensitivity-aware router`-t (opcionális, kemény, szerveroldali), a §4.7.2 pedig részletezi a működését — de **a kód jelenleg ezt nem tartalmazza**.

Jelenleg a `ModelGateway.call()` (`app/src/domain/gateway/model-gateway.ts`) egyetlen guardrailje a **ticketenkénti hívásszám-plafon**. A prompt tartalma vizsgálat nélkül megy ki a kiválasztott (akár felhős) modellhez. Ez azt jelenti, hogy egy agent — akár prompt injection hatására — érzékeny adatot (személyi szám, bankkártyaszám, e-mail, IBAN) küldhet egy külső LLM-API-ba.

Ez a feature beilleszt egy **determinisztikus, szerveroldali tartalom-vizsgáló réteget** a Gateway-be, amely a prompt elküldése **előtt**:

1. **Felismeri** az érzékeny mintázatokat (PII/PCI) — szabály-alapú, nulla LLM-token
2. **Eldönti a policy-akciót:** átengedi / lokális modellre kényszeríti / redaktálja / blokkolja + emberi jóváhagyást kér
3. **Naplózza** a döntést a hash-láncolt auditba

**Miért önmagában is értékes:**
- **Közvetlen GDPR / PCI DSS argumentum** — a célszegmens (fintech/PSP, mid-market) beszerzésénél a "PII nem megy ki felhőbe kontroll nélkül" önmagában eladható garancia
- **A meglévő multi-provider infrastruktúrára épül** — a `chatgpt-oauth` (felhő), `gemini` (felhő) és `ollama` (helyi) provider már be van kötve; a router csak a *választást* teszi tartalom-érzékennyé
- **Nem igényel LLM-et** — szabály-alapú detektálás, determinisztikus, olcsó és auditálható

---

## 1. Scope

### 1.1 In scope (ez a feature)

- **`SensitivityClassifier`** — determinisztikus, regex/szótár-alapú PII/PCI-detektor (személyi szám, adószám, IBAN/bankszámla, bankkártyaszám + Luhn, e-mail, telefonszám, magyar TAJ, konfigurálható egyéni minták)
- **`SensitivityPolicy`** — per-agent / globális szabály: mit jelent „érzékeny", és mi a teendő (allow / local_only / redact / block)
- **Router-integráció a `ModelGateway.call()`-ba** — a guardrail után, a provider-hívás előtt
- **Provider-fallback lokális modellre** — ha a policy `local_only` és az agent felhős modellt választott, a Gateway átirányít a konfigurált lokális providerre (`ollama`)
- **Redaktálás** — `redact` policy esetén az érzékeny tokenek helyére helyőrzők (`[REDACTED:email]`) kerülnek, mielőtt a prompt felhőbe megy
- **Blokk + emberi jóváhagyás** — `block` policy esetén a hívás megáll, audit-flag, és a ticket `awaiting_human` állapotba kerülhet
- **Audit** — minden sensitivity-döntés (kategória, akció, érintett mintaszám — de **sosem a nyers érzékeny érték**) az audit_log-ba
- **Admin UI** — per-agent sensitivity policy szerkesztő + globális default + dry-run teszter

### 1.2 Out of scope (most NEM)

- LLM-alapú érzékenység-osztályozás (a v1 determinisztikus; LLM-classifier opcionális upgrade, ha a szabály-alapú nem elég)
- Kimenő (completion) tartalom szűrése — ez a feature a **bemenő prompt**-ra koncentrál; a completion-redakció külön mini-spec (§13 D-SR-3)
- ML-alapú named-entity recognition (NER) — Fázis 3, ha a regex/szótár nem elég pontos
- Tool Broker oldali secret-szűrés — az már megvan (a secret sosem a promptban, §4.9.2); ez a feature a *felhasználói/dokumentum-eredetű* PII-re vonatkozik, nem a rendszer-secretekre
- Differential privacy / tokenizációs vault — Fázis 3

### 1.3 Illeszkedés a meglévő architektúrához

A feature **nem új komponens** — a meglévő Model Gateway kiterjesztése:

| Meglévő elem | Mit ad a feature-höz |
|---|---|
| `ModelGateway.call()` | A guardrail-check után beilleszti a `classifyAndRoute()` hívást |
| `ModelProvider` interfész + provider-map | A `local_only` fallback a meglévő `ollama` providerre vált, kódváltás nélkül |
| `model_calls` napló + `audit_log` | A sensitivity-döntés ugyanarra a naplóra kerül (`model.call.sensitivity` action) |
| Agent Registry `model_config` (jsonb) | Bővül egy opcionális `sensitivityPolicy` mezővel (agent-szintű felülírás) |
| `PlatformSetting` (kill-switch minta, PM-D) | A globális default policy és a router kill-switch ott él |

---

## 2. Hogyan illeszkedik a Gateway routing-rétegéhez

A koncepció §3.2.1 az engedélyezés rétegeit egy belülről kifelé sorrendben írja le. A sensitivity-router helye:

```
  GOOSE ── prompt ──►  MODEL GATEWAY.call()
                         │
                         │ 1. 🔒 Hívás-guardrail (MEGLÉVŐ) — ticketenkénti hívásszám-plafon
                         │
                         │ 2. 🔒 SENSITIVITY-AWARE ROUTER (ÚJ, ez a feature) — LOKÁLIS vizsgálat:
                         │    ├─ tiszta?            → engedi tovább a routingot
                         │    ├─ érzékeny + local_only? → KÉNYSZER: lokális provider (ollama)
                         │    ├─ érzékeny + redact? → helyőrzőzés, majd felhőbe mehet
                         │    └─ érzékeny + block?  → BLOKK + audit-flag + (opc.) emberi jóváhagyás
                         │
                         │ 3. 🔒 ROUTING-DÖNTÉS (MEGLÉVŐ) — provider feloldás + provider.chat()
                         ▼
              ┌──────────────────────┬───────────────────────┐
              ▼                      ▼                       ▼
        FELHŐ (chatgpt-oauth,   LOKÁLIS (ollama)       BLOKK / emberi
        gemini)                 — adat nem megy ki     jóváhagyás
```

**Kulcs-elv (§4.7.2):** a router **lokálisan** dönt, *mielőtt* a prompt elhagyná a kontrollált határt. A vizsgálat determinisztikus (nulla token), és a döntés szerveroldalon **kemény** — az agent nem tudja megkerülni.

---

## 3. SensitivityClassifier — a detektor

**Fájl:** `app/src/domain/gateway/sensitivity/classifier.ts`

### 3.1 Felelősség

A teljes prompt-szövegben (a `messages` egyesített tartalmában) determinisztikusan felismeri az érzékeny mintázatokat, kategóriánként megszámolva, **de a nyers értéket nem tárolva**.

### 3.2 Beépített detektorok (v1)

| Kategória | Detektor | Megjegyzés |
|---|---|---|
| `email` | RFC-szerű e-mail regex | |
| `phone_hu` | Magyar telefonszám (+36 / 06 előtag) | |
| `iban` | IBAN-formátum + checksum (mod-97) | False-positive csökkentés checksummal |
| `bank_card` | 13–19 jegyű szám + **Luhn**-ellenőrzés | A Luhn kizárja a véletlen számsorokat |
| `hu_tax_id` | Magyar adószám / adóazonosító jel formátum | |
| `hu_taj` | Magyar TAJ-szám (9 jegy + checksum) | |
| `hu_personal_id` | Személyi igazolvány szám formátum | |
| `ip_address` | IPv4 / IPv6 | Konfigurálhatóan ki/be |
| `custom` | Per-tenant konfigurálható regex-lista | Pl. ügyfél-azonosító formátum |

### 3.3 Interfész

```typescript
export type SensitivityCategory =
  | 'email' | 'phone_hu' | 'iban' | 'bank_card' | 'hu_tax_id'
  | 'hu_taj' | 'hu_personal_id' | 'ip_address' | 'custom'

export type SensitivityMatch = {
  category: SensitivityCategory
  /** A találat pozíciója a szövegben — a redaktáláshoz, NEM tárolva auditban */
  start: number
  end: number
  /** A találat hossza — auditba kerülhet (a nyers érték SOSEM) */
  length: number
}

export type ClassificationResult = {
  /** Volt-e bármilyen érzékeny találat */
  hasSensitive: boolean
  /** Kategóriánkénti darabszám (ez kerülhet auditba) */
  counts: Partial<Record<SensitivityCategory, number>>
  /** A konkrét találatok (redaktáláshoz; nyers érték nélkül a hívó dönti el, mit tárol) */
  matches: SensitivityMatch[]
}

export interface SensitivityClassifier {
  classify(text: string, customPatterns?: CustomPattern[]): ClassificationResult
}

export type CustomPattern = {
  category: 'custom'
  label: string          // pl. "customer_id"
  pattern: string        // regex forrás (szerveroldalon fordítva, timeout-tal védve)
}
```

### 3.4 Implementációs megjegyzések

- **ReDoS-védelem:** a custom regex-eket szerveroldalon, hossz- és komplexitás-korláttal fordítjuk; a futtatás time-boxed (pl. `re2`-szerű lineáris motor vagy worker-timeout). A beépített minták kézzel auditáltak.
- **A nyers érzékeny érték SOHA nem kerül logba/auditba** — csak a `category` + `count` + `length`. Ez a §4.9.2 "secret sosem a logban" elv kiterjesztése a felhasználói PII-re.
- **Determinista és gyors** — tipikus prompt-méretnél (<100KB) ms-os nagyságrend, nulla LLM-token.

---

## 4. SensitivityPolicy — a szabály

**Fájl:** `app/src/domain/gateway/sensitivity/policy.ts`

### 4.1 Policy-modell

A policy megmondja, **mely kategória érzékeny**, és **mi a teendő**, ha a prompt felhős providerhez menne.

```typescript
export type SensitivityAction =
  | 'allow'        // átengedi (a kategória nem érzékeny ebben a kontextusban)
  | 'local_only'   // lokális modellre kényszerít (ollama); ha nincs lokális → block
  | 'redact'       // helyőrzőzi az érzékeny tokeneket, majd felhőbe mehet
  | 'block'        // megállítja a hívást + audit-flag + (opc.) emberi jóváhagyás

export type SensitivityPolicy = {
  /** Globálisan érvényes-e a router (kill-switch). Default: true */
  enabled: boolean

  /** Mely providerek számítanak "felhősnek" (érzékeny adat kimegy a cégből) */
  cloudProviders: string[]   // pl. ["chatgpt-oauth", "gemini", "openrouter"]

  /** Mely provider a lokális fallback local_only esetén */
  localProvider: string       // pl. "ollama"

  /** Kategóriánkénti akció. A nem felsorolt kategória default akciója: defaultAction */
  rules: Partial<Record<SensitivityCategory, SensitivityAction>>

  /** Ha egy kategória nincs a rules-ban: ez az akció. Default: "redact" */
  defaultAction: SensitivityAction

  /** Egyéni minták (per-tenant/agent) */
  customPatterns?: CustomPattern[]

  /**
   * block esetén: a hívás megáll. Ha true, a ticket awaiting_human-ba is kerül
   * (emberi jóváhagyás után újrafuttatható). Ha false, csak hibát ad vissza.
   */
  escalateOnBlock: boolean
}
```

### 4.2 Policy-feloldás (precedencia)

A `call()` az alábbi sorrendben oldja fel az érvényes policy-t:

1. **Agent-szintű** — az `agents.model_config.sensitivityPolicy` (jsonb), ha van
2. **Globális default** — `PlatformSetting` kulcs: `sensitivity.default_policy`
3. **Kód-default** — biztonságos alapérték (lent)

**Kód-default (ha semmi nincs konfigurálva):**
```typescript
const DEFAULT_POLICY: SensitivityPolicy = {
  enabled: true,
  cloudProviders: ['chatgpt-oauth', 'gemini', 'openrouter'],
  localProvider: 'ollama',
  rules: {
    bank_card: 'block',        // bankkártyaszám sosem megy ki, és nem is redaktálható-átengedhető némán
    iban: 'local_only',
    hu_taj: 'local_only',
    hu_personal_id: 'local_only',
    hu_tax_id: 'redact',
    email: 'redact',
    phone_hu: 'redact',
    ip_address: 'allow',
  },
  defaultAction: 'redact',
  escalateOnBlock: true,
}
```

> **Tervezési elv:** a default **biztonságos oldalra dől** (fail-safe): ismeretlen érzékeny adatot inkább redaktál, bankkártyát blokkol. A célszegmens (PSP/fintech) számára ez a helyes alapállapot; lazítani admin-aktus.

---

## 5. SensitivityRouter — a döntéshozó

**Fájl:** `app/src/domain/gateway/sensitivity/router.ts`

A router köti össze a classifiert és a policy-t, és visszaad egy **routing-döntést**, amit a `ModelGateway.call()` betart.

```typescript
export type RoutingDecision =
  | { action: 'pass'; messages: GatewayMessage[] }                       // változatlanul tovább
  | { action: 'reroute_local'; messages: GatewayMessage[]; provider: string }  // lokális providerre
  | { action: 'redacted'; messages: GatewayMessage[]; redactedCounts: Partial<Record<SensitivityCategory, number>> }
  | { action: 'blocked'; category: SensitivityCategory; counts: Partial<Record<SensitivityCategory, number>> }

export class SensitivityRouter {
  constructor(private classifier: SensitivityClassifier) {}

  /**
   * Determinisztikus döntés. Nulla LLM-token.
   * @param requestedProvider az agent által kért provider neve
   */
  decide(params: {
    messages: GatewayMessage[]
    requestedProvider: string
    policy: SensitivityPolicy
  }): RoutingDecision {
    const { messages, requestedProvider, policy } = params

    if (!policy.enabled) return { action: 'pass', messages }

    // Ha a kért provider amúgy is lokális, nincs kockázat (adat nem hagyja el a céget)
    const isCloud = policy.cloudProviders.includes(requestedProvider)
    if (!isCloud) return { action: 'pass', messages }

    const text = messages.map((m) => messageText(m)).join('\n\n')
    const result = this.classifier.classify(text, policy.customPatterns)
    if (!result.hasSensitive) return { action: 'pass', messages }

    // A legszigorúbb alkalmazandó akció nyer (block > local_only > redact > allow)
    const effectiveAction = this._resolveEffectiveAction(result.counts, policy)

    switch (effectiveAction) {
      case 'allow':
        return { action: 'pass', messages }

      case 'block': {
        const category = this._firstCategoryWithAction(result.counts, policy, 'block')
        return { action: 'blocked', category, counts: result.counts }
      }

      case 'local_only': {
        // Ha nincs lokális provider beállítva → fail-safe blokk
        if (!policy.localProvider) {
          const category = this._firstCategoryWithAction(result.counts, policy, 'local_only')
          return { action: 'blocked', category, counts: result.counts }
        }
        return { action: 'reroute_local', messages, provider: policy.localProvider }
      }

      case 'redact': {
        const redacted = this._redact(messages, result.matches)
        return { action: 'redacted', messages: redacted, redactedCounts: result.counts }
      }
    }
  }

  // Akció-precedencia: block > local_only > redact > allow
  private _resolveEffectiveAction(
    counts: Partial<Record<SensitivityCategory, number>>,
    policy: SensitivityPolicy,
  ): SensitivityAction {
    const order: SensitivityAction[] = ['block', 'local_only', 'redact', 'allow']
    let strongest: SensitivityAction = 'allow'
    for (const category of Object.keys(counts) as SensitivityCategory[]) {
      const action = policy.rules[category] ?? policy.defaultAction
      if (order.indexOf(action) < order.indexOf(strongest)) {
        strongest = action
      }
    }
    return strongest
  }

  private _redact(messages: GatewayMessage[], matches: SensitivityMatch[]): GatewayMessage[] {
    // Helyőrzőzés: [REDACTED:category]. A pozíciókat csökkenő sorrendben dolgozzuk fel,
    // hogy az indexek ne csússzanak. A redakció üzenetenként történik.
    // (Implementáció: per-message offset-térkép; a matches a teljes joinolt szövegre vonatkozik,
    //  ezért a router a join-térképet is karbantartja — lásd 5.1.)
    // ...
    return messages /* helyőrzőzött másolat */
  }

  private _firstCategoryWithAction(
    counts: Partial<Record<SensitivityCategory, number>>,
    policy: SensitivityPolicy,
    action: SensitivityAction,
  ): SensitivityCategory {
    for (const category of Object.keys(counts) as SensitivityCategory[]) {
      if ((policy.rules[category] ?? policy.defaultAction) === action) return category
    }
    return 'custom'
  }
}
```

### 5.1 Redaktálás pontossága (megjegyzés)

A `classify()` a **joinolt** szövegen fut, de a redaktálás **üzenetenként** kell történjen. Két megközelítés:
- **Egyszerűbb (v1):** a router üzenetenként külön klasszifikál és redaktál — kismértékben redundáns, de pontos az offset.
- **Optimalizált:** join-offset-térkép, amely a globális találatot visszamappeli az üzenetre. A v1-ben az egyszerűbb út javasolt; a `decide()` a `messages`-en iterál.

---

## 6. Integráció a ModelGateway.call()-ba

**Fájl:** `app/src/domain/gateway/model-gateway.ts` — a `call()` metódusban, a hívás-guardrail után (jelenleg ~560. sor), a `provider.chat()` előtt (~562. sor).

```typescript
// ... a meglévő hívás-guardrail blokk után ...

// ── ÚJ: Sensitivity-aware router (§4.7.2) ──────────────────────────────────
const policy = await this._resolveSensitivityPolicy(params.agentId)
const decision = this.sensitivityRouter.decide({
  messages: params.messages,
  requestedProvider: params.modelConfig.provider,
  policy,
})

let effectiveMessages = params.messages
let effectiveProvider = provider
let effectiveProviderName = params.modelConfig.provider

if (decision.action === 'blocked') {
  await this.audit.append({
    actorType: 'agent',
    actorId: params.agentId,
    agentVersion: null,
    action: 'model.call.sensitivity_blocked',
    targetType: params.ticketId ? 'ticket' : 'conversation',
    targetId: params.ticketId ?? params.conversationId ?? params.agentId,
    modelUsed: model,
    inputRef: `category:${decision.category}`,
    outputRef: 'blocked',
    policyDecision: 'sensitivity_blocked',
    metadata: { counts: decision.counts },   // SOHA nyers érték — csak darabszám
  })
  throw new SensitivityBlockedError(
    `Sensitivity policy blocked call: category=${decision.category}`,
    { category: decision.category, counts: decision.counts, escalate: policy.escalateOnBlock },
  )
}

if (decision.action === 'reroute_local') {
  const local = this.providers.get(decision.provider)
  if (!local) {
    // fail-safe: ha a konfigurált lokális provider nincs regisztrálva → blokk
    throw new SensitivityBlockedError(
      `local_only policy but local provider '${decision.provider}' not available`,
      { category: 'custom', counts: {}, escalate: policy.escalateOnBlock },
    )
  }
  effectiveProvider = local
  effectiveProviderName = decision.provider
  await this._auditSensitivity(params, 'reroute_local', model, { toProvider: decision.provider })
}

if (decision.action === 'redacted') {
  effectiveMessages = decision.messages
  await this._auditSensitivity(params, 'redacted', model, { redactedCounts: decision.redactedCounts })
}

// ── A meglévő provider.chat() hívás, de az effective* értékekkel ───────────
const started = Date.now()
try {
  const result = await effectiveProvider.chat({
    agentId: params.agentId,
    ticketId: params.ticketId,
    messages: effectiveMessages,
    modelConfig: { ...params.modelConfig, provider: effectiveProviderName, model },
    tools: params.tools,
  })
  // ... a meglévő naplózás, de a model_calls.provider = effectiveProviderName ...
```

**Konstruktor-bővítés:**
```typescript
constructor(
  private audit: AuditRepository,
  private modelCalls: ModelCallRepository,
  private providers: Map<string, ModelProvider> = createDefaultProviders(),
  private guardrail: GatewayGuardrail = guardrailFromEnv(),
  private sensitivityRouter: SensitivityRouter = new SensitivityRouter(new DefaultSensitivityClassifier()),
  private platformSettings?: PlatformSettingsService,  // a globális default policy-hez
) {}
```

**Fontos:** a `model_calls` napló a **ténylegesen használt** providert rögzítse (`effectiveProviderName`) — ha a router lokálisra váltott, az audit és a költség-dashboard a valóságot mutatja, nem a kért providert.

---

## 7. Adatmodell-bővítés

### 7.1 Agent-szintű policy

A `agents.model_config` (jsonb) opcionálisan tartalmaz egy `sensitivityPolicy` kulcsot — nincs séma-migráció, mert a `model_config` már jsonb:

```jsonc
{
  "provider": "chatgpt-oauth",
  "model": "gpt-5.5",
  "temperature": 0.2,
  "sensitivityPolicy": {        // ← ÚJ, opcionális
    "enabled": true,
    "rules": { "iban": "block", "email": "redact" },
    "defaultAction": "redact"
  }
}
```

Az agent-szintű policy **összeolvad** a globális defaulttal (agent felülír; a hiányzó mezők a globálisból jönnek).

### 7.2 Globális default + kill-switch (`PlatformSetting`)

A PM-D kill-switch mintáját követve (`app/src/domain/platform-settings/platform-settings-service.ts`):

| Kulcs | Típus | Jelentés |
|---|---|---|
| `sensitivity.enabled` | bool | Globális router kill-switch (false → minden átmegy, csak audit-figyelmeztetéssel) |
| `sensitivity.default_policy` | jsonb | A globális default `SensitivityPolicy` |

**Bővítendő:** `PlatformSettingsService` — `getSensitivityPolicy()`, `setSensitivityPolicy()`, `isSensitivityEnabled()` metódusok (a `getMonitorControls()` minta szerint).

---

## 8. Hibaosztály + escaláció

**Fájl:** `app/src/domain/gateway/sensitivity/errors.ts`

```typescript
export class SensitivityBlockedError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      category: SensitivityCategory
      counts: Partial<Record<SensitivityCategory, number>>
      escalate: boolean
    },
  ) {
    super(message)
    this.name = 'SensitivityBlockedError'
  }
}
```

**Escaláció kezelése** (a hívási oldalon, pl. `chat-tool-loop.ts` / `agent-chat-runtime.ts` / harness-runtime):
- Ha `SensitivityBlockedError` és `escalate === true`: a ticket `awaiting_human` állapotba kerül, a payloadba bekerül a blokkolt kategória (de **nem** a nyers tartalom), és egy approver eldöntheti, hogy:
  - jóváhagyja a felhős hívást (felülírás, auditálva), vagy
  - lokálisan futtatja, vagy
  - elveti a folyamatot
- Ha `escalate === false`: a hívás hibát ad vissza, a folyamat ott megáll.

---

## 9. Audit követelmények

Minden sensitivity-döntés a hash-láncolt `audit_log`-ba kerül. **A nyers érzékeny érték SOHA nem kerül auditba** — kizárólag kategória + darabszám.

| Esemény | `action` | Mikor |
|---|---|---|
| Lokálisra terelés | `model.call.sensitivity_reroute` | `reroute_local` döntésnél |
| Redaktálás | `model.call.sensitivity_redact` | `redacted` döntésnél (redaktált kategória-számok) |
| Blokk | `model.call.sensitivity_blocked` | `blocked` döntésnél |
| Router kikapcsolva, de talált volna | `model.call.sensitivity_warn` | ha `enabled=false`, de a classifier érzékenyt talált (figyelmeztető nyom) |
| Policy módosítás | `sensitivity.policy_update` | admin policy-mentésnél |

Az audit `metadata` mezőbe: `counts` (kategóriánkénti darabszám), `fromProvider`/`toProvider` (reroute esetén), `policySource` (`agent` | `global` | `default`).

---

## 10. Admin UI

### 10.1 Navigáció

A globális policy a `/control-plane/system` oldalon (a Monitor-control-panel mellé), egy **Sensitivity Control Panel** kártyával.

### 10.2 Komponensek

| Hely | Komponens | Tartalom |
|---|---|---|
| `/control-plane/system` | `SensitivityControlPanel` | Globális kill-switch, default policy szerkesztő (kategória → akció mátrix), cloud/local provider lista |
| `/control-plane/agents/[agentId]` | `AgentSensitivityForm` | Per-agent felülírás (a meglévő model-config form mellé) |
| `SensitivityControlPanel` része | `SensitivityDryRun` | Beilleszt egy próba-szöveget, megmutatja: mit detektált (kategória + darabszám), mi lenne a döntés — **a beillesztett szöveg nem kerül auditba/logba** |

### 10.3 Policy-mátrix UI

A `rules` szerkesztő egy egyszerű táblázat: minden kategória sorához egy legördülő (`allow` / `redact` / `local_only` / `block`). A `defaultAction` külön sor. A cloud/local providerek a meglévő `MODEL_PROVIDERS` listából választhatók.

---

## 11. Implementációs fázisok

### SR-A — Classifier + Policy + Router (nem-LLM mag)

**Scope:**
- `DefaultSensitivityClassifier` az összes beépített detektorral (Luhn, IBAN mod-97, TAJ checksum)
- `SensitivityPolicy` típus + feloldási precedencia + kód-default
- `SensitivityRouter.decide()` az összes akcióval (pass / reroute_local / redact / block)
- ReDoS-védett custom pattern fordítás
- Tesztek: `sensitivity-classifier.test.ts` (minden detektor + false-positive ellenőrzés Luhn/IBAN-nal), `sensitivity-router.test.ts` (akció-precedencia, redakció-offset)

**Elfogadási kritérium:** egy bankkártyaszámot tartalmazó szöveg `block` döntést kap; egy IBAN `reroute_local`-t; egy e-mail `redact`-ot a redaktált szöveggel — minden LLM-hívás nélkül, determinisztikusan.

### SR-B — Gateway-integráció + audit

**Scope:**
- `SensitivityRouter` bekötése a `ModelGateway.call()`-ba (guardrail után)
- `SensitivityBlockedError` + a `reroute_local` valódi provider-váltás (ollama)
- `model_calls` napló a tényleges providerrel
- Audit-események (§9)
- `_resolveSensitivityPolicy()` — agent + globális + default összeolvasztás
- Tesztek: end-to-end — érzékeny prompt felhős agenttel → lokálisra terelődik, audit-log igazolja

**Elfogadási kritérium:** egy felhős (`chatgpt-oauth`) agenthez küldött IBAN-os prompt **bizonyíthatóan a lokális providerre** megy (mock provider-hívás ellenőrzi), és az audit-log rögzíti a `sensitivity_reroute`-ot; a nyers IBAN sehol nem jelenik meg a logban.

### SR-C — PlatformSetting + Admin UI

**Scope:**
- `PlatformSettingsService` sensitivity-metódusok + globális kill-switch
- `SensitivityControlPanel` a system oldalon (policy-mátrix + dry-run)
- `AgentSensitivityForm` a per-agent felülíráshoz
- `sensitivity.policy_update` audit

**Elfogadási kritérium:** admin a UI-ból módosíthatja a globális policy-t, kikapcsolhatja a routert (kill-switch), és a dry-run teszterben kipróbálhat egy szöveget anélkül, hogy az auditba kerülne.

### SR-D — Escaláció + emberi jóváhagyás

**Scope:**
- `SensitivityBlockedError` + `escalate` kezelése a harness/chat runtime-ban
- A ticket `awaiting_human` állapotba terelése blokk esetén
- Approver-felülírás (felhős hívás engedélyezése auditált felülírással)
- Seed: minta agent szigorú policyval

**Elfogadási kritérium:** egy bankkártyát tartalmazó folyamat `awaiting_human`-ba kerül; egy approver vagy elveti, vagy auditált felülírással engedélyezi — minden lépés a hash-láncolt naplóban.

---

## 12. Biztonsági és governance szempontok

### 12.1 A nyers érzékeny érték SOHA nem perzisztálódik

A classifier `matches` mezője pozíciókat tartalmaz (a redaktáláshoz), de **se a router, se az audit nem írja ki a nyers értéket** — csak `category` + `count` + `length`. Ez a §4.9.2 secret-elv kiterjesztése. A dry-run teszter beillesztett szövege szintén nem perzisztálódik.

### 12.2 Fail-safe alapértékek

- A kód-default `enabled: true` és biztonságos szabályokkal indul.
- `local_only`, de nincs lokális provider → **blokk** (nem némán átengedés).
- Ismeretlen / nem felsorolt kategória → `defaultAction` (default: `redact`), sosem néma `allow`.
- A router kill-switch (`sensitivity.enabled=false`) nem teljesen néma: a classifier ekkor is fut, és `sensitivity_warn` audit-nyomot hagy, ha érzékenyt talált — így a kikapcsolás auditálható döntés, nem vakfolt.

### 12.3 A router kemény, szerveroldali kapu

A döntés a Gateway-ben, szerveroldalon dől el — az agent nem tudja megkerülni (összhangban a §3.2.1 "kemény, szerveroldali" jelöléssel). Egy prompt injectionnel megfertőzött agent sem tudja érzékeny adatát kicsempészni felhőbe, mert a Gateway a `provider.chat()` előtt vizsgál.

### 12.4 Teljesítmény

A classifier minden modellhíváson lefut. Tipikus prompt-méretnél (<100KB) ez ms-os, elhanyagolható a hálózati LLM-latency mellett. Nagyon nagy prompt esetén (pl. teljes dokumentum) a vizsgálat hossz-korlátozott + a `re2`-szerű lineáris regex garantálja a futásidőt.

### 12.5 False-positive / false-negative kezelés

- **False-positive csökkentés:** Luhn (bankkártya) és mod-97 (IBAN) checksum kizárja a véletlen számsorokat. A TAJ-checksum hasonlóan.
- **False-negative tudatosítás:** a determinisztikus detektor nem fog el mindent (pl. szabad szövegben elrejtett, formázatlan PII). A v1 ezt vállalja; az LLM-classifier upgrade (§1.2 out of scope) erre ad választ, ha egy ügyfél igényli. A dokumentációban ezt expliciten jelezni kell — nem ad 100%-os garanciát, hanem a leggyakoribb, strukturált PII-t fogja el.

---

## 13. Nyitott döntések

| # | Kérdés | Jelenlegi javaslat |
|---|---|---|
| D-SR-1 | A lokális provider (`ollama`) éles deploymentben rendelkezésre áll-e minden tenantnál? | Ha nem, `local_only` → `redact` degradáció policy-ben konfigurálható; alapból `block` (fail-safe) |
| D-SR-2 | Redaktálás esetén a modell hasznos választ tud-e adni a kimaszkolt adattal? | Use-case-függő; a `redact` kategóriánként szabályozható, a kétséges eseteknél `local_only` ajánlott |
| D-SR-3 | Kimenő (completion) tartalom szűrése — beletartozik-e? | Külön mini-spec; ez a feature a bemenő promptra koncentrál |
| D-SR-4 | LLM-alapú classifier mikor indokolt? | Csak ha egy ügyfél a determinisztikus detektor false-negative arányát kifogásolja; opcionális upgrade |
| D-SR-5 | A custom regex-eket admin vagy csak fejlesztő veheti fel? | Admin, de ReDoS-védett fordítással + hossz/komplexitás-limit |

---

## 14. Kapcsolódó dokumentumok

- `AI-Agent-Platform-Koncepcio.md` — §3.2.1 (engedélyezés három szintje, a router mint kemény szerveroldali kapu), §4.7.1 (routing-döntés precedencia), §4.7.2 (sensitivity-aware router — a forrás), §0.7 (OWASP LLM01/LLM02), §8.6 (költségkontroll — a lokális terelés költség-hatása)
- `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` — §5.4 (Model Gateway, guardrail), §2.3 (`ModelProvider` absztrakció — a fallback cserepontja)
- `AI-Agent-Platform-Feature-Spec-Proactive-Monitor.md` — `PlatformSetting` kill-switch + control-panel minta (PM-D), amelyet ez a feature követ
- `app/src/domain/gateway/model-gateway.ts` — a `call()` integration-pont (~560. sor)
- `app/src/lib/model-providers.ts` — a meglévő provider-lista (cloud + local)
- `app/src/domain/platform-settings/platform-settings-service.ts` — a `getMonitorControls()` minta, amelyre a sensitivity-controls épül
