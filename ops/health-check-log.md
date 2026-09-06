# Napi health-check napló — Enterprise AI Agent Platform

Egy sor / futás. Oszlopok: dátum | top találat | ág (A/B/C/D) | PR link vagy „nincs" | státusz.

Részletes riportok: `ops/reports/health-check-YYYY-MM-DD.md`

---

| Dátum | Top találat | Ág | PR | Státusz |
|-------|-------------|----|----|---------|
| 2026-09-02 | Nincs érdemi találat — a deployolt platform 24h-ban 0 kérés, 0 hiba, 0 költségjel; scale-to-zero | D | nincs | Lezárva. Két nem-kód javaslat a riportban: (1) `gcloud auth login` az ops-hoston (lejárt token vakon hagyja a jövőbeli futásokat), (2) `pg_stat_statements` bekapcsolása a prod Neon DB-n. |
| 2026-09-05 | Regresszió-ellenőrzés #426-on: PR #420 (`robots.txt: Disallow /`) deploy után (09-04 14:50 UTC) a Google-crawler `/control-plane/...` forgalma 57×200-ról 0-ra esett; DE a gyökérok (Clerk `pk_test_` = dev-instance élesben) ma is fennáll, telemetria-log igazolja. 0 hiba, 153 kérés/24h (98% bot). | D | nincs (már #426 alatt fut) | Nyitva. #426 Urgent címke jogos marad, csak a tünet (crawl) van lefedve, nem az okozat. Javaslat: #426-ba konkrét lezárási határidő, nehogy „mitigálva=elfelejtve" legyen. |
| 2026-09-06 | #426 Clerk dev-instance session-leak — Google-flotta hitelesített olvasás **és `POST`** a control-plane-en; **REGRESSZIÓ**: a #420 `robots.txt` enyhítés ellenére 09-05 = 6 467 kérés (7 napos csúcs), 7 nap alatt 14 981 kérés ~100% `Google` UA, 0 valódi user | A | nincs (nyitott #426-ra regressziós komment) | Nyitva — gyökérok: prod Clerk = *development* instance. Teendő emberi: prod Clerk instance + `sk_live`, session-revoke, Search Console index-removal. Riport: `ops/reports/health-check-2026-09-06.md` |
