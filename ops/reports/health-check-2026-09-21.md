# Napi health-check — 2026-09-21

Időablak: utolsó ~25 óra (2026-09-20 ~12:00 UTC – 2026-09-21 ~12:45 UTC), viszonyítási alap: megelőző 7 nap.

## 0. Amit már tudunk (nem javasoltam újra)

- **#426** (Clerk dev-instance prod-on, Urgent/security) — nyitva, 15 napja, emberi döntésre vár. Ma nincs új jel.
- **#549** (2026-09-18, séma-eltérés éles DB-n, döntési jegyzet) — **még mindig OPEN**, nincs mergelve. Regresszió-ellenőrzés lent (1. pont) — nem javaslom újra, csak státuszfrissítés.
- **#437, #449, #498, #512, #515** — mind **MERGED** azóta (a #515 tegnap még draftként szerepelt a naplóban, mára mergelve). Regresszió-ellenőrzés: mindegyik tart, lásd 1. pont.
- Nyitott PR-szám: 52 (stagnál a 09-18-i 52-höz képest). `cursor/*` draft: 22→**24**.

## 1. Adatgyűjtés

**Cloud Run / alkalmazás-log (`gcloud logging read`, `enterprise-ai-demo` projekt, `enterprise-ai-agent-platform` szolgáltatás, `europe-west4`):**
- 24h alatt **0 db `severity>=ERROR`** (minden szolgáltatásra, a `enterprise-code-sandbox`-ra is).
- 24h alatt **1501 HTTP kérés**: 909×200, 367×307, 112×401, 104×202, 5×404, 2×308, 2×304 — **0×5xx**.
- p50 74 ms, **p95 552 ms**, p99 5,4 s (hosszú SSE-kapcsolatok, a 09-18-i 541 ms-os p95-tel egy sávban, nem anomália).
- Napi kérésszám 7 napos trendje: 11002 (09-15) → 9873 (09-16) → 3196 (09-17) → 2020 (09-18) → 1407 (09-19) → 1672 (09-20) → 678 (09-21, részleges nap) — csökkenő, de nincs hozzá hibajel, valószínűleg természetes használati ingadozás.
- OOM-jelzés (`#437` regresszió-ellenőrzés): 7 napra visszamenőleg **0 találat** `OOM`/`memory limit` mintára.

**#549 regresszió-ellenőrzés (`rail-state`/`active-runs`/`agent-chat/turns` 500-ak):**
- 7 napos 500-as trend: 51 (09-17) → 209 (09-18) → 25 (09-19) → **0 (09-20)** → **0 (09-21)**.
- Utolsó előfordulás: 2026-09-19T04:33:51Z. Azóta egy sincs.
- **DE**: a három végpontra a mai 24h-ban **0 kérés is érkezett** (nincs forgalom, ami a hibás `launch_*` lekérdezési ágat futtatná) — tehát ez **nem bizonyítja**, hogy a séma-eltérés megszűnt, csak azt, hogy senki nem futtatott olyan agent-forduló indítást/helyreállítást, ami ráfutna. A `#549` döntési jegyzet (kell-e valakinek `npx prisma migrate deploy`-t futtatnia élesben) **továbbra is nyitott és érvényes**.

**GitHub CI/PR állapot:**
- `main` CI **jelenleg zöld** (utolsó futás 07:17 UTC, success). Volt egy tranziens `tsc` hiba ma 06:09 UTC-kor (`provisioning-service.ts` — hiányzó `connectorMode` mező egy catalog-listázó ágban), de ez **már javítva volt, mielőtt ez a futás elindult**: a felhasználó saját, ma reggeli PR #586 (`fix/catalog-connector-mode`) 07:0x UTC körül mergelt, és a 07:17-es CI-futás már zöld ez ellen. Nincs teendő, csak megfigyelés.
- Nyitott PR: 52, `cursor/*` draft: 24.

