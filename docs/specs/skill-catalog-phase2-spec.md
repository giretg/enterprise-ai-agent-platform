# Fejlesztői specifikáció — Skill-katalógus Fázis 2 (kód-hordozó skillek: T2/T3)

Státusz: **Tervezet** · **Kanonikus hely: #396** — a spec GitHub issue-ként él, ez a fájl a részletes forrás · Forrás: `skill-catalog-spec.md` §6 + D13 (2026-07-07 grill-me) alapján, kódbázis-feltárással kiegészítve (2026-07-21), felülvizsgálva (2026-08-27, §0.4; 2026-09-16, §0.5) · Kapcsolódó specek: `skill-catalog-spec.md` (Fázis 1, KÉSZ), `code-mode-sandbox-tool-bridge-spec.md` (#470), `AI-Agent-Platform-Koncepcio.md` §4.6.3–4.6.4, §4.9

> **⚠️ Olvasási sorrend:** ha ezt a specet implementálod, **először a §0.5-öt olvasd el**. A 2026-09-16-i felülvizsgálat rögzíti, hogy a #485 (`sandbox_exec`) a végrehajtó réteget megépítette, ezzel a WP-0/8/9/10/13 okafogyott, és a hátralévő munka szinte teljesen skill-oldali (§4, WP-17..20). A §0.4 (2026-08-27) és a §1 eredeti döntés-szövege **történeti** — a döntésenkénti státuszt a §0.5 táblázata és a P2-D* elején álló jelölés adja.

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

### 0.5 2026-09-16 felülvizsgálat — a #485 `sandbox_exec` után

A #485 (PR #499, merged) **megépítette a végrehajtó réteget**, de nem a spec P2-D1/D7/D11 elképzelése szerint, és P2-D10-hez képest fordított sorrendben (az ad-hoc agent-script bejárat készült el először). Az alábbi táblázat a spec kérdéseit a tényleges kódra vetíti.

| Spec-pont | Állapot 2026-09-16 | Bizonyíték a kódban |
|---|---|---|
| **P2-D11** futtató-platform | **Eldőlt:** Cloud Run *service* `--sandbox-launcher`-rel, hívásonként efemer nested gVisor-sandbox, `min-instances 0`, `concurrency 1`, `--timeout 900`. Nem Job, nem WASM. | `infra/gcp/deploy-code-sandbox-service.sh`, `domain/code-sandbox/cloud-run-runner.ts` (`sandbox run … --detach`) |
| **L4** egress-zártság | **Megoldva a launcher szintjén**, nem VPC-vel: hálózat csak `--allow-egress` flaggel, alapból nincs; `defaultAllowEgress: z.literal(false)` a connector-configban. | `buildSandboxRunArgs`, `code-sandbox-types.ts` |
| **WP-0** spike | Okafogyott — `provisionMs`/`execMs`/`coldStart` minden hívásnál mérve, auditban. | `SandboxExecMetrics` |
| **WP-8** sandbox-szerződés | **Kész:** `/work/in` read-only bind, `/work/out` write, script `/work/run.py`, timeout → SIGKILL (exit 124), stdout/stderr 256 KB kapu, symlink/hardlink-szűrés a kimeneten, fájl-/bájt-limitek. | `cloud-run-runner.ts`, `code-sandbox-service.ts` |
| **P2-D10** két bejárat | Az **ad-hoc agent-script** bejárat él (`sandbox_exec.script`); a **skill-csatolt kód** bejárat NINCS. | `tool-registry.ts` `sandbox_exec` |
| Következmény-kapu | A spec állítása igazolódott: a számítás nem kapuzott, csak `allowEgress:true` kér embert (`sandbox_egress`). | `consequence-gate-policy.ts` |
| Per-scope keret | Van: `maxCallsPerScope`/`maxExecSecPerScope` a connectoron, ticket-/beszélgetés-scope. | `tool-broker-service.ts` |
| Futtató-image | **Rés:** csak `python3`, pip-csomag nélkül. Excel-feldolgozáshoz (`openpyxl`) nem elég. | `Dockerfile.code-sandbox` |
| Kimenet bizalmi osztálya | **Rés:** `trust: 'trusted'` akkor is, ha a script külső adatot printel vissza — a #470 D3 kezeli (öröklés a bemenetekből). | `tool-registry.ts`, #470 |

**Döntés-szintű következmények** (a részletes indoklás a P2-D* pontok elején álló jelölésben):

- **Törölve / okafogyott:** P2-D1, P2-D7, P2-D4 (az AST-scanner egészében), P2-D5 (regeneráló agent), WP-0, WP-8, WP-9, WP-10, WP-13, WP-15.
- **Átírva:** P2-D2 (kód-bundle → `attachments` + `kind:'code'`), P2-D10 (a bejáratok különbsége = referencia vs. érték, P2-D13), P2-D3 (eval-kapu nem blokkoló v1-ben), P2-D6 (nem előfeltétel).
- **Új:** P2-D12 (futtató-image csomagkészlete), P2-D13 (skill-script referenciával, nem értékkel).
- **Változatlan:** P2-D8 (kész), P2-D9 / WP-16, §6 hatókörön kívüli lista.

**A hátralévő munka** (§4, WP-17..20, ebben a sorrendben): `py` melléklet beengedése + `t2` levezetés → `sandbox_exec.scriptRef` (skill-verzió mellékletéből, szerver-oldali feloldással) → image-csomagkészlet → pilot: `tulajdoni-lap-egyeztetes` átvitele skill-scriptbe, majd a platform-törzs domain-logikájának törlése.

