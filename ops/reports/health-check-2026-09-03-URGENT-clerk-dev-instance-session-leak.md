# 🔴 AZONNALI — Health-check 2026-09-03 (kiegészítő futás)

**Dátum:** 2026-09-03 · **Szerep:** SRE + FinOps · **Ág:** **A — adatszivárgás-gyanú**
**Kapcsolódó:** ez a futás felülírja a ma korábbi #421 riport „adatszivárgás nincs" következtetését.

---

## Egy mondatban

A deployolt platform egy Clerk **fejlesztői** (development) instance-szel fut, ezért a
bejelentkezett munkamenet az **URL-ben** utazik (`__clerk_handshake`, `__clerk_db_jwt`) —
és mivel nincs `robots.txt`, a Google crawler beindexelt egy ilyen hitelesített linket,
majd **visszajátssza a benne lévő élő munkamenetet**, így a Googlebot authentikált
operátorként futtatja a belső control-plane-t (agent-beszélgetések, workspace-fájlok
olvasása, sőt valódi agent-futások LLM-hívásokkal és eszköz-hívásokkal).

## Mi a kitettség

| # | Kitettség | Bizonyíték |
|---|---|---|
| 1 | **Belső, több-bérlős control-plane tartalma a Google indexébe kerül**, mert a Googlebot egy visszajátszott munkamenettel *bejelentkezve* renderel: agent-konfigok, beszélgetés-tartalmak, `/api/v1/conversations/<id>/workspace/files`, futás-trace-ek. | `2026-09-03T12:07:17Z` `GET /?__clerk_db_jwt=dvb_…&__clerk_handshake=<JWT>` a 66.249.81.162 címről (Googlebot-tartomány), UA `Google`; utána ugyanezekről az IP-kről (`66.249.81.x`, `74.125.208.x`) `POST /control-plane/agents/<id>/chat`, `GET /api/v1/conversations/<id>/workspace/files`, `POST /api/v1/agent-chat/stream` → mind **HTTP 200**. |
| 2 | **Élő munkamenet-token nyílt szövegben a Cloud Loggingban.** A teljes `__clerk_handshake` JWT + `__clerk_db_jwt` a request-URL query-stringjében naplózódik. Bárki `roles/logging.viewer`-rel visszajátszható munkamenet-hitelesítőt lát. | A fenti logsor a query-stringgel együtt eltárolva; `roles/logging.viewer` a projekt több principaljának. |
| 3 | **Kontrollálatlan agent-végrehajtás a crawler kezében.** A visszajátszott munkamenet valódi LLM-hívásokat (OpenRouter) és eszköz-hívásokat indít, köztük **állapotváltó** eszközt (`board_write`). | 7 nap alatt 2 crawler-indított agent-session (`2026-08-31T10:09`, `2026-09-03T12:07`, mindkettő 163 s-os `agent-chat/stream`, UA `Google`), sessiononként ~6 `model.call`; a 7 napos `tool.call` halmazban `board_write`, `kb_search`, `file_read`, `http_api_get`, `run_trace`, `tulajdoni_lap_parse`. |
| 4 | **Fejlesztői Clerk-instance biztonsági profil élesben.** A dev-instance nem tesz first-party sütit a valós domainre (innen az URL-ben utazó handshake), lazább rate-limit, teszt-JWT sablonok, bekapcsolt telemetria. | 30 nap alatt **393×** app-logsor: *"Attention: Clerk collects telemetry data from its SDKs when connected to development instances."*; a `DEPLOY.md` 3. lépése kifejezetten „Clerk **production instance** kulcsok"-at ír elő. |

**Nem érintett:** a token nélküli, tényleg anonim kérés helyesen elutasul —
`GET /` token nélkül → **307** a sign-inre, a védett API-k → **404/403**. A rés
kizárólag a **dev-instance URL-ben szállított munkamenet visszajátszása**.

## Mióta áll fenn

- `__clerk_handshake` a request-URL-ekben **19 külön napon** 2026-08-05 és 2026-09-03
  között (68 találat); `__clerk_db_jwt` 7 napon (8 találat). A Cloud Logging retenció
  ~30 nap → **legalább 2026-08-05 óta**.
- A Clerk-konfiguráció az `apphosting.yaml`-ban az első App Hosting config-commit óta
  jelen van → a kitettség **nagy valószínűséggel a platform éles indulása óta** áll fenn.
