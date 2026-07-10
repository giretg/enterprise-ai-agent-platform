# Sensitivity Router — átdolgozási spec

**Státusz:** nyitott (kód nincs, csak a lenti "Már megtörtént" szakasz)
**Dátum:** 2026-07-10
**Kiváltó ok:** élő incidens, ld. §1

---

## 1. Kiváltó incidens

Egy chat-beszélgetésben (`5082cda0-3776-4097-9d9e-6bfa4fe4c54a`) a felhasználó
első kérdése az utolsó e-mailjeire vonatkozott. Az agent lefuttatta a
`gmail_search` + 3× `gmail_get_message` hívást, és a válaszába **beidézte** a
feladó e-mail-címét (`szilagyi.tamas@tmdminformatika.hu`).

A második kérdés ("mi a vezető cikk a telex.hu-n?") ezután **soha nem kapott
választ**:

1. A `classifyPrompt` az előzményben találta az e-mail-címet → `sensitive`.
2. A policy `sensitive` esetén `ollama / gemma-local`-ra kényszerített.
3. Ollama nem futott → `fetch failed` (623 ms, `model_calls.status=error`).
4. A chat UI az SSE `error` eseményre eldobta az optimista user-buborékot, így a
   kérdés "felvillant és eltűnt" — miközben a `messages` táblában (seq 3) ott volt.

**Két külön tanulság.** Egyrészt a beszélgetés ettől fogva véglegesen
használhatatlan volt: minden további forduló újraolvasta az előzményt, tehát
újra `sensitive` lett. Másrészt — és ez a súlyosabb — az **első** forduló öt
modellhívása simán kiment az OpenRouterre, a nyers Gmail-tartalommal együtt,
mert a klasszifikátor akkor még nem nézte a `tool` szerepű üzeneteket.

---

## 2. Már megtörtént (2026-07-10)

| # | Változás | Hol |
|---|---|---|
| 1 | A klasszifikátor a `tool` szerepű üzeneteket is nézi | `sensitivity-router.ts` `extractText` |
| 2 | Fail-closed: ha nincs elérhető helyi modell, `GatewaySensitivityError` + `sensitivity_local_unavailable` audit, nem nyers `fetch failed` | `model-gateway.ts` `resolveSensitiveTarget` |
| 3 | A célmodell env-ből konfigurálható (`SENSITIVITY_LOCAL_*`) | `sensitivityPolicyFromEnv` |
| 4 | Per-agent felmentés (`agents.allow_sensitive_external_model`), tenant admin + superadmin állítja, auditált | migráció `0005`, `updateAgentSensitivityPolicy`, `SensitivityPolicyForm` |
| 5 | A chat UI hibánál megtartja a perzisztált user-üzenetet | `agent-chat-panel.tsx` |

Regressziós fedés: `npm run test:gateway-negative` (MG-N8, 5 eset).

**Fontos korlát:** a per-agent felmentés kizárólag a `sensitive` szintre hat.
A `forbidden` szint (PAN, IBAN, privát kulcs) továbbra sem kapcsolható ki
agent-szinten — ezt az MG-N8 külön teszteli.

---

## 3. Nyitott problémák

### P1 — A minta-készlet nem konfigurálható

Ma a `SENSITIVE_PATTERNS` / `FORBIDDEN_PATTERNS` beégetett regexek. Emiatt:

- Egy e-mail-szortírozó agentnél az `EMAIL_RE` értelmetlen jelzés — ott az
  e-mail-cím a **munkadarab**, nem szivárgás. A per-agent kapcsoló ezt ma
  mindent-vagy-semmit alapon oldja meg: ha bekapcsolod, a TAJ-szám és az adószám
  is szabadon kimegy.
- Nincs mód tenant-specifikus minta hozzáadására (pl. belső ügyfél-azonosító
  formátum).

**Irány:** kategória-szintű, tenant- és agent-szinten felülbírálható policy.
Vagyis nem egy `boolean`, hanem kategóriánként (`email`, `taj`, `adoszam`, `pan`,
`iban`, `secret_key`) egy döntés: `block` | `local_only` | `allow`.
A `pan` / `iban` / `secret_key` esetén az `allow` legyen superadmin-jog és külön
megerősítés mögött.

### P2 — Nincs konfigurációs felület

Kell egy admin UI, ahol látszik:

- mely kategóriák aktívak, milyen döntéssel,
- melyik célmodellre irányít a `local_only`,
- élő "próbáld ki" mező: beírt szövegre megmutatja az `inspectPromptSensitivity`
  találatait (ez a függvény már maszkolt snippetet ad vissza, tehát biztonságos).

Az `inspectPromptSensitivity` már ma visszaad `findings[]`-et sor/oszlop pozícióval
— erre ráépíthető.

### P3 — A célmodell nem tenant-szintű

Az env-konfiguráció (§2/3.) globális. Firebase App Hosting alatt nincs helyi
modell, tehát ott a `sensitive` ma fail-closed. Kell:

- tenant-szintű célmodell-választás (akár egy jóváhagyott külső provider is,
  pl. EU-régióban futó, DPA-val fedett modell),
- a `localProvider`/`localModel` elnevezés emiatt félrevezető → `sensitiveTarget`.

### P4 — A `system` üzenetek nem osztályozódnak

Az `extractText` szándékosan kihagyja a `system` szerepet, mert azok
platform-generált szövegek (tool-instrukció, skill-törzs). **De** a tartós
agent-memória a felidézett memória-chunkokat is `system` üzenetként injektálja
(`chat-tool-loop.ts`). Ha egy memória-chunk PII-t tartalmaz, az ma osztályozás
nélkül megy ki.

Nem triviális: a memória-chunk jóváhagyott, emberi szemmel látott tartalom, tehát
vitatható, hogy szivárgásnak számít-e. Döntést igényel, nem automatikus szigorítást.

### P5 — Az osztályozás fordulónként újrafut a teljes előzményen

Ez helyes (a prompt tényleg tartalmazza az előzményt), de két következménnyel jár:

- **Költség:** minden fordulóban végigregexeljük a teljes history-t. Hosszú
  beszélgetésnél ez mérhető. Érdemes lehet a már osztályozott prefixre eredményt
  cache-elni (a history append-only).
- **UX:** egyetlen `sensitive` találat után a beszélgetés végleg átbillen. Ma ez
  csak a per-agent kapcsolóval oldható fel. Alternatíva: forduló-szintű
  emberi jóváhagyás (a `sensitivityOverride` mechanizmus már létezik a
  `forbidden` szintre — ki lehetne terjeszteni).

---

## 4. Nyitott döntések

- **D1:** A kategória-szintű policy hol lakjon? (`PlatformSettings` kulcs vs. új
  tábla vs. tenant-oszlop) — a mintakészlet verziózása auditálandó.
- **D2:** A `sensitive` szintre kiterjesszük-e a meglévő emberi-jóváhagyás
  (`sensitivityOverride`) mechanizmust, vagy maradjon agent-szintű kapcsoló?
- **D3:** P4 — a memória-chunkot osztályozzuk-e?
- **D4:** A `sensitiveTarget` lehet-e külső provider, és ha igen, milyen
  jóváhagyás mögött?
