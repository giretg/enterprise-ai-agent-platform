# AI Agent Platform — Feature Spec: Prompt-cache határ (`cache_control`) a Gatewayben

## Problem Statement

A prefix-sorrend fejlesztés (ld. `AI-Agent-Platform-Feature-Spec-Prompt-Cache-Prefix-Ordering.md`) elérte, hogy a stabil, agent-szintű blokkok (tool-sémák, agent system prompt, org-roster, `TOOL_INSTRUCTION`, connector-katalógus, skill-index) megszakítás nélküli prefixként a prompt elején álljanak, a per-forduló változó adat pedig utánuk. Az a spec kifejezetten **hatókörön kívülre tette** a `cache_control`-t azzal az indokkal, hogy „a platform nem használ Anthropic providert".

Ez az indok azóta nem áll: a Gateway `openrouter` providere rutinszerűen **Anthropic modelleket** is kiszolgál, és ezeknél a prompt-cache **nem automatikus** — a providernek explicit `cache_control` breakpointot kell kapnia, különben a cache egyáltalán nem lép életbe. A stabil prefix tehát ma helyes sorrendben áll, de **nincs cache-határral megjelölve**, így ezen az úton a nagy, soha nem változó blokkok minden fordulóban és minden beszélgetésben teljes áron mennek ki.

Üzletileg (UX/költség): a tool-nehéz agentek OpenRouter/Anthropic úton fölösleges token-költséget termelnek, és a válasz lassabban indul, mert a több ezer tokenes statikus preamble minden körben újra feldolgozódik. A hiány **néma**: nincs hibaüzenet, nincs riasztás, csak a számla és a latency magasabb a szükségesnél.

## Solution

Kétlépcsős, providerfüggetlen jelölés → provider-specifikus fordítás:

1. **Jelölés (assembler).** A közös prompt-assembler a stabil zóna (stabil preamble + stabil postamble) **utolsó** üzenetére ráteszi a `cacheBoundary` jelölést. Ez tartalom-semleges: a `content` bájtra változatlan marad, csak metaadat kerül az üzenet mellé. Az assembler nem mutálja a hívó szegmens-tömbjeit.

2. **Fordítás (Gateway).** A Gateway a providerhez menet a jelölést lefordítja a provider saját cache-API-jára: az OpenAI-kompatibilis sémán az adott üzenet `content`-je egyetlen `text` részre bomlik, amin ott a `cache_control: { type: 'ephemeral' }`. Ahol a provider nem vár explicit breakpointot (ChatGPT OAuth, Gemini, Ollama), ott a jelölés **no-op** — ott az automatikus prefix-cache / helyi KV-cache él tovább, változatlanul.

A providerhez menő tartalom így **bájtra ugyanaz marad**, mint eddig; egyedül a stabil prefix záró üzenetének burkolata változik (string → egyelemű text-tömb). A modell viselkedése nem változik.

## User Stories

1. Platform-üzemeltetőként azt szeretném, hogy az OpenRouter/Anthropic úton futó agentek stabil prefixe ténylegesen cache-elődjön, hogy a ma fölöslegesen fizetett token-költség eltűnjön.
2. Platform-üzemeltetőként azt szeretném, hogy a cache-találatok mérhetők legyenek (metrika), hogy a megtakarítás igazolható legyen, és egy néma regresszió (a prefix megtörése) észrevehető legyen.
3. Platform-üzemeltetőként azt szeretném, hogy a prompt-cache egyetlen env-változóval kikapcsolható legyen, hogy provider-oldali hiba esetén azonnal visszaállhassak jelölés nélküli működésre — kód-deploy nélkül.
4. Platform-üzemeltetőként azt szeretném, hogy a rövid promptokra ne kerüljön cache-jelölés, mert ott a provider minimum-hossz alatt úgysem cache-el, a jelölés viszont írási felárat vonhat maga után.
5. Agent-fejlesztőként azt szeretném, hogy a cache-határ automatikusan a stabil zóna végére kerüljön, hogy egy új stabil blokk hozzáadásakor ne kelljen kézzel is határt igazítanom.
6. Agent-fejlesztőként azt szeretném, hogy a jelölés ne változtassa meg a prompt tartalmát, hogy ne legyen viselkedés-regresszió, és a prompt-eval piros vonalak érintetlenek maradjanak.
7. Platform-fejlesztőként azt szeretném, hogy a chat-, task- és tool-loop runtime **ugyanazt** a határ-logikát kapja, mert mindhárom a közös assemblert használja.
8. Platform-fejlesztőként azt szeretném, hogy a cache-API ismerete a providernél maradjon (képességjelző), hogy egy új provider bekötése egyetlen kapcsolóból megoldható legyen.
9. Security-felelősként azt szeretném, hogy a cache-telemetria kizárólag számokat naplózzon és auditáljon, prompt-tartalmat soha (MG-N4).
10. Platform-üzemeltetőként azt szeretném, hogy a hosszú (1h) TTL választható legyen, mert a ritkás forgalmú tenantoknál az 5 perces cache a fordulók közt lejár.

