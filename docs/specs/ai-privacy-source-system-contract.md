# AI Privacy Gateway — forrásrendszer-szerződés

**Amit a CRM, ERP és egyéb csatlakoztatott rendszereknek a saját oldalukon meg kell valósítaniuk**, hogy a platform pszeudonimizálni tudjon.

| | |
|---|---|
| **Verzió** | v0.1 |
| **Státusz** | szerződés-tervezet — odaadható forrásrendszer-csapatnak |
| **Dátum** | 2026-08-20 |
| **Célközönség** | CRM / ERP / egyéb forrásrendszer termék- és fejlesztőcsapata |
| **Szülő spec** | [`ai-privacy-gateway-spec.md`](./ai-privacy-gateway-spec.md) (platformoldali mechanika) |
| **Referenciaimplementáció** | saját CRM connector (`ostorosbor-crm-*`) + `company` entitástípus |

Ez a dokumentum **önállóan olvasható**. Nem kell ismerni a platform vaultját, a surrogate-formátumot vagy a Model Gatewayt ahhoz, hogy a forrásrendszer oldala megépüljön.

---

## 1. Egy mondatban

A forrásrendszer **nem tokenizál**. Megjelöli, mely mezők azonosítók, stabil belső ID-t ad melléjük, és a tool-API-jait ID-val is el lehet érni. A csere (`SPAR Magyarország` → `[[COMPANY_1]]`) a platformon történik, közvetlenül az LLM-hívás előtt.

> A pszeudonimizáció azt szabályozza, hogy az **LLM** mit lát. A forrásrendszer saját felhasználói továbbra is a valódi adatot látják. A forrásrendszer access controlját a privacy réteg nem másolja le.

---

## 2. Felelősségi határ

| Ki | Mit csinál | Mit nem csinál |
|---|---|---|
| **Forrásrendszer** | Mezőjelölés, entitástípus, stabil source ID, opcionális feloldás (`resolve`) és hint-ek. Saját admin-UI a jelölések szerkesztésére. Saját ACL. | Nem cserél álnévre a saját API-válaszában. Nem implementál vaultot, HMAC-et, beszélgetés-scope-ot. |
| **Connector** (platform) | A katalógust leképezi a connector `config.fields` / `privacy` capability-re. A tool-hívás argumentumában az álnevet source ID-ra oldja, *mielőtt* a forrásrendszert hívná. | Nem találja ki a domain-tudást (melyik mező cégnév). |
| **Platform Privacy Gateway** | Surrogate képzése, LLM-bound csere, feloldás a trusted UI-n. | Nem dönti el, hogy a CRM-ben Ki látja a SPAR-t. |

**Két réteg, két UI.** A jelölések **kanonikus helye a forrásrendszer**. A platform connector-konfigja importálja (vagy átmenetileg kézzel tükrözi) ugyanezt. A platformon is legyen olvasható a capability szint, de a napi karbantartás ne ott történjen, különben a két rendszer elcsúszik.

---

## 3. Képességszintek

A forrásrendszer a connector capability-deklarációban közli, mit tud. Hiányzó interfész esetén a platform **továbbra is működik**, de alacsonyabb privacy-szintet jelez (UI + audit). Nem kötelező mindent egyszerre szállítani.

| Capability | Jelentés | Minimum (M1) | Ajánlott | Teljes |
|---|---|---|---|---|
| `structured_field_privacy` | Van mezőkatalógus: mely kulcsokat kell cserélni | kell | kell | kell |
| `stable_entity_ids` | Minden jelölt mezőhöz van interpolálható source ID | kell | kell | kell |
| `entity_resolution` | `resolve(text, entity_type?)` végpont | — | kell | kell |
| `free_text_hints` | Mely szabad szöveges mezőkben várhatók entitásnevek | — | — | kell |

**Minimum (M1, saját CRM + `company`):** a platform determinisztikusan tudja cserélni a strukturált cégnevet, és a tool-hívást source ID-val tudja visszaküldeni. Enélkül csak best-effort szövegszkenner marad, ami nem elég.

**Ajánlott:** a `resolve` — nélkül a user promptjában lévő „SPAR” nyersen mehet az LLM-hez (dokumentált maradékkockázat a szülő spec §9 / §16 szerint).

