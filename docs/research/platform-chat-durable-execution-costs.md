# Platform-chat (#1003): tartós futtatás és infra-költség

Kutatás: 2026-10-29. Az árak USD-ben, listaáron, a nyilvános árlapok és a lent felsorolt források alapján. Élesítés előtt a GCP árkalkulátorral és a Neon számlával ellenőrizendő.

## Kiinduló tények

- A platform Firebase App Hostingon fut (Cloud Run alatta), **request-based** számlázással: `cpu: 1`, `memoryMiB: 2048`, `minInstances: 0`, `concurrency: 10` (`apphosting.yaml`). A kérésen kívül a CPU throttlingolt. Emiatt halt el a régi detached forduló, amikor a fül háttérbe került.
- A régió a repo hivatkozásai alapján `europe-west4`. Ez a Cloud Run locations oldal szerint **Tier 1** árazású.
- Az adatbázis Neon Postgres. Ha nincs forgalom, a compute alvó állapotba kerül (scale-to-zero). A Launch-csomag ára $0,106 / CU-óra; 1 CU ≈ 1 vCPU + 4 GB RAM.
- A modell-költséget a tenant fizeti a saját OpenRouter-kulcsán (D1). Ez a **meglévő** Hermes Enterprise út, nem új infra.

## Árak (Tier 1)

| Tétel | Ár |
|---|---|
| Cloud Run instance-based CPU | $0,000018 / vCPU-s (ingyenes keret: 240 000 vCPU-s/hó) |
| Cloud Run instance-based memória | $0,000002 / GiB-s (ingyenes keret: 450 000 GiB-s/hó) |
| Cloud Run request-based, aktív CPU | ~$0,000024 / vCPU-s (+ kérésenkénti díj) |
| Cloud Run request-based, tétlen min-instance | ~$0,0000025 / vCPU-s |
| Cloud Tasks | első 1M művelet/hó ingyenes, utána $0,40 / 1M |
| Külső Application Load Balancer | $0,025/óra az első 5 forwarding rule-ra (~$18/hó) + $0,008/GiB |
| Neon Launch compute | $0,106 / CU-óra; tárolás ~$0,35/GB-hó |

Az ingyenes keret a számlázási fiókra szól, és a meglévő szolgáltatásokkal osztozik rajta.

## Megvizsgált tartós futtatási megoldások

| Megoldás | Hogyan fut | Működik a mi helyzetünkben? | Költség |
|---|---|---|---|
| **Cloud Tasks + saját lépés-tábla** | Minden lépés (LLM-hívás, tool-hívás) egy HTTP-kérés a workerre. A sor újrapróbál, a checkpoint a `platform_chat` sémában van. | Igen. A CPU a kérés alatt jár, így a throttling nem érinti. Leállás után a Cloud Tasks újrapróbál, és a futás az utolsó kész lépéstől megy tovább. | Csak aktív idő + gyakorlatilag ingyenes sor |
| **DBOS Transact (TS)** | Library, csak Postgres kell hozzá, külön szerver nem. | Igen, de csak egy példánnyal. Újraindulás után egy példány csak a saját executor-ID-jához tartozó workflow-kat állítja helyre. Autoskálázott Cloud Runon a helyreállításhoz kell a DBOS Conductor (production self-hostnál fizetős) vagy saját helyreállító logika. | A library ingyenes; a worker folyamatosan fut (lásd A) |
| **Vercel Workflow DevKit, Postgres World** | graphile-workerrel polloz. | Gyengén. Hosszan futó, pollozó worker kell (serverless-en nem megy), és a Vercel saját maga is kísérletinek / bétának jelöli. A pollozás miatt a Neon nem tud elaludni. | Folyamatos worker + folyamatos Neon |
| **Inngest / Trigger.dev cloud** | Külső motor. | Működne, de a lépés-eredményeket (céges adatot tartalmazó tool-eredményeket) a szolgáltató tárolja. Ez adatvédelmi és DPIA-kérdés. | Inngest: 50k végrehajtás/hó ingyenes, a Pro ~$75–99/hó; lépésenként számláz |
| **Memorystore / Redis a streamhez** | Esemény-busz. | Nem szükséges: a sorszámozott esemény-napló Postgresben is elfér. | Fix havidíjú példány, megspórolható |

## Költség-forgatókönyvek (csak az új infra, prod, egy környezet)

Feltételezett terhelés: 50 aktív felhasználó × 20 forduló/munkanap × 22 nap = **22 000 forduló/hó**. Egy forduló ~5 lépés és ~60 s falióra-idő, ennek nagy része várakozás az LLM-re.

| Forgatókönyv | Cloud Run | Neon | Egyéb | Összesen ~/hó |
|---|---|---|---|---|
| **A. Folyamatosan futó worker** (instance-based, min=1, 1 vCPU / 1 GiB) – DBOS vagy saját hurok | 2,63M s × $0,00002 = **$52,6** (ingyenes kerettel ~$47) | A worker pollozása ébren tartja: 0,25 CU × 730 h × $0,106 = **~$19** (0,5 CU-n ~$39) | – | **~$65–90** |
| **B. Cloud Tasks + request-based worker, min=0** | Legrosszabb eset, átfedés nélkül: 1,32M s × ~$0,0000265 = **~$35**. Átfedéssel (concurrency 80) reálisan **$5–20** | Csak használat alatt ébred; a növekmény kicsi | Cloud Tasks ~220k művelet → $0 | **~$5–35** |
| **B+ ugyanez min=1 tétlen példánnyal** (nincs hidegindítás) | + ~$13 tétlen díj | mint B | – | **~$18–50** |

