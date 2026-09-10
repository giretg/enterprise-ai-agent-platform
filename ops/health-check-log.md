# Napi health-check napló — Enterprise AI Agent Platform

Egy sor / futás. Oszlopok: dátum | top találat | ág (A/B/C/D) | PR link vagy „nincs" | státusz.

Részletes riportok: `ops/reports/health-check-YYYY-MM-DD.md`

---

| Dátum | Top találat | Ág | PR | Státusz |
|-------|-------------|----|----|---------|
| 2026-09-02 | Nincs érdemi találat — a deployolt platform 24h-ban 0 kérés, 0 hiba, 0 költségjel; scale-to-zero | D | nincs | Lezárva. Két nem-kód javaslat a riportban: (1) `gcloud auth login` az ops-hoston (lejárt token vakon hagyja a jövőbeli futásokat), (2) `pg_stat_statements` bekapcsolása a prod Neon DB-n. |
| 2026-09-05 | Regresszió-ellenőrzés #426-on: PR #420 (`robots.txt: Disallow /`) deploy után (09-04 14:50 UTC) a Google-crawler `/control-plane/...` forgalma 57×200-ról 0-ra esett; DE a gyökérok (Clerk `pk_test_` = dev-instance élesben) ma is fennáll, telemetria-log igazolja. 0 hiba, 153 kérés/24h (98% bot). | D | nincs (már #426 alatt fut) | Nyitva. #426 Urgent címke jogos marad, csak a tünet (crawl) van lefedve, nem az okozat. Javaslat: #426-ba konkrét lezárási határidő, nehogy „mitigálva=elfelejtve" legyen. |
| 2026-09-06 | #426 Clerk dev-instance session-leak — Google-flotta hitelesített olvasás **és `POST`** a control-plane-en; **REGRESSZIÓ**: a #420 `robots.txt` enyhítés ellenére 09-05 = 6 467 kérés (7 napos csúcs), 7 nap alatt 14 981 kérés ~100% `Google` UA, 0 valódi user | A | nincs (nyitott #426-ra regressziós komment) | Nyitva — gyökérok: prod Clerk = *development* instance. Teendő emberi: prod Clerk instance + `sk_live`, session-revoke, Search Console index-removal. Riport: `ops/reports/health-check-2026-09-06.md` |
| 2026-09-07 | Cloud Run OOM-kill párhuzamos agent-chat + inline HTML-előnézet alatt (09-06 10:06–10:25 UTC, 47 kill, 42 kliens-`5xx`) — **REGRESSZIÓ** a `e1a92700` javítás után (512/80→1024/40, most 1024/40 is elbukott). Csak 1 instance futott a 10-es plafon ellenére. | B | [#437](https://github.com/giretg/enterprise-ai-agent-platform/pull/437) | Nyitva — `apphosting.yaml` `concurrency 40→10`, `memoryMiB 1024→2048` (mindkét fájl). Tartós fix (#114 runtime-szétválasztás) külön döntés. Riport: `ops/reports/health-check-2026-09-07.md` |
| 2026-09-10 | Kliens életjel-poll `GET /api/v1/agent-chat/turns` 750 ms-enként — az origin-forgalom **47%-a** (1304/2782 kérés/24h), redundáns az élő SSE-streammel, autoscaling-ébresztés; 2 valódi user. + **Korrekció:** a 09-05/06/07 „Googlebot-flotta" a CDN origin-UA (`Google`) félrediagnózisa volt — a CDN-él naplója szerint a forgalom 2 valódi böngésző, 0 bot; #426 gyökér-ok (prod Clerk = dev instance) valós marad, de a „Urgent / crawl folyamatban" súlyosság felülvizsgálandó. 0 hiba, 0 `5xx`. | B | [#449](https://github.com/giretg/enterprise-ai-agent-platform/pull/449) (draft) | Nyitva — külön `AGENT_TURN_LIVENESS_POLL_DEFAULT_MS = 5000` + `NEXT_PUBLIC_AGENT_TURN_LIVENESS_POLL_MS` env. #426-ra korrekciós komment küldendő. Riport: `ops/reports/health-check-2026-09-10.md` |
