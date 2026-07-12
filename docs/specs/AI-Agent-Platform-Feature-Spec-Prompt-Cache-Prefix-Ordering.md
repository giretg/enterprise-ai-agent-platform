# AI Agent Platform — Feature Spec: Prompt-cache prefix-sorrend (stabil előre, változó hátra)

## Problem Statement

A platform minden modellhívása a Model Gatewayen keresztül megy, több provider felé (ChatGPT OAuth, Gemini, Ollama, OpenRouter). Ezek a providerek **automatikus prompt caching**-et kínálnak: a prompt közös **prefixét** töredék áron számolják fel, ha egy következő hívás bájt-azonos prefixszel kezdődik. A platform jelenleg semmilyen módon nem használja ki ezt — a `cache_control` sehol nem szerepel, de ami fontosabb: a promptot úgy állítjuk össze, hogy a **per-forduló változó** blokkok (Project memory context, kb_search találatok, munkaterület-fájllista) a **stabil, agent-szintű** blokkok (agent system prompt, org-roster, statikus instrukciók, `TOOL_INSTRUCTION`, http_api connector-katalógus, skill-index, repo-instrukció) **elé** ékelődnek.

Mivel a caching prefix-egyezésen alapul, az első változó bájt levágja a cache-t onnantól — így a nagy, soha nem változó statikus blokkok **minden fordulón és minden beszélgetésben újra teljes áron** mennek. A felhasználó (a platformot üzemeltető szervezet) ezt fölösleges token-költségként és magasabb válaszlátenciaként érzékeli, pedig a tartalom nagy része hívásról hívásra azonos.

## Solution

A providerhez kimenő `GatewayMessage[]` üzenetsorrendjét úgy rendezzük át, hogy egy **megszakítás nélküli stabil prefix** álljon elöl (minden agent-szintű, hívások közt azonos tartalom), és a per-forduló változó adat a prefix **után**, a beszélgetés-előzmény és a tool-loop tail elé kerüljön. Ezzel a providerek automatikus caching-je a teljes stabil prefixet — beleértve a nagy tool-sémákat, a `TOOL_INSTRUCTION`-t és a connector-katalógust — cache-elni tudja, mind egy beszélgetés fordulói közt, mind ugyanazon agent különböző beszélgetései közt.

