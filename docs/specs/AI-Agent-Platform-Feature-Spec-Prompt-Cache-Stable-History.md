# AI Agent Platform — Feature Spec: Prompt-cache stabil előzmény (a gördülő ablak megszüntetése)

**Státusz:** grill-lezárt, kód nincs
**Dátum:** 2026-08-25
**Előzmény:** `AI-Agent-Platform-Feature-Spec-Prompt-Cache-Prefix-Ordering.md` (stabil zóna sorrendje),
`AI-Agent-Platform-Feature-Spec-Prompt-Cache-Control-Breakpoints.md` (explicit `cache_control` a stabil zóna végén)
**Kapcsolódik:** #375 (nyomonkövethetőség — a közös eredetű grill másik fele),
`agent-memory-persistent-cross-conversation-spec.md`, `ai-privacy-gateway-spec.md` (APG-15 álnév-invariáns)

## Problem Statement

A prompt három zónából áll: **stabil** (agent-szintű, hívások közt azonos), **változó**
(per-forduló visszakeresett adat) és **előzmény** (a beszélgetés üzenetei). Az első két
zónát a korábbi két spec rendezte: a stabil rész elöl áll, és — ahol a provider explicit
jelölést vár — cache-határt is kap.

A harmadik zóna érintetlen maradt, és **garantáltan cache-hibát okoz minden providernél**.
A `context-assembly.ts` az előzményből az utolsó **16** érvényes üzenetet tartja meg
(`DEFAULT_CONTEXT_RECENCY_MESSAGES`), majd erre még ráhúz egy **10 000 tokenes** keretet
(`DEFAULT_CONTEXT_BUDGET_TOKENS`), amit hátulról előrefelé vág. A 17. üzenettől kezdve
tehát **az előzmény első üzenete minden fordulóban más** — az üzenet-szintű prefix
elmozdul, és a providerek automatikus prefix-cache-e (ChatGPT OAuth, Claude Code OAuth,
Grok, Gemini, Ollama) soha nem tud találni rá. Az explicit jelölést váró úton (OpenRouter)
pedig nincs is határ az előzmény végén, tehát ott sincs mit cache-elni.

A hiány kettős, és mindkét fele néma:

1. **Költség.** Az előzmény minden fordulóban, minden providernél teljes áron megy ki. A mai
   modelleknél a cache-olvasás a beszámított input-ár ~0,1-szerese; ebből az következik, hogy
   egy **teljes, stabil előzmény cache-ből olvasva jellemzően olcsóbb fordulónként**, mint a
   mai csonkolt ablak, ami sosem tud cache-be kerülni. A csonkolással nem spórolunk — a
   spórolás eszközéről mondunk le.
2. **Minőség.** A 16. üzeneten túli előzményt némán eldobjuk (`droppedSeqs`, csak egy
   `context.truncated` audit-sor). A felhasználó felfelé görgetve látja a saját mondatát, a
   modell nem — és a felületen semmi nem magyarázza meg. A mai modellek kontextusablaka
   1M token; a 10 000-es keret egy jóval kisebb és drágább modell-korszak beállítása.

Van egy **kemény blokkoló** is: az APG-15 álnév-invariáns (`assertCachedPrefixSurrogateInvariant`)
**hibát dob**, ha a cache-elt prefix bármely pontján `[[TÍPUS_N]]` alakú álnév szerepel.
Az előzmény cache-elése tehát ma nem csak „nem történik meg", hanem **technikailag tiltott**:
az őr nem tesz különbséget a beszélgetések közt megosztott (agent-szintű) prefix és az
egyetlen beszélgetéshez tartozó előzmény között.

## Solution

Négy lépés, séma-változtatás nélkül:

1. **A csonkolás megszüntetése.** A `context-assembly` az előzményt **append-only**
   sorozatként adja tovább: nincs 16-os ablak és nincs 10 000-es hátulról vágó keret.
   Így az előzmény bájt-prefixe fordulóról fordulóra **csak nő**, sosem mozdul el —
   ez az egyetlen feltétel, amit minden provider automatikus cache-e kér.
2. **A változó zóna az előzmény mögé kerül.** A memória-blokk, a munkaterület-fájllista és a
   `kb_search` találatok ma az előzmény **elé** ékelődnek, és fordulónként változnak — ezzel
   érvénytelenítenék a mögöttük álló, immár stabil előzményt. Ezek a blokkok az előzmény
   **után** kerülnek: ahol a modell támogatja, a beszélgetésbe fűzött `role: "system"`
   üzenetként (nem hamisítható üzemeltetői csatorna), máshol az utolsó felhasználói
   fordulóhoz csatolt, „adat, nem utasítás" jelöléssel ellátott blokként. **A blokk szövege
   mindkét formában bájtra azonos** — csak a burkolat különbözik.
