# Önfrissítő connector (kulcs + capability-link) — fejlesztői specifikáció

Státusz: **IMPLEMENTÁLVA (WP-0–WP-8)** · Verzió: v1.0 · Dátum: 2026-07-15

> Ez a dokumentum önállóan olvasható. Nem feltételezi, hogy az olvasó látta az
> ötletet szülő beszélgetést. Elolvasás után egy fejlesztő tudja, **mi a cél**,
> **milyen a modell**, **mit kényszerítünk ki**, és **mit lát a felhasználó** —
> beleértve a felületi szövegeket is, amelyeket nem technikai kollégáknak
> szánunk.

---

## 1. Mi ez, és kinek szól

A platform "connectorai" külső REST API-kapcsolatok (pl. egy CRM), amelyeket az
agentek eszközként hívnak. Ma egy connector képességei **rögzítettek**: a
provisioning során valaki felveszi a végpontokat, fejléceket, auth-módot, és ha
a **partner-alkalmazás frissül** (új végpont, bővülő funkció), akkor ezt nálunk
**kézzel, egy több lépéses folyamatban** kell utánakövetni.

Ez a spec egy **új, különleges connector-típust** vezet be:

> **Önfrissítő connector** = **egy API-kulcs** + **egy link egy gépi olvasható
> API-leírásra** (OpenAPI/JSON spec). A partner frissülésekor a connector
> képességei **egy gombnyomással** átvehetők — anélkül, hogy a kapcsolatot
> újra kellene építeni, és anélkül, hogy a meglévő, működő kötés szétesne.

