# Code review — döntést igénylő pontok

**Terület:** Governed Flow Builder — Playbook v2 compile + runtime út
**Dátum:** 2026-07-06
**Reviewer:** automatizált code-review futás (Claude Code)
**Státusz:** 1 javítás elvégezve; 2 pont döntést igényel, 1 defenzív megjegyzés

A javított hibát (Decision Step ág-mezők kimaradtak az output-következtetésből) lásd a
`code-review-log.html`-ben és a `code_review.md`-ben. Az alábbi pontok **szándékosan
nem lettek javítva**, mert termék/architektúra-döntést igényelnek.

---

## D1 — A `tool_denied` hard-signal jelenleg elérhetetlen kód

**Hol:**
- `app/src/lib/playbook-v2/process-step-payload.ts:258` — `computeStepOutcome`, a `toolDenied`
  jel `failed / tool_denied` kemény hibaként dokumentálva.
- `app/src/domain/agent/general-task-runtime.ts:238` — a hívó **nem** ad át `toolDenied`-ot.
- `app/src/domain/agent/chat-tool-loop.ts:73` — `ToolLoopResult = completed | exhausted`,
  nincs benne „volt-e megtagadott tool-hívás” jel.

**Mi a helyzet:** ha a tool broker egy lépés futása közben megtagad egy tool-hívást, a
megtagadás szövege visszamegy a modellnek, és a loop `completed`-tel zárulhat. Így egy lépés
`ok`-ként záródhat annak ellenére, hogy egy (akár kritikus) tool-hívást a governance megtagadott.
A `StepOutcomeSignals.toolDenied` mező soha nem populálódik.

**Miért nem javítottam magamtól:** ez nem egyértelmű hiba. Két, egyaránt védhető viselkedés van:
1. **Jelenlegi:** a modell helyreállhat a megtagadásból (más eszközzel/úttal), és ha a
   kimeneti szerződést teljesíti, a lépés `ok`. Ez rugalmas, de elrejtheti a governance-blokkot.
2. **Szigorúbb:** bármely broker-megtagadás keményen buktatja a lépést (`failed/tool_denied`),
   emberi felülvizsgálatra terelve. Ez auditálhatóbb és governance-konzisztens, de „false
   positive” blokkokat okozhat olyankor, amikor a modell legitim módon állt helyre.

**Javasolt döntés (megvitatásra):** a 2. opció felé hajlok egy **finomítással** — csak akkor
buktasson keményen, ha a megtagadott tool a lépés kimeneti szerződéséhez / deliverable-jéhez
tartozik (pl. a `deliverable` fájl-eszköz vagy egy kötelező adat-forrás), egyébként maradjon a
jelenlegi helyreállás. Megvalósításhoz: `ToolLoopResult`-ra egy `deniedToolCalls: string[]` mező,
és a `general-task-runtime` adja tovább a `computeStepOutcome`-nak.

**Kockázat, ha nem történik semmi:** governance-megtagadás után is lezárulhat `ok` lépés →
audit-nyomvonal azt sugallja, hogy a lépés rendben lefutott, holott egy kontroll megtagadott
egy műveletet.

---

## D2 — Inkonzisztens terminál-státusz védelem az advance-ágakon

**Hol:** `app/src/domain/playbook/process-service.ts`
- `next_step` ág (~651) és `complete` ág (~490): `updateProcessIfStatusIn(...)` feltételes író,
  amely **nem** írhat felül terminális (`completed`) állapotot.
- `await_gate` ág (~539) és `await_human` ág (~589): feltétel nélküli
  `updateProcess(status: 'awaiting_human')`.

**Mi a helyzet:** egy késő/párhuzamos advance-hívás elméletileg felülírhatná egy már
`completed` folyamat állapotát `awaiting_human`-ra az await-ágakon.

**Miért nem javítottam magamtól:** **jelenleg elérhetetlen** az egy-aktív-lépés invariáns miatt
(egy lineáris folyamatban egyszerre egy lépés aktív, és a bevezetett idempotencia-őr a duplikált
dispatch-eket kiszűri). Így nem „nyilvánvaló bug”, hanem defense-in-depth következetlenség — a
javítás megváltoztatná a viselkedést egy jelenleg nem előforduló úton.

**Javasolt döntés:** alkalmazzuk ugyanazt a státusz-őrt az await-ágakra is:
`updateProcessIfStatusIn(process.id, [...ADVANCEABLE_PROCESS_STATUSES], { status: 'awaiting_human' })`,
és ha nem sikerült (időközben terminális lett), adjunk `noop`-ot. Ez olcsó, konzisztens, és
felkészít egy jövőbeli párhuzamos-lépés (fork/join) kiterjesztésre. Alacsony prioritás.

---

## D3 (megjegyzés, nem blokkoló) — null-feltételű hiba-él az `evaluateAdvance`-ban

**Hol:** `app/src/lib/playbook-v2/runtime.ts:254`

Az `evaluateAdvance` hiba-ág ciklusa `if (rule.condition && evaluateCondition(...))` — egy
`condition` nélküli hiba-él némán kimaradna. A compiler **mindig** ad feltételt a hiba-élekre
(reason- vagy status-illesztés), ezért ez ma nem elérhető.

**Javaslat:** csak dokumentáció/defenzió kérdése. Ha valaha kézzel is előállhat `compiled_spec`
(pl. import), egy explicit „feltétel nélküli hiba-él = mindig illeszkedik” ág vagy egy assert
tenné robusztussá. Kód-változtatás most nem indokolt.

---

## Nyugtázott erős pontok (nincs teendő)

- Kapu-megkerülés fail-closed (`gateDecision`): agent/system SOHA nem léphet át blocking emberi
  kaput; a kapu-ellenőrzés a transition-lánc előtt fut.
- Kaszkád-védelem: `blocked`/`failed` outcome esetén a happy-path ágak kizárva.
- Concurrency-hardening (idempotencia-őr + feltételes írások) valós „stuck running” versenyt céloz.
- Validátor: kétrétegű, gazdag keresztreferencia / elérhetőség / ciklus / error-path lefedettség.