**Teljes:** hint-ek a jegyzet/email mezőkre + alias-szótár a magyar toldalékos illesztéshez.

---

## 4. Amit a forrásrendszer *nem* küld ki

- **Álnevet** (`[[COMPANY_1]]`) a saját API-válaszában. Az álnevet a platform képzi.
- **Titkot** (API-kulcs, jelszó, magánkulcs) a connector-API-n. Ezekre a platform policy `block`; tokenizálni őket tilos és értelmetlen.
- **Nyers PII-t extra, strukturálatlan dumpban**, ha ugyanaz az adat strukturált mezőben is ott van. Ha a `company_name` mellett a `notes` mezőben is ott van a teljes cégnév, a 2. védelmi vonal (known-value substitution) még elkapja — de csak akkor, ha az első mezőt jelöltétek.

---

## 5. Domain-szabályok

### 5.1 Entitástípusok

A platform ezeket ismeri. Új típus felvétele platformoldali változás; a forrásrendszer ne találjon ki saját címkéket.

| `entity_type` | Példa mező | LLM-álnév (csak a platform képzi) |
|---|---|---|
| `company` | `company_name`, `legal_name` | `[[COMPANY_1]]` |
| `person` | `contact_name`, `full_name` | `[[PERSON_2]]` |
| `email` | `email`, `billing_email` | `[[EMAIL_3]]` |
| `phone` | `phone`, `mobile` | `[[PHONE_1]]` |
| `account` | `iban` megjelenített forma, ügyfélszám szövegesen | `[[ACCOUNT_1]]` |

### 5.2 Mezőakció

| `privacy` | Hatás | Mikor |
|---|---|---|
| `tokenize` | A platform a string értéket álnévre cseréli az LLM felé | azonosító jellegű **szöveges** mező |
| `pass` | Érintetlenül megy az LLM-hez | üzleti szám, dátum, státusz, kategória |
| `block` | A mező nem mehet ki a connector-API-n / a platform eldobja | titok, irreleváns belső azonosító |

**Kemény szabályok (a platform mentéskor is elutasítja):**

1. `tokenize` **csak `string` mezőn**. Szám, egész, dátum, datetime, boolean → `pass` vagy `block`. Indok: az álnév elrontja a modell számtani érvelését és a séma-parszolást.
2. `tokenize`-hoz **kötelező** az `entity_type`.
3. Privát kulcs / API token / jelszó **soha nem `tokenize`** — `block`, és lehetőleg ne is legyen a connector-API sémájában.

### 5.3 Stabil source ID

A ref-surrogate **nem tárolja a nyers nevet**, csak a referenciát: `(connector, entity_type, source_id)`. Ezért:

- A source ID **örök**: cégátnevezés, fúzió-megjelenítés, ékezet-javítás nem változtatja.
- Törlés a forrásban automatikusan átüt a feloldáson (GDPR törlési jog) — pont ezért jobb, mint értékmásolat.
- Formátum:

```
{rendszer}/{entitástípus}/{stabil_id}
```

Példa: `crm/company/4821`, `crm/person/9012`, `erp/account/HU123`.

A `{stabil_id}` legyen a forrásrendszer saját elsődleges kulcsa (UUID vagy numerikus PK). **Megjelenítési név, adószám, email nem source ID** — ezek változhatnak vagy ütközhetnek.

A katalógusban **sablon** él, a futásidejű rekordban a placeholder a testvérmezőből töltődik:

```
crm/company/{id}     +  { "id": "4821", "company_name": "SPAR Magyarország" }
                    →  crm/company/4821
```

Ha a sablon bármely `{mező}`-je hiányzik vagy üres a rekordban, a platform **nem cserél** arra a mezőre. A cégnév nyersen megy az LLM-hez. Ezért a `id` (vagy a sablonban hivatkozott kulcs) **kötelező testvére** minden tokenizálandó mezőnek ugyanabban a JSON-objektumban.

### 5.4 Tool-API-k ID-val dolgozzanak

Amikor a modell `get_revenue(company="[[COMPANY_1]]")`-et hív, a platform a connector-hívás **előtt** kicseréli az argumentumot a source ID-ra. A forrásrendszer tehát ezt kapja:

```json
{ "company": "crm/company/4821" }
```

nem a cégnevet, és nem az álnevet.