Az App Hosting szolgáltatásra is van következménye. Ha a streamet (SSE) a mostani platform-szolgáltatás proxyzza, minden nyitott fordulós stream elfoglal egyet a 10 slotból, és aktív időként számlázódik. Ez a régi OOM-gond forrása is volt. Ezért a streamet a worker szolgálja ki, és ehhez három út van:

| Stream-útvonal | Többletköltség | Megjegyzés |
|---|---|---|
| Aldomain (pl. `chat.<domain>`) + rövid életű token, amit a platform ad ki | $0 | A user nem lép be újra; ehhez CORS kell |
| Útvonal-alapú routing Load Balancerrel (`/chat/*` → worker) | ~$18/hó + $0,008/GiB | Teljesen azonos domain |
| Proxy az App Hostingon át | nincs fix díj, de slotot és memóriát foglal | Nem javasolt |

## A legnagyobb költség: modell-tokenek

A tool-hurokban minden kör újraküldi a teljes kontextust (system prompt, tool-sémák, előzmények), ezért a token-költség körönként nő. Ezt a tenant fizeti az OpenRouter-kulcsán, nem a mi infránk. Mivel a beépített chat könnyebben elérhető, mint a Hermes, a használat várhatóan nő. Javasolt mérséklő eszközök:
- prompt cache (stabil prefix-sorrend);
- halasztott tool-betöltés (#468);
- az agent `modelConfig`-ja (olcsó modell ott, ahol elég; #990);
- tenant-szintű napi keret.

## Ajánlás

**B: Cloud Tasks + saját, kis lépés-tábla a `platform_chat` sémában, request-based Cloud Run workerrel.**
- A legolcsóbb, és tétlenül nulla.
- GCP-natív, nincs új külső szolgáltató, nincs adat harmadik félnél.
- A helyreállítást a Cloud Tasks újrapróbálása adja, nem kell hozzá Conductor.
- Ára: a checkpoint-logikát mi írjuk meg. Egy egyszerű tool-hurokra ez kis kód.
- Tartalék: DBOS egyetlen példánnyal (A), ha mégsem akarunk saját checkpoint-logikát.

## Döntés és mért adatok (2026-10-29, gcloud-dal ellenőrizve)

**Elv:** használat nélkül ne kerüljön pénzbe. A chat kiegészítő funkció, nem ez az elsődleges használati minta, már csak a modell-költség miatt sem.

- **Futtatás:** Cloud Tasks + saját lépés-tábla, request-based Cloud Run worker, `minInstances: 0`. A DBOS (folyamatosan futó worker) és a min=1 változat kiesik.
- **Stream:** a böngésző közvetlenül a worker `*.run.app` címére csatlakozik, egy platform által kiadott rövid életű tokennel. A cím a user számára láthatatlan (háttér-kérés). A Load Balancer ($0,025/óra fix díj) kiesik.
- **Mért:** a régió `europe-west4` (Tier 1). Minden Cloud Run szolgáltatás `minScale 0`, CPU-throttlinggal. A Cloud Tasks API még nincs engedélyezve; az engedélyezés ingyenes.
- **Mért:** az `enterprise-ai-agent-platform` az elmúlt 30 napban ~451 000 számlázott instance-másodpercet használt (1 vCPU / 2 GiB). Ez már meghaladja a request-based ingyenes keretet (180k vCPU-s, 360k GiB-s), tehát **a worker minden aktív másodperce listaáron számlázódik**. A platform maga ~$8/hó.
- **Tétlen költség:** gyakorlatilag $0. Marad a worker image tárolása az Artifact Registryben (pár cent/hó) és a log (50 GiB/hó ingyenes).
- **Rejtett költség-kockázatok és kezelésük:**
  - nyitva felejtett SSE-kapcsolat aktív időként számlázódik → a forduló végén és tétlenségi időkorlátnál zárjuk;
  - végtelen Cloud Tasks újrapróbálás → `maxAttempts` korlát;
  - a stream-pollozás ébren tartja a Neont → csak futó forduló alatt pollozunk.
- **Jóváhagyásra várás:** a futás ilyenkor nem foglal folyamatot, tehát nem kerül pénzbe.
- **Hidegindítás:** tétlenség utáni első üzenetnél néhány másodperc. A UI ezt közérthetően jelzi.

## Források

- Cloud Run pricing: https://cloud.google.com/run/pricing
- Cloud Run billing settings (instance- vs request-based): https://docs.cloud.google.com/run/docs/configuring/cpu-allocation
- Cloud Run locations (Tier 1/2): https://docs.cloud.google.com/run/docs/locations
- Cloud Tasks pricing: https://cloud.google.com/tasks/pricing
- Cloud Load Balancing pricing: https://cloud.google.com/load-balancing/pricing
- Neon pricing: https://neon.com/pricing
- DBOS pricing: https://www.dbos.dev/pricing
- DBOS self-hosting workflow recovery: https://docs.dbos.dev/production/self-hosting/workflow-recovery
- DBOS Conductor: https://docs.dbos.dev/production/self-hosting/conductor
- Workflow DevKit Postgres World: https://useworkflow.dev/docs/deploying · https://app.unpkg.com/workflow@4.2.0-beta.68/files/docs/deploying/world/postgres-world.mdx
- Vercel agent harness self-hosting: https://vercel.com/docs/agent-harnesses/self-hosting
- Inngest pricing (másodlagos): https://automationatlas.io/answers/inngest-pricing-explained-2026/
