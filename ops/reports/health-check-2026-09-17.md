# Napi health-check — 2026-09-17

Időablak: utolsó 24 óra (2026-09-16 00:00 UTC – 2026-09-17 00:00 UTC), viszonyítási alap: megelőző 7 nap.

## 0. Amit már tudunk (nem javasoltam újra)
- #426 (Clerk dev-instance prod-on) — nyitva, gyökér-ok emberi döntésre vár.
- #415 (active-runs dupla-poll) — nyitva.
- #443/#445/#448 (OOM/DoS body-size gate stack) — nyitva, review nélkül.
- `main` CI 100/100 pirosan bukott (09-16 találat) — **JAVÍTVA**: [PR #498](https://github.com/giretg/enterprise-ai-agent-platform/pull/498) 09-16 08:13 UTC-kor mergelt, azóta a `main` CI-ja minden futáson zöld (ellenőrizve: utolsó 5 futás, mind `success`). Regresszió-ellenőrzés lezárva.
- Nyitott PR-szám tovább nő: 51→**54**, `cursor/*` draft: 22→**22** (stagnál).
- gcloud CLI-auth ismét lejárt (interaktív login, nem az elsőkör) — ezúttal a health-check saját service accountjával (`eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com`, `~/.config/eai-healthcheck/gcp-runner-key.json`) sikerült aktiválni és a projektet is beállítani, tehát a mai futás minden tervezett forrást elért. **Emberi teendő marad**: az interaktív `gcloud` session tokenje ezen a hoszton rendszeresen lejár — érdemes véglegesen a service key-re állítani az ops-szkripteket, hogy ez a hetente visszatérő súrlódás megszűnjön.

## 1. Adatgyűjtés

**Cloud Run / alkalmazás-log (`gcloud logging read`, `enterprise-ai-demo` projekt, service: `enterprise-ai-agent-platform`):**
- 24h alatt **0 db `severity>=ERROR`**, 7 napra visszamenőleg is 0.
- 24h alatt **9873 HTTP kérés**: 4967→200 (mintavett ablak), teljes napi bontásban 200/307/404/308/400, **0× 5xx**.
- `enterprise-code-sandbox` (09-16-i #485 build) szolgáltatáson szintén **0 db ERROR** 24h alatt.
- Top endpoint-koncentráció: `/control-plane/tickets/:id` (a teljes forgalom **91%-a** egy 2000-es mintában) — ez lett a mai vizsgálat tárgya, lásd 3. pont.
- Cloud Run OOM-jelzés (`#437` regresszió-ellenőrzés): 7 napra visszamenőleg 0 találat `OOM`/`out of memory` mintára — a 09-07-i fix 10. napja tart.

**Neon DB (`pg_stat_statements`):**
- Az extension be van kapcsolva, de a stats-ablak friss (csak migrációs/bootstrap lekérdezések szerepelnek, `calls=1` mindegyiken) — a Neon scale-to-zero minden compute-felfüggesztéskor nulláz, ezért ez a forrás gyakorlatilag sosem gyűjt hosszabb távú trendet a jelenlegi (nem always-on) architektúrán. Nem hiba, csak korlát — nem becsülhető belőle lassú lekérdezés ma.

**GitHub CI/PR állapot:**
- `main` CI zöld (lásd 0. pont). Nyitott PR: 54, `cursor/*` draft: 22, [PR #512](https://github.com/giretg/enterprise-ai-agent-platform/pull/512) (gateway `x-agent-version` fix, tegnapi audit) még nyitva, review-ra vár.

**Nem vizsgált terület:**
- Billing export / SKU-bontás — nincs bekötve erről a hosztról.
- Firestore olvasás/írás darabszám — nincs bekötve/nincs hozzáférés.
- Clerk hibaráta közvetlen API-ból — csak közvetett log-jelek, ott nem volt új esemény.

## 2. Top 5

| # | Találat | Hatás | Gyakoriság | Kockázat | Pontszám |
|---|---------|-------|-----------|----------|----------|
| 1 | Egyetlen elakadt (`awaiting_human`) ticket lapja, háttérfülön hagyva, a napi platform-forgalom ~28%-át termeli feleslegesen (3 független, fülláthatóságtól független `router.refresh()` időzítő) | 3 | 4 | 1 | **12** |
| 2 | Nyitott PR-szám folyamatosan nő (51→54), `cursor/*` draft stagnál 22-n — review-kapacitás vs. termelt PR-mennyiség szétnyílik | 2 | 3 | 3 | 2 |
| 3 | gcloud interaktív auth ismét lejárt ezen a hoszton — heti visszatérő súrlódás, ma service key-jel megkerülve | 2 | 4 | 1 | 8 (emberi lépés, nem PR) |
| 4 | #426 Clerk dev-instance prod-on — változatlan, korábban jelezve | 4 | 1 | 3 | 1,3 |
| 5 | pg_stat_statements a scale-to-zero architektúrán nem gyűjt trendet — megfigyelés, nem hiba | 1 | 5 | — | n/a |

## 3. Mélyebb vizsgálat — a #1 találat

**Tünet:** a `/control-plane/tickets/:id` route adja a teljes napi kérésforgalom túlnyomó részét. Egy adott ticket (`660852b3-…`) önmagában **2 092 kérést** kapott a ticket-oldalra + **660 kérést** a workspace-fájllista API-ra = **2 752 kérés/nap egyetlen ticketről**, a napi ~9 873-ból (~28%). Az óránkénti bontás 15:26–15:38 között 100+ kérés/perc kiugrást mutat, utána egyenletes 4-8 kérés/perc egészen 23:59-ig — ez nyitva hagyott, háttérbe került böngészőfülre utal, nem aktív használatra.

**Gyökér-ok:** a ticket-részletező lapon három kliens-komponens (`ticket-activity-history.tsx`, `ticket-connector-grants.tsx`, `ticket-consequence-approvals.tsx`) mindegyike saját `setInterval`-lal hívja a `router.refresh()`-t (2s / 8s / 8s), amíg a ticket "élő" állapotban van (`in_progress` / `awaiting_human` / stb.) — **egyik sem néz fülláthatóságot**. A `router.refresh()` Next.js Server Action, minden hívás DB-lekérdezést és teljes RSC-újrarendelést indít az origin-en. A kódbázisban már létezik a helyes minta (`wiki-proposal-detail.tsx`, explicit kommenttel: "Rejtett fülön nem pollozunk... felébreszti az adatbázist"), csak nem lett alkalmazva a másik három helyen.

**Ellenőrzés:** helyben lefuttatva a hiányzó logika tiszta függvényként (`shouldFireVisibilityGatedPoll`) — 3/3 eset (látható fül, rejtett fül, kikapcsolt env-flaggel rejtett fül) a várt módon viselkedik. `tsc`/`eslint` tiszta az érintett fájlokon.

**Döntés (5. pont szabálya szerint):** 7 fájl, 94 sor betoldás / 19 törlés, viselkedés mögé env-kapcsolóval (`NEXT_PUBLIC_TICKET_POLL_PAUSE_ON_HIDDEN_TAB`), egy lépésben visszaállítható → **B ág, draft PR**.

→ **[PR #515](https://github.com/giretg/enterprise-ai-agent-platform/pull/515)** (draft): megosztott `useVisibilityGatedInterval` hook, alkalmazva mindhárom komponensen. Mérési parancs és üzleti nyelvű indoklás a PR leírásában.

Nem foglalkoztam vele ebben a PR-ban, de ugyanaz a gyökér-minta érinti a `use-ticket-workspace-files.ts`-t is (660 kérés/nap ugyanezen a ticketen) — az API-route könnyebb súlyú, mint a teljes oldal-RSC, ezért külön döntésre hagytam (lásd a PR "Amit el kell döntened" pontját).

## 4. Zárás

| Dátum | Top találat | Ág | PR | Státusz |
|-------|-------------|----|----|---------|
| 2026-09-17 | Egyetlen háttérfülön hagyott, elakadt ticket a napi platform-forgalom ~28%-át termeli három fülláthatóságot nem néző `router.refresh()` időzítő miatt | B | [#515](https://github.com/giretg/enterprise-ai-agent-platform/pull/515) (draft) | Nyitva — review és merge emberi döntésre vár. |
