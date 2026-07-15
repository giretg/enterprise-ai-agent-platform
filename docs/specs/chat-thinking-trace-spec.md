# Chat "Thinking trace" megjelenítés — fejlesztői specifikáció

Státusz: **MIND KÉSZ (WP-1..WP-8)** · Verzió: v0.3 · Dátum: 2026-07-14

## Megvalósítási állapot (2026-07-14)

- **WP-1 (Gemini felderítés) — KÉSZ.** A `GeminiProvider` a `@google/genai` (v2.8)
  `generateContent`-et hívja (NEM streamel). A felderítés megerősítette: a
  `thinkingConfig.includeThoughts:true` bekérésével a válasz `candidates[].content.parts`
  között `thought:true` jelölésű text-partok jönnek vissza (thought summary), és a
  `response.text` már eleve KIZÁRJA ezeket. Így a WP-8 stream-váltás NÉLKÜL is
  megvalósítható (egy-deltás emisszió) — ld. WP-8.
- **WP-2 KÉSZ** — `chatgpt-oauth-bridge.ts`: `reasoningSummaryDelta()` felismeri a
  `response.reasoning_summary_text.delta` eseményeket; `callChatGptOAuth` mostantól
  inkrementálisan olvassa az SSE-t és él az `onReasoningDelta` callbackkel (a
  streaming variáns is). Gateway-interfész (`ModelProvider.chat/chatStream`,
  `GatewayClient.call/callStream`) átvezetve.
- **WP-3 KÉSZ** — `chat-tool-loop.ts`: `onReasoning` param, sorpufferelt tartalom-őr
  (D5) minden reasoning-deltán, körönkénti `kind:'reasoning'` összefoglaló valódi
  (redaktált) szöveggel; placeholder-fallback ahol nincs (D3).
- **WP-4 KÉSZ** — új `{ type:'thinking', turnId, delta }` SSE esemény
  (`agent-chat-runtime.ts`), mindkét ágon (tool-loop + tool nélküli `callStream`).
- **WP-5 KÉSZ** — `agent-chat-panel.tsx`: élő, streamelt "Gondolkodás" bejegyzés az
  `AgentActivityPanel`-ben (dőlt/másodlagos, lezáráskor összefoglalóra vált).
- **WP-6 KÉSZ** — tenant-szintű kapcsoló (`platform-settings-service.ts`
  `isChatThinkingTraceEnabledForTenant`, fail-closed default OFF), tenant-admin
  UI (`tenant-thinking-trace-panel.tsx` a Control Plane → System oldalon) +
  `chat-thinking-trace.ts` server-actionök.
- **WP-7 KÉSZ** — OpenRouter `reasoning.exclude` feloldása kapcsolt tenanteknél:
  az `OpenAiCompatibleProvider` `extraBody` most `({ reasoningRequested }) => …`
  kontextust kap, és a `reasoning.exclude`-ot csak akkor állítja `false`-ra, ha a
  hívó bekötötte az `onReasoningDelta`-t (azaz a tenant D7-kapcsolója engedélyezte).
  Alapból marad az `exclude:true` (költség + válaszméret). A `chat` (nem-streamelő)
  ág is felismeri a külön `message.reasoning`-et és egyetlen deltaként továbbadja.
- **WP-8 KÉSZ** — Gemini bekötés: `GeminiProvider.chat` `onReasoningDelta` esetén
  `thinkingConfig:{ includeThoughts:true, thinkingBudget:-1 }`-t kér, és az
  `extractGeminiThoughtText()` helper a `thought:true` partokból egyetlen deltaként
  emittálja a thought summary-t (a `response.text` így tiszta marad). A `callStream`
  nem-streamelő fallback-ágán (Gemini) is átvezetve az `onReasoningDelta`.
- **D5 tartalom-őr KÉSZ** — `sensitivity-router.ts` `redactSensitiveText()`
  (PAN/IBAN/kártya/titok/privát kulcs + TAJ/adószám/email maszkolás). A WP-7/WP-8
  delták ugyanezen a sorpuffer + redakciós rétegen mennek át (tool-loop + tool nélküli ág).
- **Tesztek** — `scripts/chat-thinking-trace.test.ts` (bridge-parser, content-guard,
  feature-flag, WP-7 OpenRouter exclude-toggle + delta-forward, WP-8 Gemini
  thought-part szeparálás), CI-be véve; tsc/eslint tiszta.
