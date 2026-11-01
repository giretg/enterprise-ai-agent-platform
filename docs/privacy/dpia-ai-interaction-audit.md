# DPIA — AI-használati napló (Hermes Managed Client prompt-naplózás)

**Hatály:** Excellence AI Agent Platform, Hermes Managed Client céges mód.
**Hivatkozás:** GitHub #759, spec `docs/specs/hermes-managed-client-spec.md` §14, D5, D6.
**Verzió:** 1.0 · 2026-10-03
**Státusz:** műszaki DPIA, aláírásra kész. Az éles bekapcsolás a DPO / jogi képviselő aláírása után indul.

Ez a dokumentum a GDPR 35. cikke szerinti adatvédelmi hatásvizsgálat a munkavállalói
AI-beszélgetések naplózására. Nem helyettesíti a tenant saját munkajogi
tájékoztatóját; a platform a technikai és szervezési intézkedéseket adja.

---

## 1. Az adatkezelés leírása

A céges módban futó AI-munkatárs (Hermes Managed Client) minden modellhívását a
platform Model Gateway-e viszi, a helyi tool-használatot az Excellence Guard küldi
be. A közös napló az `AiInteractionEvent` tábla:

| Mező | Tartalom |
|---|---|
| Ki | tenant, felhasználó, agent, telepítés (`installId`) |
| Mikor | `createdAt`, session/turn azonosító |
| Mit | `kind`: user_prompt / model_call / tool_call / final |
| Honnan | `source`: gateway vagy guard |
| Tartalom | AES-GCM boríték, vagy üres (metaadat-mélység) |
| Meta | modell, policy-döntés, tool neve, token-használat — nem a prompt szövege |
| Lejárat | `expiresAt` = írás + 90 nap (konfig: `AI_AUDIT_RETENTION_DAYS`) |

**Cél:** biztonság, visszaélés-felderítés, költség- és policy-ellenőrzés, incidensvizsgálat.
Modelltréningre, marketingre, teljesítményértékelésre a napló **nem** használható.

**Érintettek:** a tenant munkavállalói és megbízottai, akik céges módban AI-munkatársat
használnak. A naplóban ügyféladatok is megjelenhetnek, ha a munkavállaló a promptba írja
őket — ezt a tartalomszűrő (PAN-blokk, e-mail/név tokenizálás, #773) arányosítja.

**Jogalap:**

- GDPR 6. cikk (1) f) — a munkáltató jogos érdeke a céges AI-használat ellenőrizhetőségére
  (titoktartás, költség, tiltott adatkiszivárgás).
- Magyar Mt. 9. §, 11. §, 11/A. § — a munkáltató az elektronikus eszközök használatát
  **előzetes tájékoztatás** mellett ellenőrizheti; a tájékoztatás a Guardben jelenik meg
  (lásd 5. pont).
- A tenant a saját munkaszerződésében / IT-szabályzatában rögzíti a céges AI-használatot.
  A platform nem a munkáltató, a tenant az adatkezelő a saját munkavállalói adatain;
  az Excellence a platformüzemeltető (adatfeldolgozó a tenant utasítására).

**DPIA-kötelezettség:** a GDPR 35. cikk (3) c) és a 29. cikk szerinti munkacsoport
iránymutatása szerint a munkavállalók **rendszeres, módszeres megfigyelése** DPIA-köteles.
Ez a napló ilyen megfigyelés (minden céges beszélgetés).

---

## 2. Szükségesség és arányosság

