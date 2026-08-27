# Fejlesztői specifikáció — Skill-katalógus Fázis 2 (kód-hordozó skillek: T2/T3)

Státusz: **Tervezet** · **Kanonikus hely: #396** — a spec GitHub issue-ként él, ez a fájl a részletes forrás · Forrás: `skill-catalog-spec.md` §6 + D13 (2026-07-07 grill-me) alapján, kódbázis-feltárással kiegészítve (2026-07-21), felülvizsgálva (2026-08-27, §0.4) · Kapcsolódó specek: `skill-catalog-spec.md` (Fázis 1, KÉSZ), `AI-Agent-Platform-Koncepcio.md` §4.6.3–4.6.4, §4.9

> **⚠️ Olvasási sorrend:** ha ezt a specet implementálod, **először a §0.4-et olvasd el**. A 2026-08-27-i felülvizsgálat négy ponton korrigálja a lenti szöveget — köztük egy olyan feltételezést (P2-D1 docker-flagek), ami élesben nem áll, és egy munkacsomagot (WP-15), ami időközben elkészült.

> **Fontos:** ez a spec **nincs grillezve** — a Fázis 1 D13 döntésének kibontása + a ténylegesen meglévő kód (nem a Fázis 1 spec §0.1-ben *feltételezett* kód) alapján készült. §0.2 pontosan megmondja, hol tért el a feltételezés a valóságtól. Mielőtt ez implementálásra kerül, a döntéseket (§1) egy grill-me körben át kell futtatni — különösen a P2-D3 (eval-gate) és P2-D6 (jóváhagyási mechanizmus) pontokat, ahol a kódbázis-feltárás új, nem triviális választásokat tárt fel.

## 0. Vezetői állítás

> **Közérthetően:** A Fázis 1 skill-katalógus csak *szöveges instrukciót* tartalmazó skilleket enged be — ezek tehetetlenek önmagukban, a hatalmukat a hozzájuk rendelt tool-jogosultság adja. Vannak viszont skillek, amik **futtatható kódot** hoznak magukkal (pl. egy Python-szkript, ami egy Excel-riportot generál). Ezt kétféleképpen lehetne kezelni: (a) lefuttatni az idegen kódot egy elszigetelt dobozban, vagy (b) a kódot csak **specifikációnak** tekinteni, és a mi agentünkkel **újraírat­ni natívan**. A Fázis 1 D13 döntése a (b) utat választotta — a kockázat így nem tűnik el, csak áttolódik: az agent-írta kód **ugyanazon a kapun** megy át, mint az idegen kód (nincs kedvezmény azért, mert "a miénk írta"). Ez a spec azt írja le, mi kell ehhez ténylegesen: egy valódi, OS-szintű elszigetelt futtatókörnyezet, egy erősebb statikus vizsgálat, egy viselkedést mérő "vizsga" (eval-kapu), és maga az újraíró agent.

**Kulcs-korrekció a Fázis 1 spechez képest:** a Fázis 1 spec §0.1-je két meglévő elemet Fázis 2 alapkőnek jelölt (`Eval`/`EvalRun`, `docker-local-harness-launcher.ts`). A kódbázis-feltárás (§0.2) megmutatta, hogy ezek **léteznek és élesben futnak**, de **más célra** — egyik sem nyújtja azt, amire a D13 számít. Ez nem a Fázis 1 hibája (a séma és a launcher tudatosan Fázis 2-re előkészítve épült), de a Fázis 2 tervezésnek pontosan kell tudnia, mi az, amit **bővíteni** lehet, és mi az, amit **nulláról** kell megépíteni.

### 0.1 Ami MÁR VAN és ténylegesen reuse-olható

| Elem | Kód | Mit ad ténylegesen |
|---|---|---|
| `Eval`/`EvalRun` tábla + `EvalService` | `eval-service.ts`, `schema.prisma` (`// ── Fázis 2: Eval-kapu ──` komment) | Élesben fut, de **agent-memória tanítási jóváhagyáshoz** kötve (`agentId`, nem `skillVersionId`). Az assertion-motor (`contains`/`not_contains`/`min_length` string-check) egyszerű determinisztikus szabály-kiértékelő — **a mintázat** (kapu → `passed`/`score` → blokkol, ha bukik) reuse-olható, a motor maga nem elég viselkedés-méréshez.
| `docker-local-harness-launcher.ts` | ua. | Konténer **indítási mechanizmust** ad (spawn + env-átadás) — ez a bázis, amire az izolációs réteget rá lehet építeni.
| `WriteGateService` (single-use CAS token) | `write-gate-service.ts` | A TOCTOU-biztos issue/consume állapotgép mintája reuse-olható **mintaként**, jelenleg **memória/tanítási írásra** kötve (`trainingTicketId`/`memoryCandidateId` horgony, `targetMemoryId` kötelező mező).
| `SkillDistillerAgent` | `skill-distiller-agent.ts` | Architekturális előkép a "regeneráló agent"-hez: LLM-ügynök, ami **javasolt** (`proposed`) `SkillVersion`-t állít elő külső bemenetből, a **változatlan** hardcoded validátoron megy át, provenience-kedvezmény nélkül. Nem kódot desztillál (beszélgetést desztillál), de a mintát (bemenet → új verzió-javaslat → azonos kapu) érdemes követni.
| `Skill.riskTier` enum (`t0`/`t1`/`t2`/`t3`) | `schema.prisma:862` | A `t2`/`t3` érték már **létezik a sémában** (kommentben jelölve: `// F1: csak t0/t1`) — csak levezető logika nincs rá.
| Tool Broker (`AllowlistAuthorizer`) | `tool-broker-authorizer.ts` | Capability/connector/tenant-scope-olt autorizációs döntés — ez a "melyik toolt hívhatja az agent" kérdésre válaszol, nem hálózati tűzfal.
| `skill-validator.ts` kód-detektálás | ua. | Regex-alapú (fenced code + shebang) — Fázis 1-ben ez **elutasít**; Fázis 2-ben ugyanez a hely lesz a **tier-levezetés** belépési pontja, de a felismerést meg kell erősíteni (§1, P2-D4).