- **HÁTRA:** nincs — mind a 8 munkacsomag kész. Élő verifikáció: OpenRouter-hez
  valós `OPENROUTER_API_KEY` + reasoning-képes modell, Geminihez `GEMINI_API_KEY`
  + thinking-képes modell (pl. `gemini-2.5-*`) kell.

---

## Eredeti terv (v0.1)

Státusz volt: **DRAFT / kód nincs** · Verzió: v0.1 · Dátum: 2026-07-14
Scope: az interaktív **chat** (agent-chat) ág, a modell gondolkodási/reasoning
tartalmának streamelése és megjelenítése a tool call-okat mutató aktivitás-panel
mellett. A ticket/Folyamat (dispatcher) ág nem tárgya.

---

## 1. Cél

A chat ablakban jelenleg egy összecsukható "Agent aktivitás" doboz mutatja a
tool call-okat és két statikus placeholder-címkét ("Üzenet feldolgozása",
"Tool eredmények kiértékelése"). A cél, hogy ez a doboz a modell **valódi**
gondolkodási/reasoning szövegét is megjelenítse — streamelve, forduló közben —
ott, ahol a mögöttes provider ezt ténylegesen szolgáltatja.

Nem cél: Anthropic Claude Messages API bevezetése (a rendszer jelenleg nem
Claude-ot hív, ld. 2.1) — ez a spec a **meglévő providerekre** (OpenAI ChatGPT
Responses API, OpenRouter, Gemini, Ollama) épül, és jelzi, hol nem lesz
valódi thinking-tartalom.

---

## 2. Jelenlegi állapot (kódalapú diagnózis)

### 2.1 Provider-réteg — nincs Anthropic hívás, a reasoning vegyesen kezelt

- `app/src/domain/gateway/model-gateway.ts:673-698` (`createDefaultProviders`) —
  négy provider van bekötve: `ChatGptOAuthProvider` (OpenAI ChatGPT Responses
  API, OAuth), `GeminiProvider`, `ollama`, `openrouter` (utóbbi kettő
  OpenAI-kompatibilis `/v1` végponton). Nincs `anthropic`/`claude-*` import.
- `app/src/domain/gateway/chatgpt-oauth-bridge.ts:207-402`
  (`callChatGptOAuth`/`callChatGptOAuthStream`) — a hívás már küld
  `reasoning: { effort: input.reasoningEffort ?? 'low' }` paramétert
  (211-233, 288-331), **de** a stream-parser (267-270, 359-388) csak a
  `response.output_text.delta` és `response.output_item.done`/`function_call`
  eseményeket dolgozza fel. A Responses API reasoning-summary eseményeit
  (`response.reasoning_summary_text.delta` / `response.reasoning_summary.done`)
  **nem olvassa** — a provider valószínűleg küldi, a bridge eldobja.
- `app/src/domain/gateway/model-gateway.ts:694` — az OpenRouter providernél
  kifejezetten `extraBody: () => ({ reasoning: { exclude: true } })` van
  beállítva, azaz a reasoning-tartalom **aktívan ki van kapcsolva**.
- Gemini/Ollama provider-kód nem vizsgált részletesen ezen körben — a WP-1
  során tisztázandó, hogy a Gemini "thinking" (`thinkingConfig`,
  `thought: true` part) elérhető-e ezen a bridge-en.

### 2.2 Loop / activity réteg — van típus, nincs valódi tartalom

- `app/src/domain/agent/chat-tool-loop.ts:126-133` — `ToolLoopActivityEvent`
  típus már deklarál egy `kind: 'reasoning' | 'tool'` uniót.
- `chat-tool-loop.ts:1695-1713` — a `'reasoning'` kind ténylegesen emittálódik,
  de **statikus placeholder-címkékkel** ("Üzenet feldolgozása" fordulónként),
  nincs mögötte a modell tényleges gondolkodási szövege.

### 2.3 SSE réteg — nincs `thinking` event típus

- `app/src/domain/agent/agent-chat-runtime.ts:675-681` — az SSE event unió:
  `meta`, `activity` (ez hordozza a `ToolLoopActivityEvent`-et),
  `memory_candidate`, `token`, `done`, `cancelled`, `error`. Nincs külön
  `thinking`/`reasoning-delta` esemény — a reasoning ma az `activity` csatorna
  alá lenne besorolható, de streamelt delta-frissítésre ez a séma nem készült
  fel (egy `activity` egy lezárt eseményt ír le, nem token-folyamot).