## 1. Elvi keretek (döntés-javaslatok — grillezésre várnak)

Ezek **nem lezárt döntések**, hanem a D13 (Fázis 1) kibontásából és a kódbázis-feltárásból adódó javaslatok. A `P2-` előtag jelzi, hogy ezek a Fázis 2 spec saját döntései, megkülönböztetve a Fázis 1 D1–D14-től, amelyeket öröklünk és nem írunk felül.

- ~~**P2-D1**~~ — **TÖRÖLVE (2026-09-16, §0.5):** a végrehajtó réteg Cloud Run nested sandboxként épült meg (#485), docker-flag-profil nincs és nem kell. Történeti szöveg: **A sandbox nem a meglévő `docker-local-harness-launcher.ts` bővítése, hanem egy új, szigorúbb futtatási mód ugyanazon a launcheren keresztül.** A launcher *spawn-mechanizmusa* (konténer indítás, env-átadás) marad, de egy új `sandboxProfile: 'skill-execution'` (vagy hasonló) paraméter viszi be a D13 által megkövetelt flageket: `--network none` (majd a brokerelt proxy külön hálózati interfészen, §P2-D7), `--read-only` + `tmpfs` az efemer írható részekhez, `--memory`/`--cpus`/fali-idő limit, `--cap-drop=ALL`, seccomp-profil. **Miért külön profil, nem az alap mód szigorítása:** az agent-beszélgetés harnessének (mai használat) más az egress-igénye (Model Gateway, platform API elérése kell) — nem szabad véletlenül szigorítani az élesben futó utat egy skill-futtatás miatt.

- **P2-D2 — ÁTÍRVA (2026-09-16):** nem kell `codeBundle`/`sandboxManifest` mező. A `SkillVersion.attachments` (SHA-256, `contentHash`-be bevonva, verziózott, 128 KB/fájl, szöveg-tár) *pont* a jó tár egy scriptnek. Ami kell: a `CODE_EXTENSIONS` szűrő (`skill-package-adapter.ts`) kapuvá alakul — kezdetben **csak `py`** engedve, `kind: 'code'` jelöléssel a mellékleten; a többi kiterjesztés továbbra is `code_file` okkal kimarad (Fázis 1 „kétség esetén elutasít"). Manifeszt helyett a SKILL.md instrukciója mondja meg, mit és mivel kell futtatni — a Fázis 1 „skill = puha instrukció + kemény capability" elvének folytatása. *Eredeti szöveg:* **A kód-bundle NEM a `content`/`requires` JSON-t bővíti, hanem új, elkülönített mezőt/táblát kap a `SkillVersion`-ön.** A `content` (instrukciók) és `requires` (capability-manifeszt) sémája szándékosan szöveg-alapú és emberi-olvasható — egy bináris/többfájlos kód-bundle ide zsúfolása elmosná a T0/T1 vs T2/T3 határt a séma szintjén is. Javaslat: `SkillVersion.codeBundle: Json?` (fájlnév → tartalom/hash térkép, vagy objektum-tár referencia nagyobb bundle-ökhöz) + `SkillVersion.sandboxManifest: Json?` (a bundle mely belépési pontját, milyen futtatási paranccsal, milyen `requires`-hez kötve kell indítani). `contentHash` a bundle-t is bevonja.

- **P2-D3 — ÁTÍRVA (2026-09-16):** a mechanizmus a sandbox-szal olcsóvá vált (golden `inputs` → `sandbox_exec` → `outputs` diff), de **v1-ben nem blokkoló kapu** — a humán jóváhagyás + a melléklet SHA-256-ja elég az induláshoz. A `SkillEval`/`SkillEvalRun` séma-döntés marad, hátrébb sorolva (WP-12). *Eredeti szöveg:* **Az eval-gate skillekhez NEM az `Eval`/`EvalRun` táblák közvetlen kiterjesztése (`skillVersionId` FK hozzáadása), hanem egy párhuzamos `SkillEval`/`SkillEvalRun` pár, azonos mintára.** Indoklás: az `Eval.agentId` és a hozzá tartozó jóváhagyási folyamat (`memory-approval-service.ts`, `training-service.ts`) szemantikailag **agent-tanítási** eseményhez van kötve; egy skill-verzió jóváhagyása más életciklus (nem agent-verzióhoz, hanem globális/tenant-skill-katalógushoz kötött). A közös minta (kapu → `passed`/`score` → blokkol) átvehető kódszinten (megosztott `EvalAssertionEngine` interfész), de a táblák és a hívási pontok külön maradnak, hogy a meglévő memória-eval-gate audit- és jóváhagyási szemantikáját ne zavarja meg egy idegen entitás. **Az assertion-motort bővíteni kell:** a mai `contains`/`not_contains`/`min_length` string-check nem elég "viselkedés a referenciához képest" méréshez — kell legalább egy `sandbox_execution_matches_golden_output` assertion-típus, ami a jelölt kódot **is** a sandboxban (§P2-D1) futtatja egy rögzített bemenet-kimenet golden-seten, és összeveti a kimenetet. Ez összeköti az eval-gate-et a sandbox-szal: **az eval maga is sandbox-futtatás**, csak jóváhagyás-célból, nem éles használatra.

- ~~**P2-D4**~~ — **TÖRÖLVE (2026-09-16):** a §1.1 újragondolás tanácsadóvá fokozta, most egészében kimarad. A sandbox runtime-ban zárja el a hálózatot és a fájlrendszert, ezért egy `.py` mellékletnél a tier nem a kód *tartalmától*, hanem a *bejárattól* függ: **kód-melléklet ⇒ `t2`; kód-melléklet + `allowEgress` igény ⇒ `t3`** (v1-ben `t3` nem adható ki). Ez egy sor a `skill-validator.ts`-ben, nem parser. A „kétség esetén elutasít" elv fájl-szinten marad (nem-`py` kód továbbra is kimarad). Történeti szöveg: **A statikus vizsgálat regex helyett AST-alapú, nyelvenkénti parserrel, de a "kétség esetén elutasít" elv (Fázis 1) változatlan.** A mai `skill-validator.ts` kód-detektálása (fenced-code + shebang regex) Fázis 1-ben **elég**, mert a cél ott a teljes elutasítás (bármi, ami kódnak *tűnik*, T2/T3-ba esik → kívül a Fázis 1 hatókörén). Fázis 2-ben viszont a tier-levezetésnek **pontosnak** kell lennie (T2 vs T3 a hálózat/secret-hozzáférés alapján dönt a jóváhagyási szigorról) — egy AST-parseren (pl. nyelvenként specifikus, kezdetben Python + JS/TS lefedés) alapuló elemzés kell, ami ténylegesen felismeri az import/require-eket, hálózati- és fájlrendszer-hívásokat, és ez alapján sorolja T2 (nincs hálózat/secret) vagy T3 (van) kategóriába. Amit a parser nem tud egyértelműen kategorizálni (obfuszkált, dinamikusan generált kód, ismeretlen nyelv) → **automatikus T3**, sosem enyhébb tier felé kerekít.

- ~~**P2-D5**~~ — **TÖRÖLVE (2026-09-16):** a D13 eredeti indoka („nincs hova futtatni az idegen kódot, ezért újraíratjuk") megszűnt. Egy hálózat nélküli, workspace-scope-olt, ember által jóváhagyott, hash-elt script *kisebb* supply-chain kockázat, mint egy LLM-mel újraírt változat, aminek a helyességét senki nem ellenőrizte. A Fázis 1 D13 ezzel **opcióvá** fokozódik (az admin kérhet újraírást, de nem kötelező), a WP-13 törlődik. Történeti szöveg: **A regeneráló agent a `SkillDistillerAgent` mintáját követi, de kód → kód irányban, és a kimenete MINDIG `proposed`, provenience-kedvezmény nélkül (D13 általánosítása).** Bemenet: az importált/desztillált kód mint **specifikáció** (mit csinál, milyen bemenet/kimenet-szerződéssel) + a natív célnyelv (a platform saját agent-toolkit-je: instrukció + `requires` capability-hívások, NEM tetszőleges nyelvű újraírt szkript — ha a cél a runtime-kockázat valódi csökkentése, a regenerált "kód" ideálisan a meglévő Level-1 instrukció + capability-hívás modellbe fér, nem egy új bináris). Ha ez nem lehetséges (a skill funkciója ténylegesen egyedi kódfuttatást igényel, pl. helyi fájl-transzformáció), a regenerált kód **is** végigmegy a T2/T3 kapun (statikus scan + sandbox + eval + humán), **azonos szigorral**, mint egy közvetlenül importált T2/T3 skill — a regeneráció nem ad felmentést, csak azt nyeri, hogy nincs idegen bájt supply-chain kockázat (D13, öröklött elv).

- **P2-D6 — NYITVA, de nem előfeltétel (2026-09-16):** a melléklet SHA-256-ja a `contentHash`-en át már a `signSkillVersion` HMAC alatt van, tehát a jóváhagyott bájtok kötve vannak. A CAS-migráció csak `t2`-re kötelezné, ha egyáltalán; grill után, WP-14. *Eredeti szöveg:* **A T2/T3 jóváhagyás a `WriteGateToken` egyszer-használatos CAS-mechanizmusára migrál, a mai egyszerű `signSkillVersion` HMAC helyett — de ehhez a `WriteGateToken` sémát generikus horgonnyá kell bővíteni.** Indoklás: a T2/T3 jóváhagyás tétje (futtatható kód élesítése) nagyobb, mint a T0/T1 (instrukció-szöveg) — a replay-védelem és a lejárat hiánya (amit a mai skill-aláírás elfogad) itt már nem elég. Séma-hatás: a `WriteGateToken.targetMemoryId` (ma kötelező) és `trainingTicketId`/`memoryCandidateId` páros helyett egy **harmadik, opcionális horgony** (`skillVersionId`) kell, `targetMemoryId` nullable-lé válik, és az alkalmazás-szintű invariáns (pontosan egy horgony töltött ki) bővül. **Ez visszaható hatással jár a Fázis 1 T0/T1 skillekre is** — nyitott kérdés, hogy a T0/T1 útvonal maradjon-e a mai egyszerűbb HMAC-en (kockázat-arányos), vagy a konzisztencia kedvéért az egész skill-katalógus a CAS-ra migráljon. **Ez grillezendő pont**, nem ez a spec dönti el egyoldalúan.

- ~~**P2-D7**~~ — **ELVETVE (2026-09-16), nem elhalasztva:** a #485 és a #470 spec együtt más modellt választott — a sandbox hálózat nélküli marad, a hálózat felé a *jóváhagyott* `allowEgress` a kivétel (következmény-kapu, `sandbox_egress`), a tool-hívás pedig (ha lesz) **fájl-RPC a runneren át, csak olvasó toolokra** (#470 v2, D6-feltétel). Egy hálózati proxy-sidecar ehhez képest második autorizációs út lenne. Történeti szöveg: **A "brokerelt egress" egy valódi hálózati proxy, ami a sandbox-konténer EGYETLEN kiengedett interfésze, és minden kérésnél lekérdezi a Tool Broker autorizációs döntését.** A mai Tool Broker (`AllowlistAuthorizer`) *eldönti*, hívhat-e az agent egy adott toolt egy adott connectoron — de ez a döntés ma a platform oldalán fut, a sandboxon *kívül*, és nincs hálózati szinten kikényszerítve. Fázis 2-ben: a sandbox-konténer `--network none`-t kap (P2-D1), és az egyetlen elérhető cél egy proxy-sidecar, ami minden kimenő HTTP-hívást a Tool Broker meglévő `authorize()` döntésén enged csak át (ugyanaz a capability/connector/tenant-scope, amit ma a nem-sandboxolt tool-hívások is használnak). Ez **nem új autorizációs logika**, csak egy új **kikényszerítési pont** (a mai döntéshozó elé egy hálózati kaput állítunk).

- **P2-D8 — KÉSZ (§0.4 L1).** Level-2 melléklet: fájlonként tárolt, méret-limitált, csak a `load_skill` UTÁN egy külön `load_skill_attachment` tool-lal érhető el (harmadik progresszív-betöltési szint).** A D7 (Fázis 1) mintáját folytatja: Level-0 (index) mindig bent, Level-1 (`instructions`) `load_skill`-lel, Level-2 (mellékletek: script-fájlok maguk, referencia-dokumentumok) egy újabb, explicit tool-hívással, ami **is** ToolCall-ként auditált. A melléklet-hozzáférés a T2/T3 kapun átment, aktív skill-verzióra korlátozódik.

- **P2-D9 — Upstream-frissítés jelzés: passzív diff-jelző, NEM automatikus szinkron.** A Fázis 1 D6 rögzíti, hogy az import **fork** (az importált skill onnantól a mi verziózott másolatunk, upstream-változás nem folyik be automatikusan). Fázis 2: egy admin-kezdeményezett "ellenőrizd az upstreamot" akció (nem cron/automata — a forrás megbízhatatlan, automatikus behúzás supply-chain kockázat), ami újra lekéri a `provenance`-ban rögzített forrást, és ha eltér az eredeti importált tartalomtól, **diff-et mutat** — az admin dönt, importál-e új verziót (a teljes T2/T3 kapun át, nem gyorsított úton).

### 1.1 Új döntési pontok (2026-08-27, §0.4 nyomán — szintén grillezésre várnak)

- **P2-D10 — A végrehajtó rétegnek KÉT fogyasztója van, két tierrel.** *(2026-09-16: az ad-hoc bejárat elkészült a #485-ben, a skill-bejárat a WP-18. A két bejárat közti különbséget technikailag a P2-D13 adja: a skill-script **referenciával** megy a sandboxba, az ad-hoc script **értékkel**.)* A „kaphatnának-e az agentek bash-eszközt" kérdés és a kód-hordozó skill kérdése ugyanarra a hiányzó rétegre fut ki: egy futtató, két bejárat, eltérő jogosultsággal.

  | Bejárat | Mi az | Governance |
  |---|---|---|
  | **Skill-csatolt kód** | Ember által jóváhagyott, verziózott, aláírt, hash-elt artefakt | A meglévő write-gate / `riskTier` / provenance / audit **készen áll rá** |
  | **Ad-hoc agent-írt szkript** | Minden futásban új, nem jóváhagyott kód | Szigorúbb keret: kizárólag workspace-scope, hálózat nélkül, kimenete `external_untrusted` (a `resolveTrustClass` fail-safe amúgy is ezt adná egy új toolra) |

  **A helyes sorrend: a skill-kód az első fogyasztó, nem az ad-hoc szkript** — a Fázis 1 D13 elve („az agent-írta kód nem megbízhatóbb attól, hogy a mi agentünk gyártotta") pont ezt mondja ki, és a skill-út governance-e már létezik.

  **Amit külön ki kell mondani:** a `consequence-gate-policy.ts` fejléce szerint *„a felhasználó a workspace-munkát (Excel, script, ticket) a kéréssel már engedélyezte; a kapu csak ritka, veszélyes / kilépő műveletekre marad."* Egy hálózat nélküli, workspace-re szűkített szkript-futtató tehát **nem sérti a mai következmény-kapu modellt** — a kapu a kilépési pontokon ül, nem a számításon. Ami ütközne, az a connectorokat és hálózatot elérő szabad shell; az továbbra sem hatókör (§6).

- **P2-D11 — ELDŐLT (2026-09-16, §0.5):** Cloud Run service `--sandbox-launcher`-rel, hívásonként efemer nested gVisor-sandbox (#485). *Eredeti szöveg:* **A futtató-platform választás mérés alapján dőljön el, ne feltételezésre.** Az L4 miatt a WP-8 nem indítható a spec mai szövegével. Három út, eldöntendő: (1) **Cloud Run Job per futás** — a meglévő launcher mintájára, izoláció gVisor + VPC-firewall, indítási latencia nagyságrendileg 5–15 mp hidegen (a mai feladat-profilhoz — a SKILL.md-ben 900 000 ms wall-clock — elhanyagolható, chat-közbeni gyors szkripthez érezhető); (2) **dedikált „exec service"** `min-instances=1`-gyel — alacsonyabb latencia, folyamatos költség; (3) **in-process WASM** (pl. Pyodide) — nulla új infrastruktúra, by-design hálózat nélküli, de a platform 1 GiB memóriáján osztozna, és a natív wheel-lefedettséget ellenőrizni kell. A döntés a **WP-0 spike** dolga (§4).

- **P2-D4 újragondolása — MEGHALADVA (2026-09-16): P2-D4 egészében törölve, l. fent.** *Eredeti szöveg:* **a runtime-korlát kiváltja a statikus levezetés nagy részét.** A P2-D4 AST-scannerrel akarja levezetni a T2/T3-at (van-e a kódban hálózat/secret-hozzáférés). **Ha a sandbox ténylegesen nem enged ki, ez a különbség runtime-ban kikényszerített, nem statikusan megjósolt.** A statikus elemzés obfuszkációval kijátszható, a runtime-korlát nem. Javaslat: a scanner **tanácsadóvá** fokozódik le (ahogy az LLM-review a Fázis 1-ben), a teherhordó a futtatókörnyezet — ez jelentősen olcsóbbá teszi a WP-10-et. A „kétség esetén a szigorúbb tier felé kerekít" elv változatlan.

### 1.2 Új döntési pontok (2026-09-16, §0.5 nyomán)

- **P2-D12 — A futtató-image csomagkészlete platform-döntés, rögzített verziókkal, nem skill-szintű függőség.** A `Dockerfile.code-sandbox` ma csak `python3`-at tesz fel. A melléklet-tár **szöveg** (NUL-bájt ⇒ elutasítás), tehát bináris wheel/`.so` soha nem jöhet be skillben — ez jó: a csomagkészlet *csak* az image-ből jöhet. Kezdeti készlet: `openpyxl` (Excel-egyeztetés), esetleg `pandas`; verzió pinnelve, a lista a repóban (`requirements-sandbox.txt` vagy a Dockerfile-ban). Bővítés = platform-release, nem tenant-döntés. A SKILL.md-ben a script deklarálja, mit használ; ha az image-ben nincs, a futás `ModuleNotFoundError`-ral bukik — ez látható, nem csendes hiba.

- **P2-D13 — A skill-script REFERENCIÁVAL megy a sandboxba, nem értékkel.** Ma az agent a `load_skill_attachment`-tel 30 000 karakterig *szövegként* kapná a scriptet, majd `sandbox_exec.script`-ként visszaküldené: a jóváhagyott artefakt így **átmegy a modellen** (csonkolódhat, módosulhat, tokent éget), és az audit csak `scriptHash`-t lát, nem skill-verziót. Ehelyett: `sandbox_exec` kap egy `scriptRef: { skillVersionId, path }` argot (`script`-tel kölcsönösen kizáró); a handler **szerver-oldalon** oldja fel az *aktív, az agenthez rendelt* skill-verzió mellékletéből (ugyanaz a fail-closed ellenőrzés, mint `loadSkillAttachmentForAgent`), a többi `kind:'code'` mellékletet `/work/in/skill/…` alá csatolja (helper-modulok), az audit `skillVersionId + sha256`-ot rögzít. **Ettől lesz a skill-kód „jóváhagyott artefakt", nem „prompt-szöveg"** — ez a P2-D10 két bejáratának tényleges technikai különbsége. A `script` (érték) út marad az ad-hoc bejáratnak.

## 2. Célarchitektúra (rétegek, a Fázis 1 táblázat kiegészítése)

| Réteg | Fázis 1 (KÉSZ) | Fázis 2 (ÚJ) |
|---|---|---|
| Katalógus | `Skill`, `SkillVersion` (`content`/`requires`) | + `attachments[].kind = 'code'` (P2-D2 átírva) |
| Import | `SKILL.md` adapter, hardcoded validátor (regex-kód-tiltás) | + `CODE_EXTENSIONS` kapu (`py`), kód-melléklet ⇒ `t2` (P2-D4 törölve) |
| Design-time | Skill-editor, write-gate `proposed→approved→active` | változatlan (P2-D5 törölve) |
| Kötés | `AgentSkill`, readiness-check | változatlan |
| Run-time | Level-0/Level-1 progresszív betöltés | + Level-2 melléklet-betöltés (P2-D8, KÉSZ) |
| Futtatás | *(nincs Fázis 1-ben — instrukció-only)* | `sandbox_exec` (#485, KÉSZ) + `scriptRef` skill-bejárat (P2-D13, WP-18) + image-csomagkészlet (P2-D12, WP-19) |
| Minőség-kapu | *(nincs)* | skill-eval-gate (P2-D3, nem blokkoló, hátrasorolva) |
| Kikényszerítés | Capability/Tool Broker, audit | + sandbox runtime (hálózat nélkül, workspace-scope) · `WriteGateToken` CAS nyitva (P2-D6) |

## 3. Adatmodell (Prisma-vázlat, kiegészítés)

> **2026-09-16:** nincs séma-migráció a kód-hordozáshoz. A `SkillVersion.attachments Json?` bővül egy `kind: 'reference' | 'code'` mezővel (Zod-séma `lib/skill/skill-attachments.ts`, alapérték `reference` a meglévő adatokra). A lenti `codeBundle`/`sandboxManifest` **elvetve**; a `SkillEval*` táblák és a `WriteGateToken` bővítés hátrasorolva (WP-12, WP-14).

```prisma
model SkillVersion {
  // ... Fázis 1 mezők változatlanul (content, requires, status, contentHash, signature, attachments, ...)
  // attachments[] eleme: { path, text, bytes, sha256, kind: 'reference' | 'code' }  — ELVETVE: codeBundle, sandboxManifest
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

> **2026-09-16 státusz:** WP-0/8/9/10/13/15 törölve vagy kész (§0.5). A hátralévő, sorrendben: **WP-17 → WP-18 → WP-19 → WP-20**, utána igény szerint WP-12, WP-14, WP-16. A WP-0..16 szövege alatt történeti.

### WP-0 — Futtató-platform spike — **OKAFOGYOTT (2026-09-16):** a #485 eldöntötte (P2-D11), a metrikák auditban mérve
- Egyetlen kérdést dönt el **mérés alapján** (P2-D11): a `deploy-harness-job.sh` mintájára felhúz egy `skill-exec` jobot, ami egyetlen Python-szkriptet futtat a workspace-en, hálózat nélkül.
- Mért kimenet: indítási latencia hidegen és melegen; az egress **tényleges** zártsága (nem az in-process önteszt, hanem kívülről igazolt); a workspace be/ki-csatolás ideje reális fájlszámnál.
- Becslés: ~1 nap. **Enélkül a WP-8 feltételezésre épülne** (l. §0.4 L4).
- Függőség: nincs.

### WP-8 — OS-szintű sandbox-futtatási szerződés — **KÉSZ (#485, §0.5)**
> ~~**⚠️ ÚJRAÍRANDÓ (§0.4 L4).**~~ A lenti docker-flag lista a `docker-local-harness-launcher.ts` lokális útra érvényes; **élesben Cloud Run Job fut, ami nem vesz át tetszőleges docker-flageket.** A WP tényleges tartalma a WP-0 spike után: futtató-platform (P2-D11) + a hozzá tartozó GCP-konfiguráció (VPC-connector + firewall deny), smoke-teszttel **kívülről** igazolt egress-zártsággal. A lokális docker-profil megmarad fejlesztői útként, de **nem ez a garancia forrása**.

- `docker-local-harness-launcher.ts` mellé (nem helyette) egy `sandboxProfile: 'skill-execution'` indítási mód: `--network none`, `--read-only` + célzott `tmpfs`, CPU/memória/fali-idő limit, `--cap-drop=ALL`, seccomp-profil.
- Smoke-teszt: a sandbox **ne** tudjon kiérni a hálózatra brokerelt proxy nélkül (P2-D7 előtt ez explicit tiltás — a proxy WP-9-ben jön), ne tudjon a konténeren kívülre írni, ne léphesse túl az erőforrás-limitet.
- Függőség: nincs (építhető a meglévő launcherre azonnal).

### WP-9 — Brokerelt hálózati egress-proxy — **ELVETVE (P2-D7, 2026-09-16)**
- Proxy-sidecar, ami minden kimenő HTTP-hívást a Tool Broker `authorize()` döntésén enged át (P2-D7).
- A sandbox `--network none` + a proxy az egyetlen elérhető cél (pl. Unix-socket vagy dedikált belső interfész).
- Függőség: WP-8 (a hálózati elzárás nélkül a proxy nem az egyetlen út).

### WP-10 — Statikus scan (AST) + T2/T3 tier-levezetés — **TÖRÖLVE (P2-D4, 2026-09-16); a tier-levezetés a WP-17 része**
> **Szűkíthető (§0.4, P2-D4 újragondolás):** ha a sandbox valóban zárt, a scanner **tanácsadó**, nem kapu — a T2/T3 különbség runtime-ban kikényszerített. A mai levezetés amúgy is egyetlen sor (`skill-validator.ts:104`), tehát ez nulláról építés, nem lecserélés (L3).

- `skill-validator.ts` kód-detektálásának lecserélése/kiegészítése AST-parseren alapuló elemzésre (kezdeti nyelvi lefedés: Python, JS/TS).
- Hálózati/secret-hívás felismerés → T2 (nincs) vs T3 (van) levezetés; kategorizálhatatlan bemenet → automatikus T3 (P2-D4).
- Függőség: nincs, párhuzamosítható WP-8/9-cel.

### WP-11 — Kód-bundle séma + tárolás — **ÁTÍRVA → WP-17 (nincs új séma)**
> **Szűkíthető (§0.4 L1/L2):** a `SkillVersion.attachments` séma (verziózás, SHA-256, `contentHash`-bevonás) **már létezik** — valószínűleg bővíteni kell, nem új `codeBundle` táblát nyitni. Az import-adapter oldalán a `CODE_EXTENSIONS` szűrő (`skill-package-adapter.ts:64`) **kapuvá alakul**, nem törlődik.

- `SkillVersion.codeBundle`/`sandboxManifest` mezők (§3), migráció.
- `contentHash` kiterjesztése a bundle-re.
- Import-adapter bővítés: `SKILL.md` mellett kód-fájlokat is hordozó csomag beolvasása (pl. ha a `SKILL.md` mellett szkript-fájlok is vannak a forrásban).
- Függőség: nincs.

### WP-12 — Skill-eval-kapu — **hátrasorolva, nem blokkoló v1-ben (P2-D3)**
- `SkillEval`/`SkillEvalRun` táblák (§3), `SkillEvalService` (a meglévő `EvalService` mintájára, de önálló osztály — P2-D3).
- Új assertion-típus: sandbox-futtatás golden-input/output párokra, a sandbox (WP-8) felhasználásával.
- Jóváhagyási integráció: T2/T3 `approveVersion` blokkol, ha nincs zöld `SkillEvalRun` az adott verzióhoz.
- Függőség: WP-18 (a golden-futás ugyanaz a `scriptRef` út).

### WP-13 — Regeneráló agent — **TÖRÖLVE (P2-D5, 2026-09-16)**
- Bemenet: kód-bundle mint specifikáció + célzott natív reprezentáció (elsődlegesen: instrukció + `requires` — csak ha ez nem elég, kerül új kód-bundle-be, P2-D5).
- Kimenet: mindig `proposed` `SkillVersion`, a teljes T2/T3 kapun megy át (nincs provenience-kedvezmény).
- Függőség: WP-10 (a regenerált kódnak is át kell mennie a scan-en), WP-12 (eval-gate a regenerált verzióra is).

### WP-14 — T2/T3 jóváhagyási kapu megerősítése (`WriteGateToken` CAS) — **nyitva, nem előfeltétel (P2-D6)**
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

### WP-17 — `py` melléklet beengedése + `t2` levezetés (ÚJ, 2026-09-16)
- `skill-package-adapter.ts`: `CODE_EXTENSIONS`-ből a `py` átkerül egy `CODE_ATTACHMENT_EXTENSIONS` kapuba → melléklet `kind: 'code'`-dal; minden más kód-kiterjesztés változatlanul `code_file` okkal kimarad. A szöveg-/méret-limitek (128 KB, 20 db, 512 KB, NUL-tiltás) változatlanok.
- `skill-attachments.ts`: `kind` mező a Zod-sémában, alapérték `reference` (a tárolt Json visszafelé kompatibilis).
- `skill-validator.ts`: bármely `kind:'code'` melléklet ⇒ `riskTier: 't2'`; `t3` v1-ben nem adható ki.
- Skill-UI: „futtatható kódot tartalmaz" jelzés a verzión, a jóváhagyó lássa a script tartalmát és SHA-256-ját.
- `load_skill_attachment` továbbra is visszaadhatja a script szövegét (olvasásra, hibakereséshez) — a futtatás útja a WP-18.
- Függőség: nincs. Önállóan szállítható.

### WP-18 — `sandbox_exec.scriptRef` — skill-script referenciával (ÚJ, 2026-09-16, P2-D13)
- `tool-registry.ts` `sandbox_exec` argsSchema: `scriptRef: { skillVersionId, path }` opcionális, `script`-tel kölcsönösen kizáró (`refine`).
- `sandbox-exec.handler.ts`: `scriptRef` esetén a handler a `SkillService`-en át oldja fel — csak *aktív*, az *agenthez rendelt* skill-verzió `kind:'code'` melléklete; egyébként fail-closed `skill.access_denied` audit. A feloldott script `/work/run.py`, a verzió többi `kind:'code'` melléklete `/work/in/skill/<path>` alá kerül (helper-modulok; a `command` így `python3 /work/run.py` vagy `python3 /work/in/skill/x.py` lehet).
- Audit (`tool-broker-support.ts` `sandbox_exec` ág): `skillVersionId`, `skillId`, `scriptPath`, `scriptSha256` a `scriptHash` mellett.
- `chat-tool-loop.ts` tool-leírás: a modell tudja, hogy skill-scriptet `scriptRef`-fel indít, nem másolja a szöveget.
- A `/work/run.py` egy-fájlos feltevését (`relativeSandboxPath`, `buildSandboxRunArgs`) itt érdemes egyszerre általánosítani.
- A `scriptRef`-fel futó script kimenete is a bemenetei bizalmi osztályát örökli (#470 D3) — a skill-út nem moshatja ki a trust-envelope-ot.
- Teszt: (a) nem-rendelt skill-verzió `scriptRef`-je → deny + audit; (b) `script` és `scriptRef` együtt → séma-hiba; (c) a futtatott bájtok SHA-256-ja egyezik a jóváhagyott melléklettel.
- Függőség: WP-17.

### WP-19 — Futtató-image csomagkészlet (ÚJ, 2026-09-16, P2-D12)
- `Dockerfile.code-sandbox`: pinnelt `pip install` (`openpyxl==…`, döntés szerint `pandas==…`), a lista a repóban verziózva.
- Smoke-teszt bővítés: a `smokeSandboxRequest` mellé egy `import openpyxl` próba, hogy a deploy ne csendben szállítson csomag nélküli image-et.
- Függőség: nincs; a WP-20-hoz kell.

### WP-20 — Pilot: `tulajdoni-lap-egyeztetes` átvitele skill-scriptbe (ÚJ, 2026-09-16)
- Ez a #396 §1-ben mért fájdalom, tehát **ez az elfogadási teszt**: a `lib/tulajdoni-lap-egyeztetes.ts` (981 sor) helyett egy ~200 soros `scripts/egyeztetes.py` melléklet a skillen; a `SKILL.md` „Ne párosíts a modellben" tiltásai helyett egyetlen „futtasd a scriptet `scriptRef`-fel, bemenet/kimenet a workspace-en" lépés.
- Siker-kritérium: azonos bemeneten azonos egyeztető Excel, mint a mai platform-tool; a futás egy `sandbox_exec` hívás, a modell nem lát rekord-szintű adatot a kontextusában.
- Ha zöld: a `tulajdoni_lap_egyeztetes` / `reconcile_records` pont-toolok és a platform-törzs domain-logikája **törölhető** (külön PR, a §5 kockázat szerint regressziós teszttel).
- Függőség: WP-17, WP-18, WP-19.

## 5. Fejlesztői hatás / kockázatok

- ~~**A sandbox-garancia a leggyengébb láncszem, ha félkészen kerül élesbe.**~~ *(2026-09-16: a WP-8/9 feltétel megszűnt — WP-8 kész, WP-9 elvetve. Helyette a lenti új residualok.)* Történeti: Ha a WP-8 hálózati elzárása vagy a WP-9 proxy hiányos, egy T2/T3 skill futtatása pontosan azt a kockázatot nyitja meg, amit a D13 explicit el akart kerülni (idegen/agent-írta kód szabad hálózati/fájlrendszer-hozzáféréssel). **WP-8 és WP-9 nem szállítható részlegesen** — amíg a hálózati elzárás nincs smoke-teszttel igazolva, a T2/T3 jóváhagyási kapu (WP-14) nem nyithat.
- ~~**Az AST-scan (WP-10) sosem lehet a teljes kontroll.**~~ *(2026-09-16: WP-10 törölve; a kikényszerítés a sandbox runtime + humán jóváhagyás.)* Történeti: A Fázis 1 D5 elve ("a determinista lint + humán a teherhordó, az LLM csak tanácsadó") itt is érvényes — a statikus scan jelzi a tier-t és szűri a nyilvánvaló kockázatot, de a sandbox (WP-8/9) és a humán jóváhagyás (WP-14) a tényleges kikényszerítés. Kategorizálhatatlan kód mindig a szigorúbb tier felé kerekít (P2-D4), sosem lazábbra.
- **A `WriteGateToken` séma-bővítés (P2-D6) visszaható hatású.** Ha a T0/T1 útvonal is átkerül a CAS-mechanizmusra, az érinti a már élesben futó Fázis 1 skill-jóváhagyási folyamatot — ezt külön migrációs terv és regressziós teszt nélkül nem szabad bevezetni.
- **Az eval-gate (WP-12) csak annyit ér, amennyire a golden-set reprezentatív.** A mai `EvalService` string-match motorja túl gyenge mintaként való átvétele hamis biztonságérzetet adna — a sandbox-futtatáson alapuló assertion (P2-D3) architekturálisan más súlyú komponens, nem egy egyszerű bővítés.

- ~~➕ **ÚJ (2026-08-27, §0.4 L4) — az izolációs garancia egy része repón kívüli GCP-konfiguráció.**~~ *(2026-09-16: megoldva a launcher szintjén, `--allow-egress` flag, §0.5.)* Történeti: Ha a VPC-connector és a firewall deny-szabályok nincsenek beállítva, a kód-futtatás **nyitott internettel** fut, miközben ez a spec zártságot feltételez. A Cloud Run konténernek alapból van kimenő internet-hozzáférése, és ezt a `HARNESS_EGRESS_ENFORCE` in-process önteszt **nem** pótolja. Ezt telepítési checklistként kell kezelni, nem kód-szintű állításként — és a WP-0 spike-nak **kívülről** kell igazolnia.

- ➕ **ÚJ (2026-09-16) — a sandbox-service fail-open token nélkül nem-Cloud-Run deployon.** A #485 audit residuálja: a `code-sandbox-server` hitelesítése Cloud Run-identitásra épül; más deploy-célon a token hiánya nem tiltás. Telepítési checklist-tétel, nem skill-oldali kód.
- ➕ **ÚJ (2026-09-16) — a `sandbox_exec` kimenete `trusted` osztályú, a bemenetétől függetlenül.** Egy skill-script, ami külső (pl. `http_api`-ból archivált) adatot dolgoz fel és printel vissza, ma „kimossa" a #97 trust-envelope-ot. A #470 D3 (bizalmi öröklés a bemenetekből) kezeli; a WP-18-nak nem szabad ezt megkerülnie.
- ➕ **ÚJ (2026-09-16) — a WP-20 törlés-lépése regressziós kockázat.** A `tulajdoni_lap_egyeztetes` platform-tool élesben fut; a skill-script csak akkor válthatja ki, ha azonos bemeneten azonos kimenetet ad (golden-teszt), és a régi tool egy release-ig párhuzamosan marad.

## 6. Hatókörön kívül (ennek a specnek sem tárgya)

- Automatikus, cron-vezérelt upstream-szinkron — a P2-D9 kizárólag admin-kezdeményezett, diff-alapú jelzés, sosem automata import.
- Idegen kód "biztonságossá" statikus átírása — véglegesen elvetve (D13, öröklött elv, ez a spec sem nyit ezt újra).
- Több nyelvű AST-lefedés a kezdeti Python/JS-TS-en túl — külön munkacsomag, ha a katalógus-igény indokolja.
- A `Recipe`/`Skill` konvergencia — változatlanul külön (Fázis 1 §5 elve érvényes).
- **Connectorokat, titkokat és szabad hálózatot elérő általános shell-eszköz** (2026-08-27, P2-D10). A végrehajtó réteg mindkét bejárata workspace-scope-olt és hálózat nélküli; a hálózat felé az egyetlen kijárat a jóváhagyott `allowEgress` (következmény-kapu), tool-hívás felé pedig — ha lesz — a #470 v2 fájl-RPC, csak olvasó toolokra. *(2026-09-16: a WP-9 hivatkozás elvetve.)* Egy szabad shell megkerülné az auditált web-egress nyelőt, a napi keretet és a következmény-kaput.
- **Nem-Python kód-melléklet** (`sh`, `js`, `sql`, …) — 2026-09-16: a `py` az egyetlen beengedett kód-kiterjesztés; bővítés külön döntés, ha a katalógus-igény indokolja. Bináris/wheel soha (a melléklet-tár szöveg, P2-D12).
- **Tenant-szintű pip-csomag** — a futtató-image csomagkészlete platform-release (P2-D12).