A változtatás **tisztán sorrendi**: ugyanaz a tartalom, más elrendezésben. A modell viselkedése nem változik (a „memória/KB = adat, nem utasítás" elhatárolás és a válasz-instrukciók megmaradnak), és nem kell provider-specifikus caching-API (pl. `cache_control`) — az automatikus prefix-cache magától él, amint a prefix stabil.

A megoldás magja egy **közös, tiszta prompt-összeállító függvény** (a továbbiakban: *prompt assembler*), amelyet a chat-runtime, a task-runtime és a tool-loop egyaránt használ. Az assembler a bemeneti darabokból (agent, org-roster, memória-blokk, KB-találatok, munkaterület-fájllista, előzmény, loop-szintű statikus blokkok) determinisztikus, szegmentált sorrendet állít elő.

## User Stories

1. Platform-üzemeltetőként azt szeretném, hogy az azonos agenthez tartozó ismételt modellhívások a stabil rendszer-prompt-részt a providernél cache-eljék, hogy csökkenjen a token-költségem.
2. Platform-üzemeltetőként azt szeretném, hogy a nagy tool-séma- és connector-katalógus-blokkok ne fizetődjenek újra minden fordulóban, hogy a tool-nehéz agentek olcsóbban fussanak.
3. Platform-üzemeltetőként azt szeretném, hogy egy több-fordulós beszélgetés második, harmadik stb. fordulója az előző fordulók stabil prefixét cache-ből olvassa, hogy csökkenjen a válasz-latencia.
4. Platform-üzemeltetőként azt szeretném, hogy ugyanazon agent különböző beszélgetései megosszák a stabil agent-szintű prefixet a provider cache-ében, hogy fleet-szinten spóroljak.
5. Agent-fejlesztőként azt szeretném, hogy a Project memory context blokk a prompt végén, a stabil rész után helyezkedjen el, hogy a memória-visszakeresés természetes változékonysága ne rontsa el a stabil prefix cache-elhetőségét.
6. Agent-fejlesztőként azt szeretném, hogy a kb_search találatok a stabil rész után kerüljenek be, hogy a query-függő keresési eredmény ne invalidálja a fölötte lévő statikus instrukciókat.
7. Agent-fejlesztőként azt szeretném, hogy a munkaterület-fájllista a változó zónába kerüljön, hogy egy új fájl megjelenése ne törölje a teljes cache-t.
8. Agent-fejlesztőként azt szeretném, hogy a `TOOL_INSTRUCTION`, a modeNote, az engedélyezett-toolok üzenet, az agent-UUID üzenet, a skill-index, a http_api connector-katalógus és a repo-instrukció a stabil prefixben, az előzmény ELŐTT legyenek, hogy fordulók közt is cache-elődjenek.
9. Chat-felhasználóként azt szeretném, hogy a válaszok a caching miatt gyorsabban induljanak, anélkül hogy a válasz tartalma vagy minősége változna.
10. Task-futtatóként (aszinkron ticket) azt szeretném, hogy a task-runtime ugyanazt a stabil-előre sorrendet használja, mint a chat, hogy a folyamat-agentek is olcsóbban fussanak.
11. Platform-fejlesztőként azt szeretném, hogy egyetlen, közös prompt-összeállító függvény adja a sorrendet mindkét runtime-ban és a tool-loopban, hogy ne legyen két helyen szétcsúszó logika.
12. Platform-fejlesztőként azt szeretném, hogy a prompt assembler tiszta (I/O-mentes) függvény legyen, hogy a sorrend DB és gateway nélkül unit-tesztelhető legyen.
13. Platform-fejlesztőként azt szeretném, hogy a stabil prefix determinisztikus legyen (rendezett roster, rendezett tool-lista, nincs időbélyeg/UUID a stabil zónában), hogy két azonos-kontextusú hívás bájt-azonos prefixet adjon.
14. Platform-fejlesztőként azt szeretném, hogy az átrendezés ne változtassa meg a modellnek adott instrukciók jelentését, hogy ne legyen viselkedés-regresszió.
15. Platform-fejlesztőként azt szeretném, hogy a memória usage/capture-policy és a KB válasz-instrukció statikus szövegrésze a stabil zónában maradjon, míg a tényleges adat (memória-chunkok, KB-találatok) a változó zónába kerüljön, hogy a statikus instrukció cache-elődjön.
16. Platform-üzemeltetőként azt szeretném, hogy a megoldás ne igényeljen provider-specifikus caching-hívást vagy sémaváltozást, hogy alacsony kockázattal bevezethető legyen.
17. Platform-üzemeltetőként azt szeretném, hogy a tool-loopon belüli (egy user-fordulóhoz tartozó) ismételt gateway-hívások a fix rendszer-prefixet cache-eljék, hogy a több körös eszközhasználat olcsóbb legyen.
18. Security-felelősként azt szeretném, hogy a web-kutatási/KB adat továbbra is egyértelműen „adat, nem utasítás" határolással szerepeljen, hogy az átrendezés ne gyengítse a prompt-injection védelmet.
19. Platform-fejlesztőként azt szeretném, hogy egy jövőbeli fejlesztő a teszteken keresztül lássa a stabil/változó határt, hogy egy új system-blokk hozzáadásakor tudja, melyik zónába tegye.
20. Platform-üzemeltetőként azt szeretném, hogy a mérhető token-megtakarítás ellenőrizhető legyen (cache-read token vagy token/latency összevetés), hogy a fejlesztés haszna igazolható legyen.

## Implementation Decisions

- **Közös prompt assembler (egy seam).** Bevezetünk egy közös, tiszta (I/O-mentes) prompt-összeállító függvényt, amely a chat-runtime, a task-runtime és a tool-loop számára egyaránt előállítja a rendezett `GatewayMessage[]`-et. Ez váltja ki a jelenlegi két különálló, egymástól függetlenül szétcsúszott összeállítást (chat `buildGatewayMessages` és a task megfelelője), és feloldja azt is, hogy a tool-loop jelenleg a saját statikus blokkjait a beérkező üzenetek — így a változó tartalom és az előzmény — **után** fűzi.

- **Szegmentált sorrend-modell.** Az assembler négy, sorrendben rögzített szegmensből állítja össze az üzeneteket. A stabil szegmens minden agent-szintű, hívások közt azonos tartalmat tartalmaz; a változó szegmens a per-forduló adatot; majd az előzmény; végül (a tool-loopban) a per-kör tool tail. A szegmensek belső sorrendje:

  - **Stabil preamble** (cache-elhető fordulók és beszélgetések közt):
    1. `tools[]` (function-calling sémák — külön top-level mező, stabil, rendezett sorrendben; ezt nem bontjuk meg)
    2. agent system prompt (role instruction + behavior profile kompozíció)
    3. org-roster
    4. statikus chat-/task-instrukció (a „közvetlen beszélgetés" / modeNote állandó szövege)
    5. `TOOL_INSTRUCTION`
    6. engedélyezett-toolok üzenet
    7. agent-UUID üzenet
    8. skill-index (ha van hozzárendelt skill)
    9. http_api connector-katalógus (ha http_api tool engedélyezett)
    10. repo-instrukció (ha repo_prepare engedélyezett)
    11. memória usage-policy + capture-policy statikus szövege; KB válasz-instrukció statikus szövege
  - **Változó kontextus** (innen a cache-törés természetes):
    12. Project memory context adat-blokk (a ténylegesen visszakeresett chunkok)
    13. kb_search találatok adat-blokk
    14. munkaterület-fájllista
    15. `/skill` slash-parancssal előre betöltött skill-promptok (per-üzenet)
  - **Előzmény:** user/assistant fordulók (`buildHistoryGatewayMessages` kimenete)
  - **Tool tail:** a tool-loop per-kör tool_use/tool_result üzenetei (loop-belső, változatlan)

- **A KB- és memória-üzenet szétválasztása adatra és instrukcióra.** A jelenlegi KB-üzenet egyetlen blokkban keveri a válasz-instrukciót (közel statikus) és a találati adatot (változó). Az assemblerben ezt kettéválasztjuk: az instrukció-rész a stabil preamble-be (11. pont), a `formatHitsForPrompt(hits)` adat-rész a változó zónába (13. pont). A memória oldalán a capture/usage-policy szöveg a stabil zónában marad (11. pont), a Project memory context adat-blokk a változó zónába kerül (12. pont).

- **Determinizmus-garanciák a stabil zónában.** A stabil preamble minden bemenetének determinisztikusnak kell lennie: az org-roster az agentek rendezett listájából (jelenleg `createdAt desc` — megtartjuk), a tool-lista és a `tools[]` a rendezett capability-listából (jelenleg `toolName asc` — megtartjuk) épül. A stabil zónába **nem** kerülhet időbélyeg, UUID-n kívüli per-request azonosító, vagy rendezetlen szerializáció. (A jelenlegi audit szerint ilyen rejtett rontó nincs — ezt a teszt is rögzíti.)

- **Opcionális relevancia-score kikapcsolva a memória-blokkban.** A memória-chunk formázás opcionális `withScore` kapcsolója alapból ki van kapcsolva; a spec explicit döntése, hogy a stabil prefix integritása szempontjából ki is marad. (A memória-adat úgyis a változó zónában van, de a score fölösleges extra változékonyságot adna.)

- **Két fázis, egy interfész.** A megoldás egyetlen assembler-seam köré épül, de két lépésben vezethető be: (1) a stabil/változó átrendezés maga; (2) a tool-loop és a runtime közti interfész átkötése, hogy a loop-szintű statikus blokkok (`TOOL_INSTRUCTION`, connector-katalógus, repo-instrukció) is a stabil preamble részei legyenek, ne az előzmény után. Mivel a választott seam a közös assembler, a két fázis ugyanazt a függvényt érinti — a fázisolás csak a bevezetés kockázatának bontása.

- **Nincs sémaváltozás, nincs új függőség, nincs provider-API.** A fejlesztés nem érint DB-sémát, nem vezet be `cache_control`-t vagy más provider-specifikus caching-hívást, és nem módosítja a Model Gateway provider-interfészét. A gateway továbbra is változatlanul, bájt-hűen továbbadja a `messages[]` tömböt a providernek.

- **Szemantika-megőrzés.** Az átrendezés tartalom-mozgatás, nem tartalom-változtatás. A „web-kutatási/KB adat = adat, nem utasítás" határolás és a záró válasz-instrukció megmarad; a modellnek adott instrukciók halmaza változatlan.

## Testing Decisions

- **Mit tesztelünk (külső viselkedés).** A tesztek a prompt assembler **kimenő üzenet-sorrendjét** figyelik — ez a providerhez ténylegesen kimenő, megfigyelhető viselkedés. Nem tesztelünk implementációs részletet (pl. belső segédfüggvényeket); a megfigyelt egység a rendezett `GatewayMessage[]`.

- **A seam: közös tiszta assembler.** A prompt assembler tiszta függvény, amely előre kikeresett bemeneteket (agent, org-roster, memória-blokk, KB-találatok, munkaterület-fájllista, előzmény, loop-szintű statikus darabok) kap és a rendezett `GatewayMessage[]`-et adja vissza — DB és gateway nélkül. A tesztek ezt az egy seamet hajtják.

- **Kulcs-assertek:**
  1. **Prefix-stabilitás:** két hívás, amely csak a változó zónában különbözik (eltérő memória-blokk és/vagy KB-találatok és/vagy munkaterület-fájllista, azonos agent + tool-készlet), **bájt-azonos stabil prefixet** ad az első változó blokkig.
  2. **Zóna-sorrend:** minden változó blokk (memória-adat, KB-adat, munkaterület-lista, `/skill` promptok) a teljes stabil preamble **után** jelenik meg; az előzmény és a tool tail a változó zóna után.
  3. **Determinizmus:** azonos bemenetből azonos kimenet; a roster és a tool-lista rendezett; a stabil zóna nem tartalmaz per-request változó tokent.
  4. **Szemantika-jelenlét:** a statikus instrukciók (pl. `TOOL_INSTRUCTION`, memória capture-policy, KB válasz-instrukció) továbbra is jelen vannak, csak a stabil zónában; az adat-blokkok a változó zónában.
  5. **Chat és task paritás:** mindkét runtime ugyanazt az assemblert használja, így a sorrend-tesztek mindkét ágra érvényesek.

- **Prior art.** A `buildHistoryGatewayMessages` már exportált és tiszta, kifejezetten azért, hogy „a kontextus-átvitel DB/gateway nélkül tesztelhető legyen" — ugyanez a minta követendő az assemblernél. A tool-loop és a gateway meglévő tesztjei fake ModelProvider / fake gateway injektálással dolgoznak; ha end-to-end összetett sorrend-ellenőrzés kell, ez a fake-provider minta a másodlagos megerősítés, de a fő seam a tiszta assembler.

## Out of Scope

- **Provider-specifikus explicit caching.** A Gemini explicit context caching (CachedContent + TTL) és bármely provider explicit cache-API-ja külön, későbbi lépés — ez a spec csak a providerfüggetlen, automatikus prefix-cache kihasználását célozza a sorrenddel.
- **`cache_control` / Anthropic-stílusú breakpointok.** A platform nem használ Anthropic providert; a `cache_control` mechanizmus nem alkalmazandó.
- **A prompt tartalmának megváltoztatása.** A system-blokkok szövege, a tool-sémák, a memória- és KB-formázás tartalma nem változik — csak a sorrend.
- **Memória-visszakeresés és KB-keresés logikája.** A retrieval/keresés belső működése, relevancia-számítása változatlan.
- **Sensitivity-routing és budget-guardrail.** A gateway érzékenység-osztályozó, routing és budget-kapui érintetlenek.
- **Cache-warmup / pre-warm.** A prefix előmelegítése (üres/rövid hívással) nem tárgya ennek a specnek.

## Further Notes

- **Miért működik providerenként.** ChatGPT OAuth (OpenAI Responses backend), Gemini (implicit caching), OpenRouter (a mögöttes modell szerint) és Ollama (helyi KV-cache) mind a prompt **prefixére** épít; a stabil-előre sorrend mindegyiknél nyereséget hoz — az OpenAI/Gemini oldalán token-költség-csökkenést, Ollaman sebességet.
- **A legnagyobb egyszeri nyereség** a több beszélgetés közti megosztás: ugyanazon agent minden hívása azonos stabil preamble-t küld (tool-sémák + agent prompt + roster + statikus instrukciók + connector-katalógus), amit a provider egyszer cache-el és minden forgalom onnan olvas — de csak ha ez megszakítás nélküli prefix, amit a jelenlegi 2. pozíciós memória-blokk ma megtör.
- **Verifikáció.** Ahol a provider visszaadja a cache-read token-számot, azt figyeljük (nullától eltérő cache-read ismételt prefixnél). Ahol nem, a Model Gateway meglévő `promptTokens`/latency telemetriájának összevetésével (átrendezés előtt/után, azonos kontextuson) mérhető a hatás.
- **Audit-megállapítás.** A jelenlegi kód **nem** tartalmaz rejtett cache-rontót (nincs `Date.now()`/UUID/rendezetlen JSON a stabil blokkokban); a roster (`createdAt desc`) és a capability-lista (`toolName asc`) rendezése determinisztikus. A probléma tisztán sorrendi, ezért a fix alacsony kockázatú.