### 0.2 Amit a Fázis 1 spec TÉVESEN feltételezett készen állónak — pontosítás

| Feltételezés (Fázis 1 spec §0.1) | Valóság (kódbázis-feltárás, 2026-07-21) |
|---|---|
| "Agent-harness Docker-izoláció egress-enforce-szal (Fázis 2 sandbox-alap)" | A launcher **nem állít be** hálózati namespace-t, olvasás-only fájlrendszert, erőforrás-limitet, cap-drop-ot vagy seccomp-profilt — grep-elve nulla találat ezekre a Docker-flagekre. Az `egressEnforce` egy **in-process önteszt** (a harness maga próbál kiérni egy tiltott URL-re induláskor, és hibát dob, ha sikerül) — ez bizonyíték, nem kikényszerítés. A tényleges hálózati korlátozás (ha van) a GCP Cloud Run VPC/firewall-szinten történik, ami **ezen a repón kívül** van, és a spec nem feltételezheti a garanciáit ellenőrzés nélkül.
| "Eval-kapu (Fázis 2 regenerációhoz)" | Az `Eval`/`EvalRun` séma és `EvalService` **skillre nincs kötve** (nincs `skillVersionId` mező sehol), és az assertion-motor szöveg-egyezés, nem viselkedési diff. Skill-eval-gate-hez vagy új horgony (séma-migráció) kell, vagy párhuzamos tábla — és az motor maga bővítendő.
| "Write-gate reuse (WriteGateToken)" a skill-aláíráshoz | A Fázis 1 skill-jóváhagyás **NEM** a `WriteGateToken` egyszer-használatos CAS-táblát használja — egy egyszerűbb `signSkillVersion` HMAC-et hív közvetlenül (`hash-chain.ts`), replay-védelem és lejárat nélkül. A `WriteGateToken` tábla ma kizárólag a memória/tanítási írás-útvonalhoz van kötve (`trainingTicketId`/`memoryCandidateId`, kötelező `targetMemoryId`). A T2/T3 jóváhagyás magasabb tétje miatt ez a spec (P2-D6) explicit döntést kér: migráljunk-e a CAS-mechanizmusra.

### 0.3 Ami ÚJ (ennek a specnek a tárgya)

1. **OS-szintű sandbox-futtatási szerződés** — valódi hálózati namespace-elzárás, read-only efemer fájlrendszer, erőforrás-limit (CPU/memória/idő), cap-drop, seccomp. *(P2-D1, WP-8)*
2. **Brokerelt hálózati egress-proxy** — a sandboxból induló forgalom ténylegesen a Tool Broker autorizációján megy át, nem csak egy önteszt. *(P2-D7, WP-9)*
3. **Erősebb statikus vizsgálat + T2/T3 tier-levezetés** — AST-alapú kód-felismerés és -elemzés a jelenlegi regex helyett. *(P2-D4, WP-10)*
4. **Kód-bundle séma** — a `SkillVersion` jelenlegi `content`/`requires` JSON-ja nem hordoz kódot; új mező/tábla kell. *(P2-D2, WP-11)*
5. **Skill-eval-kapu** — viselkedés-mérés a referenciaverzióhoz képest, blokkoló kapuként. *(P2-D3, WP-12)*
6. **Regeneráló agent** — a külső/desztillált kódot *specifikációnak* tekintő, natívan újraíró LLM-ügynök. *(P2-D5, WP-13)*
7. **T2/T3 jóváhagyási kapu megerősítése** — döntés a `WriteGateToken` CAS-mechanizmusra migrálásról. *(P2-D6, WP-14)*
8. **Level-2 mellékletek** — szkriptek/dokumentumok progresszív betöltése a Fázis 1 Level-0/Level-1 fölött. *(P2-D8, WP-15)*
9. **Upstream-frissítés jelzés / re-import diff** — importált skill forrásának változását jelző mechanizmus. *(P2-D9, WP-16)*

### 0.4 2026-08-27 felülvizsgálat — négy korrekció ehhez a spechez

A §0.2 a *Fázis 1* spec téves feltételezéseit korrigálta. Az alábbi négy lelet **ezt a Fázis 2 specet** korrigálja. Kiváltó ok: felmerült a kérdés, kaphatnának-e az agentek shell/bash eszközt — a feltárás megmutatta, hogy az és a kód-hordozó skill **ugyanarra a hiányzó rétegre fut ki** (l. P2-D10). Teljes indoklás és a mért fájdalom: **#396**.