**Új megfigyelés — `/api/mcp/ostorosbor` 401-hullám (nem rangsorolt, lásd indoklás):**
- 7 napos trend: 1 (09-17) → 79 (09-18) → 210 (09-19) → 92 (09-20) → 56 (09-21, részleges) 401-es válasz erre az egy endpointra.
- A repóban **jelenleg helyben, commitolatlanul** két, a felhasználó által ma/nemrég írt szkript van (`app/scripts/inspect-connector-visibility.ts`, `app/scripts/remove-orphan-ostoros-crm-connectors.ts`), ami pontosan "szellem" (draft nélküli, aktív, fixed-módú) Ostoros CRM/föld connectorokat keres és törölne — ez összhangban van a megfigyelt 401-mintázattal (egy elárvult, rossz/lejárt hitelesítéssel újrapróbálkozó self-updating connector). **Nem veszem fel új találatként/PR-ként**, mert ez már aktív, folyamatban lévő emberi munka ugyanerre a gyökérokra — a szabály szerint ("amit már ismerünk, ne javasoljuk újra") ez idetartozik, csak dokumentálom, hogy a log-jel alátámasztja a WIP-et.

**Nem vizsgált terület:**
- Billing export / SKU-bontás — `bq ls --project_id=enterprise-ai-demo` üres, nincs bekötve.
- Neon DB slow query / `pg_stat_statements` — nem csatlakoztam közvetlenül éles DB-hez (kockázatkerülés), lásd `#549` regresszió-ellenőrzés indirekt módszerét fent.
- Firestore — nem releváns (Postgres/Prisma-alapú platform, korábban is megállapítva).
- Clerk hibaráta — nincs önálló 401-jel Clerk-auth oldalon (a 401-ek mind az `/api/mcp/ostorosbor`-ra koncentrálódnak, ami connector-szintű hitelesítés, nem Clerk-munkamenet).

## 2. Top 5

| # | Találat | Hatás | Gyakoriság | Kockázat | Pontszám |
|---|---------|-------|-----------|----------|----------|
| 1 | `#549` séma-eltérés éles DB-n — dormant (0 új 500 két napja), de **nem bizonyítottan javítva** (nincs forgalom az érintett ágon), döntés emberi kézben | 4 | 1 (ma 0 előfordulás) | 1 | 4 |
| 2 | `/api/mcp/ostorosbor` 401-hullám, ~50-200/nap 3 napja — de már aktív WIP fedi | 2 | 4 | 1 | 8 (nem cselekvésre vár tőlem) |
| 3 | Nyitott PR-szám stagnál 52-n, `cursor/*` draft 22→24 — enyhe növekedés, nem romlás | 2 | 2 | 3 | 1,3 |
| 4 | `#426` Clerk dev-instance élesben — változatlan, 15 napja nyitva | 4 | 1 | 2 | 2 |
| 5 | Tranziens `tsc` CI-hiba ma reggel — már önjavított a felhasználó saját PR-jával, mielőtt ez a futás elindult | 1 | 1 | 1 | 1 |

Egyik találat sem éri el azt a küszöböt, ahol új PR-t vagy döntési jegyzetet érdemes nyitni: az #1 és #4 már nyitott, ismert tételek (döntés emberi kézben), a #2 aktív WIP-pel fedett, a #3 és #5 nem éri meg a beavatkozást.

## 3. Döntés

**D ág — nincs érdemi, ÚJ találat.** Amit ellenőriztem: Cloud Run hibaszint/HTTP-státusz-eloszlás/latencia (24h + 7 nap trend), OOM-jelzés, `main` CI állapot, nyitott PR/draft-szám, a `#549` séma-eltérés regressziója (indirekt, kérésszám alapú), `/api/mcp/ostorosbor` 401-minta. Amit nem vizsgáltam: billing export (nincs bekötve), közvetlen Neon slow-query (kockázatkerülés), Firestore (nem releváns), önálló Clerk-hibaráta (nincs jel rá).

Nincs ma nyitandó PR. A két nyitott, emberi döntésre váró tétel (`#426`, `#549`) változatlan — mindkettő napok óta nyitva, egyik sem romlott, egyik sem oldódott meg.
