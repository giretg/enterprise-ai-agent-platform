# Connector-beállítás és -szerkesztés — jegybontás

Forrás: [AI-Agent-Platform-Dev-Spec-Connector-Setup-and-Editing.md](./AI-Agent-Platform-Dev-Spec-Connector-Setup-and-Editing.md) (v0.1, 2026-07-15)

A 3 nyitott döntés (D-1, D-2, D-3) az ajánlott opcióval van lezárva a jegyekben
(lásd az adott jegy "Döntés" sorát). WP-0 kihagyva (kész, csak commit/PR vár rá).

---

## TICKET-1 — Auth-forma egyértelműsítése (B1)

**WP:** WP-1 · **Prioritás:** Magas · **Függés:** —

**Probléma:** `buildAuthHeaders` a `header` sémánál nem teszi elé a `Bearer `
előtagot (`app/src/domain/connector/http-api-client.ts:639`, vö. `bearer`
séma: `:633`), a UI ezt sehol nem teszi egyértelművé.

**Feladat:**
- Connector-szerkesztő auth-szekció: emberi nyelvű magyarázat "Bearer token"
  és "Egyedi fejléc" választásnál (pontos szövegek: spec §7).
- Puha figyelmeztetés mentés előtt, ha `Egyedi fejléc = Authorization` és a
  kulcs nem `Bearer `-rel kezdődik.
- `testConnectorDraft` auth-hiba (401) esetén explicit üzenet: ellenőrizd a
  kulcs formátumát / `Bearer` előtagot / fejléc nevét.

**DoD:** sandbox-teszt hibaüzenete auth-hibánál explicit; UI mindkét
auth-módnál megmondja mit ír be a felhasználó és mit tesz hozzá a rendszer.

---

## TICKET-2 — Per-agent kulcs valódivá tétele (B2)

**WP:** WP-2 · **Prioritás:** Magas · **Függés:** —

**Döntés (D-1):** Opció **(A)** — a per-agent alias mindig hat, üzemmódtól
függetlenül.

**Probléma:** a per-agent alias csak `agent_owned` módban él
(`app/src/domain/tool-broker/tool-broker-delegation.ts:133`), de egyetlen
http_api-connector sem kerül ebbe az üzemmódba (create:
`app/src/app/actions/platform.ts:1194`; aktiválás:
`app/src/domain/provisioning/provisioning-service.ts:357`) — a UI-ban
megadott per-agent kulcs csendben hatástalan.

**Feladat:**
- Runtime: ha `agentSecretAlias` létezik, azt használjuk függetlenül az
  `authMode`-tól (a `user_delegated` oauth ág változatlan marad).
- Ha a választott konfigurációban a per-agent kulcs nem érvényesülne, a UI ne
  engedje megadni, vagy a mentés adjon egyértelmű hibát — csendes elnyelés
  tilos.
- Tenant-szintű kulcs marad fallback a per-agent kulcs nélküli agenteknek.

**DoD:** teszt bizonyítja: agent A per-agent kulccsal az A-kulcsot használja,
agent B (kulcs nélkül) a tenant-kulcsot; a kettő egyszerre él.

---

## TICKET-3 — Endpoint-korlát kikényszerítése (B3)

**WP:** WP-3 · **Prioritás:** Közepes-Magas (biztonsági vonatkozás) · **Függés:** —

**Probléma:** az endpoint-korlát csak `restrictToEndpoints===true` esetén él
(`app/src/domain/connector/http-api-client.ts:392`), a materializer ezt nem
állítja be (`app/src/domain/connector-template/materializer.ts:40`) — az
agent listán-kívüli útvonalat is hívhat.

**Feladat:**
- Materializer: endpointtal rendelkező http_api confignál alapból
  `restrictToEndpoints: true` (kivétel: tudatosan nyitott sablonok, pl.
  GitHub repo-scope).
- UI: látható/kapcsolható "Csak a fenti endpointok hívhatók" opció.
- Listán-kívüli hívás azonnal, külső hívás nélkül bukjon (`endpoint_not_allowed`).
- Agent-katalógus (`app/src/domain/agent/chat-tool-loop.ts:2179`) egészüljön
  ki: "Csak az itt felsorolt végpontok hívhatók." ha a korlát aktív.

**DoD:** listán-kívüli path → `endpoint_not_allowed`, nincs külső hívás;
ToolCall-napló ezt tükrözi.

---

## TICKET-4 — Aktiválás utáni szerkesztés a provisioningban (B6)

**WP:** WP-4 · **Prioritás:** Közepes · **Függés:** —

**Döntés (D-2):** meglévő reopen-mechanika kiterjesztése (draft→active
vissza), nem dedikált aktív-config-editor — újrahasználja a
valid→review→sandbox kaput.

**Probléma:** a provisioning panel csak draft/validated configot enged
szerkeszteni (`updateConnectorDraftConfig`), aktiváltat nem
(`app/src/domain/provisioning/provisioning-service.ts:539`) — ezért csúszik
át a szerkesztés az agent-dobozba (lásd TICKET-5 / B4).