| # | Lelet | Hatás |
|---|---|---|
| **L1** | A Level-2 melléklet-réteg (P2-D8 / WP-15) **elkészült**: `SkillVersion.attachments Json?` (`schema.prisma:1109`), `load_skill_attachment` (`chat-tool-loop.ts:381`, végrehajtás `skill-service.ts:1529`), audit-esemény (`event-catalog.ts:375`), limitek `lib/skill/skill-attachments.ts`-ben (128 KB/fájl, 20 fájl, 512 KB, 30 000 karakter betöltéskor). Két eltérés a spectől: **nincs T2/T3-hoz kötve** (minden skillre él), és a melléklet **szövegként a promptba** kerül, nem futtatható artefaktként. | **WP-15 törlendő.** P2-D2 felülvizsgálandó: a meglévő `attachments` séma bővítése valószínűleg elég, új `codeBundle` tábla helyett. |
| **L2** | A kód-csatolást **egyetlen szűrő** tiltja: `lib/skill/skill-package-adapter.ts:64`, `CODE_EXTENSIONS` — 40+ kiterjesztés (`py`, `sh`, `js`, `sql`, …) kimarad importkor, `reason: 'code_file'`. Ez a Fázis 1 „kétség esetén elutasít" elvének fájl-szintű megvalósítása, **szándékos**. | Fázis 2-ben ez a hely **kapuvá alakul** (tier-levezetés belépési pontja), nem törlendő akadály. |
| **L3** | A `riskTier` levezetés ma egyetlen sor: `skill-validator.ts:104` — `requires.length > 0 ? 't1' : 't0'`. A `t2`/`t3` enum létezik a sémában, logika nincs mögötte. | **WP-10 nem „lecserélés", hanem nulláról építés.** |
| **L4** ⚠️ | **A P2-D1 docker-flag feltételezés Cloud Runon nem áll.** Élesben nem docker fut, hanem Cloud Run Job (`cloud-run-job-launcher.ts`, `infra/gcp/deploy-harness-job.sh`). A Cloud Run API **nem vesz át tetszőleges docker-flageket** — `--cap-drop`, `--read-only`, `--network none` nem adható meg. Cserébe a Cloud Run eleve **gVisor-izolációban** futtat (erősebb, mint a puszta docker), **de a kimenő hálózat alapból nyitva van**: a tiltás VPC-be kötés (`--vpc-connector` + `--vpc-egress=all-traffic`) és firewall deny-szabályok kérdése, azaz **repón kívüli GCP-konfiguráció**. Ami az API-n valóban állítható: `--cpu`, `--memory`, `--task-timeout` (ma `30m`), `--max-retries`. | **WP-8 újraírandó**: nem launcher-flag-bővítés, hanem futtató-platform-döntés (P2-D11) + GCP-konfiguráció. Új kockázat §5-ben. |

**Amiből viszont több van készen, mint a spec feltételezi** — a végrehajtó réteg köré álló váz: hitelesített per-futás konténer-indítás (`cloud-run-job-launcher.ts` + `cloud-run-auth.ts`), env-override-építés (`harness-run-env.ts`), completion-callback lock-tokennel (`harness/job-entrypoint.ts`), erőforrás-limit és timeout (`deploy-harness-job.sh`), egress-allowlist logika (`harness/egress-guard.ts`), Artifact Registry + Cloud Build pipeline, GCS-workspace (`file-editor/workspace-storage.ts`), és L1 szerint a kód-csatolás/verziózás/hash/audit. **Hiányzik:** futtató-image, workspace be/ki-csatolás konzisztencia-szabállyal, valódi egress-tiltás (L4), latencia-döntés (P2-D11).

## 1. Elvi keretek (döntés-javaslatok — grillezésre várnak)

Ezek **nem lezárt döntések**, hanem a D13 (Fázis 1) kibontásából és a kódbázis-feltárásból adódó javaslatok. A `P2-` előtag jelzi, hogy ezek a Fázis 2 spec saját döntései, megkülönböztetve a Fázis 1 D1–D14-től, amelyeket öröklünk és nem írunk felül.

- **P2-D1 — A sandbox nem a meglévő `docker-local-harness-launcher.ts` bővítése, hanem egy új, szigorúbb futtatási mód ugyanazon a launcheren keresztül.** A launcher *spawn-mechanizmusa* (konténer indítás, env-átadás) marad, de egy új `sandboxProfile: 'skill-execution'` (vagy hasonló) paraméter viszi be a D13 által megkövetelt flageket: `--network none` (majd a brokerelt proxy külön hálózati interfészen, §P2-D7), `--read-only` + `tmpfs` az efemer írható részekhez, `--memory`/`--cpus`/fali-idő limit, `--cap-drop=ALL`, seccomp-profil. **Miért külön profil, nem az alap mód szigorítása:** az agent-beszélgetés harnessének (mai használat) más az egress-igénye (Model Gateway, platform API elérése kell) — nem szabad véletlenül szigorítani az élesben futó utat egy skill-futtatás miatt.