## Implementation Decisions

- **A határ jelölése az assemblerben, a fordítása a Gatewayben.** A „hol ér véget a stabil prefix" tudás a prompt-összeállításban van, a „hogyan kell ezt a providernek elmondani" tudás a Gatewayben. A két réteg szétválasztásával egy új provider bekötése nem nyúl a prompt-építéshez, és egy új stabil blokk nem nyúl a Gatewayhez.

- **`GatewayMessage.cacheBoundary` — opcionális, providerfüggetlen metaadat.** Az üzenet-unió minden ága kap egy opcionális `cacheBoundary?: boolean` mezőt. Nem provider-specifikus (nem `cache_control`), mert a jelentése „itt ér véget a stabil prefix", nem „tegyél ide Anthropic breakpointot".

- **Provider-képességjelző, nem modell-detektálás.** A `cache_control` átengedését az `OpenAiCompatibleProvider` `promptCache` opciója kapcsolja (jelenleg: `openrouter` = igen, `ollama` = nem). Szándékosan **nem** a modell-azonosítóból következtetünk (`anthropic/*`), mert a modell-lista a routing/tartalék-lánc futásidejű döntése, és egy nem-Anthropic modellnek átadott extra mező a providernél tolerált no-op.

- **A tool-sémákat a system-üzenet határa fedi.** Az Anthropic render-sorrend `tools` → `system` → `messages`, ezért a stabil zóna utolsó system-üzenetére tett breakpoint a tool-sémákat is a cache-elt prefixbe vonja. Külön tool-szintű jelölést nem küldünk (az OpenAI-kompatibilis sémán nem szabványos).

- **Max 4 breakpoint, a leghosszabb prefixek nyernek.** Az Anthropic kérésenként legfeljebb 4 `cache_control`-t fogad. Az assembler ma egyet jelöl, de a Gateway védőkorlátot húz: 4 fölött a legkésőbbi (leghosszabb prefixű, azaz leginkább megtérülő) jelöléseket tartja meg.

- **Minimum prefix-hossz (default 1024 becsült token).** A providerek minimum-hossz alatt csendben nem cache-elnek. A becslés a meglévő ~4 karakter/token heurisztika; a tool-sémákat nem számoljuk bele, így a becslés konzervatív (inkább kihagy, mint fölöslegesen írjon cache-t). Env: `GATEWAY_PROMPT_CACHE_MIN_TOKENS`.

- **Kill switch és TTL env-ből.** `GATEWAY_PROMPT_CACHE=off|false|0` teljesen kikapcsolja a jelölést; `GATEWAY_PROMPT_CACHE_TTL=1h` hosszú TTL-t kér. Mindkettő hívásonként olvasódik (nincs process-lifetime cache) — ugyanaz a minta, mint a tarifa- és tartalék-lánc beállításoknál.

- **Csak system/user szöveges üzenet lehet határ.** Tool-eredmény, tool-hívásos assistant üzenet és üres tartalom nem — ezek nem stabil prefix-végek, és a tömbösített `content` egyes providereknél a tool-ágon nem is értelmezett.

- **Nincs sémaváltozás és nincs új függőség.** DB-séma, provider-interfész és prompt-tartalom változatlan; a `ModelProviderResult.usage` két opcionális számmezővel bővül.

- **A költségbecslés (`costEstimate`) egyelőre nem számol cache-kedvezményt.** A tarifa-tábla nem tartalmaz cache-olvasási/írási szorzót, és providerenként eltér — kitalált szorzóval rontanánk a meglévő költség-riportot. A megtakarítás a cache-token metrikán mérhető; a tarifa-tábla cache-rátáinak bevezetése külön lépés.