### 2.4 Frontend — a doboz megvan, bővíthető

- `app/src/components/agents/agent-chat-panel.tsx:220-277` —
  `AgentActivityPanel`, natív `<details>/<summary>` alapú összecsukható panel,
  `AgentActivity[]` listát rendereli állapot-pöttyel (running/done/error) +
  cím + detail szöveggel. Az `event.type === 'activity'` SSE-ág frissíti
  (`upsertActivity`, ~1212-1219).

---

## 3. Tervezési elvek és döntések

| # | Döntés | Választás | Indok |
|---|--------|-----------|-------|
| **D1** | Melyik providerekre terjedjen ki a valódi thinking-streamelés? | **OpenAI ChatGPT Responses API** elsőként (a `reasoning.effort` már megy ki, csak a válasz-parse hiányzik); **OpenRouter** másodikként (`reasoning.exclude` visszavétele, csak azon modelleknél ahol a provider ezt szolgáltatja); **Gemini** csak ha a bridge-vizsgálat (WP-1) megerősíti a `thought` part elérhetőségét; **Ollama** kimarad (helyi modellek jellemzően nem adnak külön reasoning-csatornát) | Ne ígérjünk olyat, amit a provider ténylegesen nem ad vissza; a meglévő paraméter (`reasoning.effort`) mutatja, hogy az OpenAI-ág a legközelebb van a célhoz. |
| **D2** | Az SSE-n a reasoning **delta-streamelt** legyen, vagy csak a lezárt szöveg egy `activity`-ként? | **Delta-streamelt**, új `thinking` event típussal (`{ type:'thinking', delta:string, turnPhase? }`), lezáráskor egy összefoglaló `activity` bejegyzés a panel-történetbe | A "gondolkodás közben" élmény ehhez a funkcióhoz lényegi; a meglévő `token` esemény mintáját követi (delta-alapú), nem az `activity` egyszeri-esemény mintáját. |
| **D3** | A `ToolLoopActivityEvent.kind:'reasoning'` placeholder marad-e, vagy lecserélődik? | **Lecserélődik** valódi tartalomra ott, ahol van (D1 szerinti providereknél); ahol nincs (Gemini még nem, Ollama soha), a **jelenlegi statikus placeholder marad meg fallback-ként** — nem tüntetjük el a dobozt, csak nem állítunk valótlant | Ne törjön a UI azoknál a providereknél, ahol nincs mit mutatni; fokozatos bevezetés. |
| **D4** | Kell-e a reasoning-tartalmat **perzisztálni** (DB, `messages`/`AgentTurn`)? | **NEM** perzisztáljuk alapból — csak a folyamat alatti, kliens-oldali (React state) megjelenítésre szolgál; forduló/session végén eldobható | A reasoning-szöveg gyakran verbózus, nem végleges "termék", és a legtöbb providernél kifejezetten figyelmeztetnek, hogy ne kezeljük auditálható/stabil tartalomként. Ha később kell (pl. audit), külön döntés (Q2). |
| **D5** | Megy-e a reasoning-tartalom a **sensitivity router**/content-guard rétegen át, mielőtt a kliensre kerül? | **IGEN, kötelező** — ugyanaz a content-guard fusson rá, mint a normál asszisztens-szövegre, mielőtt SSE-n kimegy | [[sensitivity-router-incident-fix]] pontosan azt az esetet mutatta be, hogy osztályozatlan tartalom (ott: tool-eredmény) kiszivároghat külső providerhez/kliensre; a reasoning-szöveg ugyanolyan kockázatú, gyakran több nyers kontextust tartalmaz, mint a végső válasz. |
| **D6** | UI: külön doboz legyen a reasoning-nek, vagy ugyanaz az `AgentActivityPanel`? | **Ugyanaz a panel**, de a reasoning-bejegyzés vizuálisan megkülönböztetve (pl. dőlt/másodlagos szín, "Gondolkodás" címke), és **alapból összecsukva/streamelt live-region**-ként, hogy ne törje meg az olvasási folyamot | A user kérése ("a tool callokat is mutató dobozba") kifejezetten ezt kéri; nem indokolt új UI-elemet bevezetni. |
| **D7** | Legyen-e felhasználói/tenant-szintű **be- és kikapcsolhatóság**? | **IGEN** — tenant-admin szintű kapcsoló (hasonlóan a meglévő tenant-szintű beállításokhoz), alapértelmezetten **kikapcsolva**, amíg a D5 content-guard-lefedettség nincs éles-verifikálva | Óvatossági alapállás: amíg a redakció nincs bizonyítva, ne menjen ki alapból nyers reasoning-szöveg. |