**Feladat:**
- Aktivált connectorhoz "Szerkesztés" gomb a provisioning panelen, a
  jelenlegi configból előtöltve.
- Reopen-mechanika kiterjesztése: részleges, auditált módosítás, verzió-emelés
  és re-validáció.
- Kulcs-rotáció itt (tenant-szint), "üresen hagyva marad a jelenlegi"
  szemantikával.

**DoD:** aktivált connector configja a provisioningból módosítható, üres
mező nem töröl meglévő értéket, minden módosítás auditált + verziózott.

---

## TICKET-5 — Agent-szerkesztő leszűkítése a kötésre (B4)

**WP:** WP-5 · **Prioritás:** Magas (adatvesztés-kockázat) · **Függés:** TICKET-2, TICKET-4

**Probléma:** az agent "Külső kapcsolatok" doboza connector-szintű update-et
csinál a form-ból újraépített teljes configgal
(`app/src/app/actions/platform.ts:1367`) — (a) az egész tenantra hat, (b) a
szerkesztő nincs feltöltve, ezért mentéskor a kitöltetlen mezők felülírják a
valós configot (fejléc-, endpoint-, auth-vesztés).

**Feladat:**
- Agent "Külső kapcsolatok" doboz: csak csatolás/leválasztás,
  hozzáférés (olvasás/írás), per-agent kulcs (TICKET-2 után) szerkeszthető.
- Ha marad connector-mező a nézetben, kizárólag olvasható, provisioningra
  mutató linkkel + felirat: "Ez a beállítás a connector egészére (az egész
  tenantra) vonatkozik — a provisioningban módosítható."
- `platform.ts:1367` roncsoló update megszűnik / tisztán részlegessé válik.

**DoD:** az agent-nézetből nem lehet a connector fejléceit/endpointjait/
auth-ját véletlenül felülírni; "csak új kulcs" mentés semmi mást nem változtat.

---

## TICKET-6 — Meglévő Ostorosbor connectorok migrációja

**WP:** WP-6 · **Prioritás:** Közepes · **Függés:** TICKET-4 (ha a reopen-utat használjuk) — de mehet önállóan is script formában

**Döntés (D-3):** újra-materializálás a javított sablonból (nem automatikus
átírás), hogy a config garantáltan a sablon-igazsághoz igazodjon.

**Probléma:** WP-0 (kész) a sablont `bearer` sémára javította, de a már
aktivált connectorok (pl. `Ostorosbor CRM` / `0fa32c6b`) még a régi
`api_key_header`/`Authorization` configot hordozzák.

**Feladat:**
- Egyszeri script/áttekintés: élő Ostorosbor connectorok azonosítása.
- Újra-materializálás a javított sablonból (config + tárolt kulcs, ha van
  benne felesleges `Bearer ` prefix, eltávolítva).

**DoD:** minden élő Ostorosbor connector `bearer` sémájú, a sandbox-teszt
200-at ad az `/accounts`-ra.

---

## TICKET-7 — Címkék, súgók, placeholderek (B5 + átfogó egyértelműség)

**WP:** WP-7 · **Prioritás:** Közepes · **Függés:** TICKET-1 (auth-szövegek átfedésben)

**Probléma:** az aktiválási "alias" mező csak meghatározott formákat fogad el
(`env:…`, `secret-manager:…`, `secret-ref:…`) — `isResolvableSecretAlias`
(`app/src/domain/provisioning/provisioning-service.ts:325`), a feloldó a bare
nevet eldobja (`app/src/domain/connector/http-api-client.ts:310`); a UI-ban
javasolt "sima név" elutasításra kerül, a mező szerepe nincs elmagyarázva.

**Feladat:**
- Minden kulcs/alias beviteli ponton egységes szöveg: mit írj be, a
  `Bearer`-t a rendszer adja-e, melyik szintre hat (pontos szövegek: spec §7).
- Alias mező alapból rejtett, "Meglévő titok hivatkozása (haladó)" lenyíló
  mögött, elfogadott formák felsorolásával + inline validációval.
- Mindig látszódjon: "A kulcs titkosítva tárolódik, sosem kerül az
  adatbázisba."

**DoD:** UX-átnézés: minden mezőnél egy nem-fejlesztő is meg tudja mondani,
mit kell oda írni.

---

## Áttekintő tábla

| Jegy | WP | B-hiba | Prioritás | Függés |
|---|---|---|---|---|
| TICKET-1 | WP-1 | B1 | Magas | — |
| TICKET-2 | WP-2 | B2 | Magas | — |
| TICKET-3 | WP-3 | B3 | Közepes-Magas | — |
| TICKET-4 | WP-4 | B6 | Közepes | — |
| TICKET-5 | WP-5 | B4 | Magas | TICKET-2, TICKET-4 |
| TICKET-6 | WP-6 | (WP-0 köv.) | Közepes | TICKET-4 (opcionális) |
| TICKET-7 | WP-7 | B5 | Közepes | TICKET-1 |

Javasolt sorrend: **1 → 2 → 3 → 4 → 5 → 7 → 6** (a 6-os bármikor mehet
párhuzamosan, de logikusan a 4-es reopen-út után egyszerűbb).