- A crawler-forgalom heteken át a platform *egyetlen* forgalma (lásd #421), tehát a
  visszajátszás végig zajlott, amióta a Googlebot bejárja az oldalt.

## Mit kell most tenni (emberi lépések, kód-PR NÉLKÜL — A ág)

1. **Clerk production instance-re váltás.** A Clerk dashboardban a valós domainre
   (`enterprise-ai-agent-platform--enterprise-ai-demo.europe-west4.hosted.app`, ill. a
   custom domain) production instance; utána a Secret Manager titkok cseréje:
   `CLERK_SECRET_KEY` → `sk_live_…`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` → `pk_live_…`,
   majd redeploy. A production instance first-party sütit használ → **nincs többé
   munkamenet az URL-ben**.
2. **A meglévő dev-instance munkamenetek érvénytelenítése** (a dev instance
   nyugdíjazása ezt elvégzi). Minden, a dev instance-en aktív munkamenetet
   kompromittáltnak kell tekinteni — a már beindexelt `__clerk_handshake` tokenek ne
   legyenek visszajátszhatók.
3. **#420 (`robots.txt` = `Disallow: /`) azonnali merge** — ez a gyors, részleges
   mitigáció, ami a szabálykövető crawlereket leállítja. A #420/#421 „adatszivárgás
   nincs / a Clerk-kapu a helyén van" állítását javítani kell.
4. **Google index/cache törlése** a `run.app` és a `hosted.app` hosztra (Search Console
   Removals), amint a `robots.txt` él.
5. **A kiszivárgott tokenek eltávolítása a logból**, ha a retenciós politika engedi;
   különben `roles/logging.viewer` szűkítése + jövőre log-kizárás/redakció a
   `__clerk_*` query-paraméterekre.
6. **Audit:** a crawler-indított `tool.call` írás(ok) (`board_write`) és a
   visszajátszott munkamenet bérlőjére könyvelt `model.call` költség átnézése.

## Amit el kell döntened

**Elfogadható-e ideiglenes intézkedésként a dev-instance azonnali leállítása (a platform
addig bejelentkezés-képtelen lesz), amíg a production Clerk instance + `sk_live/pk_live`
titkok készen állnak — vagy maradjon élő a platform a production instance-re váltásig,
csak #420 merge-dzsel és Search Console-törléssel fedve?** (leállítás / élve hagyás)

---

## Források (mind read-only, SA: `eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com`)

```
# handshake-token az URL-ben, 30 nap:
filter: resource.labels.service_name="enterprise-ai-agent-platform"
        AND httpRequest.requestUrl:"__clerk_handshake"
→ 68 találat, 19 külön napon 2026-08-05 .. 2026-09-03

# dev-instance telemetria app-logsor, 30 nap:
filter: ... AND textPayload:"connected to development instances"
→ 393 találat, 25 külön napon

# crawler-indított agent-stream:
filter: ... AND httpRequest.requestUrl:"agent-chat/stream"
→ 4 találat / 7 nap, MIND UA="Google"; 2 db 163 s-os (teljes forduló)

# crawler-indított LLM/eszköz:
filter: ... AND jsonPayload.event="model.call"   → 15 / 7 nap (6 a 09-03 12:07 crawler-sessionben)
filter: ... AND jsonPayload.event="tool.call"    → 22 / 7 nap (közte board_write=1)

# ellenpróba (token nélkül nincs rés):
2026-09-03T12:05:55Z GET /  UA="Google"  token nélkül → HTTP 307 (sign-in)
2026-09-03T06:02–06:08 anonim próbálkozások → 403 / 404
```

## Egyéb (nem-A) megfigyelések erről a futásról — külön kezelendők, ma nem viszem tovább

- **`prisma:error … kind: Closed`**: 387 db / 7 nap, éjszakai (crawler-only) órákban is.
  **Fedve:** PR #409 (`perf/neon-pool-connection-churn`) nyitva. Nem javaslom újra.
- **`/embed/control-plane/agent.new` → HTTP 500 (`TenantAuthError: NO_USER`)**: 2 db / 7 nap,
  mindkettő a 09-03 crawler-burstből; a route nem kezeli a be-nem-jelentkezett esetet
  (a többi route 307/404-et ad). Új viselkedés (30 napban először 09-03). Alacsony
  volumen; a Clerk-váltás + #420 után gyakorlatilag megszűnik. Ha marad, önálló kis jegy.
- **FinOps:** nincs költség-anomália. CPU ~10–40% p99, memória ~40–50% (1 GiB),
  hidegindítás p95 ~1,9–3,3 s, számlázott gépidő aktív napokon pár száz–~1500 s/nap.
  Scale-to-zero. A crawler LLM-költése alacsony volumenű (~15 model.call / 7 nap), de
  kontrollálatlan — a Clerk-váltás ezt is elzárja.
- **Nem vizsgált:** prod Neon DB (nem elérhető a futtató hostról), teljes GCP
  számla-SKU-bontás (nincs BigQuery billing-export), Clerk API hibaráta (nincs kulcs),
  `model_calls` prod tábla (prod DB).
