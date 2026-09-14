# Feature-spec — Halasztott tool-betöltés: tool-index + `tool_describe` a teljes séma-lista helyett

**Verzió:** 1.0
**Dátum:** 2026-09-14
**Státusz:** fejlesztésre kész
**GitHub issue:** [#468](https://github.com/giretg/enterprise-ai-agent-platform/issues/468)
**Kapcsolódik:** #395 (MCP-connector), Prompt-Cache-Prefix-Ordering spec, skill-catalog-spec §D7 (`load_skill`), #97 (trust-envelope), #469 (nagy tool-eredmény offload)
**Referencia-implementáció:** TrueForge `packages/trueforge-core/src/core/runtime/DeferredTool.ts`, `core/mcp/ToolSelectorPolicy.ts`, `core/mcp/convertMCPServers.ts`, `docs/key-features/deferred-tool-loading.mdx`

## 0. Vezetői döntés

**A probléma:** ma minden grantolt tool teljes JSON-sémája minden modellhívásban a `tools[]`-ben utazik. A regiszter 74 toolja együtt **59 200 karakter (~17 000 token)**; egy „mindent tud" agent 10–15 ezer tokennyi sémát fizet fordulónként, amiből egy tipikus forduló 1–3 toolt használ. Ehhez jön az `http_api` connectorok végpont-katalógusa (connectoronként 10–40 sor szöveg a system-promptban). A prompt-cache prefix-rendezés ezt olcsóbbá tette, de (a) nem minden provider cache-el, (b) a `tools[]` mérete a modell tool-választási pontosságát is rontja, (c) a Level-2 skill-melléklet tool és a skill-hatókör-szűkítés fordulón belül változtatja a `tools[]`-t, ami a teljes prefixet érvényteleníti.

**A javaslat:** a TrueForge „deferred tool loading" mintája, a platform meglévő **progresszív skill-betöltés** (`load_skill`, Level-0 index → Level-1 instrukció) mintájára ráhúzva. A modell alapból egy **tömör tool-indexet** lát (név + egysoros leírás, csoportosítva), és egyetlen meta-toollal, a **`tool_describe`**-bal kéri le a teljes sémát annak az 1–3 toolnak, amire a feladathoz szüksége van. A leírt tool a forduló hátralévő részére bekerül a `tools[]`-be, a hívás pedig a **változatlan** úton (saját néven, Tool Broker `invoke`, következmény-kapu, trust-envelope, audit) megy.

**Mit NEM veszünk át a TrueForge-ból és miért:**

| TrueForge | Nálunk | Indok |
|---|---|---|
| `call_tool(server, tool, input)` meta-tool — a hívás egy burkolón át megy, a harness `toolCallInfo(…, is_deferred)`-del csomagolja ki a jóváhagyáshoz | **Nincs burkoló.** A modell a leírt toolt a saját nevén hívja | A következmény-kapu, a Gmail-send jóváhagyás-kötés (#414), a http_api gate és az audit mind tool-névre és nyers args-ra épül. Egy burkoló minden kapu-utat érintene — pont az a réteg, ahol a code-review memóriák szerint a vakfoltok születnek. Nulla kapu-változás = az elfogadási feltétel triviálisan teljesül. |
| `list_tools(server)` külön meta-tool | **Nincs.** Az index mindig a stabil prefixben van | A regiszter korlátos (74 tool, index ≈ 1,2–1,5k token). A `list_tools` MCP-szervereknél kell, ahol 100+ tool lehet; ez a #395 MCP-connectornál kerül elő (lásd §7). |
| `get_tool_output_schema` (Code Mode-hoz) | **Nincs** | Kimeneti sémát nem publikálunk a modellnek; a #470 Code Mode külön dönt. |
| `preload` connector-szinten + `preload_tools: [...]` szelektív lista `@read-only` tag-szelektorokkal | `preload` **regiszter-default** toolonként (D1); connector-szinten egy bit (D6); grant-szintű felülírás Fázis 2 (D9) | A szelektor-nyelv (`@all`, `@read-only`) YAGNI: nálunk a tool-halmaz statikus és csoportosított. |
| Az agent-instrukcióba beírt lista a halasztott szerverekről („MUST use list_tools…") | Ugyanez, de az index maga a lista (D2) | Átvéve. |

## 1. Cél és scope

### 1.1 In scope — v1

- `ToolDescriptor.preload` mező a kanonikus regiszterben, csoportonkénti default (D1).
- Level-0 **tool-index** a stabil prefixben, az eddigi „A számodra engedélyezett eszközök: …" sor helyett (D2).
- **`tool_describe(names[])`** infrastruktúra-tool a chat-tool-loopban, a `load_skill` mintájára (D3).
- Aktivált toolok halmaza fordulón belül + fordulók közt a beszélgetés `ToolCall`-történetéből származtatva (D4).
- Le nem írt, de grantolt tool közvetlen hívása **nem** kerül elutasításra (D5).
- `http_api` connector végpont-katalógus halasztása connectoronként (D6).
- Mérőszkript + elfogadási teszt (§6).

### 1.2 Out of scope — v1

- Grant-szintű (`Capability.preload`) felülírás és a hozzá tartozó admin-UI — **Fázis 2** (D9).
- Az MCP-bridge (`surfaces: ['mcp']`) felület: a külső harness (Claude Code, stb.) saját deferred-loadingot csinál; ott a teljes `tools/list` marad.
- `TOOL_INSTRUCTION` rövidítése (az több tool nevét említi; az index mellett ez konzisztens, de a szöveg-diéta külön feladat).
- `tool_search` szabadszöveges keresés (D7 — akkor, ha az index >150 tool vagy a #395 MCP-import >50 toolt hoz).
- Kimeneti séma publikálása (#470).

### 1.3 Biztonsági határ egy mondatban

A halasztás **kizárólag azt változtatja, mit lát a modell a promptban**; hogy mit hívhat, azt továbbra is a capability-grant (`listAllowedChatTools`), a skill-hatókör és a Tool Broker dönti. Egy tool „nem leírt" állapota **nem** jogosultsági állapot.

## 2. Mai állapot (mért)

`app/src/domain/tool-broker/tool-registry.ts` — 74 descriptor, `toolJsonSchema()` a Zod-alakból. Séma-méret (karakter, `name+description+parameters` JSON):

| Csoport | Toolok | Karakter | Legnagyobb |
|---|---|---|---|
| Futás-elemzés | 3 | 7 586 | `run_index` 3 051 |
| Excel (XLSX) | 6 | 6 706 | `xlsx_write_cells` 1 843 |
| Google Drive | 16 | 6 135 | `google_drive_share_file` 588 |
| Fájlkezelés (Workspace) | 10 | 5 730 | `reconcile_records` 1 842 |
| Ingatlan-nyilvántartás | 2 | 5 322 | `tulajdoni_lap_egyeztetes` 3 308 |
| Dokumentumok | 6 | 4 302 | `docx_create` 1 491 |
| Mini-app | 6 | 4 156 | `sandbox_app.create` 1 300 |
| HTTP API | 3 | 4 086 | `http_api_get_all` 1 710 |
| Agent együttműködés | 6 | 3 536 | `ticket_create` 835 |
| Projektmemória | 1 | 2 327 | `memory_propose` |
| Email (Gmail) | 5 | 2 157 | |
| többi (Sandbox, KB, PPTX, Web, Privacy) | 10 | 7 158 | |
| **Összesen** | **74** | **59 201 (~17k token)** | |

Ehhez jön a `loadHttpApiConnectorsForGate()` által a system-promptba tett connector-katalógus: 3 fix bekezdés + connectoronként fejléc + végpontonként egy sor (paraméterlistával). Egy 5 connectoros, 8–15 végpontos agentnél ez 3–6k karakter.

A mai prompt-szerkezet (`chat-tool-loop.ts`): `buildTools()` → `toToolDefinitions(inScope)` a teljes engedélyezett listára; a `tools[]` fordulón belül **újraépül**, ha `load_skill` hatókört szűkít vagy a melléklet-tool megjelenik.

## 3. Megoldás

### D1 — `preload` a regiszterben, csoport-default

`ToolDescriptor` új, kötelező mezője: `readonly preload: boolean`. A drift-teszt (`scripts/tool-registry-drift.test.ts`) nem enged descriptor-t nélküle. Defaultok:

| `preload: true` (mag) | `preload: false` (halasztott) |
|---|---|
| Fájlkezelés: `file_read`, `file_write`, `file_edit`, `file_list`, `file_glob`, `file_search`, `file_delete` | Fájlkezelés: `reconcile_records`, `repo_prepare`, `repo_open_pull_request` |
| Projektmemória: `memory_propose` | Excel, PowerPoint, Dokumentumok (`*_create`; a `*_read` toolok is), Mini-app, Sandbox |
| Agent együttműködés: `ticket_create`, `agent_ask`, `user_directory`, `agent_catalog`, `agent_resolve` | Google Drive (mind a 16), Gmail (mind az 5) |
| Tudásbázis: `kb_search`, `kb_get_page`, `kb_list_index` | HTTP API (3), Webes kutatás (2), Ingatlan (2), Futás-elemzés (3), Privacy |
| Webes kutatás: `web_search` | |

Elv: **ami minden agentnél, szinte minden fordulóban kellhet, és kicsi** → előtöltve (~7k karakter összesen). Ami egy szakterület vagy egy nagy séma → halasztott. `web_search` azért mag, mert a `TOOL_INSTRUCTION` „ELŐSZÖR a web_search-t hívd" szabálya csak akkor működik, ha a séma kéznél van.

A `requiredSystemRole`-os toolok (Run-analyst) halasztottak: a rendszer-szerep amúgy is skill-szerű, célzott feladatot kap.

### D2 — Level-0 tool-index a stabil prefixben

A `loopStablePreamble` mai „A számodra engedélyezett eszközök: a, b, c" üzenetét egy **index-blokk** váltja, ami ugyanabban a pozícióban marad (Prompt-Cache spec §sorrend 6. pont), determinisztikus (csoport-sorrend `TOOL_GROUP_ORDER`, azon belül név szerint), és **nem** tartalmaz per-request adatot:

```
Eszközeid. A [betöltött] jelűek sémája már nálad van, hívd őket közvetlenül.
A többinél ELŐBB hívd a tool_describe eszközt (több nevet is megadhatsz egyszerre),
megkapod a pontos paraméter-sémát — utána a saját nevén hívd.

Fájlkezelés (Workspace)
- file_read [betöltött] — Munkaterület-fájl beolvasása…
- reconcile_records — Két rekordlista párosítása kulcsmezők alapján…
Excel (XLSX)
- xlsx_write_cells — Cellák írása értékkel és stílussal…
…
Külső REST API-k (http_api_get / http_api_get_all / http_api_request)
- Pipedrive CRM (connectorId: 3f1c…) — olvasás + írás — 14 végpont — „Ügyfelek, ajánlatok…"
```

Az egysoros leírás a descriptor `description` mezőjének **első mondata**, max 120 karakter (a TrueForge `MAX_DESCRIPTION_LENGTH = 200` mintája). Ahol az első mondat nem informatív, a descriptor kap egy opcionális `summary` mezőt — a drift-teszt csak azt ellenőrzi, hogy létezik egysoros alak.

Az index-blokk mérete a teljes regiszterre ≈ 5–6k karakter (~1,5k token) — a mai 59k helyett. Grantolt részhalmazra arányosan kevesebb.

### D3 — `tool_describe` infrastruktúra-tool

A `load_skill` / `tool_result_read` mintájára (nem capability, nem a broker-regiszterben, a loop külön ágon kezeli — `chat-tool-loop.ts` ~2379. sor mintája):

```ts
const TOOL_DESCRIBE_DEFINITION: ToolDefinition = {
  name: 'tool_describe',
  description: 'Egy vagy több, az eszköz-indexben látott eszköz teljes paraméter-sémájának lekérése. Csak akkor hívd, ha az eszközt tényleg használni akarod; a betöltött eszközöknél felesleges. A leírt eszközt utána a saját nevén hívd.',
  inputSchema: objectSchema({ names: { type: 'array', items: STR }, connectorId: STR }, []),
}
```

Viselkedés:
- `names[]`: minden név (wire-alak elfogadva, `fromWireToolName`) → ha grantolt és chat-felületen van: a válasz `{name, description, parameters}`; ha nem grantolt: `{name, error: 'nem elérhető'}` — **nem** árulja el a sémát. Ismeretlen név → hiba-sor. Egy hívásban max 8 név.
- Mellékhatás: a sikeresen leírt toolok bekerülnek az **aktivált** halmazba → `tools = buildTools()` újraépül (D4).
- A válasz nem archiválódik (`archiveLargeToolResult` kihagyja, mint a `load_skill`-t): a séma pontosan azért kell, hogy a kontextusban maradjon.
- Activity-esemény: `kind: 'tool', title: 'tool_describe', detail: names.join(', ')` — a felhasználó a thinking-trace-ben látja, hogy „eszközt keres", nem azt, hogy tétlen.
- Audit: nem `ToolCall` rekord (nincs mellékhatás, nincs külső hívás), mint a `load_skill`-nél.
- A loop **kör-limitjébe** (`maxToolCalls`) nem számít bele: a discovery ne egye meg a skill runtime-hint keretét. Zsákutca-számlálóba sem (nem ismételt eredmény).

### D4 — Aktivált halmaz: fordulón belül + történetből származtatva

```
aktivált(forduló eleje) =
    { grantolt ∧ preload }                                   // D1
  ∪ skillToolScope / initialSkillToolScope                   // betöltött skill allowed-tools-a
  ∪ { t ∈ grantolt : t szerepel a beszélgetés korábbi ToolCall-jaiban }   // priorToolCalls
```

- **Nincs új tárolás.** A chat-runtime már betölti a `priorToolCalls`-t (`listToolCallsForConversation`) — a loop `params.priorToolNames: readonly string[]` bemenetet kap. Ha a hívó nem adja (task-mód, agent API), az üres halmaz — ilyenkor legfeljebb +1 `tool_describe` hívás.
- A `tool_describe` **maga nem** ToolCall-rekord, ezért egy leírt-de-nem-hívott tool a következő fordulóban újra leírandó. Szándékos: olcsó, és nem hoz be új állapotot. Ha mérés szerint zavar, a következő lépcső egy `Conversation.activatedTools: string[]` mező — de csak mérés után.
- `buildTools()` = `toToolDefinitions(inScope ∩ aktivált)` + infra-toolok (`tool_result_*`, `load_skill*`, `tool_describe`). **Rendezett** (név szerint), így két azonos állapotú hívás bájt-azonos `tools[]`-t ad.
- Skill betöltésekor (`load_skill` → `requiredTools`) a hatókör toolja **automatikusan aktiválódik**: a skill-instrukció úgyis névre hivatkozik, a discovery-kör felesleges lenne.

Cache-hatás: a `tools[]` **csak aktiváláskor** változik (fordulónként tipikusan 0–1×). A `tool_describe` eredménye a history-ban / tool-tailben él, ott a prefix-cache szempontjából olcsó. Ez jobb a mainál, ahol a melléklet-tool megjelenése / hatókör-szűkítés ugyanígy rebuildel, de minden fordulóban a teljes sémalistával.

### D5 — Le nem írt tool közvetlen hívása: engedett, és aktivál

A loop elutasítási ága (`!isChatPlatformTool || !allowedTools.includes`) **nem változik**: ha a modell egy grantolt, de még nem aktivált toolt hív (pl. a szöveges `{"tool":…}` fallback vagy egy provider, amely nem tiltja a nem-deklarált nevet), a hívás **lefut** a broker megengedő `toInvokeInput` + Zod-útján, és a tool aktiválódik a forduló hátralévő részére. Hibás args esetén a tool saját hibaüzenete elé a loop egy sort tesz: `Tipp: a pontos sémáért hívd a tool_describe eszközt.` Gate, audit, trust-envelope: érintetlen. Ez az elfogadási feltétel („audit/gate változatlan") garanciája — a jogosultság-döntés nem függ a láthatóságtól.

### D6 — `http_api` connector-katalógus halasztása

`loadHttpApiConnectorsForGate()` két kimenetet ad: a `gateConnectors` (szerver-oldali kapu — **változatlanul mindig betöltve**), és a `spec` prompt-szöveg. A `spec` kettéválik:

- **Index-sor** (stabil prefix, D2 utolsó szakasza): connector neve, `connectorId`, hozzáférés (`csak olvasás` / `olvasás + írás` + írás-bizalom), leírás első mondata, végpontszám. A 3 általános http_api-bekezdés (relatív path, fejléc-szabály, hatékonysági útmutató) az index-fejlécbe kerül **egyszer**.
- **Teljes blokk** (a mai `### <connector>` + `Endpointok:` szakasz) → a `tool_describe({ connectorId })` válasza. A `tool_describe` egy hívásban `names[]`-t ÉS `connectorId`-t is elfogad, hogy „xlsx_write_cells + Pipedrive" egy discovery-körben elférjen.
- Connector-szintű `preload`: `AgentConnector`-on **nem** vezetünk be új mezőt v1-ben; a szabály fix: **≤3 végpontú connector blokkja inline marad** az index-sor alatt (nincs mit takarítani), a többi halasztott. `ponytail:` fix küszöb; ha valamelyik tenantnál a 4–6 végpontos connectorok discovery-köre zavar, a küszöb Fázis 2-ben grant-szintű bit lesz (D9).
- A `httpApiGateConnectors` és az `endpoint_not_allowed` allowlist-ellenőrzés semmit nem tud a halasztásról.

### D7 — Nincs `tool_search` (YAGNI)

Az index ~1,5k token a teljes regiszterre; a modell egy pillantással választ. Szabadszöveges keresés akkor kell, ha az index maga válik drágává: regiszter >150 tool, vagy a #395 MCP-connector egyetlen szerverről >50 toolt importál. Akkor a #395 `mcp_list_tools` és ez a spec egy `tool_search(query, connectorId?)` toolban egyesül — az index ilyenkor connector-szintre húzódik vissza (név + leírás + toolszám), pont, mint a TrueForge szerver-listája.

### D8 — Determinizmus és cache-szabályok

- Index-blokk: csoport-sorrend `TOOL_GROUP_ORDER`, azon belül `toolName asc`; connector-sorok `connector.name asc`, majd `id`. Nincs időbélyeg, nincs számláló.
- `tools[]`: `aktivált` név szerint rendezve; az infra-toolok fix sorrendben a végén.
- A `tool_describe` válasza `JSON.stringify` stabil kulcssorrenddel (a `toolJsonSchema` már determinisztikus).
- A Prompt-Cache spec prefix-stabilitási tesztje bővül egy esettel: két hívás, azonos grant, eltérő `priorToolNames` → **az index-blokk azonos**, csak a `tools[]` tér el.

### D9 — Fázis 2: grant-szintű felülírás + UI (NFR)

`Capability.preload Boolean?` (null = regiszter-default). Az eszközjog-szerkesztőben csoportonként/toolonként egy „Előtöltés" kapcsoló, a Közérthető-UI NFR szerint:
- magyarázó doboz a szekció tetején: *„Az előtöltött eszközök leírása mindig a munkatárs előtt van (gyorsabb, de drágább). A többit a munkatárs szükség esetén kéri le — ez 1 plusz lépés, de olcsóbb és pontosabb."*
- üres-állapot: *„Nincs egyedi beállítás — az alapértelmezés érvényes: mag-eszközök előtöltve, szak-eszközök kérésre."*
- **effektív-előnézet:** „Ennek a munkatársnak a promptja most ≈ N token eszköz-leírást tartalmaz (előtte: M)." — a `scripts/tool-prompt-size.ts` (§6) számítása UI-ban.
- badge: `alap` / `kézi`.

Csak akkor épül, ha a v1 mérés után egy konkrét agentnél a discovery-kör mérhetően zavar (pl. Excel-specialista agent, aki minden fordulóban `xlsx_*`-t hív).

### D10 — Kölcsönhatás a meglévő rétegekkel

| Réteg | Hatás |
|---|---|
| Következmény-kapu, trust-envelope (#97), Gmail-send kötés (#414), http_api gate | **Nincs.** Tool-név + args változatlan. |
| Skill-hatókör (`skillToolScope`) | Metszet: `inScope ∩ aktivált`; a skill `requiredTools`-a automatikusan aktivál. |
| Prompt-cache prefix-sorrend | Index az eddigi 6. pozícióban; `tools[]` ritkábban változik. |
| Nagy tool-eredmény archiválás | `tool_describe` kivétel (mint `load_skill`). |
| Zsákutca-/kör-limit | `tool_describe` nem számít. |
| Kontextus-tömörítés / checkpoint (`ToolLoopCheckpoint`) | A checkpoint az aktivált halmazt is menti (`activatedTools: string[]`), hogy „folytasd" után ne kelljen újra describe-olni. |
| Agent API / task-mód | `priorToolNames` opcionális; nélküle csak a preload-halmaz aktív. |
| MCP-bridge | Érintetlen (teljes lista). |
| Prompt-eval harness (#35) | Az eval-esetek `expectedToolCalls`-a a discovery-hívást **nem** számolja (infra-tool). |

## 4. Példa-forduló

Agent: 5 connector (Pipedrive, Fakturoid, GitHub, belső HR-API, Slack-webhook), teljes Excel + Drive + Gmail grant. Kérés: *„Készíts Excel-t a Pipedrive nyitott ajánlatairól, cégenként összesítve."*

| Ma | Spec szerint |
|---|---|
| tools[]: 34 tool, ≈ 26k karakter; connector-katalógus ≈ 5k karakter | tools[]: 15 mag-tool + `tool_describe`, ≈ 7k karakter; index ≈ 3,5k karakter |
| 1. `http_api_get_all(Pipedrive, /deals?status=open)` | 1. `tool_describe({ names: ['http_api_get_all','xlsx_create','xlsx_write_cells'], connectorId: pipedrive })` |
| 2. `xlsx_create` | 2. `http_api_get_all(…)` |
| 3. `xlsx_write_cells` | 3. `xlsx_create` |
| | 4. `xlsx_write_cells` |
| Prompt-költség/kör: ≈ 31k karakter sémára+katalógusra | ≈ 10,5k + a describe-válasz (≈ 5k) egyszer a tailben |

+1 hívás, ≈ 60% kevesebb statikus séma-szöveg körönként. A következő fordulóban (`priorToolNames` = {http_api_get_all, xlsx_create, xlsx_write_cells}) a három tool már aktivált, discovery nélkül.

## 5. Munkacsomagok

| WP | Tartalom | Fájlok | Méret |
|---|---|---|---|
| WP-1 | `ToolDescriptor.preload` + opcionális `summary`; defaultok D1 szerint; `toolIndexLine(name)` helper; drift-teszt bővítés | `tool-registry.ts`, `tool-registry-drift.test.ts` | S |
| WP-2 | Index-blokk builder (D2, D8), `tool_describe` tool + loop-ág (D3), aktivált halmaz + `priorToolNames` param + checkpoint mező (D4), D5 tipp-sor | `chat-tool-loop.ts`, `agent-chat-runtime.ts` (priorToolNames átadás), loop-tesztek | M |
| WP-3 | Connector-katalógus kettéválasztása index-sor / teljes blokk; `tool_describe({connectorId})`; ≤3 végpont inline | `chat-tool-loop.ts` (`loadHttpApiConnectorsForGate`) | S |
| WP-4 | `scripts/tool-prompt-size.ts`: agentId → grantolt toolok, séma-karakter ma vs. spec szerint; elfogadási teszt (§6) | `scripts/`, `chat-tool-loop` teszt | S |
| WP-5 (Fázis 2, mérés után) | `Capability.preload`, eszközjog-UI kapcsoló + effektív-előnézet (D9) | prisma, capability-szerkesztő | M |

WP-1..4 egy PR-ban elfér; feature-flag **nincs** — a D5 fail-open miatt a legrosszabb eset egy plusz hibaüzenet, nem elutasítás. Ha mégis vissza kell lépni: `preload: true` minden descriptorra = a mai viselkedés (az index-blokk ekkor „mind [betöltött]").

## 6. Elfogadás és tesztek

1. **Méret:** a `tool-prompt-size.ts` a §4 profilú (5 connector, Excel+Drive+Gmail) agentre ≥50% csökkenést mutat a `tools[]` + connector-katalógus karakterszámában. *(Számított: ≈ 66%.)*
2. **Funkció:** a §4 feladat fake-provider teszttel ugyanannyi broker-hívással lefut, +1 `tool_describe`. A `ToolCall` rekordok (név, args, kapu-döntés) bájt-azonosak a mai úttal.
3. **Gate változatlan:** a következmény-kapu, http_api gate, Gmail-send tesztek zölden — kód nem változik ezekben a modulokban (`git diff --stat` a PR-ban ezt mutatja).
4. **Nem grantolt tool describe-ja** → `nem elérhető`, a séma nem szivárog; nem grantolt tool hívása → a mai `ELUTASÍTVA` üzenet.
5. **D5:** nem aktivált, grantolt tool közvetlen hívása lefut és aktivál; a következő körben a `tools[]`-ben van.
6. **D4:** `priorToolNames` alapján aktivált tool discovery nélkül hívható; skill-betöltés a `requiredTools`-t aktiválja.
7. **Determinizmus:** azonos grant + eltérő `priorToolNames` → azonos index-blokk; azonos aktivált halmaz → bájt-azonos `tools[]`.
8. **Checkpoint:** „folytasd" után az aktivált halmaz visszaáll.
9. **Drift:** descriptor `preload` nélkül vagy egysoros leírás nélkül → drift-teszt piros.

## 7. Kockázatok

| Kockázat | Kezelés |
|---|---|
| Gyenge modell nem hívja a `tool_describe`-ot, hanem találgat | D5: a hívás lefut, a tool saját hibája + tipp-sor; az index-fejléc instrukciója explicit. Mérés: a prompt-eval harness (#35) egy „discovery" esetet kap. |
| A modell minden fordulóban újra describe-ol, mert az előző forduló csak leírt, nem hívott | Olcsó (+1 kör); ha a mérés zavart mutat → `Conversation.activatedTools` (D4 megjegyzés). |
| `TOOL_INSTRUCTION` olyan toolt említ névvel, amit a modell nem lát sémával | Az index minden grantolt nevet felsorol; a `TOOL_INSTRUCTION`-ben említett mag-toolok (`gmail_search`, `web_search`, `document_read`) — `gmail_search` és `document_read` **kivétel a D1-ből: preload true**, mert az instrukció „ELŐSZÖR ezt hívd" szabályt ad rájuk. |
| `tools[]` változás aktiváláskor → cache-miss | Fordulónként ≤1×, a mai rebuild-esetek részhalmaza; a describe-válasz a tailben cache-barát. |
| #395 MCP-connector 50+ toolja az indexet felfújja | D7 lépcső: `tool_search` + connector-szintű index. Előre nem építjük. |

## 8. Nyitott kérdések

1. A `*_read` toolok (`docx_read`, `pdf_read`, `xlsx_read_sheet`, `google_drive_read_file`) legyenek-e mag-toolok? Kicsik (200–420 karakter), és „olvasd el a csatolt fájlt" jellegű kérés gyakori. **Javaslat:** igen, preload — összesen ≈ 1,3k karakter, cserébe a leggyakoribb olvasó-kérés discovery nélkül megy. Döntés WP-1-ben.
2. A `tool_describe` válasza tartalmazza-e a `description` teljes szövegét, vagy csak a sémát? **Javaslat:** teljeset — a hosszú descriptor-leírások (xlsx stílus-szabályok, http_api fejléc-szabályok) pont a hívás előtt kellenek.
