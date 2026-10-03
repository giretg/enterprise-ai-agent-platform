# Hermes Enterprise Managed Client – magas szintű specifikáció

**Verzió:** v0.3 · **Dátum:** 2026-09-30 · **Státusz:** döntések lezárva, v1 szelet fejlesztésre kész (§17)
**Előzmény:** `docs/hermes-integration-foundation-2026-09-26.html` (H3 Guard, H4 managed distribution, H5 restricted mode), #682 Bot-szinkron (PR #683 / #734)
**Hermes alapvonal:** v0.21.5, upstream `d0288be5` (2026-09-26), helyi forrás: `~/.hermes/hermes-agent`

> **v0.3 változás:** a nyitott döntések lezárva (§15, D1–D16), a kódalappal való összevetés leletei (G1–G3) beépítve, új §17: az első fejlesztési szelet (hatókör, feladatok, elfogadás).
>
> **v0.2 változás:** a cél a **paraméterezhetőség**, nem a korlátozás. Új fejezetek: §1 (a tényleges cél), §2 (miért nem harness a szerveren), §5 (policy-modell), §7 (kimenő tartalomszűrés, a legacy AI Privacy Gateway átvételével). A korábbi „mindent tiltunk” példák a „Kötött pálya” preset részei lettek.

---

## 0. Összefoglaló

**A cél:** a cég **paraméterezhesse**, hogy egy adott felhasználó egy adott AI agenttel mit tehet és mit nem, miközben a munka egy profi, kliensen futó agent harnessben (Hermes) történik. Az egyik munkatársnál ez jelenthet helyi kódfuttatást, szabad böngészést és saját skilleket. Egy másiknál, aki érzékeny adatokkal dolgozik, szigorúan kötött pályát, céges sandboxszal és tartalomszűréssel. **A korlátozás opcionális.** A kötelező rész az, hogy a döntés a cég kezében legyen, és ami történik, az látható és auditálható legyen.

**Az alapelv: a modell-kulcs a szerveren van, nem a gépen.** Ma a Hermes a user gépén tárolt provider-kulccsal (pl. OpenRouter, `~/.hermes/.env`) közvetlenül a providerrel beszél, így a cég semmit nem lát. A célállapotban minden céges provider-kulcs a szerveren van (Secret Manager), és csak a Model Gateway használja:

```
Hermes ──(rövid életű, user+eszköz kötött token)──► Excellence Model Gateway ──(céges provider-kulcs)──► OpenRouter / más provider
```

A Hermes nem kap provider-kulcsot, csak egy `key_cmd`-vel kért, percek alatt lejáró tokent, amely kizárólag a mi gateway-ünkön érvényes és egyenként visszavonható. A gépen maradt kulcsokat a rendszergazdai `.env` üresre rögzíti. **Minden más erre épül:** amíg a kulcs a gépen van, a gateway megkerülhető, és akkor nincs audit, szűrés és agentenkénti modellválasztás. Ha a kulcs csak a szerveren van, ezek megkerülhetetlenek. Mellékhatásként a költség userenként és agentenként mérhető és keretezhető, a rotáció pedig egy helyen történik. Átálláskor a laptopokon eddig tárolt kulcsokat rotálni kell. A user saját előfizetéses belépése (ChatGPT/Codex OAuth) így nem helyezhető át, ezért menedzselt módban nem használható (D2).

**Megvalósítható-e, fork nélkül?** Igen, háromrétegű megoldással:

1. **Szerver (Excellence):** a meglévő MCP Gateway és sandbox, plusz egy új, **állapotmentes Model Gateway**. Minden modellhívás ezen megy át: itt van a prompt-audit, a tartalomszűrés (a legacy AI Privacy Gateway logikájával, §7.1) és az agentenkénti modell-policy, és csak itt van céges modell-kulcs.
2. **Gép-szintű alap (`/etc/hermes`, MDM-mel terítve):** amit a user a gépén semmiképp nem kapcsolhat ki. Ilyen a Guard jelenléte, a céges modell-út és a plugin-allowlist.
3. **Excellence Guard (Hermes plugin + shell-hook tartalék):** a felhasználóra és agentre szabott policyt érvényesíti tool-hívás és modellhívás előtt, fail-closed módon, és naplóz.

**Miért nem harness a szerveren (mint a legacy verzióban)?** Mert a Model Gateway nem harness, hanem kérésenkénti átjáró. Az agent-loop, a kontextuskezelés, a böngésző és a hosszú feladatok a Hermesben maradnak. Így megmarad a profi harness előnye, a céges kontroll pedig visszajön (§2).

**Őszinte korlát:** egy saját gépén admin jogú user ellen kliensoldalon semmi sem megkerülhetetlen. Kemény garanciát a szerveroldali gateway-ek (céges modell, tool, adat és credential csak rajtuk át érhető el) és az eszközmenedzsment adnak együtt. A Guard a jóhiszemű és a kényelemből megkerülő usert fedi le, és **észleli** a kilépést.

---

## 1. A tényleges cél: paraméterezhető AI-használat

### 1.1 Célállítás

> A cég minden felhasználóra és minden AI agentre külön megadhassa, hogy a helyben futó Hermes **mit tehet meg** (helyi kódfuttatás, fájlok, böngésző, web, külső MCP-szerverek, skillek, modellek, autonóm futás) és **milyen feltételekkel** (szabadon, jóváhagyással, sandboxban, tartalomszűréssel), és hogy **mindez auditálható** legyen, beleértve a user promptjait is.

### 1.2 Irányelvek

- **Paraméterezés a korlátozás helyett.** Nincs beépített „tiltott” funkció. Minden képességnek szintjei vannak, a cég választ.
- **A munka jellegéhez igazodik.** Egy fejlesztőnek szabad AI kell, helyi terminállal. Egy pénzügyes vagy ügyfélszolgálati munkatársnak, aki érzékeny adatokkal dolgozik, jellemzően kötött pálya is elegendő.
- **Két tengely:** *ki használja* (felhasználó, szerep, csoport) és *melyik agent* (a Bot, amelynek saját feladatköre van). A kettő metszete adja a ténylegesen engedettet, tool-szintű felülírással.
- **Nem kötelező, csak az alap.** Csak egy kis, nem kikapcsolható alapréteg kötelező (§5.4): céges modell csak a gateway-en át, minimális audit, szerveroldali tool-engedélyezés.
- **Közérthetőség.** Ha valami nem engedett, a user hétköznapi nyelven megtudja, mi és miért, és kitől kérhet engedélyt.

### 1.3 Nem-cél (v1)

- Általános endpoint-security (DLP, EDR) kiváltása. Az AI nélküli helyi programfuttatás nem ennek a specnek a hatásköre.
- Más AI-kliensek (ChatGPT web, saját API-kulcs) tiltása. Ez hálózati és HR-policy kérdés. A spec annyit ad, hogy a céges erőforrások ezekből csak „Open” policyval érhetők el.
- Kriptográfiai kliens-attesztáció (H5+).

---

## 2. Miért nem harness a szerveren?

A legacy platform szerveroldalon futtatta a teljes beszélgetést. Ezt két okból vetettük el:

1. **Profi harnesst építeni túl nagy falat.** A Codex, a Hermes és a hasonló eszközök kifinomult eszközrendszert adnak (beépített böngésző, terminál, fájlkezelés, subagentek, kontextus-tömörítés, UX). Ezt reprodukálni gyakorlatilag lehetetlen.
2. **Hosszú beszélgetést szerveren nehéz életben tartani.** Egy tízperces feladathoz is bonyolult infrastruktúra kellett (állapot, detached futás, újraindulás, poll), különben az AI megállt.

**Ez a megoldás egyiket sem hozza vissza:**