**KÖTELEZŐ:** minden olyan végpont, amely entitásra hivatkozik (lekérdezés, szűrés, írás), fogadja el:

1. a teljes source ID-t (`crm/company/4821`), **vagy**
2. a nyers stabil ID-t (`4821`),

és **normalizálja** belül. Ajánlott mindkettőt elfogadni. Megjelenítési név szerinti keresés maradhat másodlagos, de a privacy-úton az ID a kanonikus kulcs.

A forrásrendszer **soha ne várja** az álnevet (`[[COMPANY_1]]`). Ha ilyet kap, az integrációs hiba: a platform nem oldott fel.

---

## 6. Szerződés: három felület

```
┌─────────────────────────────────────────────────────────┐
│  1. Katalógus (séma)     GET /privacy/catalog           │
│     mely mezők, milyen akció, milyen ID-sablon          │
├─────────────────────────────────────────────────────────┤
│  2. Üzleti payload       a meglévő connector API        │
│     minden jelölt mező mellett ott az id                │
├─────────────────────────────────────────────────────────┤
│  3. Feloldás (opcionális) POST /privacy/resolve         │
│     „SPAR” → crm/company/4821  / több találat / semmi   │
└─────────────────────────────────────────────────────────┘
```

A tokenizálást **egyik sem** végzi. A katalógus megmondja a *szabályt*, a payload adja az *értéket és az ID-t*, a `resolve` a user-szöveghez köti az ID-t.

### 6.1 Katalógus — `GET /privacy/catalog`

Verziózott, cache-elhető, auth ugyanaz, mint a connector API-n (Bearer + acting user). A platform ezt olvassa be a connector `config.fields` + `config.privacy` mezőibe. Amíg a platform automatikus szinkronja nincs meg, ugyanez a JSON kézzel is bemásolható a connector-konfigba — a séma azonos.

```json
{
  "catalog_version": 3,
  "updated_at": "2026-08-20T08:00:00Z",
  "system": "crm",
  "privacy": {
    "structured_field_privacy": true,
    "stable_entity_ids": true,
    "entity_resolution": true,
    "free_text_hints": false
  },
  "fields": {
    "company_name": {
      "type": "string",
      "privacy": "tokenize",
      "entity_type": "company",
      "source_id": "crm/company/{id}"
    },
    "name": {
      "type": "string",
      "privacy": "tokenize",
      "entity_type": "company",
      "source_id": "crm/company/{id}"
    },
    "email": {
      "type": "string",
      "privacy": "tokenize",
      "entity_type": "email",
      "source_id": "crm/email/{id}"
    },
    "revenue": {
      "type": "number",
      "privacy": "pass"
    },
    "notes": {
      "type": "string",
      "privacy": "pass",
      "free_text_hint": true
    }
  },
  "optional": {
    "context_hints": {
      "company": {
        "enabled": false,
        "fields": ["industry", "country_code"]
      }
    }
  }
}
```

**Mezőszelektor v1:** JSON-objektumkulcs, bármely mélységben. A platform a tool-választ bejárja; ha egy objektumban van `company_name` string és a sablon `{id}`-je kitöltött, cserél. Emiatt a tokenizálandó kulcsnevek legyenek **egyértelműek**: ha a cégnek és a kapcsolattartónak is `name` mezője van, a kapcsolattartót hívjátok `contact_name`-nek, vagy a cégét `company_name`-nek. Útvonal-szelektor (`$.accounts[*].legal_name`) későbbi bővítés.

**Opcionális katalógusmezők** (a platform figyelmen kívül hagyhatja, amíg a matching capability `false`):

| Mező | Szerep |
|---|---|
| `free_text_hint: true` | Ez a string mező jegyzet/email/leírás; a known-value substitution itt is fusson. |
| `optional.context_hints` | Nem azonosító típusleírás az első előforduláskor (`COMPANY_1 = kiskereskedelmi lánc, HU`). Alapból **ki**. Csak olyan mezőket adjatok ide, amelyek **önmagukban nem azonosítanak** (ágazat, országkód — nem város + utca, nem adószám). |
| `display_label` | Embernek szóló mezőnév a forrásrendszer UI-ján (`Cégnév`). A platformnak nem kell. |
| `owner_role` | Ki dönthet a jelölésről (`dpo` / `admin` / `entity_owner`). A forrásrendszer ACL-je. |

