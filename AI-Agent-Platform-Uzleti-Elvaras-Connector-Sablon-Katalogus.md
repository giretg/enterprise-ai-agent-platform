# Üzleti elvárás dokumentum — Connector Sablon-Katalógus

**Státusz:** vázlat (üzleti elvárás — specifikáció ELŐTT)
**Dátum:** 2026-07-02
**Készítette:** Platform team
**Cél:** rögzíteni azt az üzleti igényt, amelyből a részletes műszaki specifikáció készülhet. Ez a dokumentum **nem** műszaki terv — a „mit és miért"-et írja le, a „hogyan"-t nem.

---

## 1. Háttér és motiváció

A platform ma egy **generikus `http_api` connectorral** rendelkezik, amellyel elvileg bármely REST API beköthető (baseUrl + auth + endpointok + egress-allowlist + governance). A gyakorlatban azonban a jól ismert nagy szolgáltatók (Google, Microsoft, Jira, Slack, …) bekötése:

- **provider-specifikus tudást igényel** (OAuth authorize/token végpontok, scope-formátum, offline-access, userinfo-végpont stb.), amit ma részben **futásidejű, névre-tippelő logika** pótol a kódban;
- ez **törékeny és nem generikus**: egy biztonsági-releváns végpontot a connector *neve* („tartalmazza: google") vezérel, nem az explicit konfigurációja;
- ez **aszimmetriát** okoz a rendszerben: az egyik kódág (consent) kitalálja a hiányzó értékeket, a másik (futásidejű hívás) megköveteli őket — így egy connector a jóváhagyás után is elhasalhat az első hívásnál.

**Konkrét kiváltó eset (2026-07-02):** egy Google Search Console connector OAuth-consentje sikeres volt, de minden API-hívás `tokenUrl must be an absolute http(s) URL` hibával bukott, mert a `tokenUrl` sosem került a mentett configba — csak a consent-ág defaultolta Google-specifikusan. (A tüneti hibát külön javítottuk; ez a dokumentum a **strukturális** megoldást célozza.)

## 2. Vízió

> Egy **generikus API-bekötő motor** alul, felette pedig egy **Connector Sablon-Katalógus**: beépített, jól ismert providerek kész sablonjai + adminok által, felületen karbantartható saját sablonok. Új, konkrét connectort **kódolás nélkül**, sablonból, néhány mező kitöltésével lehessen létrehozni — miközben a governance (validáció, egress-allowlist, jóváhagyás, audit) mindenre egységesen érvényes.

## 3. Üzleti célok

1. **Gyorsaság:** egy új, ismert szolgáltató bekötése percek kérdése legyen, ne fejlesztői feladat.
2. **Bővíthetőség kód nélkül:** új „ismert" provider felvétele adminként, felületen történjen — release/deploy nélkül.
3. **Megbízhatóság:** ami átmegy a jóváhagyáson, az futásidőben is működjön (nincs „sikeres consent, mégis hibás hívás").
4. **Egységes governance:** minden connector — generikus és sablonból származó is — ugyanazon a biztonsági kapun megy át.
5. **Karbantarthatóság:** a provider-tudás egy helyen, adatként éljen (katalógus), ne szétszórva a kódban.

## 4. Érintett szerepkörök

| Szerepkör | Igény |
|---|---|
| **Platform-admin** | Beépített sablonokból gyorsan connectort hoz létre; új custom sablonokat készít és tart karban a felületen. |
| **Connector-onboarding felelős** | Egy adott szolgáltatóhoz kitölti a hiányzó, példány-specifikus mezőket (pl. saját OAuth client, scope-választás), majd jóváhagyat és aktivál. |
| **Biztonsági/megfelelőségi jóváhagyó** | Látja, melyik sablonból jött a connector, milyen egress-hostokat és scope-okat kér; jóváhagy vagy visszadob. |
| **Fejlesztő** | Ritka, egyedi API-hoz a generikus (sablon nélküli) utat használja. |

## 5. Fő képességek (üzleti elvárások)

### K1 — Generikus API-connector (alap)
Bármely REST API beköthető sablon nélkül is: baseUrl, auth-séma, endpointok, egress-hostok, rate-limit. Ez az alap réteg, minden más erre épül.

### K2 — Beépített provider-sablonok
A platform szállítson kész sablonokat a leggyakoribb szolgáltatókra (első körben javasolt: **Google / Google Workspace, Microsoft 365, Jira, Slack**). A sablon tartalmazza a provider *állandó, nem-titkos* tudását: OAuth authorize/token/userinfo végpontok, scope-katalógus és -formátum, offline-access igény, alap egress-hostok, tipikus endpointok.

### K3 — Sablon-alapú, gyors connector-létrehozás a UI-n
Az admin a katalógusból választ egy sablont, kitölti a **példány-specifikus** mezőket (pl. saját OAuth client_id, client secret a secret-store-ba, a kívánt scope-ok részhalmaza, opcionális egyedi endpointok), és a rendszer ebből **önhordó, teljes configot** állít elő. A választható beépített sablonok **eleve látszódjanak** a felületen.

### K4 — Admin által karbantartható custom sablonok (kód nélkül)
Az admin a felületen **új sablont hozhat létre** vagy meglévőt **klónozhat/szerkeszthet** — így cégspecifikus vagy kevésbé elterjedt szolgáltatókra is „ismert" sablon készíthető fejlesztés nélkül. A custom sablonok verziózottak és auditáltak.

### K5 — Önhordó konfiguráció elve
A sablonból létrejövő connector configja **minden szükséges (nem-titkos) értéket explicit tartalmazzon** — futásidőben SEMMILYEN provider-specifikus értéket ne kelljen a connector nevéből vagy URL-jéből kitalálni. (Ez zárja ki strukturálisan a kiváltó bug osztályát.)

### K6 — Titkok kezelése változatlanul szigorú
Sablon vagy sablon nélkül: nyers titok (client secret, refresh token, API-kulcs) SOHA nem kerül a configba, csak a secret-store mögé; a sablon legfeljebb a **secret-alias nevét** javasolja.

### K7 — Egységes governance minden úton
Minden connector — beépített sablonból, custom sablonból vagy generikusan — ugyanazon a determinisztikus validáción, egress-allowlist-kapun, (kritikusságtól függő) jóváhagyáson és append-only auditon megy át. A sablon nem megkerülő út.

### K8 — Provenance és láthatóság
Legyen nyomon követhető, egy connector **melyik sablonból és annak melyik verziójából** származik (áttekinthetőség, tömeges frissítés/patch későbbi megfontolása).

## 6. Hatókörön kívül (most)

- Automatikus, futásidejű szinkronizáció a providerek API-változásaival.
- Sablon-frissítés visszaható alkalmazása a már létrehozott connectorokra (később megfontolandó — lásd K8).
- Nem-HTTP protokollok (gRPC, SOAP stb.).
- Marketplace / sablonok külső megosztása tenantok között.
- A meglévő beépített Gmail-connector kiváltása (az maradhat, vagy később a katalógusba olvasztható).

## 7. Sikerkritériumok

- Egy beépített sablonból (pl. Google) új, működő connector **fejlesztő bevonása nélkül**, néhány perc alatt létrejön és aktiválható.
- **Nulla** „sikeres consent, mégis hibás futásidejű hívás" típusú eset (az önhordó config miatt).
- Admin **kódolás és deploy nélkül** felvesz egy új custom providert, és abból connectort gyárt.
- A kódban **nincs** provider-névre tippelő, biztonsági-releváns elágazás a generikus úton.

## 8. Nyitott kérdések a specifikációhoz

1. **Sablon-tárolás:** kódban szállított beépített sablonok + DB-ben tárolt custom sablonok kettőssége — vagy minden a DB-ben (a beépítettek seed-elve)?
2. **Sablon-séma:** mely mezők „sablon-szintűek" (állandó) és melyek „példány-szintűek" (kitöltendők)? Kell-e mező-szintű kötelezőség/validáció a sablonban?
3. **Verziózás és frissítés:** hogyan kezeljük a sablon új verzióját a már létrehozott connectorok szempontjából (K8)?
4. **Jogosultság:** ki hozhat létre/szerkeszthet sablont (csak platform-admin, vagy tenant-admin is)? Tenant-szintű vagy globális sablonok?
5. **OAuth-változatok:** service-oauth2 vs. user-delegált (auto-consent) — mindkettőt fedje-e minden sablon, és hogyan jelenik meg a UI-n?
6. **Gmail-örökség:** a jelenlegi beépített `type==='gmail'` connectort beolvasszuk-e a katalógusba, vagy külön hagyjuk?
7. **Validáció mélysége:** a sablon garantálja-e, hogy a belőle készült config eleve „valid" (átmegy a determinisztikus kapun), vagy minden példány külön validálódik?

## 9. Kapcsolódó anyagok

- Jelenlegi provisioning/connector-onboarding folyamat (Provisioning Assistant feature-spec).
- Delegált OAuth (auto-consent) kiterjesztése a generikus `http_api`-ra.
- A kiváltó bug tüneti javítása: draft-validátor `tokenUrl`-kötelezőség + action-réteg/domain-séma egységesítés (2026-07-02).