---

## 4. SSE / API felület — változások

### 4.1 Új event típus

`agent-chat-runtime.ts:675-681` unió bővítése:

```ts
| { type: 'thinking'; turnId: string; delta: string }
```

- A meglévő `token` esemény mintáját követi (throttle nélkül vagy enyhe
  throttle-lal, a provider natív chunk-méretét követve).
- A stream végén (a reasoning szakasz lezárultával) egy `activity` esemény
  írja le összefoglalóként a `ToolLoopActivityEvent{kind:'reasoning', ...}`-ot
  a történeti panelhez (mint ma, de valódi szöveggel D1 szerint).

### 4.2 Bridge-szintű változás (`chatgpt-oauth-bridge.ts`)

- A stream-parserbe (267-270, 359-388 körül) új ágak: a Responses API
  reasoning-summary eseményeinek felismerése és egy `onReasoningDelta`
  callback hívása (a meglévő `onToken`/`onActivity` callback-minta mellé).
- A `model-gateway.ts` providerinterfészébe (`ModelStreamCallbacks` vagy
  ekvivalens) új opcionális callback: `onReasoningDelta?(delta: string): void`.

### 4.3 OpenRouter

- `model-gateway.ts:694` — `reasoning: { exclude: true }` → csak azoknál a
  modelleknél kapcsoljuk ki az exclude-ot (vagy állítsuk `exclude: false`-ra),
  ahol a tenant/agent konfiguráció explicit engedélyezte a thinking-trace-t
  (D7), különben marad a mai (kizáró) viselkedés — költség- és
  válaszméret-hatása van, nem alapértelmezett.

---

## 5. Loop-réteg változás (`chat-tool-loop.ts`)

- `runAgentToolLoop` a gateway `onReasoningDelta` callback-jét bekötve
  forwardolja a delta-kat a felfelé menő event-buszra (`activity`/`thinking`
  csatorna szétválasztás, ld. 4.1).
- A forduló-végi `kind:'reasoning'` `ToolLoopActivityEvent` (1695-1713) a
  felhalmozott reasoning-szöveg rövidített összefoglalójával töltődik fel a
  statikus placeholder helyett, D3 fallback-szabály szerint.
- **D5 betartása:** a delta-k és az összefoglaló egyaránt a meglévő
  content-guard/sensitivity-classifier réteg mögé kerülnek, mielőtt a runtime
  SSE-re teszi őket — ugyanaz a hívási pont, mint a végső asszisztens-szöveg
  esetén.

---

## 6. Frontend változás (`agent-chat-panel.tsx`)

### 6.1 `AgentActivityPanel` bővítés

- Új eseménykezelő ág: `event.type === 'thinking'` → egy élő,
  streamelt "Gondolkodás" bejegyzés append-elése/frissítése a panel tetején
  (a folyamatban lévő tool call fölött vagy alatt, időrendben).
- Lezáráskor (a hozzá tartozó `activity` esemény megérkezésekor) a live
  streamelt szöveg lecserélődik a végleges, összefoglaló bejegyzésre —
  elkerülve, hogy a nyers stream-chunk-ok kaotikusan halmozódjanak a
  történetben.
- Vizuális megkülönböztetés a tool-call bejegyzésektől (D6): másodlagos
  szín/dőlt betű + "Gondolkodás" címke, státusz-pötty nélkül vagy semleges
  pöttyel (nincs siker/hiba állapota).

### 6.2 Feature-kapcsoló (D7)

- A panel csak akkor rendereli a `thinking` ágat, ha a tenant/agent
  konfiguráció (`agent capabilities` / tenant settings, hasonlóan a meglévő
  `agent-capabilities-panel.tsx` mintához) engedélyezte — kikapcsolt állapotban
  a `thinking` eventek egyszerűen eldobódnak a kliensen (a szerver oldali D7
  kapcsoló az elsődleges védelem, ez csak UI-redundancia).

---

## 7. Edge case-ek

