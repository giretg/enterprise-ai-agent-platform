# Feature-spec — Code Mode: tool-eredmény feldolgozása a kódfuttató sandboxban (és a scriptből hívott tool-híd)

**Verzió:** 1.0
**Dátum:** 2026-09-16
**Státusz:** v1 fejlesztésre kész · v2 (híd) feltételhez kötve (§D6)
**GitHub issue:** [#470](https://github.com/giretg/enterprise-ai-agent-platform/issues/470)
**Kapcsolódik:** #485 (`sandbox_exec`, PR #499 merged), #469 (nagy tool-eredmény offload, D1 trust-envelope), #396 (skill-katalógus Fázis 2, P2-D10 „1 sandbox 2 bejárat"), #97 (trust-envelope), #220 (írási bizalom), #59–#67 (HITL / awaiting_human), #468 (halasztott tool-betöltés)
**Referencia:** TrueForge Code Mode (`mcp_client.call_tool(server, tool, body)` a sandbox-scriptből, a harness hívja a toolt a tárolt credentialekkel)

## 0. Vezetői döntés

**Az ötlet jó — de két, nagyon eltérő súlyú részből áll, és az issue egybe írja őket.**

**A. „Aggregálás scriptben, nem prózában"** — ez a valódi fájdalom (hallucinált számok, kontextus-felfúvódás). **Ehhez NEM kell híd.** A kód-alapvonal (§2) szerint a lánc ma már majdnem összeér:

- egy lista-tool eredménye 12 000 karakter fölött a futás workspace-ébe kerül (`.tool-results/<turn>-<tool>-<callId>.json` + látható másolat `tool-outputs/…`) — #469;
- a `sandbox_exec` `inputs` bármely workspace-relatív fájlt beolvas `/work/in/` alá (`fileEditor.readRawFile` → ugyanaz a `storage.read`) — #485;
- a script `stdout`-ja méret-kapuval (256 KB) megy vissza a modellnek.

Tehát **„lista-tool → archívum → `sandbox_exec inputs=['tool-outputs/…json'] script=…` → stdout"** ma is lefuttatható. Ami hiányzik: a modell **nem tudja**, hogy ezt teheti (nincs rá prompt-útmutatás), a kis (<12k) eredmény nem kerül fájlba, és a sandbox kimenete **`trusted` bizalmi osztályt** kap akkor is, ha külső adatot printel vissza (mosás a #97 burkolat alól). **Ez a v1: három kis változás, új bizalmi határ nélkül.** A #469 spec ezt előre jelezte: *„Amikor lesz sandbox, a `.tool-results/` fájl ott is olvasható — nem kell külön híd."*

**B. Scriptből visszahívott tool (a tényleges Code Mode híd)** — csak ott ad többletet, ahol a script **több lépcsős** hívást csinálna (N elem → N részlet-lekérés, feltételes lekérés, hurok). Ára viszont nem kicsi:

| Akadály | Tény a kódban |
|---|---|
| A sandbox **hálózat nélküli** (`--allow-egress` bináris kapcsoló, `defaultAllowEgress: z.literal(false)`), és a P2-D10 döntés kimondja: *„a végrehajtó réteg mindkét bejárata hálózat nélküli; a hálózat felé a brokerelt út az egyetlen kijárat."* | `code-sandbox-types.ts`, `cloud-run-runner.ts` (`buildSandboxRunArgs`), `skill-catalog-phase2-spec.md` P2-D10 |
| A sandbox-futás **egyetlen szinkron HTTP-kérés** (max 900 s); egy közbeni emberi jóváhagyást (`awaiting_human`) nem lehet napokig felfüggesztett gVisor-konténerrel megvárni. | `http-sandbox-provider.ts` `/v1/execute`, `AbortSignal.timeout` |
| A **következmény-kapu a chat-tool-loopban él, nem a brokerben.** A meglévő gépi út (`POST /api/v1/agent/tools`, agent API-kulcs) ma **kapu nélkül** ér el kapuzott eszközt (`file_delete`, `google_drive_share_file`, `repo_open_pull_request`, `memory_propose`; a `gmail_send`-nek saját broker-szintű ellenőrzése van). Egy híd, ami erre az útra ül, örökli a rést. | `chat-tool-loop.ts:3080` (`requiresConsequenceApproval` egyetlen hívója), `app/api/v1/agent/tools/route.ts`, `tool-broker-service.ts` (`recordConsequenceGateBlock` — csak rögzít) |

**Döntés:**

1. **v1 = Code Mode Lite (WP-1..3), most.** Prompt-útmutatás + kis eredmény kérésre fájlba + sandbox-kimenet bizalmi öröklés. Az issue első elfogadási feltétele („státuszonkénti pontos számok egy script-hívással") ezzel teljesül; a második („write-tool scriptből jóváhagyás nélkül → blokk + audit") v1-ben **konstrukcióból** teljesül: a scriptnek nincs tool-hívási útja.
2. **v2 = híd (WP-5..7), feltételhez kötve (§D6):** csak **olvasó** (nem mellékhatásos) toolok, **fájl-alapú RPC** a runneren át (a sandbox marad hálózat nélküli), efemer kulccsal, amit a sandbox **sosem lát**. Mellékhatásos tool scriptből → azonnali elutasítás + audit-sor (`code_mode_side_effecting_tool`), nincs felfüggesztés. Írás továbbra is agent-szintű tool-hívás, ahol a következmény-kártya a tartalmat is mutatja (#411).
3. **Előfeltétel a v2-höz, de a v2-től függetlenül is javítandó (WP-4):** a következmény-kapu **chokepointja** a brokerbe (vagy a gépi útra) — a `/api/v1/agent/tools` ma megkerüli. Külön issue-t érdemel; ez a spec csak hivatkozik rá.

**Mit NEM veszünk át a TrueForge-ból és miért:**

| TrueForge | Nálunk | Indok |
|---|---|---|
| `mcp_client.call_tool` bármely (író) toolra, approval-policy scriptből | v2: csak olvasó toolok | Szinkron sandbox nem várhat emberre; az író tool agent-szinten marad, ahol a kártya, a single-use jóváhagyás (#193) és a tartalom-megjelenítés (#411) már megvan. |
| Sandbox hálózati visszahívás a harnessbe | Fájl-RPC a runner bind-mountján | P2-D10 (hálózat nélküli sandbox) érvényben marad; nincs új egress-kijárat, a kill-switch és a napi keret nem kerülhető meg. |
| MCP-szerver-névvel címzett tool | Platform-tool-név (`ToolName`), ugyanaz a `buildToolInvokeInput` regiszter | Egy leképezés van (#194); a híd nem hozhat be másodikat. |
| „csak `print` kerül a kontextusba" | Már így van (`stdout` 256 KB kapu, `tool-output-privacy` sandbox-ág) | Nincs teendő. |

## 1. Cél és scope

### 1.1 In scope — v1 (Code Mode Lite)

- D1 prompt-útmutatás: számolás/csoportosítás/összesítés → sandbox, nem próza.
- D2 kis tool-eredmény kérésre is fájlba (`saveAs`), hogy a scriptnek legyen bemenete anélkül, hogy a modell a JSON-t a scriptbe másolná.
- D3 a `sandbox_exec` eredményének bizalmi osztálya a bemeneteiből öröklődik (mosás-tiltás).
- Elfogadási tesztek (§6 T1–T4).

### 1.2 In scope — v2 (híd), csak §D6 feltétel teljesülésekor

- D5 fájl-RPC híd: `platform_tools.call(tool, args)` Python-kliens a sandboxban; a runner továbbít a `/api/v1/agent/tools` felé; efemer kulcs olvasó hatókörrel.
- D7 keretek: hívásszám / összidő scriptenként, méret-kapuk a válaszon.
- Elfogadási tesztek (§6 T5–T8).

### 1.3 Out of scope

- Író/mellékhatásos tool scriptből (bármely fázisban). Ha később kell: külön spec, aszinkron „script folytatása jóváhagyás után" modellel (checkpoint + újrafuttatás), nem felfüggesztéssel.
- Sandbox egress a platformon kívülre (marad `allowEgress` + következmény-kapu, #485).
- Ticket-/wiki-runtime híd: a v2 a chat-loop `sandbox_exec` hívásaira épül; a harness-konténeres futás (dispatcher efemer kulcs) már ma is gépi úton hív toolt.
- Új nyelv a sandboxban (Python marad, `/work/run.py`).

### 1.4 Biztonsági határ egy mondatban

A script **soha nem kap credentialt és soha nem lát hálózatot**; minden tool-hívás (v2) a runneren és a Tool Brokeren megy át ugyanazzal a grant-, tenant-, privacy- és audit-réteggel, mint az agent saját hívása, **plusz** egy olvasó-hatókör-kapuval; a sandbox kimenete a modell felé a **bemenetei legalacsonyabb bizalmi osztályát** viszi.

## 2. Mai állapot (kódból)

| Réteg | Fájl | Tény |
|---|---|---|
| Sandbox tool | `tool-registry.ts:1445` `sandbox_exec` | `command[]`, `script` (→ `/work/run.py`), `inputs[]` (→ `/work/in/`), `outputs[]` (← `/work/out/`), `timeoutMs`, `allowEgress`. `trust: 'trusted'`, `sideEffecting: true`, `surfaces: CHAT_ONLY`. |
| Végrehajtás | `code-sandbox-service.ts` | inputs `fileEditor.readRawFile(tenantId, scopeKey, {path})`; méret-kapuk (`codeSandboxLimits`: 32 fájl, 5 MB/fájl, 20 MB összes, stdout/stderr 256 KB); outputs atomikus visszaírás. Per-scope keret: `maxCallsPerScope` (10), `maxExecSecPerScope` (300) — `tool-broker-service.ts:163`. |
| Provider | `http-sandbox-provider.ts` | Egy `/v1/execute` POST = teljes sandbox-életciklus; fájlok base64-ben a kérésben; auth: connector secret vagy Cloud Run identity token. |
| Runner | `cloud-run-runner.ts` | `sandbox run --mount /work/in (ro) --mount /work/out (rw) [--mount run.py (ro)] [--allow-egress]`, majd `sandbox exec … -- <command>`; `collectSandboxOutputs` az egész `/work/out`-ot bejárja (symlink/hardlink tiltás). |
| Archívum | `chat-tool-loop.ts:3329`, `tool-result-archive.ts`, `tool-result-extract.ts:287` | `rawContent.length > 12_000` → `.tool-results/NN-<tool>-<callId>.json` + `tool-outputs/<ugyanaz>.json`. Ugyanaz a `workspaceStorage`, mint a sandbox-bemeneté. Kisebb eredmény csak a kontextusban él. |
| Kimenet-privacy | `tool-output-privacy.ts:72` | `sandbox_exec` modell-kimenete `{exitCode, stdout, stderr, outputs}`-ra szűkül; a connector privacy-mezők szerinti tokenizálás a többi toolnál fut. |
| Bizalom | `tool-trust-registry.ts` | `resolveTrustClass(tool)` determinisztikus, args-független. `file_read`, `sandbox_exec` → `trusted`; `http_api_*`, `gmail_*`, `web_*`, `run_*` → `external_untrusted`. **Egy `tool-outputs/…http_api_get_all…json` bemenetből printelt tartalom `trusted`-ként ér a modellhez.** |
| Következmény-kapu | `consequence-gate-policy.ts`, `chat-tool-loop.ts:3080` | Risk-class alapú; `sandbox_exec` csak `allowEgress:true` esetén kapuzott. **Egyetlen hívó a chat-loop.** |
| Gépi tool-út | `app/api/v1/agent/tools/route.ts` | Agent API-kulcs (`tool:invoke` scope) → kontextus-tulajdon ellenőrzés (`isAgentApiToolContextOwnedByAgent`) → tenant-kapu → `toolBroker.invoke` → `machineData`. **Nincs következmény-kapu.** |
| Efemer kulcs | `agent-repository.ts:581` `issueEphemeralKey(agentId, {ttlMs})` | Szerep szerinti scope-ok (`ticket:read, ticket:create, tool:invoke`), TTL, dispatcher adja a harnessnek, completion/reclaim visszavonja. |
| Prompt | `chat-tool-loop.ts:225–228` | HTTP API: „aggregált/report végpont + period paramok, ne dumpold a listát". Sandbox-aggregálásról **egy szó sincs.** |

## 3. Megoldás

### D1 — Prompt-útmutatás: számolás a sandboxban (v1)

Egyetlen új sor a chat-loop rendszer-útmutatójában (a `- HTTP API …` sor mellé), **csak ha az agentnek van `sandbox_exec` joga** (a meglévő capability-szűrés szerint):

> - Számolás, csoportosítás, összesítés, top-N, eltérés-keresés listán: NE fejben és NE prózában. Ha az eredmény fájlban van (`tool-outputs/…json` vagy más workspace JSON/CSV), futtasd `sandbox_exec`-kel: `inputs` = a fájl, `script` = rövid Python, ami `/work/in/<fájl>`-ból olvas és CSAK a kész számokat printeli. Ha a lista-eredmény nem került fájlba, kérd újra `saveAs` paraméterrel. A választ a stdout számaiból írd — ne becsülj.

Indok: a modell ma nem tudja, hogy az archívum a sandbox bemenete lehet. Nincs kód-változás a broker/sandbox oldalán.

### D2 — Kis eredmény is fájlba kérésre: `saveAs` (v1)

A 12 000 karakteres küszöb alatt a tool-eredmény csak a kontextusban él; a script-bemenethez a modellnek a JSON-t a `script`-be kellene másolnia (számhiba-forrás, dupla token). Ezért:

- Minden broker-tool `toInvokeInput`-ja **átengedi** az opcionális `saveAs: string` argumentumot (workspace-relatív, `isSafeWorkspaceRelativePath`). A chat-loop az eredmény-ágon (`chat-tool-loop.ts` ~3329, az archiválás mellett) ha `saveAs` van: a **nyers** eredményt (`rawContent`) a `params.writeWorkspaceFile(saveAs, rawContent, 'internal')` írja, és a modell-kimenet végére kerül egy sor: `Mentve: <path> (<bytes> bájt)`.
- Nem tool-args: a broker felé **nem** megy át (a loop leszedi, mielőtt `invokeInput` készül) — így a descriptor-sémákat nem kell módosítani, egy helyen történik (a loop `tool_result_extract`/`archive` ágának szomszédja).
- Ha az eredmény 12k fölötti, az archívum úgyis készül; `saveAs` ilyenkor a `tool-outputs/` másolat neve helyett a kért nevet adja (egy fájl, nem kettő).
- Méret-kapu: ugyanaz, mint az archívumé (a `writeWorkspaceFile` meglévő kapuja). Felülírás: a `tool-outputs/`-hoz hasonlóan megengedett, `internal` láthatóság (#262 audience-kapu érvényes).

`ponytail:` a `saveAs` a loopban egy generikus mellék-argumentum; ha később több ilyen „post-processing" opció kell (pl. `extractFields`), akkor érdemes egy `ToolCallOptions` mezőt bevezetni — most nem.

### D3 — A sandbox kimenetének bizalmi öröklése (v1, biztonsági)

`sandbox_exec` statikus `trust: 'trusted'` helyett a **futás-szintű** trust a bemenetekből:

```
trust(sandbox_exec) = min( 'trusted',
                           trust(input_i) minden input_i-re )
trust(input) =
  '.tool-results/NN-<tool>-…' | 'tool-outputs/NN-<tool>-…'  → resolveTrustClass(<tool>)   // #469 D1 névfeloldás
  'saveAs' útvonal (D2)                                      → az eredeti hívás trust-osztálya (a loop `archivedToolResults` / új `savedToolResults` térképe)
  egyéb workspace-fájl                                        → 'internal'   // felhasználói feltöltés, korábbi script-kimenet
  ismeretlen forrás                                           → 'external_untrusted'  // fail-safe
```

Rendezés: `trusted` > `internal` > `external_untrusted`. Az eredményt a loop a `sandbox_exec` **eredmény-ágán** számolja és a `buildToolOutcomeChannels`-nek adja át trust-ként — így a `<<<EXTERNAL_UNTRUSTED_DATA>>>` burkolat (#97) egy külső adatot visszaprintelő scriptre ugyanúgy rákerül, mint az eredeti tool-eredményre. **Ez a #469 D1 sandbox-ági párja**; a névfeloldó helper közös.

Nem változik: a `tool-trust-registry` statikus térképe (a regiszter továbbra is `trusted`-et mond — ez az „alsó korlát nélküli felső korlát"); a `resolveTrustClass` args-független elve sértetlen, mert a leszállítás nem az agent által adott argumentumból, hanem a **fájl provenienciájából** jön.

### D4 — Következmény-kapu chokepoint a gépi úton (v2 előfeltétel; önálló issue)

A `/api/v1/agent/tools` ma kapuzott eszközt kapu nélkül enged. Két lehetséges zárás; a kisebbik:

- **A route elutasít** minden `requiresConsequenceApproval(tool, args, connectors).required === true` hívást `403 consequence_gate_required` + `recordConsequenceGateBlock` audit-sorral. Gépi úton nincs, aki a kártyát megnyomja — a harnessnek az agent-szintű útra kell váltania. (`http_api_request` esetén a connector-katalógust a meglévő `httpApiGateConnectors` építővel kell betölteni — ez a chat-loopból kiemelendő helper.)
- Alternatíva (nagyobb): kapu a `ToolBrokerService.invoke`-ban, kártya-létrehozó callbackkel. Nem javasolt most: a chat-loop kártya-folyama (dedup, single-use, awaiting_human) ide nem ültethető át kis diffel.

Ez a rés **ma is fennáll**, Code Mode nélkül; a v2 híd csak láthatóbbá teszi. Külön issue-ként nyitandó, a spec nem függ tőle v1-ben.

### D5 — A híd: fájl-RPC a runneren át, olvasó-hatókörű efemer kulccsal (v2)

**Csatorna.** A runner a `sandbox run`-hoz egy harmadik bind-mountot ad: `/work/rpc` (rw, saját tmp-alkönyvtár, **nem** az `out` alatt — a `collectSandboxOutputs` nem járja be). Protokoll:

```
script  →  /work/rpc/<seq>.req.json   { "tool": "<ToolName>", "args": {...} }      (seq: 1, 2, …, atomikusan: tmp + rename)
runner  ←  fs.watch(rpcDir) / 50 ms poll; olvas, töröl, továbbít
runner  →  /work/rpc/<seq>.res.json   { "ok": true, "data": <machineData>, "trust": "...", "outcome": "..." }
                                     | { "ok": false, "error": "<reason>" }
script  ←  polls for <seq>.res.json (max hívás-timeout), olvas, töröl
```

`ponytail:` fájl-poll 50 ms felbontással, soros hívások; ha a hívásonkénti ~50–100 ms késleltetés méréssel gond, a felfelé út a runner unix-socketje bind-mounttal (`--host-uds`-függő, nem bizonyított a `gcp sandbox` CLI-n).

**Kliens.** A runner a `/work/in/platform_tools.py`-t **mindig** mellékeli (nem a modell írja): ~30 sor, `call(tool: str, args: dict) -> Any`, hibánál `PlatformToolError(reason)`. A rendszer-útmutató (D1 bővítése) ezt nevezi meg.

**Kulcs.** A `sandbox_exec` handler (`sandbox-exec.handler.ts`) v2-ben:

1. `agents.issueEphemeralKey(agentId, { ttlMs: timeoutMs + 30_000, scopes: ['tool:invoke:read_only'] })` — új opcionális `scopes` paraméter; a meglévő hívó (dispatcher) változatlan.
2. A kulcsot és a hívás-kontextust (`agentId`, `conversationId|ticketId`, `bridgeUrl` = a platform `/api/v1/agent/tools`) a `/v1/execute` kérés `bridge` mezőjében adja a **runnernek** (Cloud Run IAM / shared token mögött). A sandbox soha nem kapja meg: a runner memóriában tartja, a kérés végén eldobja.
3. `finally`: `agents.revokeKey(id)` — akkor is, ha a sandbox timeoutolt (a TTL a hálózati hiba elleni második védelem).

**Route-kapu.** `/api/v1/agent/tools`: ha a kulcs scope-ja `tool:invoke:read_only` (és nem `tool:invoke`), akkor `isSideEffectingTool(tool) === true` → `403` + `recordDenied(…, 'code_mode_side_effecting_tool')`. Ez **a broker `authorize` ELŐTT** fut (a fail-safe `isSideEffectingTool` ismeretlen toolra `true`). Ezzel a „write-tool scriptből jóváhagyás nélkül → blokk + audit-sor" elfogadás v2-ben is teljesül, és a D4-től függetlenül: olvasó tool sosem kapuzott (`ALWAYS_CONSEQUENCE_GATED_TOOLS` ⊂ side-effecting; `http_api_request` side-effecting; `sandbox_exec` maga side-effecting → **a script nem indíthat sandboxot**, nincs rekurzió).

**Kontextus.** A híd-hívás `conversationId|ticketId`-je a **sandbox-futásé** (runner tölti ki, nem a script) → `isAgentApiToolContextOwnedByAgent` és a tenant-kapu változatlanul fut; a `ToolCall` audit-sor `actingUserSource: 'code_mode_bridge'` értéket kap, hogy a Run Analyst / audit el tudja különíteni az agent saját hívásától.

**Privacy.** A route `machineData`-t ad (nyers, a privacy-tokenizálás a modell-csatornára szól). A sandbox EU-régiós, hálózat nélküli, hívásonként eldobott — a nyers adat itt ugyanúgy „platformon belül" van, mint a workspace-fájlban. A modell felé a script **stdout**-ja megy, amire D3 szerint a bemeneti tool-ok legalacsonyabb trust-osztálya és a meglévő sandbox privacy-ág vonatkozik; **D3 v2-kiegészítés:** a runner a válaszban visszaadja a hívott toolok listáját (`bridgeCalls: [{tool, trust, ok}]`), és a loop a trust-minimumba ezeket is beszámítja.

### D6 — Mikor épüljön meg a v2 (feltétel)

A híd akkor kerül a backlogra, ha a Run Analyst (`run_stats`) egy 30 napos ablakban kimutatja, hogy a futások ≥ 5%-ában **ugyanaz az olvasó tool ≥ 8-szor** hívódik egymás után egy fordulón belül (N+1 minta), **vagy** ha egy konkrét ügyfél-playbook explicit hurkot igényel (pl. „minden nyitott ügyfélhez kérd le a legutóbbi 3 interakciót"). Addig a v1 Lite + `http_api_get_all` (szerveroldali lapozás) fedi az ismert igényeket.

### D7 — Keretek a hídon (v2)

| Keret | Érték | Hol |
|---|---|---|
| Híd-hívás / script | connector-config `maxBridgeCallsPerExec`, default 50, max 500 | runner számol, túllépés → `{ok:false, error:'bridge_call_limit'}`, a további hívások is ezt kapják |
| Válasz-méret / hívás | a route meglévő 200 000 bájtos backstopja | route |
| Hívás-timeout | 30 s / hívás, a script teljes `timeoutMs`-én belül | runner `AbortSignal.timeout` |
| Per-scope sandbox keret | változatlan (`maxCallsPerScope`, `maxExecSecPerScope`) | broker |
| Per-tool napi keretek (web_search, http_api) | változatlan — a broker ugyanúgy számolja, mert ugyanaz az `invoke` | broker |

### D8 — Kölcsönhatások (változatlan rétegek)

- **Kontextus-tömörítés / archívum (#469):** a `saveAs` fájl `internal`, a hidratálás felveszi; a `tool_result_read`/`tool_result_extract` továbbra is olvassa.
- **Halasztott tool-betöltés (#468):** `sandbox_exec` marad a `preload` szabályai szerint; a híd nem hoz új tool-nevet a modell felé (a `platform_tools.call` Python-oldali, nem tool-definíció).
- **Trust-envelope (#97):** D3 zárja a mosást; a burkolat maga változatlan.
- **Következmény-kapu:** `sandbox_exec` `allowEgress:true` marad kapuzott; a híd **nem** egress (fájl-RPC), ezért nem nyit kaput — ez szándékos, a v2 csak olvasó toolt enged.
- **Skill-katalógus P2-D10:** a sandbox hálózat nélküli marad; a híd a „brokerelt út mint egyetlen kijárat" elvét **erősíti** (minden hívás a brokeren megy).

## 4. Példa-forduló

### 4.1 v1 Lite — „Hány nyitott ticket van státuszonként a CRM-ben?"

```
1. http_api_get_all  { path: "/tickets", query: { state: "open" }, saveAs: "tickets-open.json" }
   → modell: „412 rekord · Mentve: tickets-open.json (188 231 bájt)"   (12k fölött: archívum is)
2. sandbox_exec {
     command: ["python3", "/work/run.py"],
     inputs: ["tickets-open.json"],
     script: "import json,collections\nrows=json.load(open('/work/in/tickets-open.json'))\nc=collections.Counter(r['status'] for r in rows)\nprint(json.dumps(c, ensure_ascii=False))"
   }
   → stdout: {"new": 131, "in_progress": 204, "waiting_customer": 77}
   → trust: external_untrusted (a bemenet http_api_get_all-ból jött) → <<<EXTERNAL_UNTRUSTED_DATA>>> burkolat
3. Válasz: pontos számok a stdout-ból.
```

Két tool-hívás, a 188 KB lista sosem kerül a kontextusba.

### 4.2 v2 híd — „Minden nyitott ügyfélhez az utolsó 3 interakció"

```
sandbox_exec { command: ["python3","/work/run.py"], script: """
from platform_tools import call
custs = call("http_api_get_all", {"path": "/customers", "query": {"status": "open"}})
out = {}
for c in custs[:200]:
    out[c["id"]] = call("http_api_get", {"path": f"/customers/{c['id']}/interactions", "query": {"limit": 3}})
print(json.dumps({"customers": len(out), "with_interactions": sum(1 for v in out.values() if v)}))
""" }
```

201 broker-hívás, mind auditált (`actingUserSource: code_mode_bridge`), egy `sandbox_exec` audit-sor alá csoportosítva; a modell csak a záró sort látja. Ha a script `call("gmail_send", …)`-et próbál: `{ok:false, error:"code_mode_side_effecting_tool"}` + `tool.call.denied` audit-sor.

## 5. Munkacsomagok

| WP | Fázis | Tartalom | Érintett fájlok | Becslés |
|---|---|---|---|---|
| WP-1 | v1 | D1 prompt-sor (capability-feltételes) | `chat-tool-loop.ts` (rendszer-útmutató blokk) | XS |
| WP-2 | v1 | D2 `saveAs` a loop eredmény-ágán; loop leszedi az args-ból; `savedToolResults` térkép (path → trust) | `chat-tool-loop.ts` (~3329 környéke), `tool-result-archive.ts` (közös írás) | S |
| WP-3 | v1 | D3 trust-öröklés: `resolveInputTrust(path)` helper (közös a #469 D1 névfeloldóval), `sandbox_exec` eredmény-ágon a `buildToolOutcomeChannels` trust-paramétere | `tool-result-extract.ts` v. új `tool-result-provenance.ts`, `chat-tool-loop.ts` | S |
| WP-4 | előfeltétel | D4 gépi út következmény-kapu — **külön issue** | `app/api/v1/agent/tools/route.ts` | S |
| WP-5 | v2 | D5 runner: `/work/rpc` mount, watcher, forwarder, `platform_tools.py` mellékelés, `bridge` kérés-mező | `cloud-run-runner.ts`, `http-sandbox-provider.ts`, sandbox-image | M |
| WP-6 | v2 | D5 handler: efemer kulcs `scopes` opció, kiadás/visszavonás; route `read_only` scope-kapu + `code_mode_side_effecting_tool` audit | `sandbox-exec.handler.ts`, `agent-repository.ts`, `agent-api-key.ts`, `route.ts` | S |
| WP-7 | v2 | D7 keretek + D3 v2 (`bridgeCalls` trust-beszámítás) + connector-UI mező (`maxBridgeCallsPerExec`, közérthető felirat) | `code-sandbox-types.ts`, runner, connector-form | S |

v1 összesen: ~150 sor + tesztek. v2: ~400 sor (runner ~150, Python-kliens ~30, handler/route ~80, tesztek).

## 6. Elfogadás és tesztek

| # | Fázis | Teszt | Elvárás |
|---|---|---|---|
| T1 | v1 | `agent-tool-loop.test.ts`: lista-tool `saveAs:'x.json'` → `writeWorkspaceFile('x.json', rawContent, 'internal')` hívódik; a broker `invokeInput.args`-ban **nincs** `saveAs` | zöld |
| T2 | v1 | `sandbox_exec inputs:['tool-outputs/03-http_api_get_all-abc.json']` → az eredmény trust `external_untrusted`, a modell-szöveg burkolt | zöld |
| T3 | v1 | `sandbox_exec inputs:['feltoltes.csv']` (nem tool-eredmény) → trust `internal`; inputs nélkül → `trusted` | zöld |
| T4 | v1 | Prompt-eval (#35 harness): „hány nyitott ticket státuszonként" szcenárió — a modell `sandbox_exec`-et hív a `saveAs` fájlra, nem prózában számol; a válasz számai = a stdout számai | ≥ 4/5 futásból |
| T5 | v2 | Runner-teszt: script `call("kb_search", …)` → runner `POST /api/v1/agent/tools` Bearer = efemer kulcs; a sandbox `env`-jében és `/work/*` alatt a kulcs **nem** fordul elő | zöld |
| T6 | v2 | **Gate-teszt (issue elfogadás):** script `call("file_delete", …)` és `call("gmail_send", …)` → `{ok:false, error:"code_mode_side_effecting_tool"}`, `tool.call.denied` audit-sor `reason` mezővel, a broker `authorize` **nem** hívódott | zöld |
| T7 | v2 | Script `call("sandbox_exec", …)` → elutasítás (rekurzió-tiltás); 51. hívás → `bridge_call_limit` | zöld |
| T8 | v2 | Handler: sandbox-timeout (exit 124) után az efemer kulcs `revoked`; DB-ben nem marad aktív kulcs | zöld |
| T9 | v2 | `code-sandbox.test.ts`: `collectSandboxOutputs` nem gyűjti a `/work/rpc` tartalmát; `.req.json` symlink → hiba | zöld |

## 7. Kockázatok

| Kockázat | Hatás | Kezelés |
|---|---|---|
| A modell a `saveAs` helyett továbbra is a scriptbe másolja a JSON-t | számhiba, dupla token | D1 explicit tiltja; T4 prompt-eval méri; ha nem elég: a `script` méret-kapuja (pl. 16 KB) — ma 5 MB |
| D3 trust-leszállítás miatt több burkolat → a modell „óvatosabb", ritkábban cselekszik a script-eredményből | UX | Elvárt viselkedés: külső adat marad külső adat. A burkolat csak jelöl, nem tilt. |
| v2 fájl-RPC: verseny a runner watcher és a script között (félig írt fájl) | hibás JSON | tmp + `rename` atomikus írás mindkét oldalon; a watcher csak `.req.json` teljes névre reagál |
| v2 efemer kulcs kiszivárgása a runnerből (log, crash-dump) | tool-hívás az agent nevében, csak olvasó, TTL-lel | kulcs sosem logolható (runner `redact`), TTL = timeout + 30 s, `finally` revoke; olvasó scope → nincs mellékhatás |
| v2 híd megkerüli a chat-loop per-forduló keretét (`perTurnBudget`, loop-guard #180) | 200 hívás egy „tool-hívás" alatt | D7 saját keret (50) + per-tool napi keretek a brokerben változatlanul számolnak |
| v2 a P2-D10 szellemével ütközik-e? | governance | Nem: a sandbox marad hálózat nélküli; a híd a brokerelt utat használja, épp az elv szerint |

## 8. Nyitott kérdések

1. **D2 fájlnév-ütközés:** ha a modell ugyanazt a `saveAs`-t adja két hívásnak, felülír (mint `tool-outputs/`). Kell-e `saveAs` + `NN-` prefix automatikusan? Javaslat: nem — a modell választotta a nevet, a felülírás az elvárt.
2. **D3 a `file_read`-re is?** A `file_read` egy `tool-outputs/…http_api…json`-ra ma `trusted`. Ugyanez a mosás, sandbox nélkül. A #469 D1 hatókörébe tartozik; itt csak jelezzük.
3. **v2 UDS a fájl-poll helyett:** a `gcp sandbox` CLI támogatja-e a unix-socket bind-mountot? Mérés után döntendő; a fájl-RPC a biztos alap.
4. **v2 ticket-runtime:** a `general-task-runtime` `sandbox_exec` hívásai ugyanezt a hidat kapják-e, vagy csak a chat? Javaslat: ugyanaz a handler → automatikusan igen, de a T5–T8 tesztek a chat-útra íródnak.
5. **D6 mérés:** a `run_stats`-ban van-e ma „egymás utáni azonos tool-hívások száma" metrika, vagy ezt a Run Analyst spec (#343) alá kell felvenni?