**Validáció a katalógus mentésekor (forrásrendszer oldalon is):**

- `tokenize` + nem-string típus → elutasít, magyar hibával.
- `tokenize` entity_type nélkül → elutasít.
- `tokenize` `source_id` nélkül → elutasít (különben val-surrogate keletkezne, ami a forrásrendszer törlését nem viszi át).
- `source_id` sablon `{mező}` hivatkozása, amely nincs a payload-sémában → elutasít.
- `secret` / `password` / `api_key` jellegű mezőn `tokenize` → elutasít.

A `catalog_version` egész, monoton növő. Minden publikált változás új verzió. A platform a változást auditálja (`privacy.connector.capability.changed`).

### 6.2 Üzleti payload — a meglévő connector API

Nincs külön „privacy-válasz”. A meglévő listák, get-ek, riportok maradnak, **két invariánssal**:

```json
{
  "id": "4821",
  "company_name": "SPAR Magyarország Kereskedelmi Kft.",
  "revenue": 128400000000,
  "country_code": "HU"
}
```

1. A tokenizálandó string és a sablonban hivatkozott `id` **ugyanabban az objektumban** vannak.
2. Tömbökben minden rekord saját `id`-val érkezik. Ugyanaz a cég a listában ugyanazzal az `id`-val — a platform scope-on belül ugyanazt az álnevet adja.

Beágyazott entitás:

```json
{
  "id": "100",
  "title": "Q2 pipeline",
  "account": {
    "id": "4821",
    "company_name": "SPAR Magyarország Kereskedelmi Kft."
  },
  "owner": {
    "id": "77",
    "contact_name": "Kovács Anna",
    "email": "anna.kovacs@spar.hu"
  }
}
```

**Runtime-annotáció (opcionális, későbbi bővítés):** ha egy mező csak futásidőben derül ki (dinamikus riportoszlop), a rekord mellé tehető:

```json
{
  "_privacy": {
    "dynamic_label": {
      "privacy": "tokenize",
      "entity_type": "company",
      "source_id": "crm/company/4821"
    }
  }
}
```

v1-ben **ne erre építsetek**. A katalógus a kanonikus út; a dinamikus annotáció csak akkor kell, ha a séma tényleg futásidőben változik.

### 6.3 Feloldás — `POST /privacy/resolve` (ajánlott, M3)

A platform a user szövegéből jelölteket emel ki (`SPAR`, `Sparnak`), és a forrásrendszert kéri meg a tényleges feloldásra. A platform **nem** tart fenn globális alias-adatbázist a ti entitásaitokról.

```http
POST /privacy/resolve
Content-Type: application/json
Authorization: Bearer <connector-kulcs>
X-Acting-User: <crm-user-id-vagy-email>
X-Agent-Id: <agent-azonosito>
```

```json
{
  "text": "SPAR",
  "entity_type": "company"
}
```

`entity_type` opcionális; ha nincs, a forrásrendszer minden ismert típusban keres, de a válaszban mindig megmondja a típust.

**Pontosan három kimenet** — más státuszt ne adjatok:

```json
{ "status": "match", "candidates": [
  { "source_id": "crm/company/4821", "entity_type": "company",
    "display_name": "SPAR Magyarország Kereskedelmi Kft.",
    "aliases": ["SPAR", "Spar", "SPAR Magyarország"],
    "confidence": 0.96 }
]}
```

```json
{ "status": "ambiguous", "candidates": [ /* 2..N, confidence szerint csökkenő */ ] }
```

```json
{ "status": "none", "candidates": [] }
```

| Szabály | Elvárás |
|---|---|
| ACL | Az acting user csak azt kapja vissza, amihez a CRM-ben joga van. Nulla találat és „nincs jogod” **ugyanúgy** `none` — ne szivárogtassuk, hogy a cég létezik. |
| Confidence | `0..1`. Ajánlott küszöb a platformon: `≥ 0.85` → `match`, `0.5–0.85` vagy több közeli találat → `ambiguous`, alatta → `none`. A pontos küszöb platformoldali; a forrásrendszer őszinte score-t adjon. |
| Alias | A `aliases` tömbben legyenek a közismert rövid nevek és a toldalék nélküli tő. A ragozott alakot (`SPAR-nak`) a platform illeszti, ne a CRM. |
| Idempotencia | Ugyanarra a `(text, entity_type, acting user)`-re stabil sorrend. |
| Latency | p95 ≤ 80 ms a tipikus prefix-keresésre (pár ezer entitás). Ennél lassabb resolve a prompt előtti úton kimarad; a tool-boundary-n még egyszer lefut. |