- **P2-D2 — A kód-bundle NEM a `content`/`requires` JSON-t bővíti, hanem új, elkülönített mezőt/táblát kap a `SkillVersion`-ön.** A `content` (instrukciók) és `requires` (capability-manifeszt) sémája szándékosan szöveg-alapú és emberi-olvasható — egy bináris/többfájlos kód-bundle ide zsúfolása elmosná a T0/T1 vs T2/T3 határt a séma szintjén is. Javaslat: `SkillVersion.codeBundle: Json?` (fájlnév → tartalom/hash térkép, vagy objektum-tár referencia nagyobb bundle-ökhöz) + `SkillVersion.sandboxManifest: Json?` (a bundle mely belépési pontját, milyen futtatási paranccsal, milyen `requires`-hez kötve kell indítani). `contentHash` a bundle-t is bevonja.

- **P2-D3 — Az eval-gate skillekhez NEM az `Eval`/`EvalRun` táblák közvetlen kiterjesztése (`skillVersionId` FK hozzáadása), hanem egy párhuzamos `SkillEval`/`SkillEvalRun` pár, azonos mintára.** Indoklás: az `Eval.agentId` és a hozzá tartozó jóváhagyási folyamat (`memory-approval-service.ts`, `training-service.ts`) szemantikailag **agent-tanítási** eseményhez van kötve; egy skill-verzió jóváhagyása más életciklus (nem agent-verzióhoz, hanem globális/tenant-skill-katalógushoz kötött). A közös minta (kapu → `passed`/`score` → blokkol) átvehető kódszinten (megosztott `EvalAssertionEngine` interfész), de a táblák és a hívási pontok külön maradnak, hogy a meglévő memória-eval-gate audit- és jóváhagyási szemantikáját ne zavarja meg egy idegen entitás. **Az assertion-motort bővíteni kell:** a mai `contains`/`not_contains`/`min_length` string-check nem elég "viselkedés a referenciához képest" méréshez — kell legalább egy `sandbox_execution_matches_golden_output` assertion-típus, ami a jelölt kódot **is** a sandboxban (§P2-D1) futtatja egy rögzített bemenet-kimenet golden-seten, és összeveti a kimenetet. Ez összeköti az eval-gate-et a sandbox-szal: **az eval maga is sandbox-futtatás**, csak jóváhagyás-célból, nem éles használatra.

- **P2-D4 — A statikus vizsgálat regex helyett AST-alapú, nyelvenkénti parserrel, de a "kétség esetén elutasít" elv (Fázis 1) változatlan.** A mai `skill-validator.ts` kód-detektálása (fenced-code + shebang regex) Fázis 1-ben **elég**, mert a cél ott a teljes elutasítás (bármi, ami kódnak *tűnik*, T2/T3-ba esik → kívül a Fázis 1 hatókörén). Fázis 2-ben viszont a tier-levezetésnek **pontosnak** kell lennie (T2 vs T3 a hálózat/secret-hozzáférés alapján dönt a jóváhagyási szigorról) — egy AST-parseren (pl. nyelvenként specifikus, kezdetben Python + JS/TS lefedés) alapuló elemzés kell, ami ténylegesen felismeri az import/require-eket, hálózati- és fájlrendszer-hívásokat, és ez alapján sorolja T2 (nincs hálózat/secret) vagy T3 (van) kategóriába. Amit a parser nem tud egyértelműen kategorizálni (obfuszkált, dinamikusan generált kód, ismeretlen nyelv) → **automatikus T3**, sosem enyhébb tier felé kerekít.

- **P2-D5 — A regeneráló agent a `SkillDistillerAgent` mintáját követi, de kód → kód irányban, és a kimenete MINDIG `proposed`, provenience-kedvezmény nélkül (D13 általánosítása).** Bemenet: az importált/desztillált kód mint **specifikáció** (mit csinál, milyen bemenet/kimenet-szerződéssel) + a natív célnyelv (a platform saját agent-toolkit-je: instrukció + `requires` capability-hívások, NEM tetszőleges nyelvű újraírt szkript — ha a cél a runtime-kockázat valódi csökkentése, a regenerált "kód" ideálisan a meglévő Level-1 instrukció + capability-hívás modellbe fér, nem egy új bináris). Ha ez nem lehetséges (a skill funkciója ténylegesen egyedi kódfuttatást igényel, pl. helyi fájl-transzformáció), a regenerált kód **is** végigmegy a T2/T3 kapun (statikus scan + sandbox + eval + humán), **azonos szigorral**, mint egy közvetlenül importált T2/T3 skill — a regeneráció nem ad felmentést, csak azt nyeri, hogy nincs idegen bájt supply-chain kockázat (D13, öröklött elv).

- **P2-D6 — A T2/T3 jóváhagyás a `WriteGateToken` egyszer-használatos CAS-mechanizmusára migrál, a mai egyszerű `signSkillVersion` HMAC helyett — de ehhez a `WriteGateToken` sémát generikus horgonnyá kell bővíteni.** Indoklás: a T2/T3 jóváhagyás tétje (futtatható kód élesítése) nagyobb, mint a T0/T1 (instrukció-szöveg) — a replay-védelem és a lejárat hiánya (amit a mai skill-aláírás elfogad) itt már nem elég. Séma-hatás: a `WriteGateToken.targetMemoryId` (ma kötelező) és `trainingTicketId`/`memoryCandidateId` páros helyett egy **harmadik, opcionális horgony** (`skillVersionId`) kell, `targetMemoryId` nullable-lé válik, és az alkalmazás-szintű invariáns (pontosan egy horgony töltött ki) bővül. **Ez visszaható hatással jár a Fázis 1 T0/T1 skillekre is** — nyitott kérdés, hogy a T0/T1 útvonal maradjon-e a mai egyszerűbb HMAC-en (kockázat-arányos), vagy a konzisztencia kedvéért az egész skill-katalógus a CAS-ra migráljon. **Ez grillezendő pont**, nem ez a spec dönti el egyoldalúan.