**Kinek szól a felület:** tenant-adminok és connector-gazdák, akik **nem
feltétlenül fejlesztők**. Ezért minden felületi elemnél kötelező a közérthető
magyarázat (lásd [8. szakasz](#8-felület-ui)).

## 2. A cél (és mi a NEM-cél)

**Cél.** Amikor a partner-alkalmazás frissül:

1. a frissítés nálunk **egy gombnyomással** átvehető legyen,
2. **ne** kelljen végigmenni a teljes provisioning-folyamaton,
3. a **meglévő kapcsolat ne essen szét** (a most használt végpontok tovább
   működjenek, ha a partner nem törte el őket),
4. az átvétel **biztonságos** legyen: kontrollált, auditált, visszavonható.

**NEM-cél.**

- **Nem** akárkihez való. Ez a típus **kizárólag megbízhatónak minősített
  partner-alkalmazásokhoz** használható (lásd [7. szakasz](#7-bizalmi-modell-és-jogosultság)).
- **Nem** "az agent élőben olvassa a linket, és improvizál". Futásidőben az agent
  **soha** nem olvassa a külső linket; mindig a nálunk **jóváhagyott, rögzített
  pillanatképet** használja (lásd D-alapelvek).
- **Nem** szabad szöveges dokumentáció értelmezése. A link **gépi olvasható
  specre** (OpenAPI) mutat; szabad prózából nem generálunk hívást.

## 3. Alapelvek (invariánsok — ezek nem alku tárgyai)

Ezek a szabályok végig érvényesek; minden WP ezekre épül.

- **A1 — Nincs élő olvasás futásidőben.** Az agent kizárólag a DB-be **rögzített
  (pinned), jóváhagyott pillanatképet** használja. A külső link **csak** a
  *szinkron-és-jóváhagyás* lépéshez kell.
- **A2 — A jóváhagyás egy capability-DIFF, nem egy blob.** Sosem "az új leírás
  rendben van"-t hagyunk jóvá, hanem azt, hogy **pontosan mi változott** (új /
  eltűnt / megváltozott végpont, jog, kötelező paraméter, auth) **és azt ki
  használja** (lásd [6. szakasz](#6-capability-diff-a-lényeg)).
- **A3 — A leírás egyben az engedélylista.** A rögzített pillanatképben szereplő
  végpontokat a **tool-broker kényszeríti ki**: ami nincs benne, azt az agent
  nem hívhatja — akkor sem, ha a kulcs a túloldalon jogosult lenne rá.
  (Ez a meglévő endpoint-korlát + `{param}` matching kiterjesztése.)
- **A4 — A link is ellenőrzött.** A spec-URL-t egyszer explicit jóvá kell hagyni,
  utána **oda van szögezve** (host-pinning). A szinkron-letöltés a meglévő
  **web-egress guardon** megy át (SSRF-védelem, redirect-pinning).
- **A5 — Fail-closed.** Ha a szinkron elbukik, a spec hibás, üres vagy
  parse-olhatatlan, akkor a **régi, működő pillanatkép marad érvényben**.
  Soha nem cserélünk le működő snapshotot fél-letöltött vagy hibás verzióra.
- **A6 — A titok soha nem kerül DB-be.** Változatlanul: a kulcs a Secret Manager
  (prod) / lokális fájl (dev) mögött van, a connector csak `secret_alias`-t tart.
- **A7 — Append-only + rollback.** Minden jóváhagyott pillanatkép **verzió**;
  a történet append-only, és **egy kattintással visszaállítható** az előző.

## 4. A modell magja (fogalmak)

Négy fogalmat kell megérteni:

- **Spec-forrás (spec source):** a connectorhoz kötött, jóváhagyott link, amiről
  a leírást húzzuk (pl. `https://partner.example.com/openapi.json`).
- **Nyers pillanatkép (raw snapshot):** a linkről letöltött spec **változatlan**
  tartalma egy adott időpontban, tartalom-hash-sel. Ez a bizonyíték: "ezt
  töltöttük le, ekkor".
- **Capability-készlet (capability set):** a nyers pillanatképből **kiparse-olt**,
  strukturált képességlista — végpontok, metódusok, paraméterek, kötelező
  fejlécek, auth-mód. Ezt érti a broker és a diff. (A parse-oláshoz a meglévő
  **OpenAPI-extractort** használjuk.)
- **Rögzített verzió (pinned version):** egy **jóváhagyott** capability-készlet.
  Futásidőben **mindig** ez az igazság. Egyszerre pontosan egy rögzített verzió
  aktív; a többi a történetben marad (rollbackhez).

Az adatáramlás egyirányú és kapuzott:

```
külső link ──(A4: egress-guard)──▶ nyers pillanatkép
     │                                    │
     │                          (OpenAPI-extractor)
     │                                    ▼
     │                            capability-készlet
     │                                    │
     │                        (A2: diff a jelenlegi
     │                         rögzített verzióhoz)
     │                                    ▼
     │                          ┌── EMBERI JÓVÁHAGYÁS ──┐
     │                          │  (capability-diff)     │
     │                          ▼                        │
     └──────────────▶  ÚJ rögzített verzió ◀── rollback ─┘
                                 │
                       (A3: broker kikényszeríti)
                                 ▼
                          agent futásidő
```

## 5. Adatmodell (Prisma — javaslat)

Az önfrissítő connector a **meglévő `Connector`** rekordot használja egy új
`kind`/`mode` jelöléssel; a spec-forrás és a verziók külön táblákban élnek.

```prisma
// A Connector kap egy megkülönböztetőt (enum-bővítés vagy bool):
//   connectorMode = "self_updating"
// és egy aktív-verzió mutatót.

model ConnectorSpecSource {
  id             String   @id @default(cuid())
  connectorId    String   @unique
  connector      Connector @relation(fields: [connectorId], references: [id])
  specUrl        String                    // A4: pinned, jóváhagyott link
  specFormat     String   @default("openapi_3") // jövőállóság
  urlApprovedBy  String?                   // ki hagyta jóvá a linket
  urlApprovedAt  DateTime?
  autoApprovePolicy Json?                  // D5: mi mehet emberi kapu nélkül
  createdAt      DateTime @default(now())
}

model ConnectorSpecVersion {
  id             String   @id @default(cuid())
  connectorId    String
  connector      Connector @relation(fields: [connectorId], references: [id])
  versionNo      Int                        // 1,2,3… append-only
  rawSnapshot    Json                       // nyers spec (bizonyíték)
  rawHash        String                     // tartalom-hash (A4/A5)
  capabilitySet  Json                       // kiparse-olt, strukturált képességek
  status         String   // "proposed" | "approved" | "superseded" | "rejected" | "rolled_back"
  diffFromVersionId String?                 // melyik verzióhoz képest a diff
  diffSummary    Json?                      // A2: gépi diff (lásd 6.)
  fetchedAt      DateTime @default(now())
  approvedBy     String?
  approvedAt     DateTime?
  createdAt      DateTime @default(now())

  @@unique([connectorId, versionNo])
}
```

A `Connector` egy `activeSpecVersionId`-t tart (a rögzített verzió). Futásidőben
a broker **kizárólag** ennek a `capabilitySet`-jét látja.

> **Migráció:** additív, meglévő connectorokat nem érint. Egy sima connector
> attól lesz önfrissítő, hogy kap egy `ConnectorSpecSource`-ot és `mode`-ot.

## 6. Capability-diff (a lényeg)

A diff a spec **szíve** — ez teszi az "egy gombot" biztonságossá. Nem
szövegdiffet mutatunk, hanem **capability-szintű, kategorizált** változást,
**a használati kontextussal együtt**.

Minden változás egy kategóriába esik:

| Kategória | Mi ez | Kockázat | Alap-viselkedés |
|---|---|---|---|
| **Additív** | Új végpont / új opcionális paraméter jelent meg | Alacsony | D5 szerint auto-jóváhagyható |
| **Breaking** | MOST HASZNÁLT végpont eltűnt, vagy egy paraméter kötelezővé/típusban változott | **Magas** — "szétesik a kapcsolat" | Mindig emberi kapu + hatáslista |
| **Szűkítő** | A partner elvett egy jogot/végpontot, amit nem használunk aktívan | Közepes | Emberi kapu (tükrözni akarjuk, nem elrejteni) |
| **Auth-változás** | Változott az auth-mód, egy fejléc kötelezővé vált (pl. `Idempotency-Key`) | **Magas** | Mindig emberi kapu |

**A2 kulcseleme — "mi változott ÉS ki használja".** A diff minden breaking/
szűkítő tételhez kilistázza, **mely élő agent / Playbook / folyamat** támaszkodik
az érintett capability-re (visszakeresés a capability-grantek és a Playbook-
lépések alapján). Enélkül a jóváhagyó vakon dönt.

Példa a `diffSummary`-ra (gépi forma, a UI ezt fordítja emberi nyelvre):

```json
{
  "added":    [{ "op": "GET /invoices/{id}/pdf", "risk": "low" }],
  "breaking": [{ "op": "POST /orders", "change": "required_param_added: currency",
                "usedBy": [{ "type": "playbook", "name": "Rendelés-rögzítés", "id": "pb_123" }] }],
  "narrowed": [{ "op": "DELETE /orders/{id}", "change": "removed" }],
  "auth":     [{ "change": "header_now_required: Idempotency-Key", "scope": "POST /*" }]
}
```

## 7. Bizalmi modell és jogosultság

Mivel az egész típus a **bizalomra** épül, magát a bizalmat is governance-szel
kezeljük.

- **T1 — "Megbízható" minősítés kell.** Egy connector csak akkor lehet
  önfrissítő, ha a partner-alkalmazást valaki **explicit megbízhatónak
  minősítette**. Ez egy külön, auditált lépés (nem alapértelmezés).
- **T2 — Jóváhagyó ≠ beállító (SoD).** Aki a spec-linket beállítja, **nem
  ugyanaz**, aki a "megbízható" minősítést vagy az első rögzített verziót
  jóváhagyja. (Meglévő RBAC-szerepekre építve.)
- **T3 — Tenant-scope, fail-closed.** A connector és minden verziója a tenanthez
  kötött; cross-tenant elérés kizárt (a meglévő reachability-őr mintája).
- **T4 — Az auto-jóváhagyás (D5) opt-in és korlátozott.** Alapból minden
  változás emberi kapun megy át; az auto-jóváhagyás csak a tisztán additív,
  read-only változásokra engedhető, és tenant-szinten kikapcsolható.

## 8. Felület (UI)

**Vezérelv:** minden mezőnél és gombnál ott a **közérthető magyarázat** — mit
csinál, mi történik, ha megnyomom, és mi NEM történik. A technikai fogalmakat
(OpenAPI, endpoint, hash) mindig lefordítjuk hétköznapi nyelvre.

### 8.1 Connector létrehozása — típusválasztó

Amikor önfrissítő típust választ a felhasználó, ezt látja:

> **🔄 Önfrissítő kapcsolat**
> Ehhez elég egy **kulcs** és egy **link a partner API-leírására**. Ha a partner
> később új funkciókat ad hozzá, azokat itt **egy gombbal** átveheted — nem kell
> újraépíteni a kapcsolatot.
> *Csak megbízható partnerekhez ajánljuk.* [Mit jelent ez? ⓘ]

A "Mit jelent ez?" tooltip: *"Ez a link megmondja a rendszernek, mire képes a
partner API-ja. Ezért csak olyan partnernél használd, akiben megbízol — mintha
neki adnál egy listát arról, mit tehet a nevedben."*

### 8.2 Beállítás — két mező, semmi több

| Mező | Címke | Súgó a mező alatt |
|---|---|---|
| Kulcs | **Hozzáférési kulcs** | "A partnertől kapott titkos kulcs. Nálunk **titkosítva**, biztonságos tárolóban marad — az adatbázisba soha nem kerül." |
| Link | **API-leírás linkje** | "Egy webcím, ahol a partner közzéteszi, mit tud az API-ja (általában egy `openapi.json` fájl). Innen olvassuk ki a képességeket — **de csak akkor, amikor te megnyomod a Szinkron gombot**, sosem magától." |

Mentés után egy **jóváhagyandó** figyelmeztetés: *"A linket egy kollégának
jóvá kell hagynia, mielőtt élesítjük — így biztos, hogy nem elgépelt vagy hamis
címről olvasunk."* (T2/A4)

### 8.3 A "Szinkron" gomb és a jóváhagyó képernyő

A gomb felirata és alatta a magyarázat:

> **[ 🔄 Frissítés keresése ]**
> Megnézzük, változott-e a partner API-ja a legutóbbi átvétel óta. Ha igen,
> megmutatjuk **pontosan mi változott**, mielőtt bármit átveszünk. Amíg nem
> hagyod jóvá, **minden a régiben marad**.

A jóváhagyó képernyő **nem** nyers specet mutat, hanem **emberi nyelvű diffet**,
kategóriánként, színkóddal:

> **Változások a(z) „Partner CRM” kapcsolatban**
>
> 🟢 **Új képességek (2)** — ezeket mostantól használhatják az agentek
> &nbsp;&nbsp;• Számla PDF letöltése
> &nbsp;&nbsp;• Ügyfél-címkék listázása
>
> 🔴 **Törésveszélyes változás (1)** — ez érinthet egy működő folyamatot!
> &nbsp;&nbsp;• „Rendelés rögzítése" mostantól **kötelezően kéri a pénznemet**.
> &nbsp;&nbsp;&nbsp;&nbsp;⚠️ Ezt használja: **„Rendelés-rögzítés" folyamat**.
> &nbsp;&nbsp;&nbsp;&nbsp;Ha jóváhagyod, a folyamatot lehet, hogy frissíteni kell.
>
> 🟠 **Visszavont képesség (1)**
> &nbsp;&nbsp;• „Rendelés törlése" – a partner megszüntette. (Nem használtuk.)
>
> [ Mégse — minden marad a régiben ]&nbsp;&nbsp;[ Jóváhagyom ezeket a változásokat ]

Minden soron egy [ⓘ] a technikai részletért (végpont, metódus) — de az alapnézet
laikusnak is érthető.

### 8.4 Verziótörténet és visszaállítás

> **Korábbi állapotok**
> Minden átvett frissítést megőrzünk. Ha egy frissítés gondot okoz, **egy
> kattintással visszaállíthatod** az előzőt — a kapcsolat nem sérül.
>
> | Verzió | Átvéve | Ki hagyta jóvá | |
> |---|---|---|---|
> | v3 (jelenlegi) | 2026-07-15 | Kovács A. | — |
> | v2 | 2026-07-01 | Nagy B. | [ Visszaállítás ] |

### 8.5 Hibaállapotok (fail-closed, közérthetően)

- Szinkron nem érte el a linket: *"Nem sikerült elérni a partner API-leírását.
  **Semmi nem változott** — a kapcsolat a korábbi állapotban működik tovább.
  Próbáld később, vagy ellenőrizd a linket."*
- Hibás/üres spec: *"A partner leírását nem sikerült értelmezni, ezért **nem
  vettünk át semmit**. A jelenlegi verzió érvényben marad."*

## 9. Backend-folyamat (állapotgép)

```
[nincs forrás] ──beállít link+kulcs──▶ [link: pending-approval]
     │                                         │ (T2: jóváhagyás)
     │                                         ▼
     │                              [aktív, van rögzített verzió]
     │                                         │
     │            ┌──── "Frissítés keresése" (A4 egress-guard) ────┐
     │            ▼                                                 │
     │   letöltés + hash ──(A5 fail-closed ha hiba)──▶ nincs változás? ──▶ vége
     │            │                                                 │
     │   OpenAPI-extractor parse                                    │
     │            ▼                                                 │
     │   capability-set + DIFF (6.)                                 │
     │            ▼                                                 │
     │   [proposed verzió]                                          │
     │            │                                                 │
     │   D5 auto-jóváhagyható? ──igen──▶ [approved] ────────────────┤
     │            │ nem                                             │
     │            ▼                                                 │
     │   EMBERI JÓVÁHAGYÁS ──elutasít──▶ [rejected], régi marad     │
     │            │ jóváhagy                                        │
     │            ▼                                                 ▼
     │   [approved] → activeSpecVersion csere → régi [superseded]
     │
     └── bármikor: [Visszaállítás] → korábbi approved verzió aktív ([rolled_back] jelölés)
```

Minden állapotátmenet **auditált** (a meglévő audit-hash-lánc szerint: ki, mit,
mikor, melyik verzióról melyikre).

## 10. Biztonsági összefoglaló (miért biztonságos az "egy gomb")

1. **A kulcs nem ad korlátlan hozzáférést** — mert a broker csak a **jóváhagyott
   pillanatkép** végpontjait engedi ki (A3). A túloldali kulcs-jogosultság nem
   számít, ha nálunk nincs a listán.
2. **A link nem injektálható csatorna** — a tartalmat **adatként** parse-oljuk
   strukturált sémává, sosem tesszük nyers prózaként az agent kontextusába; a
   letöltés egress-guardon megy (A4).
3. **A frissülés nem csúszik be észrevétlenül** — minden változás **diffként,
   emberi kapun** megy át (A2), a kockázatosak sosem auto-jóváhagyhatók (T4).
4. **Semmi nem törik el visszafordíthatatlanul** — fail-closed (A5) +
   append-only + egy kattintásos rollback (A7).

## 11. Munkacsomagok (WP)

| WP | Tartalom | Függ |
|---|---|---|
| **WP-0** | Adatmodell + migráció (`ConnectorSpecSource`, `ConnectorSpecVersion`, `Connector.mode/activeSpecVersion`) | — |
| **WP-1** | Spec-forrás beállítás + link-jóváhagyás (T2), egress-guard-integráció (A4) | WP-0 |
| **WP-2** | Szinkron-motor: letöltés + hash + fail-closed (A5) + OpenAPI-extractor parse → capability-set | WP-0 |
| **WP-3** | Capability-diff-motor: kategorizálás + "ki használja" visszakeresés (6.) | WP-2 |
| **WP-4** | Jóváhagyási folyamat + verziózás + rollback (állapotgép, 9.) + audit | WP-3 |
| **WP-5** | Broker-enforcement a rögzített verzióból (A3 kiterjesztés) | WP-4 |
| **WP-6** | UI: típusválasztó, beállító, szinkron+diff-jóváhagyó, verziótörténet, hibaállapotok (8.) — **közérthető szövegekkel** | WP-4 |
| **WP-7** | Bizalmi minősítés (T1) + SoD (T2) + auto-approve policy (D5/T4) + tenant-kapcsoló | WP-4 |
| **WP-8** | Tesztek: additív/breaking/szűkítő/auth diff, fail-closed, rollback, cross-tenant izoláció, broker-enforcement | mind |

## 12. Nyitott döntések

- **D1 — Spec-formátum kör.** Induláskor csak OpenAPI 3? (Javaslat: igen; a
  `specFormat` mező jövőállósít, de az MVP csak OpenAPI-t parse-ol.)
- **D2 — Szinkron kézi vagy ütemezett is?** Az MVP **csak kézi** ("Frissítés
  keresése" gomb). Későbbi opció: napi cron, ami **csak proposed verziót** hoz
  létre, jóváhagyást sosem automatizál. (Javaslat: MVP kézi.)
- **D3 — Breaking-change hatáslista mélysége.** Elég a közvetlen capability-grant
  + Playbook-lépés visszakeresés, vagy tranzitív (agent→folyamat→futás) is kell?
  (Javaslat: MVP közvetlen; a séma engedi a bővítést.)
- **D4 — Nyers snapshot megőrzési politika.** Minden verzió nyers specjét
  megtartjuk (bizonyíték), vagy N verzió után csak hash + capability-set marad?
  (Javaslat: teljes megőrzés, amíg nincs méret-probléma.)
- **D5 — Auto-jóváhagyás hatóköre.** Tisztán additív + read-only változás
  mehet-e emberi kapu nélkül (tenant-opt-in)? (Javaslat: igen, de alapból KI.)

## 13. Újrahasznált meglévő modulok

- **OpenAPI-extractor** (legutóbbi commit) — a nyers spec → capability-set parse.
- **Connector sablon-katalógus** — capability-set / action-séma reprezentáció.
- **Endpoint-korlát + `{param}` matching** (Connector-Setup-and-Editing) — a
  broker-enforcement alapja (A3).
- **Web-egress guard** (WebFetch & Web-Egress build) — a szinkron-letöltés
  SSRF-védelme (A4).
- **Governed Flow risk-diff** — a capability-diff kategorizálás + "ki használja"
  mintája (6.).
- **Audit-hash-lánc** — minden állapotátmenet auditálása (9.).
- **IAM/RBAC + reachability-őr** — bizalmi minősítés, SoD, tenant-izoláció (7.).