**Második védelmi vonal:** ha a prompt előtti `resolve` `none`, de az LLM később `get_revenue(company="SPAR")`-t hív (még névvel, nem álnévvel), a platform a tool-hívás előtt újra megkérdezheti a `resolve`-ot, és siker esetén már source ID-val hív. A forrásrendszer ugyanazt a végpontot adja mindkét hívóra.

---

## 7. UI a forrásrendszerben — ajánlás

A jelölés **adatvédelmi döntés**, nem fejlesztői JSON-barkácsolás. Legyen rá saját admin-felület. A célközönség: adatvédelmi felelős + a connector-API gazdája, nem az értékesítő.

### 7.1 Hol éljen a menüben

**Beállítások → AI-kapcsolat → Adatvédelem** (vagy **Admin → Connector API → Privacy jelölések**).

Ne keverjétek a mező-ACL-lel („ki látja a CRM-ben”) és a connector-kulcsokkal. Három külön dolog:

1. Ki melyik rekordot láthatja a CRM-ben (meglévő ACL).
2. Mely mezők mennek ki a connector-API-n egyáltalán (API-scope).
3. Az API-n kimenő mezők közül melyiket cserélje a platform álnévre, mielőtt a modell látná (ez a felület).

Üres állapot, ha még nincs katalógus:

> Ez a rendszer csatlakozhat az AI-platformhoz, de még nincs megjelölve, mely cég- és személynevek védendők. Az agent működik, a platform viszont kevesebb adatot tud álnévre cserélni.
>
> [Mezők megjelölése]

### 7.2 Szerepkörök és jogosultság

| Szerep | Lát | Szerkeszt | Publikál |
|---|---|---|---|
| Adatvédelmi admin / DPO | igen | igen | igen |
| Connector-API gazda (fejlesztő) | igen | draft | nem egyedül |
| Tenant-admin (CRM) | igen | nem | nem |
| Értékesítő / ügynök | nem | nem | nem |

A jelölésváltozás **draft → review → publish**. A connector-API a **publikált** `catalog_version`-t adja. Mentés közben a draft ne menjen ki az agenteknek.

Minden publikálás: ki, mikor, előző verzió → új verzió, diff (mező, régi akció, új akció). A nyers mezőérték **nem** kerül az auditba, csak a séma.

### 7.3 Főképernyő: entitás + mezőtábla

Bal oldalon entitástípusok (`Cég`, `Személy`, `E-mail`, …), jobb oldalon az adott entitás connector-API-ban megjelenő mezői.

```
Adatvédelem az AI felé                         Katalógus v3  ·  publikálva
                                                [Előnézet]  [Publikálás]

Cég (company)                                   12 mező, 2 álnevesítve

Mező            Típus     AI felé              Entitás     Source ID
────────────────────────────────────────────────────────────────────────
company_name    szöveg    ● Álnévre cserél     company     crm/company/{id}
legal_name      szöveg    ● Álnévre cserél     company     crm/company/{id}
email           szöveg    ● Álnévre cserél     email       crm/email/{id}
revenue         szám      ○ Mehet a modellhez  —           —
status          szöveg    ○ Mehet a modellhez  —           —
notes           szöveg    ○ Mehet + jegyzet-hint           —
api_token       szöveg    ■ Nem megy ki        —           —   (zárolt)
```

A sorban az **AI felé** egy háromállású vezérlő, ne szabad szöveg:

| UI-címke | Érték | Mikor engedett |
|---|---|---|
| **Álnevre cserél** | `tokenize` | csak szöveges mező + van source ID sablon |
| **Mehet a modellhez** | `pass` | mindig |
| **Nem megy ki** | `block` | mindig; titok-mezőn ez az egyetlen opció, a vezérlő disabled a másik kettőre |

**Inline magyarázat** (helper a vezérlő alatt, magyarul, egy mondat):