| # | Eset | Elvárt viselkedés |
|---|------|-------------------|
| E1 | Provider nem küld reasoning-et (Ollama, be nem kötött Gemini) | Nincs `thinking` event; a placeholder (D3) marad a panelen, nincs hibaüzenet. |
| E2 | Content-guard reasoning-tartalmat blokkol/redaktál | A `thinking` delta a redaktált formában megy ki (vagy egyáltalán nem, ha teljesen blokkolt) — ugyanaz a viselkedés, mint a normál asszisztens-szöveg redakciójánál. |
| E3 | Reconnect/hard-refresh streamelés közben | A `thinking` élő delta-k **nem** perzisztáltak (D4) → reconnect után a folyamatban lévő gondolkodás-szöveg elveszik, csak a lezárt `activity` összefoglaló látszik (ha időközben lezárult). Ez összhangban van a [[chat-agent-turn-resilience-spec]] jelenlegi (részleges) állapotával — nem célja ennek a specnek a teljes reconnect-garanciát megoldani. |
| E4 | Tenant kikapcsolta a funkciót (D7) | Szerver oldalon a bridge/loop szintjén sem generálódik `thinking` event (nem csak UI-szűrés) — elkerülve a felesleges providerköltséget is. |
| E5 | OpenRouter modell, ahol a `reasoning.exclude:false` ellenére sincs reasoning a válaszban | Ugyanaz, mint E1 — nincs event, placeholder marad. |

---

## 8. Munkacsomagok

**1. hullám — felderítés + OpenAI ág**
- **WP-1** Gemini bridge felderítése: van-e elérhető `thought` part; döntés,
  bekerül-e az 1. hullámba vagy külön hullámra csúszik.
- **WP-2** `chatgpt-oauth-bridge.ts` stream-parser bővítése reasoning-summary
  eseményekre + `onReasoningDelta` callback bevezetése a gateway
  interfészben.
- **WP-3** `chat-tool-loop.ts` bekötés: reasoning-delta forwardolás +
  content-guard áteresztés (D5) + a `kind:'reasoning'` összefoglaló valódi
  tartalommal.

**2. hullám — SSE + frontend**
- **WP-4** Új `thinking` SSE event típus (`agent-chat-runtime.ts`).
- **WP-5** `AgentActivityPanel` bővítés élő streamelt reasoning-bejegyzéssel +
  vizuális megkülönböztetés.
- **WP-6** Tenant/agent-szintű feature-kapcsoló (D7), alapból kikapcsolva.

**3. hullám — bővítés (opcionális)**
- **WP-7** OpenRouter `reasoning.exclude` feloldása kapcsolt tenanteknél.
- **WP-8** Gemini bekötés, ha a WP-1 felderítés indokolja.

---

## 9. Tesztelési terv

- **Bridge-parser:** rögzített Responses API stream-fixture (reasoning-summary
  eseményekkel) → `onReasoningDelta` a helyes delta-sorrendben hívódik.
- **Content-guard lefedettség:** szándékosan érzékeny tartalmú fake
  reasoning-delta → a kimenő SSE-n redaktált/blokkolt formában jelenik meg
  (E2) — ez a legkritikusabb teszt-eset D5 miatt.
- **Feature-kapcsoló:** kikapcsolt tenant → nincs `thinking` event a
  streamben, még ha a provider küldött is reasoning-et (E4).
- **Frontend:** `thinking` delta-k helyes append/összevonás a lezáró
  `activity`-vel; placeholder-fallback providernél (E1).

---

## 10. Nyitott kérdések

- **Q1 (D1):** Van-e üzleti/product igény a Gemini és/vagy Ollama ágra is,
  vagy elég az OpenAI (+opcionális OpenRouter) lefedettség első körben?
- **Q2 (D4):** Kell-e valaha auditálhatóvá/perzisztálhatóvá tenni a
  reasoning-szöveget (pl. compliance, hibakeresés célra), és ha igen,
  milyen retenciós/redakciós szabállyal? Ez érintené az
  [[access-policy-governed-actions-spec]]-ben leírt érzékeny-válasz
  minimalizálási elveket is.
- **Q3 (D7):** A feature-kapcsoló tenant-szintű legyen, vagy finomabb
  (agent-szintű, [[agent-connector-cross-tenant-autoattach-fix]] mintájára
  board/agent opt-in)?
- **Q4:** Van-e providerköltség-hatása (több tokent számláz-e a
  `reasoning.effort`/`exclude:false` bekapcsolása), és ez hogyan viszonyul a
  [[dispatch-budget-tenant-scope-build]]-ban bevezetett napi model-keret
  méréshez — a reasoning-tokenek beleszámítanak-e a tenant büdzsébe?