| Intézkedés | Hogyan arányosít |
|---|---|
| Audit-mélység (`metadata` / `prompt_and_response` / `plus_tool_results`) | A tenant policyje dönti el, mennyi tartalom tárolódik. Ismeretlen szint → a legkevesebb (metadata). A tool-eredmény csak a legmélyebb szinten marad meg. |
| Titkosítás | A `content` tenant-származtatott AES-256-GCM boríték; a listázó API alapból nem fejti vissza. |
| 90 napos tartalom-retenció | D5, véglegesítve. Metaadat ugyanaddig él (egy sor, egy lejárat). Konfig: `AI_AUDIT_RETENTION_DAYS` > 0. |
| Élő törlő járat | Napi `POST /api/v1/internal/ai-audit-retention`. 5000-es kötegekben ürít, amíg van lejárt sor. A lejárt sor a listában a járat előtt sem jelenik meg. |
| Lokális session-DB | v1-ben a Guard **nem** törli a gép session-tárolóját (D5). A szerveroldali tartalom a kötelező minimum. |
| Tartalomszűrő | PAN nem jut el a modellhez és nem kerül a napló kérésébe; e-mail/név álnéven megy a modellhez. |
| Nincs UI v1-ben | Olvasás csak admin API-n, négy szemmel (3. pont). A napló-UI későbbi issue (#750). |

A 90 nap a biztonsági és incidensvizsgálati ablak (negyedéves audit, késve felfedezett
szivárgás). Hosszabb megőrzéshez a tenant DPO-jának külön indok kell, és az env-konfig
változtatása AuditLog nélkül nem történhet — az env platform-titok, nem tenant-beállítás.

---

## 3. Hozzáférés: audit-szerep és négy szem

Az „audit-szerep” v1-ben a tenant **admin** (nincs külön `audit` UserRole — az IAM négy
szerepe: viewer, operator, approver, admin). Operator és approver a tartalmat nem látja.

**Metaadat** (ki, mikor, melyik agent, milyen tool, policy-döntés): egy admin Clerk-munkamenete.

**Visszafejtett tartalom** (prompt, modellválasz, tool-eredmény): négy szem.

```
Admin A  POST /api/ai-audit/content-unlock          → kéréstoken (30 perc)
Admin B  POST /api/ai-audit/content-unlock/approve  → grant (15 perc), B ≠ A
A vagy B GET  /api/ai-audit/events?includeContent=true
         Header: x-ai-audit-grant: <grant>
```

Önjóváhagyás tiltott. Idegen tenant grantje érvénytelen. Harmadik admin a granttel sem
olvas. Minden kérés, jóváhagyás és visszafejtés `AuditLog` sor (`ai_audit.content_unlock.*`,
`ai_audit.content_read`), a hash-lánc append-only.

---

## 4. Kockázatok és intézkedések

| Kockázat | Súly | Intézkedés | Maradék |
|---|---|---|---|
| Munkavállaló nem tudja, hogy naplózzák | magas | Guard session-indításkor stderr + rendszerprompt-szakasz: „Ez a munkatárs céges módban fut, a beszélgetéseid naplózásra kerülnek.” | A tenant saját munkajogi tájékoztatója továbbra is kell. |
| Túl sok tartalom tárolása | közepes | Audit-mélység; tool-eredmény alapból kiesik; PAN nem kerül a naplóba. | A felhasználó szabad szövegbe írhat nevet, titkot. |
| Retenció csak papíron van (a függvény sosem fut) | magas | Élő HTTP-hívó + Clerk-allowlist + KEEP teszt, hogy a handler a sweepet hívja. | A Scheduler-jobot az üzemeltetőnek be kell kötnie (DEPLOY.md 3.2). |
| Egy admin egyedül olvassa a beszélgetést | magas | Négy szem a visszafejtésen; magán az olvasáson is AuditLog. | A grant 15 percig újrahasználható (nincs egyszer-használatos tábla v1-ben). |
| Cross-tenant szivárgás | magas | Tenant a tokentből / Clerk-kontextusból jön, soha a payloadból. Lista tenant-szűrt. | — |
| Kulcsvesztés | közepes | Tenantonként származtatott kulcs a platform-titokból; prod-ban placeholder fail-closed. | Platform-titok kompromittálása az összes tenant borítékát nyitja — KMS-envelope későbbi erősítés. |
| Lokális gép session-DB | alacsony (v1 tudatos) | D5: v1-ben a Guard nem törli. A szerveroldali 90 nap a kötelező. | Offboardingkor a profil törlődik; a gép session-fájlja maradhat. |

---

## 5. Érintetti tájékoztatás

A kliens **minden session elején** megjeleníti (Excellence Guard, `policy.NOTICE`):

> Ez a munkatárs céges módban fut, a beszélgetéseid naplózásra kerülnek.

Ugyanez a mondat a rendszerpromptba is bekerül (`excellence-guard.notice`), hogy a modell
tudja: a beszélgetés naplózott. A staging POC belső, tájékoztatott userekkel a DPIA
aláírása előtt is futhat (spec §15); éles tenant-bekapcsolás előtt a tenant DPO-ja
aláírja ezt a lapot, és a munkavállalókat a saját csatornáján is tájékoztatja.

---

## 6. Adattovábbítás, megőrzés, törlés

- **Továbbítás:** a napló tartalma nem megy ki LLM-providernek (a provider a szűrt
  promptot kapja, a napló a mi adatbázisunk). Incidensnél a tenant admin négy szemmel
  olvashat. SIEM-export v1-ben nincs erre a táblára.
- **Megőrzés:** 90 nap, aztán törlés. A lejárt sor a GET-listában már a törlés előtt sem
  jelenik meg.
- **Törlési jog:** a munkavállaló a tenant adatkezelőjénél élhet GDPR 17. cikkel; a
  platform a tenant utasítására tenant-szűrt törlést tud adni (v1-ben a 90 napos járat
  a rendszeres törlés). Legal hold v1-ben nincs ezen a táblán.
- **Adathordozhatóság:** a tenant admin a metaadat-API-n JSON-t kap; a tartalom a
  négy-szemes granttel.

---

## 7. Döntés

A kezelés **megkezdhető** a következő feltételekkel:

1. Ez a DPIA a tenant DPO / jogi képviselő aláírásával lezárt.
2. A Guard-tájékoztatás a kliensben megjelenik (KEEP: Hermes Guard teszt).
3. A 90 napos retenciós sweep route élesben a Cloud Schedulerhez van kötve (`DEPLOY.md` 3.2).
4. A tartalomolvasás négy szemmel megy, önjóváhagyás nélkül.

**Aláírás**

| Szerep | Név | Dátum |
|---|---|---|
| Adatvédelmi tisztviselő (DPO) | | |
| Jogi képviselő | | |
| Műszaki felelős | | |