## Testing Decisions

- **Mit tesztelünk (külső viselkedés).** Két megfigyelhető felület: (1) az assembler kimenő üzenetsora (hová kerül a határ), és (2) a providerhez ténylegesen kimenő HTTP request body (hová kerül `cache_control`). A provider-hívást `fetch`-stub kapja el — ez a valódi kimenő szerződés, nem implementációs részlet.

- **Seam-ek.** A tiszta assembler (I/O nélkül), a tiszta politika-függvény (`resolveCacheBreakpoints`, `extractPromptCacheUsage`), és a `createDefaultProviders()`-ből kivett **valódi** provider-példány (így a teszt azt is rögzíti, hogy az `openrouter` be van kapcsolva, az `ollama` nem).

- **Kulcs-assertek:**
  1. **Határ-pozíció:** pontosan egy határ, a stabil zóna (preamble + postamble) utolsó üzenetén; a változó zóna, az előzmény és a tool tail jelöletlen.
  2. **Tartalom-semlegesség:** a jelölt üzenet szövege bájtra változatlan; a nem jelölt üzenetek sima stringként mennek ki.
  3. **Nincs mutáció:** a hívó szegmens-tömbjei jelöletlenek maradnak (különben a következő forduló határa csendben elcsúszna).
  4. **Prefix-stabilitás:** két hívás, amely csak a változó zónában különbözik, bájt-azonos stabil prefixet **és azonos határt** ad.
  5. **Provider-képesség:** `openrouter` kap `cache_control`-t, `ollama` nem; a nem-streamelő és a streamelő ág egyaránt.
  6. **Politika:** kill switch, minimum prefix-hossz, max 4 breakpoint, tool/üres üzenet kizárása.
  7. **Telemetria:** a provider által jelentett cache-tokenek megjelennek az audit-metadatában és a Prometheus metrikában; a hiányzó/0 érték nem generál zajt.

- **Futtatás:** `npm run test:prompt-cache` (CI: stub-DB domain tesztek blokk).

## Out of Scope

- **Cache-tudatos költségbecslés.** A `costEstimate` cache-kedvezménye a tarifa-tábla bővítését igényli (provideronkénti olvasási/írási szorzó) — külön lépés.
- **Gemini explicit context caching (CachedContent + TTL).** Külön provider-API, külön életciklus-kezeléssel (létrehozás, TTL, törlés) — nem fér ebbe a jelölés-alapú megoldásba.
- **Cache-warmup / pre-warm.** A prefix előmelegítése külön hívással nem tárgya ennek a specnek.
- **Több breakpoint kiosztása (pl. előzmény-fordulónként).** A jelenlegi assembler egy határt jelöl; a több-breakpointos (fordulónkénti) stratégia a 4-es plafon és a 20-blokkos visszanézési ablak együttes kezelését igényli — későbbi lépés, a védőkorlát már a helyén van.
- **A prompt tartalmának és sorrendjének megváltoztatása.** Ezt a prefix-sorrend spec rendezte; itt semmi nem mozdul.

## Further Notes

- **Kapcsolat a prefix-sorrend speccel.** Az a spec „Out of Scope"-ja azért zárta ki a `cache_control`-t, mert Anthropic providert nem feltételezett. Ez a spec ezt a feltevést javítja: az OpenRouter-en keresztül elért Anthropic modellek explicit breakpointot várnak. A sorrend (stabil előre) **előfeltétele** ennek a lépésnek — jelölés önmagában, megtört prefix mellett, hatástalan lenne.
- **Verifikáció.** `model_gateway_prompt_cache_tokens_total{kind="read"}` tartós nullája azt jelenti, hogy valami megtöri a stabil prefixet (időbélyeg/UUID a stabil zónában, változó tool-lista, modellváltás), vagy a prefix a provider minimum-hossza alatt van. A napló `cacheHit` mezője hívásonként mutatja ugyanezt; a token-számok naplóba szándékosan nem kerülnek, mert a logger a `prompt`/`token` kulcsneveket redaktálja.
- **Miért nem tömbösítünk minden üzenetet.** A `content` tömbösítése csak a jelölt üzeneten történik: így a diff minimális, és a nem támogató providerek felé a payload bájtra a korábbi marad.