- Álnévre cserél: *„A modell `[[COMPANY_1]]`-et lát; a te képernyődön marad a valódi név.”*
- Mehet a modellhez: *„Ez az érték változtatás nélkül bekerülhet a modell kérésébe (pl. forgalom, dátum).”*
- Nem megy ki: *„Ez a mező a connector-API válaszában sem szerepel.”*

**Kényszerek a UI-n, ne csak API-hibában:**

- Szám/dátum soron az „Álnevre cserél” disabled, tooltip: *„Számot és dátumot nem cserélünk álnévre, mert a modell számol velük.”*
- „Álnevre cserél” választásakor, ha nincs `entity_type`, a mentés előtt kötelező dropdown (Cég / Személy / E-mail / Telefon / Számla).
- Ha a rekordsémában nincs `id` (vagy a sablonban hivatkozott kulcs), a sor piros: *„Álnévhez stabil azonosító kell. Add meg, melyik mező a cég ID-ja.”*
- Titok-mezőn a vezérlő zárolt `block`-on, lakat ikonnal.

**Tömeges művelet:** „Javasolt alapértelmezések” gomb, nem csendes automentés:

| Mezőjel | Javaslat |
|---|---|
| név tartalmazza: `company`, `legal_name`, `account_name` | tokenize + `company` |
| `first_name`, `last_name`, `full_name`, `contact_name` | tokenize + `person` |
| típus email / kulcs `email` | tokenize + `email` |
| kulcs `phone`, `mobile`, `tel` | tokenize + `phone` |
| szám, pénz, dátum, státusz, enum | pass |
| `password`, `secret`, `token`, `api_key` | block |

A javaslat **review-köteles**: pipálható lista, „Alkalmaz a kijelöltekre”.

### 7.4 Source ID szerkesztő

Ne nyers string-mező legyen az elsődleges. Két rész:

1. **Rendszer előtag** — `crm` (readonly, a telepítésből).
2. **Entitás** — `company` (a sor entity_type-ja).
3. **ID mező** — dropdown a rekord mezői közül, amelyek stabil azonosítók (`id`, `uuid`, `external_id`). A UI összerakja: `crm/company/{id}`.

Haladó accordion: kézi sablon, ha több mezőből áll (`crm/company/{org_id}-{id}`). Validáció: minden `{…}` létező mező.

Minta a sor alatt, élőben:

> Példa: `id = 4821` → `crm/company/4821`

### 7.5 Opcionális adatok — külön panel, nem a főtáblában

A főtábla maradjon három oszlopos (akció, típus, ID). Az opcionális dolgok **csoportonként**, kikapcsolható szakaszokban. Alapból mind zárva, capability `false`.

#### a) Jegyzet-hint (`free_text_hints`)

Checkbox a szabad szöveges mezőn: *„Ebben a mezőben gyakran szerepel cég- vagy személynév (jegyzet, email-törzs, leírás).”*

Ha be van pipálva, a platform a strukturáltan már ismert neveket ebben a szövegben is kicseréli (magyar toldalékkal: *SPAR-nak, Sparnál*). Ez **nem** NER, és nem ígér 100%-ot.

Üres/kihagyott: a platform csak a jelölt strukturált mezőket cseréli.

#### b) Kontextus-hint a modellnek

Tenant-szintű kapcsoló entitástípusonként, alapból **ki**.

> Első előforduláskor a modellnek adható egy nem azonosító típusleírás, pl. `COMPANY_1 = kiskereskedelmi lánc, HU`. Ez tudatos csere: kevés plusz kontextus a jobb válaszért. Azonosító adat (pontos cím, adószám, kapcsolattartó) ide nem tehető.

Mezőválasztó: csak `pass` + nem-azonosító mezők (ágazat, országkód, cégméret-sáv). Előnézet kötelező, mielőtt bekapcsolnák.

#### c) Alias-szótár (a `resolve` tápláléka)

Entitásonként lista: kanonikus rekord + aliasok.

```
SPAR Magyarország Kereskedelmi Kft.    crm/company/4821
  aliasok: SPAR · Spar · SPAR HU
  [+ alias]   [toldalék-tő: SPAR]
```

Import: CSV (`source_id, alias`). A toldalékolást (`-nak, -nál, -ban`) **ne** tároljátok aliasként — azt a platform csinálja a tőből.

Tesztmező a panel tetején:

```
Próbáld ki:  [ SPAR-nak        ]  [Feloldás]
→ találat: SPAR Magyarország (crm/company/4821), confidence 0.96
```

Több találatnál a UI mutassa a jelölteket, ahogy a platform `ambiguous` ága is látná. Döntés a forrásrendszerben: **ne** automatikusan az elsőt; a platform fogja eldönteni, hogy visszakérdez vagy nyersen hagyja. Ti adjatok őszinte listát.

#### d) Megjelenített vs. jogi név

Ha van `legal_name` és `short_name`, mindkettő `tokenize` + **ugyanaz** a `source_id`. Így a platform egy álnevet ad a két írásmódnak. A UI figyelmeztessen, ha két tokenize-mező eltérő source ID-sablont kapna ugyanazon az entitáson.

### 7.6 Előnézet: „amit a modell látna”

Kötelező a publikálás előtt. Bal oldalon egy **valódi, a belépő user ACL-je szerinti** minta-rekord (ne kitalált lorem), jobb oldalon a pszeudonimizált másolat. A platform algoritmusát ne implementáljátok tökéletesen — elég a katalógus szerinti stringcsere a jelölt mezőkön, `[[TYPE_n]]` sorszámozással a rekordon belül.

```
Forrás (CRM)                         Amit a modell kapna
─────────────────────────────        ─────────────────────────────
company_name: SPAR Magyarország      company_name: [[COMPANY_1]]
revenue: 128 400 000 000             revenue: 128400000000
email: ada@spar.hu                   email: [[EMAIL_1]]
```

Alatta számláló: *„2 mező cserélődne, 1 változatlan, 0 blokkolt.”*

Ha a mintarekordban hiányzik az `id`, a jobb oldal pirosan a nyers nevet hagyja, és a publikálást tiltja: *„Ennél a mezőnél nincs stabil ID, az álnév nem képezhető.”*

Ne mutassátok a vaultot, a HMAC-et, a beszélgetés-scope-ot. A forrásrendszer UI-ja a **jelölés helyességéről** szól, nem a platform belsejéről.

### 7.7 Publikálás és regresszió

Publikálás gomb csak akkor aktív, ha:

- minden `tokenize` sornak van entity_type + érvényes source_id sablon,
- a validáció zöld,
- van legalább egy előnézet az aktuális drafton,
- a publikáló DPO/admin szerepű.

Megerősítő dialógus:

> A v4 katalógus ettől a pillanattól a connector-API-n él. Az AI-platform a következő szinkronkor (vagy kézi frissítéskor) ezt használja. A már folyamatban lévő beszélgetések álnevei a platformon maradnak; az új tool-válaszok az új jelölést követik.
>
> Változás: `legal_name` pass → tokenize. [Publikálom]

Visszaállítás: előző publikált verzióra egy kattintás, ugyanazzal az audittal.

### 7.8 Connector-API státusz a UI-n

Egy readout, nem szerkesztő:

| Jelzés | Feltétel |
|---|---|
| Adatvédelem beállítva | `structured_field_privacy` + `stable_entity_ids` |
| Részleges adatvédelem | csak az egyik, vagy tokenize ID nélkül |
| Korlátozott adatvédelem | nincs publikált katalógus |

Ugyanezek a címkék a platform connector-listáján is megjelennek. A szöveg legyen azonos, hogy a két csapat ugyanazt értse.

### 7.9 Amit a forrásrendszer UI-ján *ne* építsetek

- Álnév-kézi szerkesztés, vault-böngésző, „generálj `[[COMPANY_99]]`-et”.
- A modellnek szánt prompt-előnézet teljes beszélgetéssel — az a platform observability felülete.
- Felhasználónkénti jelölés („ennél az ügynöknél a cégnév mehet”). A jelölés **séma-szintű**. Az, hogy ki melyik rekordot láthatja, maradjon a meglévő ACL.
- Tokenizálás kapcsolója ENFORCE/OBSERVE/OFF — az a platform kill-switch, nem a CRM-é.

---

## 8. Implementációs sorrend a forrásrendszernek

A platform M1–M3 szeleteivel párosítva. Minden lépés önmagában szállítható.

**S0 — adatmodell.** Minden AI elé kerülő entitásnak van változhatatlan PK. A connector-válaszokban a PK ott van a név mellett.