3. **Cache-határ az előzmény végén.** Ahol a provider explicit jelölést vár, a stabil zóna
   határa mellé egy második, **mozgó** határ kerül az előzmény utolsó üzenetére. Ahol a
   cache automatikus, nincs teendő: az 1. lépés önmagában elég.
4. **Az álnév-invariáns szűkítése.** A tiltás a **megosztott, agent-szintű** zónára
   korlátozódik; a beszélgetés saját előzményére nem vonatkozik. Az álnevek beszélgetés-scope-ú
   széfben élnek (`PrivacyScope { type: 'conversation' }`), tehát ugyanaz az entitás a
   beszélgetésen belül végig ugyanazt az álnevet kapja — az előzmény bájtjai emiatt nem
   változnak fordulónként, és a beszélgetés-scope-ú cache-bejegyzés ugyanahhoz a
   jogosultsági körhöz tartozik, mint maga a beszélgetés.

Kiegészítésként a felület **időben szól**, ha egy beszélgetés a modell kapacitásához közelít
(„Ez a beszélgetés nagyon hosszú — érdemes újat kezdeni"), és a döntést a felhasználóra
hagyja. Automatikus tömörítés ebben a lépésben **nincs**: az egyszer is megváltoztatná a
prompt elejét, márpedig a cél éppen az, hogy soha ne változzon.

## User Stories

1. Platform-üzemeltetőként azt szeretném, hogy egy több-fordulós beszélgetés előzménye a
   második fordulótól cache-ből olvasódjon, hogy a ma fordulónként újra kifizetett
   előzmény-token eltűnjön a számláról.
2. Platform-üzemeltetőként azt szeretném, hogy ez a megtakarítás **provider-független**
   legyen — az automatikus cache-t kínáló providereknél is éljen, ne csak ott, ahol explicit
   jelölést küldünk.
3. Platform-üzemeltetőként azt szeretném, hogy a megtakarítás mérhető legyen a meglévő
   cache-token metrikán, hogy egy néma regresszió (valami újra elmozdítja az előzményt)
   észrevehető legyen.
4. Chat-felhasználóként azt szeretném, hogy az agent emlékezzen arra, amit feljebb írtam,
   mert a képernyőn látom — ne csak az utolsó 16 üzenetre.
5. Chat-felhasználóként azt szeretném, hogy ha egy beszélgetés tényleg túl hosszúra nyúlik,
   azt **előre** megtudjam, ne utólag abból, hogy az agent elfelejtett valamit.
6. Agent-fejlesztőként azt szeretném, hogy a visszakeresett memória- és KB-adat az előzmény
   **után** kerüljön a promptba, hogy a természetes változékonysága ne rontsa el a mögötte
   álló előzmény cache-elhetőségét.
7. Adatvédelmi felelősként azt szeretném, hogy egy beszélgetés álneve **továbbra is hibát
   okozzon**, ha a beszélgetések közt megosztott, agent-szintű prefixbe kerül — a szűkítés
   csak a beszélgetés saját előzményére vonatkozzon.
8. Platform-fejlesztőként azt szeretném, hogy a döntést adat támassza alá: mérjük meg a
   valós beszélgetés-hosszakat és az üzenetek közti időt, mielőtt a keretekhez nyúlunk.

## Implementation Decisions

- **Két beállítás megy ki, nem egy.** A `DEFAULT_CONTEXT_RECENCY_MESSAGES` (16) **és** a
  `DEFAULT_CONTEXT_BUDGET_TOKENS` (10 000) egyaránt elmozdítja az előzmény elejét — az
  előbbi elölről dob, az utóbbi hátulról vág, de a kimenő tömb első eleme mindkettőnél
  változhat. Csak az egyik eltávolítása nem old meg semmit.

- **A törölt tartalmú üzenet marad kizárva.** A megőrzési takarítás által kiürített üzenetek
  (`contentDeletedAt`) továbbra sem kerülnek a promptba. Ez egyszeri, ritka
  cache-érvénytelenítés az adott beszélgetésben — elfogadjuk, nem kezeljük külön.

- **A mozgó határ az előzmény utolsó üzenetére kerül.** A szabvány több-fordulós minta: a
  legutóbb hozzáfűzött forduló utolsó blokkja kapja a jelölést, és a korábbi bejegyzések
  továbbra is olvasható pontok maradnak, így a találatok a beszélgetés növekedésével
  halmozódnak. A meglévő 4-es plafon és a „csak system/user szöveges üzenet lehet határ"
  szabály változatlanul él.

- **A 20-blokkos visszanézési ablak a tool-nehéz fordulóknál számít.** Ha egyetlen forduló
  20-nál több blokkot fűz hozzá (sok tool-hívás), a következő kérés határa nem találja meg az
  előző bejegyzést, és némán elvéti. A tool-loop tail-ben ezért köztes határ kerül
  ~15 blokkonként, a 4-es plafonon belül.

- **Az eszközhívás-összegzés determinizmusa külön ellenőrzendő.** A korábbi fordulók
  renderelése tartalmazza az adott fordulóban futott `ToolCall`-ok szinopszisát, **időablak
  alapján** (`windowStart < createdAt <= message.createdAt`). Ha egy tool-rekord késve
  íródik meg (leválasztott/aszinkron ág), egy korábbi forduló szövege utólag megváltozhat —
  és ezzel az egész előzmény-cache elszáll. Ezt a WP-F tesztje fedi le; ha a késői írás
  valós, a szinopszist a forduló lezárásakor **egyszer** kell rögzíteni, nem lekérdezésenként
  újraszámolni.

- **A változó blokk kétféle burkolata, azonos szöveggel.** A `role: "system"` beszélgetés
  közbeni üzenet a nem hamisítható üzemeltetői csatorna, de nem minden modell fogadja el
  (elutasításnál 400). A fallback a mai, „adat, nem utasítás" jelöléssel ellátott blokk az
  utolsó felhasználói fordulón. A **szöveg bájtra azonos** a két úton, hogy a modell
  viselkedése ne váljon provider-függővé; a cache szempontjából a két forma egyenértékű,
  mert mindkettő az előzmény mögött áll.

- **Az álnév-invariáns zóna-tudatossá válik.** A `findSurrogatesInCachedPrefix` ma a
  *legnagyobb indexű* határig vizsgál. Ehelyett a **stabil zóna határáig** kell vizsgálnia; az
  előzmény-határ által lefedett szakasz nem esik a tiltás alá. A megkülönböztetés az
  assemblertől jön (melyik határ melyik zóna vége), nem indexek találgatásából.

- **Nincs automatikus tömörítés ebben a lépésben.** A providerek kínálnak szerveroldali
  tömörítést, és a platform is építhetne sajátot — de mindkettő **megváltoztatja a prompt
  elejét**, ami pontosan az, amit ez a spec meg akar szüntetni. A hosszú beszélgetésre a
  válasz egy felületi figyelmeztetés; a tömörítés csak akkor kerül napirendre, ha a WP-A
  mérése kimutatja, hogy egyáltalán vannak ilyen beszélgetések.

- **A TTL nem a mi döntésünk.** A hat provider közül egynek küldünk explicit jelölést; a
  többinél a cache automatikus, saját, providerenként eltérő lejárattal. A rendszer
  feltételezi, hogy van automatikus cache, és úgy építi a promptot, hogy az működjön. A
  meglévő `GATEWAY_PROMPT_CACHE_TTL` beállítás marad, ahol értelmezett — hangolása a WP-A
  mérése után, üzemeltetési döntés, nem spec-döntés.

## Testing Decisions

- **Mit tesztelünk (külső viselkedés).** (1) A `context-assembly` kimenő üzenetsora
  (az előzmény append-only-e), (2) az assembler zóna-sorrendje és határai, (3) a
  providerhez ténylegesen kimenő request body.

- **Kulcs-assertek:**
  1. **Append-only prefix:** N és N+1 fordulónál a kimenő üzenetsor első *k* eleme bájtra
     azonos; a 17. üzenet után is (ez a mai viselkedés regressziós ellentéte).
  2. **Zóna-sorrend:** stabil → előzmény → változó blokk; a memória/KB/fájllista **az
     előzmény után** áll.
  3. **Burkolat-ekvivalencia:** a `role: "system"` és a fallback forma szövege bájtra
     azonos; csak a burkolat különbözik.
  4. **Mozgó határ:** az előzmény utolsó üzenete jelölt; a változó blokk jelöletlen.
  5. **Álnév-invariáns:** beszélgetés-scope-ú álnév az **előzményben** megengedett; ugyanaz
     az álnév a **stabil zónában** továbbra is hibát dob.
  6. **Tool-szinopszis determinizmusa:** ugyanarra a beszélgetésre kétszer felépített
     előzmény bájtra azonos, akkor is, ha közben új `ToolCall` sor keletkezett egy korábbi
     forduló időablakában.
  7. **Törölt üzenet:** a kiürített tartalmú üzenet kimarad, és ez az egyetlen megengedett
     prefix-elmozdulás.

- **Futtatás:** a meglévő `npm run test:prompt-cache` blokk bővítése.

## Munkacsomagok

- **WP-A · Mérés.** Két egymást követő üzenet közti idő eloszlása; beszélgetésenkénti
  üzenetszám és token-hossz eloszlása; hány beszélgetés lépi túl a mai 16-os, illetve
  10 000-es korlátot. *Enélkül a többi csomag méretezése találgatás.*
- **WP-B · A csonkolás megszüntetése** (16-os ablak + 10 000-es keret), a hosszú beszélgetés
  felületi figyelmeztetésével.
- **WP-C · Zóna-sorrend:** a memória-, fájllista- és KB-blokk az előzmény mögé, kétféle
  burkolattal, azonos szöveggel.
- **WP-D · Mozgó cache-határ** az előzmény végén (explicit jelölést váró providereknél),
  köztes határokkal a tool-nehéz fordulókban.
- **WP-E · Az álnév-invariáns szűkítése** zóna-tudatosra + a tiltás megmaradását bizonyító
  teszt.
- **WP-F · Regressziós teszt:** a 2. és 3. forduló promptjának eleje bájtra azonos; a
  tool-szinopszis determinizmusa.

Javasolt sorrend: **WP-A → B → C → D/E → F**. A WP-B önmagában, a WP-C nélkül is javítja a
minőséget, de a megtakarítást csak a WP-C-vel együtt hozza.

## Out of Scope

- **Automatikus tömörítés / összefoglalás** hosszú beszélgetésre — l. Implementation
  Decisions; csak a WP-A mérése után, külön jegyben.
- **A folytonos munkatárs-szál, a téma-szakaszok és az átvitel-blokk.** A #375 grillje ezt
  elvetette: a beszélgetések külön maradnak, a fájdalom a nyomonkövethetőség, nem a
  session-ek száma.
- **Cache-tudatos költségbecslés** (a tarifa-tábla cache-szorzói) — változatlanul a korábbi
  spec Out of Scope-ja.
- **Gemini explicit context caching** (CachedContent + TTL) — külön provider-API.
- **A `projectKey` élővé tétele.** A webes chat ma soha nem ír `projectKey`-t, így minden
  webes beszélgetés memóriája a `__general__` gyűjtőbe kerül. Valós hiányosság, de nem ennek
  a specnek a tárgya.

## Further Notes

- **Miért provider-független a javítás.** A hat providerből ötnél szándékosan **nem** küldünk
  cache-jelölést, mert ott a prefix-cache automatikus. Az automatikus cache egyetlen feltétele
  a bájt-azonos prefix — vagyis a gördülő ablak eltávolítása mind a hat providernél hoz
  megtakarítást, provider-specifikus munka nélkül. Az explicit határ (WP-D) csak a hatodikon
  ad pluszt.
- **Miért nem drágább a teljes előzmény.** Cache-olvasás ~0,1×, cache-írás ~1,25× a beszámított
  input-árhoz képest. Amíg a fordulók a provider lejárati ablakán belül követik egymást, a
  teljes előzmény cache-ből olvasva olcsóbb, mint a mai, sosem cache-elt 10 000 tokenes ablak.
  A kockázat a ritkán használt beszélgetés (hideg írás minden fordulónál) — ezt méri a WP-A.
- **Megőrzés-kapcsolat.** Ma egyetlen `RetentionPolicy` sor sem hozható létre felületről, így
  `retainUntil` mindenhol `null`, és a takarító sosem talál semmit. Amikor ez élesedik, a
  kiürített üzenetek egyszeri prefix-elmozdulást okoznak az érintett beszélgetésben —
  elfogadható. (Külön, itt nem kezelt hiányosság: a `Conversation.title` titkosítatlan oszlop,
  és a felhasználó első mondatából készül, tehát a shredding után is olvasható marad.)