- **P2-D7 — A "brokerelt egress" egy valódi hálózati proxy, ami a sandbox-konténer EGYETLEN kiengedett interfésze, és minden kérésnél lekérdezi a Tool Broker autorizációs döntését.** A mai Tool Broker (`AllowlistAuthorizer`) *eldönti*, hívhat-e az agent egy adott toolt egy adott connectoron — de ez a döntés ma a platform oldalán fut, a sandboxon *kívül*, és nincs hálózati szinten kikényszerítve. Fázis 2-ben: a sandbox-konténer `--network none`-t kap (P2-D1), és az egyetlen elérhető cél egy proxy-sidecar, ami minden kimenő HTTP-hívást a Tool Broker meglévő `authorize()` döntésén enged csak át (ugyanaz a capability/connector/tenant-scope, amit ma a nem-sandboxolt tool-hívások is használnak). Ez **nem új autorizációs logika**, csak egy új **kikényszerítési pont** (a mai döntéshozó elé egy hálózati kaput állítunk).

- **P2-D8 — Level-2 melléklet: fájlonként tárolt, méret-limitált, csak a `load_skill` UTÁN egy külön `load_skill_attachment` tool-lal érhető el (harmadik progresszív-betöltési szint).** A D7 (Fázis 1) mintáját folytatja: Level-0 (index) mindig bent, Level-1 (`instructions`) `load_skill`-lel, Level-2 (mellékletek: script-fájlok maguk, referencia-dokumentumok) egy újabb, explicit tool-hívással, ami **is** ToolCall-ként auditált. A melléklet-hozzáférés a T2/T3 kapun átment, aktív skill-verzióra korlátozódik.

- **P2-D9 — Upstream-frissítés jelzés: passzív diff-jelző, NEM automatikus szinkron.** A Fázis 1 D6 rögzíti, hogy az import **fork** (az importált skill onnantól a mi verziózott másolatunk, upstream-változás nem folyik be automatikusan). Fázis 2: egy admin-kezdeményezett "ellenőrizd az upstreamot" akció (nem cron/automata — a forrás megbízhatatlan, automatikus behúzás supply-chain kockázat), ami újra lekéri a `provenance`-ban rögzített forrást, és ha eltér az eredeti importált tartalomtól, **diff-et mutat** — az admin dönt, importál-e új verziót (a teljes T2/T3 kapun át, nem gyorsított úton).

### 1.1 Új döntési pontok (2026-08-27, §0.4 nyomán — szintén grillezésre várnak)