**S1 — katalógus + admin UI (minimum).** Cégnév mezők `tokenize` + `company` + `crm/company/{id}`. Publikálás, audit, előnézet. `GET /privacy/catalog`. Szám mezők `pass`. Titkok kint hagyása az API-ból.

**S2 — ID-fogadás a tool-API-n.** Minden entitásra hivatkozó endpoint elfogadja `crm/company/4821` és `4821` alakot. Szerződéses teszt: névvel hívni másodlagos; ID-val hívni az elsődleges út.

**S3 — `resolve` + alias-UI.** `POST /privacy/resolve` a három státusszal. Alias-szerkesztő és próbamező. ACL-azonos viselkedés `none`-nál.

**S4 — hint-ek.** Jegyzet-mezők megjelölése, opcionális kontextus-hint. Csak mért minőségromlás után kapcsoljátok a kontextus-hintet (a szülő spec a válaszminőséget méri; a hint tudatos szivárgás).

---

## 9. Elfogadás — a forrásrendszer kész, ha

M1 (kötelező):

- [ ] A connector-API céglistája minden elemén van `id` + `company_name` (vagy a katalógusban jelölt kulcs).
- [ ] `GET /privacy/catalog` 200, `catalog_version ≥ 1`, `structured_field_privacy` és `stable_entity_ids` true.
- [ ] A katalógusban legalább egy `tokenize` + `company` + `source_id` sablon, és a sablon `{id}`-je a payloadban ott van.
- [ ] Numerikus mezőre a UI és az API elutasítja a `tokenize`-t.
- [ ] Van admin-felület a jelölések szerkesztésére, draft/publish-csel és audittal.
- [ ] Az entitásra hivatkozó GET/POST elfogadja a source ID-t; álnevet nem vár.
- [ ] A connector-API válasza **nem** tartalmaz `[[…]]` álnevet.
- [ ] Titok jellegű mező nincs a connector-válaszban.

M3 (ajánlott):

- [ ] `POST /privacy/resolve` a három státuszt adja; acting user ACL-je érvényesül.
- [ ] Alias-szótár szerkeszthető; a próba-mező ugyanazt adja, mint az API.
- [ ] Toldalékos aliasokat (`SPAR-nak`) nem tároltok, csak a tövet.

---

## 10. Gyakori hibák

| Hibás ötlet | Miért | Helyette |
|---|---|---|
| A CRM kicseréli a nevet `[[COMPANY_1]]`-re a válaszban | Az álnév beszélgetés-scope-ú, vaultos, a CRM nem tudja képezni | Nyers név + `id`; a platform cserél |
| Source ID = cégnév vagy adószám | Átnevezés / javítás eltöri a leképezést; adószám azonosító | Belső PK |
| `revenue` tokenize | A modell nem tud számolni az álnévvel | `pass` |
| Tool-API csak nevet fogad | Feloldás után source ID érkezik, a hívás elhasal | ID kanonikus |
| `resolve` 403-at ad, ha a usernek nincs joga | Létezést szivárogtat | `none` |
| Minden `name` kulcs `company` | Kapcsolattartó neve cégálnevet kap | Egyértelmű kulcsnevek |
| Jelölés csak egy JSON-fájl a repo-ban, UI nélkül | A DPO nem tartja karban, elavul | Admin-felület + publikálás |

---

## 11. Mit ad a platform, amit nektek nem kell

- Álnév formátuma, sorszámozása, bijektivitás, HMAC.
- Beszélgetés- és tenant-scope, feloldás a chat UI-n.
- OBSERVE / ENFORCE / OFF üzemmód.
- A sensitivity-router, a prompt-cache szabály, az egress-mátrix (Telegram, e-mail).
- Magyar toldalékos illesztés a known-value rétegen.

Ezek a [`ai-privacy-gateway-spec.md`](./ai-privacy-gateway-spec.md) tárgyai. Ha a katalógus, a payload-ID és a `resolve` megvan, a platform a saját oldalán összerakja a láncot.

---

## 12. Változásnapló

| Verzió | Dátum | Változás |
|---|---|---|
| v0.1 | 2026-08-20 | Első szerződés-tervezet a szülő spec §4 / §7 / §9 / §11 alapján; UI-ajánlással. |
