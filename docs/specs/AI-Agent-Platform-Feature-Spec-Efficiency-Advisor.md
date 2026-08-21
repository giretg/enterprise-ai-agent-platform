# AI Agent Platform — Feature Spec: Hatékonysági tanácsadó (pazarló futás-minták felismerése)

> Forrás: [#237](https://github.com/giretg/enterprise-ai-agent-platform/issues/237) — „Hatékonysági tanácsadó: pazarló futás-minták felismerése és közérthető javaslat (token/költség)".

## Problem Statement

A platform ma **megméri**, mibe kerül egy futás, de nem **magyarázza meg**. A `ModelCall` sor futásonként tárolja a `promptTokens`, `completionTokens`, `cachedPromptTokens`, `costEstimate` és `latencyMs` értékeket, a `ToolCall` sor pedig minden eszközhívást — a loop saját, nem brokeren átmenő hívásait is (`policyDecision: 'internal'`, #180 WP-3). Ebből egy nem-technikai felelős annyit lát, hogy **az agent sokba került**; azt nem, hogy **miért**, és főleg nem azt, hogy **mit tehetne ellene**.

A drágaság nagy része néhány ismert, ismétlődő mintából jön, és mindegyikről tudjuk, hogy ténylegesen megtörtént ebben a rendszerben:

- **Ismétlődő visszaolvasás.** A mért incidensben (2026-07-29) 149 eszközhívásból 132 volt ugyanannak a forrásnak az újraolvasása, és a futás 40 körön át egy helyben járt — 2,8M token, kész eredmény nélkül. A fékek azóta megvannak (`loop-stop-decision.ts` forrás-számvitele, per-kör és per-forrás keret, ismétlés-őr), de a fékbe futás **utólag, agentenként** nem látszik sehol.
- **Kontextus-hízás.** A tool-loop minden modellhívásnál a teljes addigi előzményt újraküldi; egy 24 eszközhívásos feladatnál ez mérten 21k → 154k token prompt-növekedést jelentett. A `context-compactor.ts` ezt kezeli, de a küszöbei **platform-szintű env-értékek**, és nincs jelzés arról, melyik agentnél lépnek működésbe túl későn.
- **Túlméretezett eszköz-kimenet.** A `TOOL_RESULT_INLINE_LIMIT` (12 000 karakter) fölötti eredmény archívumba és munkaterületre kerül (#179), de ha egy agent minden fordulóban ugyanazt a 250 KB-os API-választ kéri le, az archiválás csak enyhíti a kárt — a hívás maga rossz (nem aggregált végpont, túl széles mezőlista).
- **Cache-prefix törés.** A prompt-cache prefix-sorrend (`prompt-assembler.ts`) épp azért készült, hogy a stabil rész cache-elődjön; a `ModelCall.cachedPromptTokens` meg is mondaná, fog-e a cache — de **senki nem nézi meg**, és `null` (nincs adat) meg 0 (nincs találat) között ma semmi nem tesz különbséget a felületen.

A jelek tehát **megvannak**, csak **nyersek**: a forduló-szintű riasztás (`turn-cost-signals.ts`) naplóba és in-process Prometheus-számlálóba megy, ami üzemeltetői eszköz, nem a folyamatgazdáé. A `domain/` alatt keresésre **nincs** hatékonysági-elemző komponens. Következmény: ugyanaz a pazarló minta hat futáson át megismétlődhet, mire valaki észreveszi — és amikor észreveszi, sem tudja, melyik kapcsolóhoz nyúljon.

## Solution

Egy **utólagos, olvasás-oldali hatékonysági tanácsadó**: agentenként végignézi a közelmúlt futásait a **már perzisztált** `ModelCall` és `ToolCall` sorokból, felismeri a fenti négy mintát, és mindegyikhez **közérthető magyarázatot, becsült megtakarítást és — ahol van meglévő kapcsoló — egy alkalmazható javaslatot** ad.

A megoldás magja egy **tiszta (I/O-mentes) detektor-modul**: `src/domain/agent/efficiency-advisor.ts`. Bemenete egy futás-halmaz normalizált alakja (futásonként a modellhívások token-sora és az eszközhívások metaadatai), kimenete a **hatékonysági kártya**: token-bontás + felismert minták listája + javaslatok. A lekérdezés (mit olvasunk a DB-ből) és a megjelenítés (hogyan mondjuk el) ezen kívül marad, hogy a küszöbök és a szövegek DB nélkül tesztelhetők legyenek — pontosan úgy, ahogy a `turn-cost-signals.ts` és a `loop-stop-decision.ts` már ma is működik.

A tanácsadó **semmit nem állít le és semmit nem dob el**. Nem fut a futás közben, nem hoz döntést, nem módosít promptot: kizárólag **utólag olvas és javasol**. Az egyetlen íráshoz vezető út a felelős explicit kattintása, amely egy meglévő kapcsolót állít az agent `modelConfig`-jában — auditáltan, visszavonhatóan.

Felület: az agent adatlapján (`/control-plane/agents/[agentId]`) egy új „Hatékonyság" szekció a meglévő `SettingsSectionShell` szekciók mellett. Tartalma: (1) **hova megy a token** bontás a választott időablakra, (2) a felismert minták kártyái közérthető magyarázattal és óvatos megtakarítás-sávval, (3) ahol van kapcsoló, egy „Alkalmazom" gomb — a többinél a magyarázat és a megfelelő felület linkje.

## User Stories

1. Folyamatgazdaként azt szeretném, hogy egy agent adatlapján lássam, **mire ment el a tokenje**, hogy ne kelljen a nyers token-számlálókat értelmeznem.
2. Folyamatgazdaként azt szeretném, hogy a rendszer **magyarul, szakzsargon nélkül** mondja meg, miért drága egy agent, hogy dönteni tudjak róla.
3. Folyamatgazdaként azt szeretném, hogy minden felismert minta mellett ott legyen egy **óvatos megtakarítás-sáv**, hogy priorizálni tudjam, melyikkel foglalkozom.
4. Folyamatgazdaként azt szeretném, hogy ha nincs elég futás a megbízható elemzéshez, a kártya ezt **kimondja** („nincs elég adat"), hogy ne higgyek el egy két futásból számolt állítást.
5. Tenant adminként azt szeretném, hogy ahol van meglévő kapcsoló, **egy kattintással alkalmazhassam** a javaslatot, hogy ne kelljen env-változókat keresgélnem.
6. Tenant adminként azt szeretném, hogy az alkalmazott javaslat **auditba kerüljön** (ki, mikor, mit állított), hogy visszakövethető legyen a változás.
7. Tenant adminként azt szeretném, hogy az alkalmazott beállítás **visszavonható** legyen ugyanazon a felületen, hogy egy rossz döntés ne ragadjon be.
8. Üzemeltetőként azt szeretném, hogy az **ismétlődő visszaolvasás** agentenként kimutatható legyen, hogy ne kelljen újra beszélgetés-exportból kézzel kibogarásznom.
9. Üzemeltetőként azt szeretném, hogy a **fékbe futott** (blokkolt) visszaolvasások is beleszámítsanak a mintába, mert a modell szándéka ott is ugyanaz volt — a hívás akkor is költött.
10. Üzemeltetőként azt szeretném, hogy a **kontextus-hízás** külön jelként látszódjon, hogy meg tudjam különböztetni a „sok a munka" és a „minden körben újraküldjük ugyanazt" esetet.
11. Üzemeltetőként azt szeretném, hogy a **túlméretezett eszköz-kimenet** ismétlődése látszódjon eszköznévvel együtt, hogy tudjam, melyik hívást kell szűkíteni.
12. Üzemeltetőként azt szeretném, hogy a **prompt-cache találati aránya** agentenként látszódjon, hogy kiderüljön, ha a stabil prefix elromlott.
13. Üzemeltetőként azt szeretném, hogy a „nincs cache-adat a providertől" eset **ne** jelenjen meg „nincs cache-találat" hibaként, mert az félrevezető lenne.
14. Platform-fejlesztőként azt szeretném, hogy a detektorok **tiszta függvények** legyenek, hogy a küszöbök DB és gateway nélkül tesztelhetők legyenek.
15. Platform-fejlesztőként azt szeretném, hogy a kártya **a már perzisztált sorokból** épüljön, hogy ne kelljen új futásidejű írást bevezetni a forró útra.
16. Platform-fejlesztőként azt szeretném, hogy a lekérdezés **korlátos** legyen (időablak + futás-plafon + DB-oldali aggregáció), hogy egy nagy forgalmú agent adatlapja se lassuljon be.
17. Platform-fejlesztőként azt szeretném, hogy egy eszközhívás **egyértelműen a saját fordulójához** tartozzon, hogy a per-futás elemzés ne időbélyeg-illesztésre épüljön.
18. Biztonsági felelősként azt szeretném, hogy a kártya **ne mutasson tartalmat** (se prompt-, se eszköz-eredmény-részletet), csak metaadatot és számot, hogy ne nyíljon új adat-kiszivárgási út.
19. Tenant adminként azt szeretném, hogy a kártya **csak a saját tenantom** futásaiból számoljon, hogy ne lássak át más szervezet forgalmára.
20. Folyamatgazdaként azt szeretném, hogy a javaslat **konkrét legyen** („kapcsold szigorúbbra a kontextus-tömörítést ennél az agentnél"), ne általános jótanács, hogy tudjak vele mit kezdeni.
21. Folyamatgazdaként azt szeretném, hogy ha egy agent **rendben van**, a kártya ezt is kimondja, hogy ne kelljen a hiányzó figyelmeztetésből következtetnem.

## Implementation Decisions

- **Utólagos elemzés, nulla futásidejű beavatkozás.** A tanácsadó a futás **után**, kérésre fut (az adatlap megnyitásakor). Nem hívjuk a `chat-tool-loop`-ból, nem befolyásolja a prompt-építést, nem hoz stop-döntést. A futás közbeni védelem marad, ahol van: `loop-stop-decision.ts`, `context-compactor.ts`, `turn-cost-signals.ts`.

- **Tiszta detektor-modul a seam.** Az új `src/domain/agent/efficiency-advisor.ts` egyetlen belépési pontja egy tiszta függvény: futás-halmaz normalizált alakja → hatékonysági kártya. Nincs benne Prisma-hívás, óra, env-olvasás a küszöb-feloldáson kívül, és nincs benne szöveg-formázás a magyarázat-kulcsokon túl. Ez a `turn-cost-signals.ts` bevált mintája (küszöbök + `resolve…Thresholds` + `describe…` szövegek egy modulban, minden I/O a hívóban).

- **A „futás" fogalma.** Chat-ágon egy futás = egy `AgentTurn` (a `ModelCall.agentTurnId` már ma erre köt, #180 WP-2). Ticket/task-ágon egy futás = egy `Ticket` (`ModelCall.ticketId`). A kártya futás-szinten detektál, majd agent-szinten összesít; a két ág ugyanazt a detektor-bemenetet kapja, csak a csoportosító kulcs más.

- **Egyetlen séma-változás: `ToolCall.agentTurnId`.** A `ToolCall` ma csak `ticketId`/`conversationId`-hoz köt, így egy chat-futás eszközhívásait csak időbélyeg-illesztéssel lehetne a fordulóhoz rendelni — pontosan az a törékenység, amit a #180 WP-2 a `ModelCall`-nál már megszüntetett. Ugyanazt a lépést tesszük meg: **nullable, indexelt** `agent_turn_id` oszlop `onDelete: SetNull` relációval. Nincs backfill: a bevezetés előtti sorokon `null` marad, és azokat a beszélgetés-szintű ágon elemezzük (a kártya jelzi, ha egy időszakra csak durvább bontás áll rendelkezésre).

- **Egyetlen additív mező a meglévő JSON-ban: `result_chars`.** A túlméretezett kimenet detektorának a nyers eredmény hosszára van szüksége, amit ma egyik `ToolCall` sor sem tárol egységesen (a `resultMeta` eszközönként más alakú). A `tool-broker-support.ts` `resultMeta()` függvénye minden ágon kiegészül egy egységes `result_chars` mezővel — a modell csatornájára kerülő nyers hasznos teher hossza. Ez **metaadat, nem tartalom**, és JSON-mezőként nem igényel migrációt. A `tool_result_read` ágon a megfelelő szám már ma is megvan (`argsMeta.returned_chars` / `total_chars`).

- **Négy detektor, mind a perzisztált sorokból.**

  1. **Ismétlődő visszaolvasás.** Bemenet: a futás `ToolCall` sorai. Újraolvasásnak számít (a) a `tool_result_read` hívás, ahol `resultMeta.redundant === true` vagy `resultMeta.blocked === true`, és (b) minden olyan olvasó hívás, amelynél ugyanaz a forrás-kulcs (a `loop-stop-decision.ts` `toolCallSourceKey` szabálya szerint: `path` / `documentId` / `url` / `pageId` / `id`) a futáson belül többször szerepel. Mérőszám: az újraolvasó hívások aránya és a hozzájuk tartozó karakter-mennyiség (`returned_chars`, illetve `result_chars`), token-becslés ~4 karakter/token — ugyanaz a becslés, amit a `turn-cost-signals.ts` használ.
  2. **Kontextus-hízás.** Bemenet: a futás `ModelCall` sorai `createdAt` szerint rendezve. Mérőszám: az **ismételt kontextus** = `sum(promptTokens) − n × promptTokens(első hívás)`, azaz a második hívástól kezdve újraküldött prompt-tömeg, és a `promptTokens` növekedésének monotonitása. Minta akkor áll fenn, ha az ismételt kontextus a futás összes prompt-tokenjének a küszöb fölötti hányadát viszi el, **és** a futás elért annyi kört, ahol a tömörítésnek már dolgoznia kellett volna.
  3. **Túlméretezett eszköz-kimenet.** Bemenet: a futás `ToolCall` sorai `result_chars`-szal. Minta akkor áll fenn, ha ugyanaz az eszköz (opcionálisan ugyanaz a forrás-kulcs) a futásban többször ad a `TOOL_RESULT_INLINE_LIMIT` fölötti eredményt. A javaslat itt **nem** kapcsoló, hanem a hívás szűkítése (aggregált végpont, szűkebb mezőlista, `tool_result_extract`) — a kártya ezt mondja el, eszköznévvel.
  4. **Cache-prefix törés.** Bemenet: a futás `ModelCall` sorainak `cachedPromptTokens` értéke. Cache-találati arány = `sum(cachedPromptTokens) / sum(promptTokens)` **csak a nem-`null` sorokra**. Minta akkor áll fenn, ha az agentnek elég sok, azonos modell felé menő hívása van, és az arány a küszöb alatt marad. Ha minden sor `null`, a kártya „a provider nem ad cache-adatot" állapotot mutat — ez **nem** megállapítás, és nem számít bele a megtakarítás-becslésbe.

- **Küszöbök egy helyen, env-ből hangolhatóan.** A négy detektor küszöbei egyetlen `EFFICIENCY_ADVISOR_THRESHOLDS` konstansban élnek, `resolveEfficiencyAdvisorThresholds(env)` feloldással — ugyanaz a minta, mint a `resolveTurnCostThresholds`. Kiindulási értékek (a mért esetekhez igazítva, hogy egy normál futás ne riasszon): újraolvasási arány > 0,3 legalább 6 olvasó hívás mellett; ismételt kontextus > a prompt-tokenek 60%-a legalább 4 modellhívás mellett; ismételt túlméretezett kimenet ≥ 3 alkalom; cache-találat < 20% legalább 10 nem-`null` hívás mellett. A küszöb **hangolható, elnémítani nem** — érvénytelen érték az alapértékre esik vissza.

- **Minimális minta-méret és őszinte üresség.** A kártya futás-szinten detektál, de csak akkor jelenít meg mintát, ha az agentnek az ablakban legalább **3 elemezhető futása** van, és a minta ezek közül legalább **kettőben** megjelenik. Ez alatt a kártya „nincs elég adat a megbízható elemzéshez" állapotot mutat — a #230-ban is kimondott elv szerint: inkább nincs állítás, mint gyenge állítás.

- **Token-bontás: a mérés a `ModelCall`, a becslés csak annotáció.** A „hova megy a token" bontás alapja kizárólag a `ModelCall` — ez a tényleges, elszámolt fogyás: **belépő kontextus** (futásonként az első hívás `promptTokens`-e), **ismételt kontextus** (a többi hívás prompt-tömege), **válasz** (`completionTokens`), és ebből leválasztva a **cache-ből kiszolgált** rész (`cachedPromptTokens`). Az újraolvasásra becsült token-mennyiség **nem külön szelet**, hanem az „ismételt kontextus" alatti „ebből" megjegyzés — különben ugyanazt a tokent kétszer számolnánk. A forint/euró érték a meglévő `costEstimate` összegéből jön, nem újraszámolt tarifából.

- **Megtakarítás-sáv, nem pontszám.** Minden mintához egy alsó–felső sáv tartozik: felső = a mintához rendelt, mérten pazarolt token teljes megszűnése, alsó = ennek a fele. A sáv **soha nem lehet nagyobb**, mint az agent ablakbeli tényleges költsége, és a kártya kimondja, hogy becslés. Ahol nincs mérhető alap (pl. cache-adat hiánya), nincs sáv.

- **Egy kattintásos alkalmazás csak ott, ahol tényleg van kapcsoló.** A javaslat az agent `modelConfig` JSON-jába ír per-agent felülbírálást — ez a meglévő, bevált precedencia (`resolveLoopGuardLimits`: `modelConfig` → env → default). A v1-ben három kapcsoló alkalmazható:
  - kontextus-hízásra a szigorúbb tömörítés (`maxToolResultChars`, `keepRecentToolResults`),
  - ismétlődő visszaolvasásra a szűkebb forrás-keret (`sourceIngestFactor`, `sourceIngestMinChars`),
  - elszaladó körökre a szűkebb eszköz-büdzsé (`maxToolCalls` — ez ma is `modelConfig`-ból jön).

  Ehhez a `resolveContextCompactionLimits` és a `resolveSourceIngestLimits` kiegészül a `resolveLoopGuardLimits`-szel azonos `modelConfig`-overlay-jel; a hívó (`chat-tool-loop.ts`) átadja az agent `modelConfig`-ját. Ez **nem** új viselkedés, csak a meglévő küszöbök agent-szintű hangolhatósága.

- **Amire nincs kapcsoló, arra nincs gomb.** A cache-prefix törés és a túlméretezett eszköz-kimenet mintájánál a kártya magyaráz és linkel (a prompt-cache spec, illetve az adott eszköz/connector felülete felé), de nem kínál alkalmazást. Egy nem létező kapcsolót nem találunk ki csak azért, hogy legyen mit megnyomni.

- **Jogosultság és audit.** A kártya megtekintése az agent-adatlap meglévő láthatósági szabályát követi; az **alkalmazás tenant adminhoz kötött**, mint a `taskOnly` / `hiddenFromOperators` váltás. Minden alkalmazás `AuditLog` bejegyzést ír (`agent.efficiency_hint_applied`) a régi és az új értékkel, és a felületen egy kattintással visszaállítható.

- **Tenant-izoláció és tartalom-mentesség.** A lekérdezés a meglévő tenant-szűrésre épül; a kártya kizárólag **számokat, eszközneveket és forrás-kulcs darabszámokat** mutat — prompt-szöveget, eszköz-eredményt, fájltartalmat soha. Így a tanácsadó nem nyit új adat-utat a privacy-gateway megkerülésével.

- **Korlátos lekérdezés.** Alapértelmezett ablak: 30 nap **vagy** a legutóbbi 20 futás, amelyik szűkebb. A futás-lista DB-oldali `groupBy`/aggregáció; a részletes sorokat csak a kiválasztott futásokra, indexelt szűréssel (`ModelCall(agentId, createdAt)`, `ToolCall(agentId, createdAt)`, `ModelCall(agentTurnId)`, az új `ToolCall(agentTurnId)`) és felső sor-korláttal olvassuk. A `docs/perf/github-issues/003-paginate-unbounded-lists.md` „legyen felső korlát minden listalekérdezésen" szabálya itt kötelező.

- **Nincs háttérfeladat, nincs új tábla.** A v1 kártyája kérésre számolódik. Ha később a fleet-szintű rangsor vagy a trend kell, az egy külön, ütemezett aggregáció lesz — a detektor-modul akkor is változatlanul használható, mert tiszta.

## Testing Decisions

- **Mit tesztelünk (külső viselkedés).** A megfigyelt egység a **detektor kimenete**: adott futás-halmazra mely minták jelennek meg, milyen mérőszámmal és milyen megtakarítás-sávval. Nem tesztelünk belső segédfüggvényt, és nem tesztelünk szövegformázást a magyarázat-kulcson túl.

- **A seam: tiszta függvény.** A tesztek az `efficiency-advisor.ts` belépési pontját hajtják, kézzel összeállított futás-bemenettel — Prisma és gateway nélkül. Futtatás a repó bevett mintája szerint: `scripts/efficiency-advisor.test.ts`, `npm run test:efficiency-advisor`, `node:assert/strict`-tel, ahogy a `scripts/turn-cost-signals.test.ts` teszi.

- **A mérce a MÉRT eset.** Az elfogadási feltétel kétirányú, ahogy a #180 tesztjénél:
  1. A 2026-07-29-i incidens alakja (149 eszközhívás, 132 újraolvasás, 40 kör, monoton növő prompt) **kiváltja** az ismétlődő-visszaolvasás és a kontextus-hízás mintát, és a megtakarítás-sáv nem nagyobb a futás tényleges költségénél.
  2. Egy normál, 3–5 eszközhívásos, 2 modellhívásos futás **egyetlen mintát sem** vált ki.

- **Kulcs-assertek:**
  1. **Minta-méret kapu:** 2 futásból (vagy egyetlen futásból) a kártya „nincs elég adat" állapotot ad, nem mintát.
  2. **Cache: `null` ≠ 0.** Csupa `null` `cachedPromptTokens` esetén „nincs cache-adat" állapot, minta és megtakarítás-sáv nélkül; 0-ás értékek mellett viszont a minta megjelenik.
  3. **Nincs kettős könyvelés:** a token-bontás szeleteinek összege pontosan a `ModelCall` token-összeg; az újraolvasás-becslés annotáció, nem szelet.
  4. **Fékbe futott visszaolvasás számít:** a `resultMeta.blocked === true` sorok is beleszámítanak az újraolvasási arányba.
  5. **Küszöb-feloldás:** érvénytelen vagy a detektort elnémító env-érték az alapértékre esik vissza.
  6. **Determinizmus:** azonos bemenetből azonos kártya; a minták sorrendje a becsült megtakarítás szerint stabilan rendezett.
  7. **Sáv-korlát:** a megtakarítás-sáv felső vége soha nem haladja meg az ablakban ténylegesen elköltött összeget.

- **Alkalmazás-út tesztje.** A `modelConfig`-overlay a meglévő `resolveLoopGuardLimits` mintáját követi, ezért ugyanazon a szinten tesztelhető: `modelConfig` → env → default precedencia, clamp az épeszű tartományra, és hogy a felülbírálás **szigorítani tud, kikapcsolni nem**.

- **Prior art.** `scripts/turn-cost-signals.test.ts` (küszöb-tesztek mért esettel), `scripts/context-compactor.test.ts` (tiszta transzformáció). A tanácsadó ugyanebbe a családba tartozik.

## Out of Scope

- **Futás közbeni beavatkozás.** A tanácsadó nem állít le futást, nem módosít promptot, nem választ modellt. A futás közbeni fékek (#179/#180) változatlanok.
- **Automatikus alkalmazás.** A javaslatot mindig ember nyomja meg. Nincs „önjavító" mód, nincs automatikus küszöb-hangolás.
- **Fleet-szintű rangsor és trend.** „Melyik agentem a legpazarlóbb a szervezetben", idősoros trend, riasztás-küldés — külön, későbbi lépés; a v1 agent-szintű kártya.
- **Üzleti megtérülés.** A „megérte-e" kérdés a #118 tárgya (ticket/folyamat-szintű költség és alapvonal-eltérés). Ez a spec a **technikai hatékonyságról** szól, nem az üzleti értékről.
- **Indítás előtti becslés.** A futás előtti költség-sáv és hatókör-előnézet a #230 tárgya. Ez a spec **utólag** elemez.
- **Új futásidejű mérés a forró úton.** A `result_chars` és a `ToolCall.agentTurnId` kivételével nem vezetünk be új írást; a detektorok a meglévő sorokból dolgoznak.
- **Prompt-cache mechanizmus javítása.** A stabil prefix sorrendje és a cache-breakpointok külön specek tárgya (`…-Prompt-Cache-Prefix-Ordering.md`, `…-Prompt-Cache-Control-Breakpoints.md`); itt csak **kimutatjuk**, ha a cache nem fog.
- **Eszköz- és connector-oldali javítás.** A túlméretezett kimenetet adó végpont szűkítése (aggregált végpont, mezőlista) fejlesztői/konfigurációs munka; a tanácsadó megnevezi, nem végzi el.
- **Historikus backfill.** A bevezetés előtti sorokra nem töltjük vissza az új mezőket; a régebbi időszak durvább bontással elemezhető.

## Further Notes

- **Miért éri meg olcsón.** A négy detektor mindegyike **már meglévő, indexelt oszlopokból** dolgozik: `ModelCall(agentTurnId, createdAt, promptTokens, cachedPromptTokens)` és `ToolCall(agentId, createdAt, toolName, argsMeta, resultMeta, outcome)`. A #180 WP-2/WP-3 épp azt a két hiányt szüntette meg (per-forduló kötés, belső eszközhívások naplózása), ami nélkül ez az elemzés nem lenne lehetséges — ez a spec ennek a befektetésnek a kamata.
- **Miért agent-szinten.** A forduló-szintű riasztás (`turn-cost-signals.ts`) egyetlen kört véd, és üzemeltetőnek szól. A pazarlás viszont **agent-tulajdonság**: ugyanaz a rossz szokás minden futásban visszatér. Ezért az összesítés grain-je az agent, és a címzett a felelős, nem az üzemeltető.
- **A „nincs elég adat" nem hiba.** A kártya három állapotot ismer: *rendben*, *van megállapítás*, *nincs elég adat*. A harmadik ugyanolyan érvényes válasz, mint a másik kettő — egy két futásból számolt „60% újraolvasás" rosszabb a semminél, mert cselekvésre biztat.
- **A becslés őszintesége.** A ~4 karakter/token átváltás durva, és ezt a kártya ki is mondja. A megtakarítás-sáv alsó fele szándékosan konzervatív: jobb alábecsülni és beváltani, mint túlígérni.
- **Kapcsolódó munkák.** Ráépül a #180-ra (nyers jelek → itt értelmezés). Kiegészíti a #118-at (üzleti megtérülés) és a #230-at (indítás előtti becslés). A #179 munkaterület-alapú részeredménye és a `context-compactor` az a **meglévő eszköztár**, amire a javaslatok mutatnak.
- **Következő természetes lépés.** Ha a kártya bevált, ugyanez a detektor-modul változtatás nélkül kiszolgál egy ütemezett fleet-áttekintést és egy „ez az agent romlott az elmúlt héten" jelzést — a tisztaság miatt ehhez csak egy másik hívó kell, nem másik logika.