- **P2-D10 — A végrehajtó rétegnek KÉT fogyasztója van, két tierrel.** A „kaphatnának-e az agentek bash-eszközt" kérdés és a kód-hordozó skill kérdése ugyanarra a hiányzó rétegre fut ki: egy futtató, két bejárat, eltérő jogosultsággal.

  | Bejárat | Mi az | Governance |
  |---|---|---|
  | **Skill-csatolt kód** | Ember által jóváhagyott, verziózott, aláírt, hash-elt artefakt | A meglévő write-gate / `riskTier` / provenance / audit **készen áll rá** |
  | **Ad-hoc agent-írt szkript** | Minden futásban új, nem jóváhagyott kód | Szigorúbb keret: kizárólag workspace-scope, hálózat nélkül, kimenete `external_untrusted` (a `resolveTrustClass` fail-safe amúgy is ezt adná egy új toolra) |

  **A helyes sorrend: a skill-kód az első fogyasztó, nem az ad-hoc szkript** — a Fázis 1 D13 elve („az agent-írta kód nem megbízhatóbb attól, hogy a mi agentünk gyártotta") pont ezt mondja ki, és a skill-út governance-e már létezik.

  **Amit külön ki kell mondani:** a `consequence-gate-policy.ts` fejléce szerint *„a felhasználó a workspace-munkát (Excel, script, ticket) a kéréssel már engedélyezte; a kapu csak ritka, veszélyes / kilépő műveletekre marad."* Egy hálózat nélküli, workspace-re szűkített szkript-futtató tehát **nem sérti a mai következmény-kapu modellt** — a kapu a kilépési pontokon ül, nem a számításon. Ami ütközne, az a connectorokat és hálózatot elérő szabad shell; az továbbra sem hatókör (§6).

- **P2-D11 — A futtató-platform választás mérés alapján dőljön el, ne feltételezésre.** Az L4 miatt a WP-8 nem indítható a spec mai szövegével. Három út, eldöntendő: (1) **Cloud Run Job per futás** — a meglévő launcher mintájára, izoláció gVisor + VPC-firewall, indítási latencia nagyságrendileg 5–15 mp hidegen (a mai feladat-profilhoz — a SKILL.md-ben 900 000 ms wall-clock — elhanyagolható, chat-közbeni gyors szkripthez érezhető); (2) **dedikált „exec service"** `min-instances=1`-gyel — alacsonyabb latencia, folyamatos költség; (3) **in-process WASM** (pl. Pyodide) — nulla új infrastruktúra, by-design hálózat nélküli, de a platform 1 GiB memóriáján osztozna, és a natív wheel-lefedettséget ellenőrizni kell. A döntés a **WP-0 spike** dolga (§4).

- **P2-D4 újragondolása — a runtime-korlát kiváltja a statikus levezetés nagy részét.** A P2-D4 AST-scannerrel akarja levezetni a T2/T3-at (van-e a kódban hálózat/secret-hozzáférés). **Ha a sandbox ténylegesen nem enged ki, ez a különbség runtime-ban kikényszerített, nem statikusan megjósolt.** A statikus elemzés obfuszkációval kijátszható, a runtime-korlát nem. Javaslat: a scanner **tanácsadóvá** fokozódik le (ahogy az LLM-review a Fázis 1-ben), a teherhordó a futtatókörnyezet — ez jelentősen olcsóbbá teszi a WP-10-et. A „kétség esetén a szigorúbb tier felé kerekít" elv változatlan.

## 2. Célarchitektúra (rétegek, a Fázis 1 táblázat kiegészítése)

| Réteg | Fázis 1 (KÉSZ) | Fázis 2 (ÚJ) |
|---|---|---|
| Katalógus | `Skill`, `SkillVersion` (`content`/`requires`) | + `codeBundle`/`sandboxManifest` mező (P2-D2) |
| Import | `SKILL.md` adapter, hardcoded validátor (regex-kód-tiltás) | + AST-alapú statikus scan, T2/T3 tier-levezetés (P2-D4) |
| Design-time | Skill-editor, write-gate `proposed→approved→active` | + regeneráló agent mint negyedik szerzési forrás (P2-D5) |
| Kötés | `AgentSkill`, readiness-check | változatlan |
| Run-time | Level-0/Level-1 progresszív betöltés | + Level-2 melléklet-betöltés (P2-D8) |
| Futtatás | *(nincs Fázis 1-ben — instrukció-only)* | **ÚJ réteg**: OS-szintű sandbox (P2-D1) + brokerelt egress-proxy (P2-D7) |
| Minőség-kapu | *(nincs)* | **ÚJ réteg**: skill-eval-gate (P2-D3) |
| Kikényszerítés | Capability/Tool Broker, audit | + `WriteGateToken` CAS a T2/T3 jóváhagyáshoz (P2-D6) |

## 3. Adatmodell (Prisma-vázlat, kiegészítés)

```prisma
model SkillVersion {
  // ... Fázis 1 mezők változatlanul (content, requires, status, contentHash, signature, ...)
  codeBundle       Json?   @map("code_bundle")       // fájlnév → { hash, storageRef } térkép; null T0/T1-nél
  sandboxManifest  Json?   @map("sandbox_manifest")  // { entryPoint, runtimeImage, argv[], networkPolicy: 'broker-only' }
}

model SkillEval {
  id            String          @id @default(uuid()) @db.Uuid
  skillId       String          @map("skill_id") @db.Uuid
  goldenSet     Json            @map("golden_set")   // { input, expectedOutput }[] — sandbox-futtatáshoz
  status        SkillEvalStatus @default(active)
  createdAt     DateTime        @default(now()) @map("created_at") @db.Timestamptz

  skill         Skill           @relation(fields: [skillId], references: [id], onDelete: Cascade)
  runs          SkillEvalRun[]
  @@map("skill_evals")
}

model SkillEvalRun {
  id             String   @id @default(uuid()) @db.Uuid
  skillEvalId    String   @map("skill_eval_id") @db.Uuid
  skillVersionId String   @map("skill_version_id") @db.Uuid
  passed         Boolean
  score          Float
  details        Json                                // per-goldenSet-tétel eredmény + sandbox-log-referencia
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz

  skillEval      SkillEval    @relation(fields: [skillEvalId], references: [id], onDelete: Cascade)
  skillVersion   SkillVersion @relation(fields: [skillVersionId], references: [id], onDelete: Cascade)
  @@map("skill_eval_runs")
}

// WriteGateToken kiegészítés (P2-D6 — grillezésre vár, ld. §1):
model WriteGateToken {
  // ... meglévő mezők
  targetMemoryId String?  @map("target_memory_id") @db.Uuid  // Fázis 1: kötelező volt → Fázis 2: nullable-re vált
  skillVersionId String?  @unique @map("skill_version_id") @db.Uuid  // ÚJ harmadik horgony
  // invariáns bővül: pontosan egy a három horgony közül (trainingTicketId | memoryCandidateId | skillVersionId) töltött ki
}
```

Enum-kiegészítés: `SkillEvalStatus { active, retired }` (az `Eval`/`EvalRun` mintájára, de külön típus, hogy a két tábla ne keveredjen).

## 4. Munkacsomagok (tervezett, folytatva a Fázis 1 WP-1..7 számozását)

> Státusz-oszlop nincs — ez a spec még nincs implementálva, a WP-bontás a becsült sorrendet és függőséget mutatja.

### WP-0 — Futtató-platform spike (ÚJ, 2026-08-27 — a WP-8 előfeltétele)
- Egyetlen kérdést dönt el **mérés alapján** (P2-D11): a `deploy-harness-job.sh` mintájára felhúz egy `skill-exec` jobot, ami egyetlen Python-szkriptet futtat a workspace-en, hálózat nélkül.
- Mért kimenet: indítási latencia hidegen és melegen; az egress **tényleges** zártsága (nem az in-process önteszt, hanem kívülről igazolt); a workspace be/ki-csatolás ideje reális fájlszámnál.
- Becslés: ~1 nap. **Enélkül a WP-8 feltételezésre épülne** (l. §0.4 L4).
- Függőség: nincs.

### WP-8 — OS-szintű sandbox-futtatási szerződés
> **⚠️ ÚJRAÍRANDÓ (§0.4 L4).** A lenti docker-flag lista a `docker-local-harness-launcher.ts` lokális útra érvényes; **élesben Cloud Run Job fut, ami nem vesz át tetszőleges docker-flageket.** A WP tényleges tartalma a WP-0 spike után: futtató-platform (P2-D11) + a hozzá tartozó GCP-konfiguráció (VPC-connector + firewall deny), smoke-teszttel **kívülről** igazolt egress-zártsággal. A lokális docker-profil megmarad fejlesztői útként, de **nem ez a garancia forrása**.

- `docker-local-harness-launcher.ts` mellé (nem helyette) egy `sandboxProfile: 'skill-execution'` indítási mód: `--network none`, `--read-only` + célzott `tmpfs`, CPU/memória/fali-idő limit, `--cap-drop=ALL`, seccomp-profil.
- Smoke-teszt: a sandbox **ne** tudjon kiérni a hálózatra brokerelt proxy nélkül (P2-D7 előtt ez explicit tiltás — a proxy WP-9-ben jön), ne tudjon a konténeren kívülre írni, ne léphesse túl az erőforrás-limitet.
- Függőség: nincs (építhető a meglévő launcherre azonnal).

### WP-9 — Brokerelt hálózati egress-proxy
- Proxy-sidecar, ami minden kimenő HTTP-hívást a Tool Broker `authorize()` döntésén enged át (P2-D7).
- A sandbox `--network none` + a proxy az egyetlen elérhető cél (pl. Unix-socket vagy dedikált belső interfész).
- Függőség: WP-8 (a hálózati elzárás nélkül a proxy nem az egyetlen út).

### WP-10 — Statikus scan (AST) + T2/T3 tier-levezetés
> **Szűkíthető (§0.4, P2-D4 újragondolás):** ha a sandbox valóban zárt, a scanner **tanácsadó**, nem kapu — a T2/T3 különbség runtime-ban kikényszerített. A mai levezetés amúgy is egyetlen sor (`skill-validator.ts:104`), tehát ez nulláról építés, nem lecserélés (L3).

- `skill-validator.ts` kód-detektálásának lecserélése/kiegészítése AST-parseren alapuló elemzésre (kezdeti nyelvi lefedés: Python, JS/TS).
- Hálózati/secret-hívás felismerés → T2 (nincs) vs T3 (van) levezetés; kategorizálhatatlan bemenet → automatikus T3 (P2-D4).
- Függőség: nincs, párhuzamosítható WP-8/9-cel.

### WP-11 — Kód-bundle séma + tárolás
> **Szűkíthető (§0.4 L1/L2):** a `SkillVersion.attachments` séma (verziózás, SHA-256, `contentHash`-bevonás) **már létezik** — valószínűleg bővíteni kell, nem új `codeBundle` táblát nyitni. Az import-adapter oldalán a `CODE_EXTENSIONS` szűrő (`skill-package-adapter.ts:64`) **kapuvá alakul**, nem törlődik.

- `SkillVersion.codeBundle`/`sandboxManifest` mezők (§3), migráció.
- `contentHash` kiterjesztése a bundle-re.
- Import-adapter bővítés: `SKILL.md` mellett kód-fájlokat is hordozó csomag beolvasása (pl. ha a `SKILL.md` mellett szkript-fájlok is vannak a forrásban).
- Függőség: nincs.

### WP-12 — Skill-eval-kapu
- `SkillEval`/`SkillEvalRun` táblák (§3), `SkillEvalService` (a meglévő `EvalService` mintájára, de önálló osztály — P2-D3).
- Új assertion-típus: sandbox-futtatás golden-input/output párokra, a sandbox (WP-8) felhasználásával.
- Jóváhagyási integráció: T2/T3 `approveVersion` blokkol, ha nincs zöld `SkillEvalRun` az adott verzióhoz.
- Függőség: WP-8 (sandbox kell a futtatáshoz), WP-11 (kell mit futtatni).

### WP-13 — Regeneráló agent
- Bemenet: kód-bundle mint specifikáció + célzott natív reprezentáció (elsődlegesen: instrukció + `requires` — csak ha ez nem elég, kerül új kód-bundle-be, P2-D5).
- Kimenet: mindig `proposed` `SkillVersion`, a teljes T2/T3 kapun megy át (nincs provenience-kedvezmény).
- Függőség: WP-10 (a regenerált kódnak is át kell mennie a scan-en), WP-12 (eval-gate a regenerált verzióra is).

### WP-14 — T2/T3 jóváhagyási kapu megerősítése (`WriteGateToken` CAS)
- `WriteGateToken` séma bővítés (`skillVersionId` horgony, `targetMemoryId` nullable) — **P2-D6 grillezése után**, mert visszaható hatással jár a T0/T1 útra is.
- `SkillService.approveVersion` átállítása `issue()`/`consume()`-ra a mai közvetlen `signSkillVersion` hívás helyett (T2/T3-nál kötelező, T0/T1-nél a grill dönti el).
- Függőség: P2-D6 döntés lezárása (grill-me).

### WP-15 — Level-2 mellékletek — ~~TERVEZETT~~ **ELKÉSZÜLT (§0.4 L1), törlendő a hátralévő munkából**
> Él: `SkillVersion.attachments` (`schema.prisma:1109`), `load_skill_attachment` (`chat-tool-loop.ts:381`), audit-esemény (`event-catalog.ts:375`), limitek (`lib/skill/skill-attachments.ts`). Két eltérés a lenti tervtől: **nincs T2/T3-hoz kötve** (minden skillre él), és a melléklet **szövegként a promptba** kerül. A történeti terv az alábbi:

- `load_skill_attachment` tool, deny-by-default, csak aktív T2/T3 skill-verzió mellékleteire, ToolCall-auditált (P2-D8).
- Méret-limit mellékletenként és összesen (token-ökonómia, a Fázis 1 §5 kockázat folytatása).
- Függőség: WP-11 (a bundle-ben tárolt mellékletek).

### WP-16 — Upstream-frissítés jelzés
- Admin-kezdeményezett "upstream ellenőrzés" akció: a `provenance`-ban rögzített forrás újralekérése, diff a jelenlegi importált tartalommal (P2-D9).
- A diff eredménye **nem** automata import — admin dönt, új verzió-javaslatot indít-e (a teljes kapun át).
- Függőség: nincs, önállóan szállítható.

## 5. Fejlesztői hatás / kockázatok

- **A sandbox-garancia a leggyengébb láncszem, ha félkészen kerül élesbe.** Ha a WP-8 hálózati elzárása vagy a WP-9 proxy hiányos, egy T2/T3 skill futtatása pontosan azt a kockázatot nyitja meg, amit a D13 explicit el akart kerülni (idegen/agent-írta kód szabad hálózati/fájlrendszer-hozzáféréssel). **WP-8 és WP-9 nem szállítható részlegesen** — amíg a hálózati elzárás nincs smoke-teszttel igazolva, a T2/T3 jóváhagyási kapu (WP-14) nem nyithat.
- **Az AST-scan (WP-10) sosem lehet a teljes kontroll.** A Fázis 1 D5 elve ("a determinista lint + humán a teherhordó, az LLM csak tanácsadó") itt is érvényes — a statikus scan jelzi a tier-t és szűri a nyilvánvaló kockázatot, de a sandbox (WP-8/9) és a humán jóváhagyás (WP-14) a tényleges kikényszerítés. Kategorizálhatatlan kód mindig a szigorúbb tier felé kerekít (P2-D4), sosem lazábbra.
- **A `WriteGateToken` séma-bővítés (P2-D6) visszaható hatású.** Ha a T0/T1 útvonal is átkerül a CAS-mechanizmusra, az érinti a már élesben futó Fázis 1 skill-jóváhagyási folyamatot — ezt külön migrációs terv és regressziós teszt nélkül nem szabad bevezetni.
- **Az eval-gate (WP-12) csak annyit ér, amennyire a golden-set reprezentatív.** A mai `EvalService` string-match motorja túl gyenge mintaként való átvétele hamis biztonságérzetet adna — a sandbox-futtatáson alapuló assertion (P2-D3) architekturálisan más súlyú komponens, nem egy egyszerű bővítés.

- ➕ **ÚJ (2026-08-27, §0.4 L4) — az izolációs garancia egy része repón kívüli GCP-konfiguráció.** Ha a VPC-connector és a firewall deny-szabályok nincsenek beállítva, a kód-futtatás **nyitott internettel** fut, miközben ez a spec zártságot feltételez. A Cloud Run konténernek alapból van kimenő internet-hozzáférése, és ezt a `HARNESS_EGRESS_ENFORCE` in-process önteszt **nem** pótolja. Ezt telepítési checklistként kell kezelni, nem kód-szintű állításként — és a WP-0 spike-nak **kívülről** kell igazolnia.

## 6. Hatókörön kívül (ennek a specnek sem tárgya)

- Automatikus, cron-vezérelt upstream-szinkron — a P2-D9 kizárólag admin-kezdeményezett, diff-alapú jelzés, sosem automata import.
- Idegen kód "biztonságossá" statikus átírása — véglegesen elvetve (D13, öröklött elv, ez a spec sem nyit ezt újra).
- Több nyelvű AST-lefedés a kezdeti Python/JS-TS-en túl — külön munkacsomag, ha a katalógus-igény indokolja.
- A `Recipe`/`Skill` konvergencia — változatlanul külön (Fázis 1 §5 elve érvényes).
- **Connectorokat, titkokat és szabad hálózatot elérő általános shell-eszköz** (2026-08-27, P2-D10). A végrehajtó réteg mindkét bejárata workspace-scope-olt és hálózat nélküli; a hálózat felé továbbra is a brokerelt út (WP-9) az egyetlen kijárat. Egy szabad shell megkerülné az auditált web-egress nyelőt, a napi keretet és a következmény-kaput.