| Kliensen (Hermes, a „profi harness”) | Szerveren (Excellence) |
|---|---|
| Agent-loop, tervezés, újrapróbálkozás | **Model Gateway:** egyetlen kérés és válasz továbbítása, szűrés, audit |
| Kontextuskezelés, tömörítés, prompt-cache | **MCP Gateway:** vállalati toolok, adatok, credentialök (meglévő) |
| Tool-orkesztráció, subagentek, skillek, böngésző, UX | **Sandbox:** kódfuttatás, ha a policy ezt kéri (meglévő, #485) |
| A beszélgetés állapota, akár órákig | **Audit-napló:** csak hozzáírás, a beszélgetés állapotát nem kezeli |

- **Nem építünk harnesst.** Csak gateway-t, Guard plugint és policy-modellt építünk.
- **A szerveren nincs hosszan futó beszélgetés.** A Model Gateway állapotmentes. Egy tízperces feladat a szerver szemében például 40 független, egyenként másodpercektől legfeljebb pár percig tartó HTTP-hívás, a folytonosságot a Hermes tartja. Ha egy szerverpéldány közben újraindul, csak az az egy hívás bukik el, és azt a Hermes újrapróbálja. Cloud Runon vízszintesen skálázható.
- **A kontroll nem jelent tiltást.** Egy eszköz háromféleképpen kontrollálható: marad, de auditált; marad, de policyval (pl. domain-lista); vagy marad, de máshol fut (céges sandbox vagy felhős böngésző). Az eszköz mindig a Hermesé marad, csak a szabálya vagy a végrehajtás helye változik.

**Vállalt kompromisszumok:** a Model Gateway kritikus pont (kell rá SLA és redundancia); a kliens a user gépén fut (ha a laptop elalszik, a feladat megáll, mint a Codexben is; felügyelet nélküli feladatokhoz a Hermes később szerveren is futtatható, ugyanazzal a policyval); a Hermes gyorsan változik, ezért automatikus kompatibilitási teszt kell.

**Gyártófüggetlenség:** a minta (profi harness a kliensen, modell- és tool-út a céges gateway-en) nem Hermes-specifikus. API-kulcsos módban a Codex CLI és a Claude Code is átirányítható ugyanerre a gateway-re, a Claude Code-nak központi beállításai és hookjai is vannak. A Hermes azért az első választás, mert nyílt forrású, rendszergazdai konfigurációval és pluginokkal testre szabható, és a Bot mód megjeleníti a céges agenteket.

---

## 3. Fenyegetési modell

| Szint | Szereplő | Lefedjük? | Mivel |
|---|---|---|---|
| **T0** | Hibázó vagy prompt-injektált agent | ✅ | Policy szerinti tool-kapu, sandbox, tartalomszűrés, szerveroldali authz |
| **T1** | Jóhiszemű user | ✅ | Bot-szinkron, Guard, érthető elutasítás |
| **T2** | Kényelemből megkerülő user, aki nem admin a gépén | ✅ MDM-mel terítve | `/etc/hermes` root-tulajdonban, egress-szabály, a Guard észlel |
| **T3** | Rosszhiszemű, admin jogú user | ⚠️ észlelés + szerveroldali kizárás | Céges kulcs, tool és adat csak a gateway-en; a nem menedzselt kliens „Open” policyt kap |

---

## 4. Követelmények

| ID | Követelmény |
|---|---|
| **R0** | **Paraméterezhetőség:** minden képesség (§5.2) szintje felhasználóra, szerepre, agentre és toolra beállítható; a ténylegesen engedett a metszetük. |
| **R1** | Auditálhatóság, a policy szerinti mélységben: user prompt, a modellnek ténylegesen elküldött kérés, válasz, lokális és MCP tool-hívások, user/tenant/agent/session/turn azonosítóval. |
| **R2** | Tool-használat a policy szerint: ami nincs engedve, az nem hívható, ismeretlen MCP-szerveré sem (kivéve, ha a policy megengedi). |
| **R3** | Skill-használat a policy szerint: csak jóváhagyott skillek, vagy saját skillek is (auditálva). |
| **R4** | Kódfuttatás a policy szerint: tiltott, csak céges sandboxban, helyben jóváhagyással, vagy helyben szabadon. |
| **R5** | Minden LLM-hívás, a mellékhívásokat is beleértve (tömörítés, címadás, vision, subagent), a Model Gateway-en megy át. **Ez alapréteg, nem paraméter.** |
| **R6** | Kimenő tartalomszűrés a policy szerint: kategóriánként ki, figyelmeztet, kitakar/tokenizál vagy blokkol. |
| **R7** | Lokális vállalati adat (memória, session-DB) a policy szerint kezelve. |
| **R8** | Eltérés-észlelés: a szerver tudja, hogy policy-konform, menedzselt kliens hívja-e, és ha nem, szűkebb policyt alkalmaz. |
| **NFR** | Fork nélkül, frissítéskor nulla merge. Az elutasítás hétköznapi nyelvű. A policy-változás legkésőbb a következő sessionben érvényes, visszavonáskor a következő hívásnál. |

---

## 5. Policy-modell

### 5.1 Hatókör és feloldás

```
Tenant alap
  └─ Szerep / csoport (pl. „Pénzügy”, „Fejlesztő”)
       └─ Felhasználó (egyedi eltérés)
                ∩
Agent (Bot) képesség-plafon — mire való az adott agent
                ∩
Tool-szintű felülírás (explicit allow / deny)
= ténylegesen engedett (effektív policy)
```

- **Felhasználói oldal:** mit tehet az adott ember (tenant alap → szerep → felhasználó, a specifikusabb felülírja az általánosabbat). **v1-ben nincs szerep/csoport réteg (D10):** tenant alap → felhasználó (preset + felülírás). Csoport-entitás (`PolicyGroup`) akkor jön, ha a userenkénti kezelés már nem fér bele (kb. 20+ user tenantonként).
- **Agent oldal:** mire való az adott agent (plafon). Egy „Számlázási asszisztensnek” akkor sem kell terminál, ha a user fejlesztő.
- **Effektív = felhasználói engedély ∩ agent plafon**, tool-szintű felülírásokkal. **A tiltás mindig nyer.** Ez összhangban van a meglévő szerveroldali metszettel (foundation §11.1).

### 5.2 Paraméterezhető képességek

| Képesség | Szintek (szigorútól a szabadig) | Hermes-mechanizmus |
|---|---|---|
| **Helyi kódfuttatás** (`terminal`, `execute_code`) | tiltott · csak céges sandboxban · helyben, jóváhagyással · helyben, szabadon | toolset, Guard, terminál-backend plugin, `approvals` |
| **Helyi fájlok** | nincs · csak olvasás · írás a projektkönyvtárban · szabad | `file` toolset, Guard útvonal-policy, `HERMES_WRITE_SAFE_ROOT` |
| **Böngésző / computer-use** | tiltott · céges felhős böngésző · domain-allowlist · szabad | toolset, Guard (`browser_navigate` URL), böngésző-provider plugin |
| **Web-keresés** | tiltott · csak céges web-egress (MCP) · beépített | toolset, MCP |
| **MCP-szerverek** | csak céges · + jóváhagyott külsők · szabad | Guard tool-név allowlist (`mcp__<szerver>__*`) |
| **Skillek** | csak jóváhagyott · + saját, auditálva · szabad | Agent Sync manifest, Guard, `skills.write_approval` |
| **Modellek** | engedett modell-lista (ExecutionProfile, költségszint) | Model Gateway |
| **Kimenő tartalomszűrés** | kategóriánként: ki · figyelmeztet · kitakar/tokenizál · blokkol | Model Gateway (APG #272), Guard `llm_request` |
| **Audit-mélység** | metaadat · + teljes prompt és válasz · + tool-eredmények | Model Gateway, Guard |
| **Lokális memória** | tiltott · Excellence-memória · lokális | `memory` toolset, memory provider plugin |
| **Autonóm futás** (subagent, cron) | tiltott · engedett, auditálva | `delegation`, `cronjob` toolset, Guard |
| **Emberi jóváhagyás** | toolonként: nincs · kockázatos műveletnél · mindig | Guard `pre_tool_call` → `approve` |

### 5.3 Presetek (kiindulópontok, nem kötelezők)

| Preset | Kinek | Jellemző beállítás |
|---|---|---|
| **Kötött pálya** | Érzékeny adatokkal dolgozók (pénzügy, ügyfélszolgálat, HR) | Nincs helyi kódfuttatás, fájlírás és böngésző; csak céges MCP és jóváhagyott skillek; tartalomszűrés blokkol/tokenizál; teljes audit |
| **Standard** | Általános irodai munka | Kódfuttatás csak sandboxban; fájl csak olvasás; böngésző domain-listával; web céges egress-en; kitakarás; teljes prompt-audit |
| **Szabad (fejlesztő)** | Fejlesztés, kutatás | Helyi terminál és fájlírás a projektben, szabad böngésző, saját skillek; tartalomszűrés csak titkokra (kulcsok, jelszavak); audit metaadat + prompt |

A cég a presetből indul, és bármely képességet felülírhat szerepre, felhasználóra, agentre vagy toolra.

### 5.4 Nem paraméterezhető alapréteg (floor)

Ezek nélkül a paraméterezés nem ellenőrizhető, ezért minden menedzselt kliensen kötelezők:

- céges modell csak a Model Gateway-en át (R5);
- Guard jelen van és működik (heartbeat);
- legalább metaadat-szintű audit (ki, mikor, melyik agenttel, milyen toolt hívott);
- a vállalati toolok engedélyezése a szerveren (MCP Gateway `authorizeToolCall()`).

### 5.5 Hol érvényesül (statikus és dinamikus rész)

A Hermes rendszergazdai konfigurációja (`/etc/hermes`) **gépenként egy**, és minden Botra érvényes. Ezért a paraméterezés két részre oszlik:

| Rész | Hol | Tartalom |
|---|---|---|
| **Statikus padló** | `/etc/hermes` (MDM generálja az adott gépre) | Az alapréteg (§5.4), plusz ami **a gép userének egyik agentjénél sem** engedett. Szabály: *a gép padlója = a user legbővebb engedélye.* Kötött pályás usernél tehát a terminál már itt letiltható; fejlesztőnél nem. |
| **Dinamikus, user × agent** | Excellence Guard (policy-snapshot a Control Plane-ből, session-indításkor + TTL) | Toolonkénti engedélyezés, jóváhagyás-kérés, útvonal- és domain-policy, a terminál-backend ellenőrzése. Fail-closed. |
| **UX (nem kontroll)** | Agent Sync a Bot-profil `config.yaml`-jába | A nem engedett toolok elrejtése, `terminal.backend` beállítása. Kényelmi funkció: a user átírhatja, ezért az érvényesítés a Guardé. |
| **Szerveroldali, kemény** | Model Gateway, MCP Gateway, Sandbox | Modell-lista, tartalomszűrés, audit-mélység, vállalati toolok, credentialök. |

---

## 6. Hermes képesség-térkép (kimért)

Jelölés: **[forrás]** = kódban/doksiban ellenőrizve · **[élő]** = ezen a gépen lefuttatva · **[POC]** = még mérendő.

| # | Mechanizmus | Mit ad | Erősség | Ismert megkerülés |
|---|---|---|---|---|
| H-1 | **Managed scope** `/etc/hermes/{config.yaml,.env}` (felülírható a `HERMES_MANAGED_DIR` változóval) — `hermes_cli/managed_scope.py` | Kulcsonként pinelt, user által felülírhatatlan érték. Minden profilra (Botra) érvényes. `hermes config set` megtagadja. Env-nél is erősebb. | Fájlrendszer-jog (root 0644). **[forrás][élő]** | Admin user törli vagy átírja. Ha a user állíthatja a `HERMES_MANAGED_DIR`-t, átirányíthatja. A hibás fájlt fail-open figyelmen kívül hagyja (hangos log). |
| H-1a | Merge-szemantika | **Levél-szintű deep-merge; a lista egészben cserélődik.** A `plugins.enabled`, `agent.disabled_toolsets` és `hooks.pre_tool_call` teljesen pinelhető. A dict típusú kulcsokat (`mcp_servers`, `providers`) viszont a user **bővítheti**. | **[forrás][élő]** | — |
| H-1b | ⚠️ Élő lelet | Csak `model.provider` pinelésekor a user `model.base_url` értéke megmaradt. **Minden érintett levelet (provider, base_url, api_mode) külön pinelni kell.** | **[élő]** | — |
| H-1c | `--safe-mode` | A managed overlay **ekkor is érvényes** (`cli_config_load.py:292`). | **[forrás]** | Lásd H-9. |
| H-2 | `agent.disabled_toolsets` | Toolset globális eltávolítása minden platformon, a per-platform beállítás **után** alkalmazva. | **[forrás]** | — |
| H-3 | `plugins.enabled` allowlist | Harmadik féltől származó plugin csak ennek alapján tölt be; managed pinnel a user nem kapcsolhat be saját plugint. | **[forrás][élő]** | A bundled platform-, backend-, memória- és provider-pluginok megkerülik (beépítettek). |
| H-4 | **Shell hook** `hooks.pre_tool_call` + `fail_closed: true` + `hooks_auto_accept: true` | Külön processzként futó policy-bináris; hibánál, timeoutnál blokkol; a payload tartalmazza a `profile`-t (melyik Bot), a toolt, az argumentumokat. Managed scope-ból pinelhető. | Processz-izolált. **[forrás][élő]** | `--safe-mode` (H-9). |
| H-5 | **Plugin hook** `pre_tool_call` | `block` / `approve` (emberi jóváhagyás) / `modify`; a `block` mindig nyer; **timeoutnál vagy kivételnél fail-closed**. | **[forrás]** | `--safe-mode`. |
| H-6 | **Prompt-hookok** `pre_llm_call` (a user eredeti szövege), `post_llm_call`, `pre/post_api_request` (a ténylegesen elküldött kérés), `pre/post_auxiliary_call`, `on_session_*`, `subagent_*`, `post_tool_call` | Teljes kliensoldali prompt- és válasz-audit. | Observer. **[forrás]** | Plugin nélkül (safe-mode) nincs. |
| H-7 | **Middleware** `llm_request` / `llm_execution` / `tool_request` / `tool_execution` | A kimenő kérés (`messages`) átírható (kitakarás), az LLM-hívás lecserélhető szintetikus válaszra. | **Kivételnél fail-open.** **[forrás]** | Upstream rés U4. |
| H-8 | **Terminál-backend plugin** | A `terminal`, az `execute_code` **és a fájl-toolok** saját backendre (céges sandbox) mennek. **Ismeretlen backend esetén elutasít, nem lokálisra esik vissza** (`terminal_tool_backends.py:360`). | Fail-closed. **[forrás]** | — |
| H-9 | `--safe-mode` | Kikapcsolja a pluginokat, a shell hookokat és az MCP-t. | — | **A Guard eltűnik**; a managed pinek maradnak, a céges MCP eltűnik. Upstream rés U2. |
| H-10 | Custom provider `providers.<id>`: `api`, `key_cmd`, `extra_headers`, `session_affinity_header` | Céges LLM-proxy natív bekötése; a `key_cmd` rövid életű tokent kér; a header viszi az agent- és session-azonosítót. | **[forrás]** | A user további providert vehet fel (dict-merge). |
| H-11 | `/model … --provider x` (session-only) | Session szintű provider-váltás. | — | **[POC K4]** |
| H-12 | Skillek: `write_approval`, `guard_agent_created` | Az agent skill-írása jóváhagyáshoz köthető. | **Nincs skill-allowlist.** | A `/skill` slash parancs tool-hívás nélkül injektál. U5. |
| H-13 | Memory provider plugin | A lokális memória Excellence-memóriára cserélhető. | **[forrás]** | — |
| H-14 | Böngésző-provider plugin | A böngésző felhős (céges) backendre irányítható. | **[forrás, doksi]** | **[POC]** |
| H-15 | `approvals` (manual/smart), hardline blocklist, `approvals.deny` | Lokális guardrail helyi terminálhoz, ha a policy engedi. A doksi szerint „nem sandbox”. | Gyenge. | Csak kiegészítés. |

---

## 7. Kimenő tartalomszűrés

A Codex és Claude előfizetéses használatánál a kliens közvetlenül a gyártó szerverével beszél a gyártó saját hitelesítésével, így a kimenő promptot nem lehet olvasni vagy szűrni. Itt a modellhívás a **mi végpontunkon** megy át (rögzített provider és `base_url`; a céges kulcs csak a gateway-en van), ezért a szűrés megvalósítható.

| Hol | Mit lát | Mit tud tenni | Erősség |
|---|---|---|---|
| **Model Gateway** | A teljes kérést: system prompt, user prompt, skill-injekció, MCP- és tool-eredmények, tömörítés-összefoglaló, képek | Engedi, blokkolja, kitakarja vagy tokenizálja (PAN, IBAN, személyes adat, titkok, ügyféladat), és a válaszban visszaállítja; érzékeny tartalmat belső modellre irányít | **Kemény** |
| **Guard (`llm_request` middleware)** | A kimenő kérést még a gépen | Helyben kitakar, figyelmeztet; a `llm_execution` szintetikus elutasítást adhat | Puha (fail-open) |

A szűrési szabály **paraméter** (§5.2): kategóriánként és felhasználóra, agentre szabható.

### 7.1 Legacy örökség: a szűrőt nem kell újraírni

A legacy platform Model Gateway-ében már működött egy kétlépcsős tartalomszűrő (AI Privacy Gateway, #272 / #320). A logika átvehető, mert a helye ugyanaz: **a modellhívás előtt, a szerveren, LLM nélkül, determinisztikusan**. Az agent vagy a prompt nem írhatja felül.

**A legacy pipeline** (`legacy/domain/gateway/model-gateway.ts`, a modellhívás előtti szakasz):

| Lépés | Mit csinál | Legacy kód |
|---|---|---|
| 1. Üzemmód feloldása | Két külön réteg, mindkettő `off / observe / enforce`, tenant → agent felülírással. Privacy alapból `observe`, sensitivity alapból `enforce`. | `domain/privacy/privacy-mode.ts`, `domain/gateway/sensitivity-mode.ts` |
| 2. **Tokenizálás** (az osztályozás előtt) | A `tokenize` akciójú kategóriák értékei álnevet kapnak (pl. `[PERSON_3]`). Az álnév tenanton és hatókörön (beszélgetésen) belül **bijektív és stabil**, a vaultban titkosítva tárolva. Ismert entitásnevek a forrásrendszer-katalógusból (pl. CRM ügyfélnevek), magyar toldalék-kezeléssel. A `user`, `assistant` és **`tool`** üzeneteket is átnézi; a cache-elt system prefixet nem módosítja. | `domain/privacy/prompt-privacy-transform.ts`, `surrogate-engine.ts`, `known-value-*`, `privacy-catalog-sync*.ts` |
| 3. **Osztályozás** a maradékon | `clean` / `sensitive` / `forbidden`, regex-alapú minták: PAN (Luhn-ellenőrzéssel), IBAN, magyar bankszámla, TAJ, adószám, privát kulcs, jelszó vagy API-kulcs (a példaértékeket kiszűri), e-mail, telefon. | `domain/gateway/sensitivity-router.ts`, `sensitivity-match-spans.ts` |
| 4. Döntés | `forbidden` → blokk + `model.call.denied` audit (+ ember elé kerül); `sensitive` → helyi vagy privát modellre kényszerítve, ha nincs ilyen, fail-closed blokk; `observe` módban csak audit. | `model-gateway.ts` (`enforceForbiddenSensitivityPolicy`) |
| 5. Kategória-policy | Kategóriánként `allow / tokenize / local_only / block`. Kemény invariánsok: titkos kulcs csak `block`; PAN/IBAN `allow` csak gépelt megerősítéssel és auditálva. | `app/src/domain/privacy/privacy-category-policy.ts` |
| 6. Visszaállítás | A válaszban (streamelve is) és a modell tool-hívásainak argumentumaiban az álnevek visszacserélődnek valódi értékre. | `streaming-surrogate-resolver.ts`, `resolve-tool-args.ts`, `resolve-display-text.ts` |
| 7. Ellenőrzés | Dry-run, observe-módú kiemelés a UI-ban, privacy-eval harness fixture-ökkel és red-line tesztekkel. | `privacy-dry-run.ts`, `lib/privacy-eval*.ts` |

**Ami már az új `app/`-ban van:** a kategória-policy, az üzemmódok, a mintakeresés (`sensitivity-match-spans.ts`, Luhn-nal), a known-value matcher, az álnév-formátum és a vault-típusok, az egress-mátrix és a privacy-audit (`app/src/domain/privacy/`). **Ami még csak a legacyban van:** a prompt-transzformáció, az osztályozó és döntés, a surrogate engine és vault-kriptó, a streamelt visszaállítás, a dry-run és az eval harness.

**Mi változik a Hermes-környezetben:**

| Téma | Legacy | Új (Model Gateway a Hermes előtt) |
|---|---|---|
| Bemenet | Belső üzenetformátum | OpenAI chat-completions / Responses (és Anthropic) kérés, tool-definíciókkal, tool-hívásokkal, multimodális részekkel → adapter kell |
| Hatókör (scope) | `conversationId` / `ticketId` | Hermes session (`session_affinity_header`) + tenant + user |
| Visszaállítás | A platform UI-jának és a platform toolainak | **A Hermesnek visszaadott válaszban** (szöveg és tool-argumentum). Így a helyi és az MCP toolok valódi értéket kapnak, a következő kérésben pedig ugyanaz az álnév tér vissza, mert bijektív. Ez megoldja a prompt-cache stabilitását is (lásd alább, 3. pont). |
| Cache-határ | A platform saját system prefixe érintetlen | A Hermes system promptja memóriát, skilleket és context-fájlokat is tartalmazhat, ezért el kell dönteni, mi számít stabil prefixnek (**K10**) |
| `local_only` / `sensitive` | Ollama-sidecar (élesben nem volt) | Privát vagy EU-s provider a Model Gateway mögött, vagy blokk |
| Blokk-jelzés | Hibaüzenet a platform UI-ban | Szintetikus asszisztens-üzenet a Hermesnek (lásd alább, 1. pont) |
| „Ember elé kerül” | Ticket | Admin-értesítés + audit-esemény (a HITL-forma nyitott) |
| Hatókör-szintek | tenant → agent | A §5 policy-modell: + szerep/felhasználó dimenzió |

**Átvehető tanulságok** (a legacy kódkommentekben és a code-review-kban rögzítve): a tool-üzenetek határán ne keletkezzen hamis PAN-találat; a dokumentációs példa-API-kulcs ne blokkoljon; a telefonszám csak tokenizálódjon, ne emelje `sensitive`-re a beszélgetést; a debug-trace se szivárogtasson PII-t (PR #319); a PAN/IBAN egress legyen auditált (PR #342). A legacy eval-fixture-ök regressziós tesztként átvehetők.

### 7.2 POC-ban mérendő

1. **A blokkolás jelzése.** Egy 4xx-es hiba újrapróbálkozást, tartalék modellre váltást vagy tömörítést válthat ki. Valószínűleg jobb egy 200-as válasz szintetikus asszisztens-üzenettel (a legacy `formatSensitivityBlockMessage` szövegéből kiindulva, hétköznapi nyelven).
2. **Inkrementális szűrés.** A teljes előzmény minden kérésben újra megy; elég az új részeket szűrni, a már tokenizált részeket a vaultból újrahasználni.
3. **Stabil tokenizálás.** A legacy surrogate engine bijektív hatókörön belül, így a Hermes sessionhöz kötve a prompt-cache stabil marad. Ezt mérni kell.
4. **Streamelt válasz** visszaállítása (a legacy streaming resolver portja).
5. **Mellékhívások (K3)** is a gateway-en menjenek (`auxiliary.*: main`).

---

## 8. Célarchitektúra

```
                         ┌──────────────── Excellence Control Plane ────────────────┐
                         │  Policy-modell (§5): tenant/szerep/user × agent × tool    │
 Hermes Desktop/CLI      │                                                           │
 (vanilla upstream)      │  MCP Gateway (meglévő)       authorizeToolCall()          │
   │                     │    └─ sandbox_run (#485) ─► céges sandbox                 │
   │  /etc/hermes        │  Model Gateway (ÚJ, állapotmentes)                        │
   │  = gép-padló (MDM)  │    modell-policy · tartalomszűrés · prompt-audit          │
   │                     │  AI Interaction Audit (ÚJ)   turn-rekord, korreláció      │
   │                     │  Client Policy (ÚJ)          policy-snapshot, heartbeat   │
   │                     └──────▲───────────────▲──────────────▲───────────────────┘
   │                            │ MCP OAuth     │ LLM-hívások  │ snapshot, audit,
   │  Excellence Guard ─────────┘               │ (key_cmd)    │ heartbeat
   │   • user × agent policy, fail-closed       │              │
   │   • turn-rekord, lokális tool-audit ───────┼──────────────┘
   │   • terminál/böngésző backend-ellenőrzés   │
   └──────────── minden LLM-hívás ──────────────┘
```

| Réteg | Mi | Kemény vagy puha |
|---|---|---|
| **Szerver** | Model Gateway, MCP Gateway, Sandbox, Audit, Client Policy | **Kemény.** Itt vannak a credentialök. |
| **Gép-padló** | `/etc/hermes`, MDM-mel terítve | T2-ig kemény, T3-nál puha |
| **Guard** | Dinamikus policy, kliensoldali audit, eltérés-észlelés | Defense-in-depth + észlelés |

**Kliens-állapotok a szerver szemében:**

| Állapot | Mikor | Policy |
|---|---|---|
| **Managed** | Hermes + gép-padló + Guard, érvényes heartbeat | A §5 szerinti effektív policy |
| **Open** | Nem menedzselt kliens, hiányzó vagy lejárt heartbeat, safe-mode | Csak olvasó / alacsony kockázatú toolok; **nincs céges modell** |

---

## 9. Követelmény → megoldás

### R0 – Paraméterezhetőség
A policy-modell (§5) a Control Plane-ben él. A Guard session-indításkor lekéri az adott user és Bot effektív policy-snapshotját (plusz TTL, visszavonáskor push vagy rövid TTL). Az MDM a user legbővebb engedélye alapján generálja a gép-padlót. A szerveroldali részt (modell, szűrés, audit, vállalati tool) a gateway-ek maguk érvényesítik.

### R1 – Audit
- **Model Gateway (elsődleges):** a modellnek ténylegesen elküldött teljes kérés és a válasz; `session_affinity_header` és `extra_headers` → session-, Bot- és agent-korreláció.
- **Guard:** `pre_llm_call` (a user eredeti szövege), `post_llm_call` (végső válasz), `post_tool_call` (**lokális** toolok, amelyeket az MCP Gateway nem lát).
- **MCP Gateway:** vállalati tool-hívások (meglévő).
- **Rekord:** `tenant, user, agentId, hermesProfile, sessionId, turnId, userPrompt(ref), modelCalls[], toolCalls[] (local|mcp), finalAnswer(ref), policyVersion, policyDecisions[]`. A mélységet a policy adja. Ha a Model Gateway-ben van hívás, de a Guardtól nem jött turn-rekord, az eltérés-jel (R8).

### R2 – Toolok
A Guard `pre_tool_call` (plugin, plusz fail-closed shell-hook tartalék) az effektív policy szerint enged, jóváhagyást kér (`approve`) vagy blokkol, hétköznapi nyelvű üzenettel. Az ismeretlen MCP-szerver toolja itt bukik el, ha a policy nem engedi (ez fedi az U1 hiányt). A gép-padló csak azt tiltja le toolset-szinten, ami a usernél sehol sem engedett. Az MCP Gateway változatlanul a végső döntő.

### R3 – Skillek
„Csak jóváhagyott” szinten az Agent Sync (#682) csak jóváhagyott skilleket materializál (`name → sha256` manifest), a Guard a `skill_view`/`skill_manage` hívást manifest szerint kapuzza, új skill pedig `platform.skills.submit`-tal megy jóváhagyásra. A „+ saját” szinten a saját skill engedett, de a Guard naplózza. A `/skill` slash-injekció tool-hívás nélkül történik: a Guard session-indításkor összeveti a skill-könyvtárat a manifesttel, a Model Gateway pedig észleli (U5-ig maradék kockázat).

### R4 – Kódfuttatás

| Szint | Megoldás |
|---|---|
| Tiltott | `terminal` és `code_execution` a gép-padlóban vagy a Guard-policyban tiltva; kód csak MCP `sandbox_run`-nal |
| Csak sandboxban | `excellence-sandbox` terminál-backend plugin; a Bot profiljában `terminal.backend: excellence-sandbox`; a Guard ellenőrzi, hogy a session backendje megfelel-e a policynak, ha nem, blokkol. Ha a plugin nem tölt be, a Hermes elutasít, nem lokálisra esik vissza. |
| Helyben, jóváhagyással | Lokális backend, a Guard minden terminál-hívásnál `approve`-ot ad vissza (vagy kockázat alapján), `approvals.mode: manual` |
| Helyben, szabadon | Lokális backend; a Guard csak naplóz, a hardline blocklist és az `approvals.deny` marad |

### R5 – Céges modell-út (alapréteg)
Gép-padló pinek, **levelenként** (H-1b):
```yaml
model:    { provider: excellence, base_url: https://<host>/api/model-gateway/v1, api_mode: chat_completions }
providers:
  excellence:
    api: https://<host>/api/model-gateway/v1
    key_cmd: /opt/excellence/bin/exc-token model   # rövid életű, user+device kötött token
    session_affinity_header: X-Excellence-Session
auxiliary: { compression: {provider: main}, vision: {provider: main}, title_generation: {provider: main} }  # minden aux task
fallback_providers: []
```
- A managed `.env` az ismert provider-kulcsokat (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) üresre pineli.
- A Guard `llm_execution` szintetikus elutasítást ad, ha a hívás nem az Excellence providerre menne.
- A modellt a Model Gateway választja az agent `modelConfig`-ja alapján (D12, D16). Az agent-azonosítót **a tokenből** veszi (D1), nem a user által átírható headerből. Tartalék-váltás csak a gateway-ben történik (a Hermes `fallback_providers: []` pinelve), így az is auditált és szűrt.
- Saját ChatGPT/Codex előfizetés menedzselt módban nem használható, mert kikerül az auditból (D2).
- MDM egress-szabály: LLM-API forgalom csak a Model Gateway felé (T2/T3).

### R6 – Tartalomszűrés
Lásd §7.

### R7 – Lokális adat
Memória a policy szerint: tiltott (`disabled_toolsets: [memory]`), Excellence-memória (memory provider plugin) vagy lokális. A session-DB lokális, a retenciót a Guard kezeli (D5), offboardingkor a profil törlődik. `security.redact_secrets: true` a gép-padlóban.

### R8 – Eltérés-észlelés
A Guard heartbeatet küld: az effektív konfig hash-ét, a managed dir hash-ét, a policy-verziót, a Guard- és Hermes-verziót. A gateway-ek `X-Excellence-Client` headert várnak (rövid életű, heartbeathez kötött); ha hiányzik vagy lejárt, a kliens Open policyt kap. Jelek: modellhívás turn-rekord nélkül, eltérő konfig-hash, elmaradt heartbeat → riasztás, opcionálisan token-visszavonás.

---

## 10. Megkerülés-elemzés

| # | Megkerülés | Hatás | Mitigáció | Maradék |
|---|---|---|---|---|
| B1 | `hermes --safe-mode` | Nincs Guard | A gép-padló él; az MCP kikapcsol; a sandbox-backend ismeretlen, tehát a terminál elutasít; nincs heartbeat → Open | Beszélgetés Guard nélkül, **de a Model Gateway auditál és szűr**. U2 |
| B2 | `/model x --provider openrouter` | Audit nélküli modell | Üres kulcsok a managed `.env`-ben, Guard `llm_execution`, egress | **[POC K4]** |
| B3 | Saját MCP-szerver (dict-merge) | Nem engedett tool | Guard allowlist | A stdio processz elindul (user-kód, nem AI-akció). U1 |
| B4 | Saját skill, `/skill` injekció | Nem engedett instrukció | Manifest, Model Gateway-észlelés | U5 |
| B5 | Admin user törli az `/etc/hermes`-t | Elveszik a gép-padló | MDM drift-riasztás, heartbeat → Open | T3 |
| B6 | Másik kliens saját kulccsal | Teljesen kívül | Céges modell, tool, adat nem érhető el | HR-policy, egress |
| B7 | Mellékhívás más providerre | Prompt-szivárgás | `auxiliary.*: main` | **[POC K3]** |
| B8 | Subagent tool-hívásai | Guard-kerülés? | `pre_tool_call` subagentben is (**[POC K2]**); `delegation` a policy szerint | — |
| B9 | A Bot profiljának kézi átírása (pl. `terminal.backend: local`) | Tiltott szint | A Guard a session backendjét a policyval veti össze, és blokkol | **[POC K9]** |
| B10 | Guard-kivétel a middleware-ben | Fail-open | A blokkolás a fail-closed `pre_tool_call`-ban van, a szűrés a gateway-en | U4 |

---

## 11. Upstream rések (fork-trigger jelöltek)

Döntési szabály: **fork csak akkor, ha egy konkrét, tesztelhető követelményt a publikus plugin, hook és managed scope, plusz OS/MDM nem tud teljesíteni, és az upstream PR-t elutasították.**

| ID | Rés | Javasolt upstream változtatás | Nélküle |
|---|---|---|---|
| **U1** | Nincs managed MCP-szerver allowlist | `mcp.allowed_servers` (managed pinelhető) | Guard tool-szinten |
| **U2** | A `--safe-mode` kikapcsolja a managed pluginokat és hookokat | `security.safe_mode: deny`, vagy a managed-ből pinelt pluginok és hookok maradjanak | Model Gateway + Open mód |
| **U3** | Natív macOS/Windows managed location, MDM-profil | `get_managed_dir()` seam (előkészítve) | `/etc/hermes` macOS-en működik (kimérve); Windows **[POC]** |
| **U4** | A middleware fail-open | `fail_closed` az `llm_execution`-re | `pre_tool_call` + gateway |
| **U5** | Nincs skill-allowlist vagy aláírás | `skills.allowed` vagy aláírt bundle | Manifest + észlelés |

---

## 12. POC terv (fork nélkül, kb. 1,5–2 hét)

**Környezet:** 1 menedzselt Mac (a user nem admin, `/etc/hermes` root-tulajdonban), vanilla Hermes v0.21.x Desktop, staging Excellence, **két eltérő policy**: az A user „Szabad (fejlesztő)”, a B user „Kötött pálya”; mindkettőnél 2 Bot (#682).

| Lépés | Tartalom | Elfogadás |
|---|---|---|
| **P1** | Gép-padló generálása a user legbővebb engedélyéből | `hermes config` mutatja a managed kulcsokat; `config set` megtagadja; a Desktop ugyanazt használja (**K1**) |
| **P2** | Minimális Model Gateway (legacy `chat/completions` karcsúsított port) + nyers napló + a legacy szűrő két lépése (§7.1): osztályozó (PAN → blokk) és tokenizálás visszaállítással (e-mail, személynév) | Minden hívás a naplóban (**K3**); a PAN-t tartalmazó prompt nem jut el a modellig, a user érthető üzenetet kap; a tokenizált e-mail a modellnél álnév, a Hermesben valódi érték, és ugyanaz az álnév tér vissza a következő kérésben (§7.2) |
| **P3** | Guard v0: policy-snapshot lekérése, `pre_tool_call` user × agent szerint, `pre/post_llm_call`, `post_tool_call` → audit | Ugyanazon a gépen: az A user fejlesztő Botja helyben futtat terminált, a B user számlázási Botja ugyanazt nem tudja; mindkettő auditált turn-rekorddal |
| **P4** | Policy-változtatás élesben: az admin a B usernek engedi a sandboxos kódfuttatást | Legkésőbb a következő sessionben érvényes; visszavonás a következő hívásnál |
| **P5** | Shell-hook tartalék (`exc-guard`, `fail_closed`) | A bináris törlése vagy timeoutja után blokkol |
| **P6** | Sandbox-irány: (a) `sandbox_run` MCP-n át; (b) `excellence-sandbox` terminál-backend spike | (b) a `terminal`, `execute_code` és fájl-toolok a sandboxban futnak (**K5**); a profil kézi átírását a Guard észleli (**K9**) |
| **P7** | Megkerülési tesztek B1–B10 | Mindegyiknél blokk vagy észlelt eltérés (**K2, K4, K6**) |
| **P8** | Heartbeat + `X-Excellence-Client` → Managed/Open | Safe-mode-ban a Model Gateway Open policyt ad |
| **P9** | Hermes-frissítés próba | Nulla patch, regressziós teszt zöld |

### Élőben mérendő kérdések

| K | Kérdés |
|---|---|
| K1 | A Desktop (Electron + serve backend) tiszteli-e az `/etc/hermes`-t és a shell hookot? |
| K2 | Lefut-e a `pre_tool_call` MCP-toolokra és a `delegate_task` gyerek-agent hívásaira? |
| K3 | Minden auxiliary task a `main` providerre megy-e a pin után? |
| K4 | A `/model --provider` session-váltás tiszteli-e a managed pint? |
| K5 | Plugin-backend esetén a fájl-toolok is a sandboxban futnak-e? |
| K6 | Látszik-e a `/skill` slash-injekció a Model Gateway kérésben? |
| K7 | `key_cmd` token-lejárat és frissítés hosszú sessionben. |
| K8 | Windows: managed dir és shell hook (natív és WSL). |
| K9 | Le tudja-e kérdezni a Guard a session tényleges terminál-backendjét és effektív konfigját (profilonként)? |
| K10 | Mi a Hermes system promptjának stabil (cache-elt) része, és mit kell mégis tokenizálni benne (memória, context-fájlok)? |
| K11 | A `key_cmd` helper a kiszolgált Bot-profil `HERMES_HOME`-jával fut-e (Desktop multiplex módban is), és eléri-e a profil `mcp-tokens/` tokenjét? **[forrás]:** igen (`tools/environments/local.py` `served_profile_child_env`, `mcp_oauth.py` `HERMES_HOME/mcp-tokens/`), a `key_cmd` kérésenként fut (`runtime_provider_custom.py:567`) → a helpernek cache-elnie kell. Élőben mérendő. |

**V1-8 mérési eredmény (2026-10-03).** A generátor és a telepítő kész; élő Hermes (CLI és Desktop) ezen a gépen nem futott, ezért K1/K3/K4 forgalmi fele nyitva marad.

| K | Eredmény |
|---|---|
| **K1** | A 2026-09-30-as CLI-mérés áll: a `hermes config` listázza a managed kulcsokat, a `config set` megtagadja, és a `model.base_url`-t külön kell pinelni. A generátor ezt a három modell-levelet, plusz a `plugins.enabled`, `hooks.pre_tool_call`, `hooks_auto_accept`, `agent.disabled_toolsets` kulcsokat kiírja. A Desktop élőben nem újramérve. A shell-hook doksi (Hermes, 2026-10) szerint a hook CLI-n, gatewayen, Desktopon, TUI-n és dashboardon is regisztrál, amikor az agent felépül. |
| **K3** | Generátor: minden ismert aux task `provider: main`, üres `base_url` / `api_key` / `model`, üres `fallback_chain`, és a top-level `fallback_providers: []`. Az aux hívások gateway-naplója élő Hermes nélkül nem mérhető. |
| **K4** | Generátor: az ismert provider-kulcsok a managed `.env`-ben üresek, a modell-út levelenként pinelt. Élő `/model --provider openrouter` nem futott. |

---

## 13. Excellence oldali munkacsomagok

| WP | Tartalom | Függés |
|---|---|---|
| **WP-A Model Gateway** | Állapotmentes, OpenAI- (és opcionálisan Anthropic-) kompatibilis LLM-proxy; rövid életű user+device token; `X-Excellence-Agent-Id` → ExecutionProfile; költségkeret; streaming; a céges modell-kulcsok csak itt. **G1:** az `app/`-ban ma nincs LLM-hívás és modell-réteg, de a legacyban teljes réteg van, ezt portoljuk (D11, D12, D16). A legacy `chat/completions` route **nem** alap, mert a `tool` üzeneteket szöveggé lapítja, és agent API-kulccsal hitelesít; a Hermeshez natív `tools`/`tool_calls` átengedés kell. Átvehető a provider-réteg (`OpenAiCompatibleProvider` streaming, `createDefaultProviders`) és a tartalék-lánc logikája. | — |
| **WP-B Tartalomszűrés** | A legacy AI Privacy Gateway portja (§7.1): prompt-transzformáció, osztályozó és döntés, surrogate engine + vault, streamelt visszaállítás, dry-run, eval harness. Az új `app/src/domain/privacy/` policy-modelljére épül; OpenAI/Anthropic kérés-adapter; blokk-válasz formátuma. | WP-A |
| **WP-C Policy-modell** | Képességek és szintek (§5.2), presetek, hatókörök (tenant/szerep/user × agent × tool), feloldás, verziózás, policy-snapshot API. | — |
| **WP-D AI Interaction Audit** | Turn-rekord séma, ingest (Guard + Model Gateway + MCP Gateway), korreláció, retenció, hozzáférés. | WP-A |
| **WP-E Excellence Guard** | Python plugin (hookok, middleware, snapshot, heartbeat) + shell-hook tartalék bináris; külön csomag, pinelt Hermes-kompatibilitási teszt. | WP-C, #682 |
| **WP-F Sandbox- és böngésző-backend** | `excellence-sandbox` terminál-backend (#485); később céges felhős böngésző-provider. | #485 |
| **WP-G Gép-padló és terítés** | Policy → `/etc/hermes` generátor (a user legbővebb engedélye alapján), MDM-csomag (Jamf/Intune), drift-ellenőrzés. | WP-C |
| **WP-H Client Policy** | Heartbeat-regiszter, `X-Excellence-Client` token, Managed/Open a gateway-eken. | WP-A, WP-E |
| **WP-I Admin UI** | Policy-szerkesztő presetekkel („Kötött pálya / Standard / Szabad” + felülírások), „AI-használati napló”. Hétköznapi nyelven, üres állapottal, előnézettel („ezt a munkatárs ezzel az agenttel meg tudja / nem tudja tenni”). | WP-C, WP-D |

---

## 14. Adatvédelem, munkajog

A promptok naplózása munkavállalói adatkezelés. Kell hozzá: jogalap és előzetes tájékoztatás (a kliens jelzi: „Ez a munkatárs céges módban fut, a beszélgetéseid naplózásra kerülnek”), céltól függő retenció, szűk hozzáférés (audit-szerep, négy szem elve), érzékeny adatnál tokenizálás. Az audit-mélység paraméter (§5.2), ez az arányosságot is szolgálja. A DPIA a WP-D előfeltétele.

---

## 15. Döntések (lezárva 2026-09-30)

| D | Kérdés | Döntés |
|---|---|---|
| D1 | A Model Gateway hitelesítése | A `key_cmd` = `exc-token` helper. A kiszolgált Bot-profil `$HERMES_HOME/mcp-tokens/<excellence>.json` MCP OAuth access tokenjét és a profil `config.yaml`-jában lévő `X-Excellence-Agent-Id`-t `POST /api/model-gateway/token`-nel cseréli egy **10 perces gateway-JWT**-re (`sub`=user, `tenant`, `agentId`, `installId`, `policyVersion`). A szerver ellenőrzi, hogy a user eléri-e az agentet. A helper a tokent `exp−60s`-ig cache-eli, mert a `key_cmd` kérésenként fut (K11). v1-ben az eszközkötés csak az `installId` (Guard-telepítés azonosítója) heartbeat-korrelációja, kriptográfiai device-kulcs nincs. |
| D2 | Saját ChatGPT/Codex előfizetés menedzselt módban | **Nem.** Kikerülne az auditból és a szűrésből. |
| D3 | Felülírhatja-e a specifikusabb szint a tágabb tiltását? | **Igen**, felhasználói szinten explicit, auditált kivétellel. Az agent-plafont semmi nem lépi túl, azonos szinten a tiltás nyer. |
| D4 | Elérhetetlen Control Plane esetén a Guard | Az utolsó érvényes snapshot **1 óráig**, utána „Kötött pálya”. (A Model Gateway ugyanabban a deploymentben fut, így kiesésnél a modell sem érhető el.) |
| D5 | Prompt-tartalom tárolása | Titkosított tartalom (meglévő `app/src/domain/privacy/aes-gcm-envelope.ts`), az audit-rekordban hivatkozással. Szerveroldali tartalom-retenció alapból 90 nap (konfig); a lokális session-DB-t v1-ben a Guard nem törli. **A DPIA után véglegesítendő.** |
| D6 | Audit-mélység „metaadat” alá? | **Nem**, a metaadat-szint az alapréteg része. |
| D7 | Upstream PR-ok (U1, U2) | A POC-mérések után, mérési eredménnyel. |
| D8 | Első fejlesztési szelet | **POC-szelet, élesíthető kóddal** (§17). A többi WP külön issue-kba kerül. |
| D9 | Terítés | **Nincs MDM.** v1-ben kézi `sudo` telepítő (`install-managed.sh`), amely a policyból generált `/etc/hermes`-t root 0644-gyel teszi fel. T2 csak részben teljesül (egy admin user eltávolíthatja); a kemény garancia a szerveroldal (Model Gateway, Open mód). |
| D10 | Szerep/csoport réteg v1-ben | **Nincs.** Feloldás: tenant alap → user (preset + felülírás) ∩ agent-plafon ∩ tool-felülírás. |
| D11 | Model Gateway helye és formátuma | Route az `app/`-ban: `/api/model-gateway/v1/chat/completions`, OpenAI `chat_completions` streaminggel, natív tool-hívás átengedéssel. Provider-regiszter a legacyból portolva, v1-ben az OpenAI-kompatibilis providerekkel (OpenRouter, Ollama); a kulcs env/Secret Manager (`OPENROUTER_API_KEY`, mint a legacyban). Gemini és a szerveroldali OAuth-providerek (ChatGPT, Claude Code, Grok), valamint a Responses/Anthropic formátum v2-ben. |
| D12 | Modellválasztás | **Agent-alapérték, a user válthat.** A gateway az agent `modelConfig.model`-jét használja. Ha a Hermes (`/model`) mást kér, csak akkor fogadja el, ha az a user effektív policyja szerint engedett modell-listán van (tenant `model.policy` ∩ preset/felülírás). Egyébként az agent modelljére esik vissza, és a helyettesítést naplózza. |
| D16 | Legacy modell-réteg a v1-ben | **Agent-modell + tartalék portolva:** `Agent.modelConfig` (provider, model, modelType, temperature, maxTokens, `fallbackModels[]`) az `app/` Agent tábláján (az MCP-snapshotba nem kerül be); tenant engedett modell-lista (`model.policy`); tartalék-lánc: agent `fallbackModels` → globális `model.fallback`, hiba-osztály szerinti váltással, streamnél csak az első token előtt. A meglévő admin űrlapok portolva (`update-model-config-form.tsx`, `model-policy-panel.tsx`, tartalék-lánc előnézettel). Napi költségkeret, ár-szinkron és `ModelCall` költség-rekord követő issue. |
| D13 | Guard kódhelye és csomagolása | Monorepo: `clients/hermes-guard/` Python plugin + `exc-guard` shell-hook + `exc-token` helper. A telepítő (D9) teríti. Pinelt Hermes-verzió, kompatibilitási teszttel. |
| D14 | Snapshot és heartbeat szállítása | REST: `GET /api/client-policy/snapshot`, `POST /api/client-policy/heartbeat`, ugyanazzal a gateway-JWT-vel, mint a modellhívás. Nem MCP-tool, mert a Guard nem LLM. |
| D15 | A blokkolás jelzése a Hermesnek | HTTP 200, szintetikus asszisztens-üzenet hétköznapi nyelven (a legacy `formatSensitivityBlockMessage` alapján). 4xx nem, mert újrapróbálkozást vagy fallbacket vált ki (§7.2/1). |

**Nem fejlesztési, de éles bekapcsolás előfeltétele:** DPIA + munkavállalói tájékoztatás (§14). A staging POC belső, tájékoztatott userekkel ezek nélkül is futhat.

---

## 16. Források

**Hermes (helyi forrás, `~/.hermes/hermes-agent` @ `d0288be5`):**
- `website/docs/user-guide/managed-scope.md`, `hermes_cli/managed_scope.py`, `hermes_cli/cli_config_load.py:259-297`
- `website/docs/user-guide/features/hooks.md`: plugin-hook katalógus, `pre_tool_call` fail-closed, shell hookok, consent-modell
- `website/docs/developer-guide/middleware.md`: `llm_request`/`llm_execution`, fail-open
- `website/docs/developer-guide/terminal-environment-plugin.md`, `tools/terminal_tool_backends.py:360`
- `website/docs/developer-guide/browser-provider-plugin.md`, `memory-provider-plugin.md`
- `website/docs/user-guide/configuration.md`: `agent.disabled_toolsets`, `skills.*`, `auxiliary.*`
- `website/docs/user-guide/features/plugins.md`: `plugins.enabled` és ami megkerüli
- `website/docs/integrations/providers.md`: `providers:` (`key_cmd`, `extra_headers`, `session_affinity_header`)
- `website/docs/reference/cli-commands.md`, `environment-variables.md`: `--safe-mode`
- `tools/mcp_tool_discovery.py:552` (nincs admin MCP-allowlist)
- `website/docs/guides/secure-hermes-on-a-work-machine.md`

**Élő mérés (2026-09-30, macOS, v0.21.5):** `HERMES_MANAGED_DIR` + pinelt `agent.disabled_toolsets`, `plugins.enabled`, `hooks.pre_tool_call`, `hooks_auto_accept`, `model.provider`. A `hermes config` mind az ötöt managed kulcsként listázta; a `model.base_url` user-értéke megmaradt (H-1b).

**V1-8 generátor (2026-10-03):** a kiadott `config.yaml` a H-1b leveleket külön pineli (`model.provider`, `model.base_url`, `model.api_mode`), és ugyanezt megteszi minden aux tasknál (`provider`, `model`, `base_url`, `api_key`, `fallback_chain`). A plugin betöltési útvonala forrásból mérve: `$HERMES_HOME/plugins/<név>/` (Desktop-profil: `~/.hermes/profiles/<profil>/plugins/`). Élő `hermes config` ezen a napon nem futott, a build gépen nincs Hermes.

**Excellence:** `docs/hermes-integration-foundation-2026-09-26.html`; `legacy/app/api/v1/gateway/v1/chat/completions/route.ts`; #682 / PR #683, #734; #485 sandbox; #272 / #320 APG.

**Legacy tartalomszűrő:** `legacy/domain/gateway/model-gateway.ts` (üzemmód → transzformáció → osztályozás → döntés), `legacy/domain/gateway/sensitivity-router.ts`, `sensitivity-mode.ts`, `legacy/domain/privacy/prompt-privacy-transform.ts`, `surrogate-engine.ts`, `streaming-surrogate-resolver.ts`, `resolve-tool-args.ts`, `privacy-dry-run.ts`, `legacy/lib/privacy-eval*.ts`; már portolva: `app/src/domain/privacy/` (kategória-policy, üzemmód, mintakeresés, vault-típusok, egress-mátrix).

---

## 17. v1 fejlesztési szelet (#746 hatóköre)

**Cél:** egy menedzselt Macen két user (A = „Szabad (fejlesztő)”, B = „Kötött pálya”), mindkettőnél 2 Bottal (#682). Minden modellhívás a Model Gateway-en megy át, auditálva és szűrve. A tool-használat user × agent szerint dől el. A policy-változás élőben érvényesül. **Stagingen, élesíthető minőségű kóddal.**

### 17.1 Feladatok

| # | Feladat | Kód | Elfogadás (POC-lépés) |
|---|---|---|---|
| **V1-1** | **Policy v0** (WP-C szelet): `ClientPolicy` tábla (`tenantId`, `scope: tenant\|user\|agent`, `scopeId`, `preset`, `capabilities` JSON, `toolOverrides` JSON, `version`); 3 preset konstansként; tiszta `resolveEffectivePolicy(tenant, user, agent)` a D3/D10 szabállyal; `GET /api/client-policy/snapshot`. | `app/src/domain/client-policy/` | Unit-tesztek a feloldásra: a tiltás nyer, user-kivétel nyer a preset ellen, agent-plafon nem léphető túl. |
| **V1-2** | **Model Gateway token** (D1): `POST /api/model-gateway/token` (MCP OAuth → 10 perces JWT, user–agent hozzáférés-ellenőrzéssel); `exc-token` helper cache-sel. | `app/src/app/api/model-gateway/`, `clients/hermes-guard/` | K7, K11: egy több mint 30 perces session megszakítás nélkül fut; visszavont user a következő hívásnál elutasítást kap. |
| **V1-3** | **Model Gateway** (WP-A szelet, D11): `chat/completions` proxy streaminggel és natív tool-hívás átengedéssel; portolt provider-regiszter; modellválasztás D12 szerint; Managed/Open (V1-7); audit-esemény minden hívásra. | `app/src/app/api/model-gateway/v1/`, `app/src/domain/model-gateway/` | P2/K3: a főhívás és az összes aux hívás a naplóban. A Hermes tool-hívásai hiánytalanul oda-vissza mennek. A `/model` engedett modellre vált, nem engedettnél az agent modellje fut, naplózva. |
| **V1-3a** | **Modell-konfig port** (D16): `Agent.modelConfig` migráció + legacy értékek átvétele; `model.policy` és `model.fallback` setting; tartalék-lánc (hiba-osztály, első token előtti váltás); admin űrlapok portja. | `app/prisma/`, `app/src/domain/model-gateway/`, admin UI | Az admin agentenként beállít elsődleges + tartalék modellt. Az elsődleges provider kényszerített hibájánál a tartalék válaszol, a váltás auditálva. Unit-teszt: a lánc-feloldás és a nem váltó hiba-osztályok (keret, érzékenység, tartalom). |
| **V1-4** | **Tartalomszűrés, minimális** (WP-B szelet): PAN → blokk (meglévő `sensitivity-match-spans.ts`, Luhn) D15-ös válasszal; e-mail + személynév tokenizálás session-hatókörrel (surrogate engine port + meglévő vault-típusok), visszaállítás a streamelt válaszban és a tool-hívás argumentumaiban. | `app/src/domain/privacy/` | P2: a PAN nem jut el a modellig; az e-mail a modellnél álnév, a Hermesben valódi érték; a következő kérésben ugyanaz az álnév. A legacy PAN/e-mail eval-fixture-ök zöldek. |
| **V1-5** | **AI Interaction Audit, minimális** (WP-D szelet): `AiInteractionEvent` tábla (`tenant`, `user`, `agentId`, `installId`, `sessionId`, `turnId`, `kind: user_prompt\|model_call\|tool_call\|final`, `source: gateway\|guard`, titkosított `content`, `meta`, `policyVersion`); ingest endpoint a Guardnak. Olvasni v1-ben csak admin API-n lehet, UI nincs. | `app/src/domain/ai-audit/` | P3: mindkét user turnjei rekorddal, a lokális tool-hívások is. |
| **V1-6** | **Excellence Guard v0** (WP-E szelet): Python plugin — snapshot session-indításkor + D4 TTL; `pre_tool_call` (allow/approve/block, hétköznapi üzenet); `pre/post_llm_call`, `post_tool_call` → audit; `llm_execution` elutasítás nem-Excellence provider esetén; heartbeat. `exc-guard` shell-hook tartalék (`fail_closed`). | `clients/hermes-guard/` | P3: A fejlesztő Botja helyben terminált futtat, B számlázási Botja ugyanazt nem tudja. P4: admin-változás a következő sessionben, visszavonás a következő hívásnál. P5: a bináris törlése vagy timeoutja → blokk. K2: subagent és MCP-tool hívásokra is lefut. |
| **V1-7** | **Client Policy** (WP-H szelet): heartbeat-regiszter (`installId`, konfig-hash, managed-dir hash, Guard- és Hermes-verzió); Managed vs Open a Model Gateway-en (Open → nincs céges modell). | `app/src/domain/client-policy/` | P8: `--safe-mode` alatt a Model Gateway Open policyt ad, a user érthető üzenetet kap (B1). |
| **V1-8** | **Gép-padló generátor + telepítő** (WP-G szelet, D9): policy → `/etc/hermes/{config.yaml,.env}` (§9 R5 pinek levelenként, üres provider-kulcsok, `plugins.enabled`, `hooks`, `disabled_toolsets` a user legbővebb engedélye szerint); `install-managed.sh`. | `clients/hermes-guard/`, generátor az `app/`-ban | P1/K1: `hermes config` mutatja a managed kulcsokat, a `config set` megtagadja, a Desktop is ezt használja. K4/B2: a `/model --provider openrouter` nem visz ki a gateway-ről. |
| **V1-9** | **Minimális admin felület:** tenant-alap preset + userenkénti preset-választó + képességenkénti felülírás (select-ek), hétköznapi nyelven, üres állapottal. Előnézet és napló-UI nincs (WP-I). | `app/src/app/[locale]/…` | P4 az admin felületről végrehajtható. |

**Sorrend:** V1-1 → V1-2 → V1-3a → V1-3 → (V1-4 ∥ V1-5) → V1-7 → V1-6 → V1-8 → V1-9. A V1-6 és a V1-8 a Hermes-gépen élőben is mérendő (K1–K4, K7, K11).

### 17.2 Kívül esik (követő issue-k)

| Issue | Tartalom |
|---|---|
| #747 | Teljes kimenő tartalomszűrés: legacy APG teljes port, `local_only`, inkrementális szűrés, K10, dry-run, eval harness (WP-B) |
| #748 | `excellence-sandbox` terminál-backend (P6, K5, K9; WP-F) |
| #749 | Céges felhős böngésző-provider (WP-F) |
| #750 | Policy-szerkesztő előnézettel + „AI-használati napló” admin UI (WP-I) |
| #751 | Szerep/csoport réteg (D10) |
| #752 | Napi költségkeret, ár-szinkron, `ModelCall` költség-rekord (D16) |
| #753 | További providerek (Gemini, OAuth) és formátumok (Responses, Anthropic) (D11) |
| #754 | Teljes megkerülés-teszt B1–B10 (P7) + automatikus Hermes-kompatibilitási teszt (P9) |
| #755 | Windows támogatás (K8, U3) |
| #756 | MDM-alapú terítés és drift-ellenőrzés (WP-G teljes, D9) |
| #757 | Upstream PR-ok U1–U5 (D7) |
| #758 | Eszközkötött gateway-token (D1) |
| #759 | DPIA, munkavállalói tájékoztatás, retenció — éles bekapcsolás előfeltétele (§14, D5) |

### 17.3 Kész, ha

- V1-1 … V1-9 (és V1-3a) elfogadási feltételei teljesülnek stagingen, a mérések (K1–K4, K7, K11) eredménye a §6/§12 táblákba visszaírva.
- Nincs céges provider-kulcs a kliensgépen; a laptopokon eddig tárolt kulcsok rotálva.
- Unit-tesztek: policy-feloldás, token-csere, PAN-blokk, tokenizálás + visszaállítás (streamelve is), Managed/Open döntés, modellválasztás (D12), tartalék-lánc.

