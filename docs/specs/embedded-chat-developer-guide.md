# Beágyazott agent-chat — integrációs útmutató külső rendszer fejlesztőjének

**Cél:** egy külső rendszer (CRM vagy bármely más app) rekordoldaláról gombnyomásra külön ablakban megnyíljon a platform chat-ablaka, és az agent lássa az aktuális rekord adatait.
**Spec-háttér:** `docs/specs/external-app-chat-api-spec.md` (#481, v1 = A-út, PR #484). Ez az útmutató annak a §8 függelék kibontása, bemásolható formában.
**Nyelv:** a felület magyar; a mezőnevek angolok (`app`, `thread`, `eai:ready`, `eai:context`).

## 1. Hogy működik — 30 másodperces kép

1. A user a CRM-ben egy rekordon (pl. deal) rákattint a „Chat az AI-ügynökkel" gombra.
2. A CRM `window.open`-nel külön ablakban megnyitja a platform agent-választóját: `/embed/agents?app=<slug>&thread=<rekord-id>` — a user kiválasztja, kivel chatel. (Fix agenthez nyitó gombhoz: `/embed/agents/<agentId>?app=<slug>&thread=<rekord-id>`.)
3. Az ablak betöltődik, jelez (`eai:ready`), a CRM visszaküldi az aktuális rekord adatait (`eai:context`).
4. A user chatel az agenttel — jóváhagyás-kártyák, fájlok, minden a platform ablakában fut. A CRM-nek **nincs saját chat-UI-ja**.

Amit direkt nem csinálunk: **nincs iframe** (a platform válasza `frame-ancestors 'none'`-t küld, cross-site iframe-ben a belépési süti sem menne át), **nincs API-kulcs**, **nincs szerver-szerver hívás**. A belépés a user saját platform-fiókja (Clerk), a böngésző első-fél sütijével.

## 2. Előfeltételek — mit kérj a platform-admintól

A fejlesztéshez 3 adat kell (mind a platform-admin adja vagy veled közösen dől el).
Fix agenthez nyitó gombhoz jön egy opcionális 4. (`agentId`):

| # | Adat | Példa | Ki adja |
|---|---|---|---|
| 1 | **Platform-origin** (`PLATFORM`) | `https://agent.teceged.hu` | platform-admin |
| 2 | **App-slug** (`app`) | `ostoros-crm` | platform-admin veszi fel a `/control-plane/embed-apps` oldalon („Beágyazó alkalmazások": név + origin), a slug automatikusan készül a névből; az oldal „Bekötő-kód másolása" gombja már ezzel a sluggal adja a mintát |
| 3 | **Agent-azonosító** (`agentId`) | `3f9c…` (UUID) | csak fix-agentes gombhoz kell; a picker-URL-hez (`/embed/agents?app=…&thread=…`) NEM kell — ott a user választ a saját listájából |
| 4 | **CRM-origin** | `https://crm.teceged.hu` | te adod meg az adminnak — **ezt** regisztrálja az allowlistbe (pontos egyezés, path nélkül) |

Amíg a lista üres, az embed-chat az egész tenantnak zárva van. Ismeretlen slug, idegen tenant agentje, vagy üres lista → az ablak **404**-et ad. Aki chatel, annak **platform-fiók kell**; belépés nélkül az ablak sign-in képernyőt mutat, nem a chatet.

### Az agentId-t honnan veszed? (csak fix-agentes gombhoz)

Az agent adatlapján, a fejléc-kártyán van egy **„Agent-azonosító másolása"** gomb — egy kattintás, és az ID a vágólapon van. (Tartalék: a böngésző címsorából is kiolvasható: `/control-plane/agents/<agentId>/chat`.)

Tehát ha az URL `https://agent.teceged.hu/control-plane/agents/3f9c1a2b-…/chat`, akkor az embed-URL `https://agent.teceged.hu/embed/agents/3f9c1a2b-…?app=ostoros-crm&thread=…` lesz. Ha az agent nem látható a user tenantjából, az embed-ablak 404-et ad (ez szándékos, nem hiba a kódodban).

## 3. Mezőleírás — melyik paraméter mire való

### 3.1 Az embed-URL paraméterei

| Paraméter | Hova kerül | Mire való | Szabály |
|---|---|---|---|
| `agentId` (path) | `/embed/agents/<agentId>` | Melyik agenttel chatel a user. Csak fix-agentes gombhoz kell; a picker-URL (`/embed/agents` agentId nélkül) a user saját listáját mutatja, a választás ugyanabban az ablakban a chatre visz. | Fix UUID, lásd §2. Idegen tenant agentje → 404. |
| `app` (query) | `?app=ostoros-crm` | Melyik külső rendszer nyitja az ablakot. Az adminnál felvett bejegyzés kulcsa. | Csak az allowlisten lévő slug fogadható el, különben 404. |
| `thread` (query) | `?thread=<rekord-id>` | **Melyik rekordhoz tartozik a beszélgetés** — a folytonosság kulcsa (részletesen §4). | `encodeURIComponent`-tal kódolva. Ugyanaz a user + ugyanaz a rekord = ugyanaz a beszélgetés folytatódik. |

### 3.2 A `postMessage`-üzenetek

| Irány | Üzenet | Tartalom | Mire való |
|---|---|---|---|
| embed-ablak → CRM | `{ type: 'eai:ready' }` | csak típus | Jelzi, hogy az ablak betöltődött és fogadja a kontextust. Minden `eai:ready`-re válaszolj `eai:context`-tel. |
| CRM → embed-ablak | `{ type: 'eai:context', label, data }` | `label: string` (emberi címke, pl. `'Megnyitott ügy'`), `data: object` (a rekord JSON-je) | Átadja az aktuális rekord adatait az agentnek. **Rekordváltáskor küldhetsz újat; minden ezután küldött forduló a legutolsót viszi.** |

Korlátok (mindkét oldalon ugyanaz a mérés): `label + data` együtt **max 8 kB** (UTF-8). Felette a kliens némán eldobja, a szerver 403-mal utasítja el a fordulót. Hibás originről érkező üzenet **némán eldobva**, hibaüzenet nélkül.

### 3.3 Eredeti viselkedés, amit nem kell lefejleszteni

Chat-UI, jóváhagyás-kártya (chat-jóváhagyás = önjóváhagyás, mint a weben), Stop/újrakapcsolódás, connector-OAuth popup, kijelentkezett állapot — mind a platform ablakában fut. A beszélgetés a platform webes agent-listájában is megjelenik `"<app-név> · <thread>"` címmel, és költségmérés a `channel = embedded_app` alapján történik.

## 4. A rekord-azonosító (`thread`) — ajánlott használat

A `dealId`, amit a példákban látsz, csak egy példa-név ugyanarra: **annak a rekordnak a stabil azonosítója, amelyről a gombot nyitották**.

- **Mit tegyél bele:** a rekord **stabil, egyedi, nem változó ID-ját** — pl. `deal.id`, `opportunityId`, ügy- vagy rendelésszám. Két megnyitás ugyanarról a rekordról ugyanazt a szálat folytatja (§3.1).
- **Mit ne:** megjelenített nevet (`"Kovács Bt. – 2026"`), mert átnevezéskor megszakad a folytonosság, és a címben is megjelenik.
- **Adatvédelem:** a `thread` értéke látszik a beszélgetés címében (`"Ostoros CRM · 12345"`), ezért **rövid, PII-mentes ID-t** használj, ne ügyfélnév + cím kombinációt.
- **Kódolás:** mindig `encodeURIComponent(recordId)` — a `/`, szóköz, `#`, `&` nélküle széttöri az URL-t.
- **Több rekordtípus:** ha a CRM-ben deal, contact és ticket oldalról is van gomb, mindegyikhez a saját ID mehet ugyanazzal a sluggal — külön szálak lesznek, ez a kívánt működés.
- Az adatátvitel nem a `thread`-ben történik: a `thread` csak kulcs, a rekord tartalmát a `data` viszi (§3.2). Másik user ugyanarról a rekordról külön szálat kap (nincs megosztott szál).

## 5. Referencia-implementáció (bemásolható)

```js
// ---- Konfiguráció: ezeket a célrendszer felületén állíthatóvá tedd (§6) ----
// Alapértelmezett: picker-URL — agentId NEM kell, a user választ a saját listájából.
const EMBED_CONFIG = {
  platformOrigin: 'https://agent.teceged.hu', // PLATFORM
  appSlug: 'ostoros-crm',                        // az adminnál felvett slug
  contextLabel: 'Megnyitott ügy',                // az eai:context címkéje
  // agentId: '3f9c1a2b-…', // CSAK fix-agentes gombhoz (picker helyett):
  //   `${platformOrigin}/embed/agents/${agentId}?app=…&thread=…`
};

// ---- Gombkezelő: minden rekordoldalon ugyanez, csak a record változik ----
function openAgentChat(record) {
  const recordId = String(record.id); // stabil ID, lásd §4
  const win = window.open(
    `${EMBED_CONFIG.platformOrigin}/embed/agents` +
      `?app=${EMBED_CONFIG.appSlug}&thread=${encodeURIComponent(recordId)}`,
    'eai-chat',
    'popup,width=480,height=720',
  );
  if (!win) return; // popup-blokkoló: a hívásnak közvetlen kattintásból kell jönnie

  function onReady(e) {
    if (e.origin !== EMBED_CONFIG.platformOrigin || e.data?.type !== 'eai:ready') return;
    window.removeEventListener('message', onReady);
    win.postMessage(
      { type: 'eai:context', label: EMBED_CONFIG.contextLabel, data: toContextData(record) },
      EMBED_CONFIG.platformOrigin,
    );
  }
  window.addEventListener('message', onReady);
}

// ---- Rekord → kontextus: csak azt küldd, amire az agentnek szüksége van ----
function toContextData(record) {
  // Ajánlott: explicit mezőlista (whitelist), 8 kB alatt tartva.
  return {
    id: record.id,
    title: record.title,
    stage: record.stage,
    value: record.value,
    contact: record.contactName,
  };
}
```

Eredeti ellenőrzőlista a kódhoz: `window.open` (nem iframe, nem `fetch`); `e.origin === PLATFORM` ellenőrzés az `eai:ready`-nél; `postMessage` cél-originje mindig a `PLATFORM` konstans, soha `'*'`; `thread` kódolva; `data` 8 kB alatt (nagy rekordnál mezőlista szűkítés).

## 6. Konfigurálhatóvá teendő változók a célrendszer felületén

Ezeket ne égesd kódba, hanem a CRM admin/beállítások képernyőjén tedd állíthatóvá — így új agent, új rekordtípus vagy költözés kódmódosítás nélkül megy:

| Változó | Javasolt beállítás-név | Miért konfigurálható |
|---|---|---|
| `platformOrigin` | „AI-platform címe" | Környezetenként változik (dev/stage/prod); elírva az ablak üres marad. |
| `agentId` — csak fix-agentes gombhoz, akár **rekordtípusonként** (deal→A-agent, ticket→B-agent) | „AI-ügynök (deal / ticket / …)" | A picker-URL-hez nem kell; fix gombnál az admin agent-cseréje ne igényeljen CRM-release-t. |
| `appSlug` | „Platform app-kulcs (slug)" | Megegyezik az adminnál felvett sluggal; egy CRM-telepítés = egy érték. |
| `contextLabel` | „Kontextus címkéje" (default: `Megnyitott ügy`) | A modell-promptban jelenik meg; nyelvenként/példányonként eltérhet. |
| Kontextus-mezőlista | „Átküldött mezők" (checkbox-lista) | A 8 kB-os korlát és az adat-takarékosság miatt: csak a szükséges mezők menjenek (lásd `toContextData`). |
| Popup-méret | haladó (default `480×720`) | Képernyőmérettől függően; a név (`eai-chat`) maradjon fix, hogy újrakattintás ugyanazt az ablakot használja. |

Nem konfigurálható (protokoll, ne tedd ki): az üzenettípusok (`eai:ready`/`eai:context`), a 8 kB-os korlát, az origin-ellenőrzés logikája, a `frame-ancestors` viselkedés.

## 7. Bizalmi modell — amit a fejlesztőnek tudnia kell

- A küldött rekord-adat **nem megbízható bemenetként** érkezik a modellhez: a szerver `EXTERNAL_UNTRUSTED_DATA source="embedded_app:<slug>"` burkolattal fűzi a prompt elé (az ügyfél által írt CRM-szöveg miatt). A mellékhatásos tool-hívások ugyanúgy a következmény-kapura esnek — ez kívánt viselkedés.
- A kontextus **nem perzisztálódik**: a beszélgetésben csak a user gépelt szövege tárolódik; a weben folytatva a kontextus már nincs ott (az agent a connectorán kéri le újra).
- A szerver mindent újraellenőriz: slug az allowlisten, 8 kB-os méret, user jogosultsága az agentre. A böngésző-oldali ellenőrzés csak előszűrés.
- Hibatáblázat: üres/idegen slug → 404; idegen tenant agentje → 404 (a pickerben meg sem jelenik — mindenki csak a saját listáját látja); nincs platform-session → sign-in képernyő az ablakban (oda-vissza redirecttel); rossz origin üzenete → néma eldobás; 8 kB feletti kontextus → a forduló 403; bejegyzés törlése az adminnál → a slug azonnal 404.

## 8. Átadási teszt (5 perc, kódból is futtatható)

1. Üres allowlist mellett az URL 404; felvétel után bejön.
2. Ugyanaz a user, ugyanaz a rekord → újranyitva ugyanaz a szál folytatódik.
3. Másik rekord → új szál; másik user, ugyanaz a rekord → külön szál.
4. `data` 8 kB felett → a forduló elutasítva; a beszélgetés látszik a webes listában `"<app-név> · <thread>"` címmel.
