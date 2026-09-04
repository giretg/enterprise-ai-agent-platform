# Napi health-check napló — Enterprise AI Agent Platform

Egy sor / futás. Oszlopok: dátum | top találat | ág (A/B/C/D) | PR link vagy „nincs" | státusz.

Részletes riportok: `ops/reports/health-check-YYYY-MM-DD.md`

---

| Dátum | Top találat | Ág | PR | Státusz |
|-------|-------------|----|----|---------|
| 2026-09-02 | Nincs érdemi találat — a deployolt platform 24h-ban 0 kérés, 0 hiba, 0 költségjel; scale-to-zero | D | nincs | Lezárva. Két nem-kód javaslat a riportban: (1) `gcloud auth login` az ops-hoston (lejárt token vakon hagyja a jövőbeli futásokat), (2) `pg_stat_statements` bekapcsolása a prod Neon DB-n. |
| 2026-09-03 | Prod Clerk = **development** instance → a munkamenet az URL-ben utazik (`__clerk_handshake`), a Googlebot beindexelte és **visszajátssza**: authentikáltan bejárja a control-plane-t + agent-futásokat indít (`board_write`, LLM). Token a logban is. Legalább 2026-08-05 óta. | A | [#426](https://github.com/giretg/enterprise-ai-agent-platform/issues/426) (Urgent) | Nyitva. Riport: `ops/reports/health-check-2026-09-03-URGENT-clerk-dev-instance-session-leak.md`. Javítja/korrigálja a ma korábbi #421 „nincs adatszivárgás" következtetését. Teendő: prod Clerk instance + `sk_live/pk_live`, dev-instance nyugdíjazás, #420 merge, Search Console index-törlés, token-scrub a logból. |
