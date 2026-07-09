# Feature-spec — ZPK / KeyOps HSM-munkafolyamat: illeszkedés- és megvalósítási-terv (gap-analízis)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.1 tervezet
**Dátum:** 2026-07-03
**Forrásdokumentum:** `zpk_agent_system_spec.html` (ZPK Agent System Specification, v0.1 draft, 2026-07-01) — payShield 10K host-interfészen keresztüli, kontrollált ZPK generálás+export egy meglévő ZMK alatt, Langflow/FastAPI/Python-tool referencia-stackkel.
**Cél-platform:** ez az Enterprise AI Agent Platform (Next.js / TypeScript / Prisma / Neon / Clerk), a meglévő feature-specek (`AgentRegistry`, `IAM-RBAC`, `AuditLog-Observability`, `ToolBroker`, `Connector-Sablon-Katalogus`, `Provisioning-Assistant`, `Playbook-Orchestrator`, `Proactive-Monitor`, `WebFetch-Egress`) által lefektetett primitívekre építve.
**Olvasó:** architect, product owner, fejlesztő(k), security/compliance reviewer.
**Státusz:** tervezet — **kizárólag elemzés és megvalósítási terv, kód nélkül**. A ZPK-spec funkcionalitásának a meglévő platformra ültetését írja le; nem a ZPK-spec referencia-stackjének (Langflow/FastAPI) lemásolását.

---

## 0. Mit ad ez a dokumentum

Három kérdésre válaszol:

1. **Hogyan valósítható meg** a ZPK-spec a mi platformunkon — mely meglévő primitívünk melyik ZPK-elemet fedi (illeszkedés-térkép, §2).
2. **Mi hiányzik** — priorizált gap-lista, új domainekkel és tervezési döntésekkel (§3–4).
3. **Mit kell kitesztelni**, hogy működőképes és PCI-védhető legyen (elfogadási + negatív tesztek, §6).

**Kulcs-keretezés.** A ZPK-spec egy konkrét referencia-stacket ír elő (Langflow + FastAPI + Python HSM-modul + lokális auth + on-prem Docker Compose). A mi platformunk ettől eltérő stacken fut, viszont **architekturálisan ugyanazokra a mintákra épült**, amiket a ZPK-spec megkövetel: több specializált agent + orchestrator, emberi jóváhagyás a végrehajtás előtt, determinisztikus/sablon-vezérelt eszközhívás (nincs nyers parancs), append-only tamper-evident audit, verziózott+jóváhagyott konfiguráció-katalógus. **Ezért a feladat nem újraépítés, hanem egy új üzleti domain (KeyOps) ráültetése a meglévő governance-vázra**, plusz néhány valóban hiányzó, PCI-specifikus építőelem.

---

## 1. Scope

### 1.1 In scope — ez a dokumentum
- A ZPK-spec teljes funkcionális lefedettségének leképezése platform-primitívekre.
- Priorizált gap-lista (P0/P1/P2) új adatmodell- és domain-vázlatokkal.
- A nyitott, irányt meghatározó tervezési döntések explicit rögzítése (auth-modell, on-prem, HSM-transport).
- Elfogadási és biztonsági (negatív) tesztterv.
- Fázisolt megvalósítási sorrend.

### 1.2 Out of scope — most nem
- Tényleges kód, Prisma-migráció, séma-írás.
- A payShield bináris protokoll (A0/A1) bitpontos parancs-formátumának kidolgozása.
- A Clerk-vs-lokális-auth végső eldöntése (nyitott kérdés, §7 — a user döntése későbbre halasztva).
- Éles payShield-integráció; az MVP mock HSM-toollal dolgozik (a ZPK-spec §15 is ezt ajánlja).

---

## 2. Illeszkedés-térkép — ZPK-elem → platform-primitív

| # | ZPK-spec elem (szakasz) | Meglévő platform-primitív | Illeszkedés | Megjegyzés |
|---|---|---|---|---|
| 1 | 5 specializált agent (Sec Officer, Clarifier, Policy, Registry, HSM Planning) + Audit agent (§3) | `Agent` + `RoleTemplate` (worker/orchestrator), `DelegationEdge`, Playbook-orchestrator | **Erős** | Az orchestrator tool-less-by-design (`ticket:create`), a workerek végzik a lookup/policy/plan munkát. |
| 2 | Ticket-életciklus 14 státusszal + history (§4) | `Ticket` + `TicketTransition`; Playbook `ProcessInstance`/`ProcessStepInstance` | **Erős, de mappelendő** | A generikus 7 `TicketState` nem elég; a 14 ZPK-státuszt process-lépésekre képezzük (§4-gap). |
| 3 | Emberi jóváhagyás végrehajtás előtt (§4, §8, §11) | `TicketState.awaiting_human`, control-plane `/pending`, `WriteGateToken` | **Közepes–erős** | A "pending approval" UX megvan; a HSM-műveletre kötött, MFA-val megerősített approval új (P1). |
| 4 | **Execution-plan hash-kötés** — ha a terv változik, a régi approval érvénytelen (§11, §12) | `WriteGateToken.expectedDiffHash` + `signature` + `consumedAt` + `status` | **Erős minta, általánosítandó** | A minta létezik (memory-diffre); HSM-execution-plan-hashre kell kiterjeszteni. |
| 5 | Determinisztikus, sablon-vezérelt tool — nincs nyers HSM-parancs (§9, §10) | Connector-sablon katalógus (`fixed_fields`, `allowed_parameters`, `validation_rules`, `template_hash`) + tool-broker `authorize()` | **Erős minta (transport eltér)** | A "csak jóváhagyott sablon futhat, nincs nyers input" invariáns pontosan a connector-motor logikája — de HTTP-re, nem TCP-binary payShieldre. |
| 6 | HSM parancs-katalógus + parancs-sablon, draft→approve, verzió+hash (§10) | `ConnectorTemplate` + `ConnectorDraft` + `ConnectorDraftReviewStatus` | **Erős minta** | Katalógus-extrakció, jóváhagyási állapotgép, hash-verziózás mind létezik connector-oldalon. |
| 7 | Audit-evidencia + tamper-evidence + evidence-package (§13) | `AuditLog` prevHash/hash-lánc, `verifyChain`, tenant/ticket/conversation oszlopok | **Erős** | A closure-summary és evidence-package a meglévő audit-láncból származtatható. |
| 8 | Email-értesítés: pending, hiányzó prereq, több ZMK, closure (§8) | `notify`/`dispatch-notify` + gmail/chat connector, Proaktív Monitor governance | **Erős** | Emlékeztető: a `gmail_send` emberi jóváhagyás-köteles → allowlistolt chat-webhookot használunk értesítőre. |
| 9 | Tudásbázis: approval + verzió + forrás-tag + pgvector RAG (§10) | `knowledge-base` domain + `Document`/`DocumentStatus` | **Közepes** | Az approval/verzió megvan; a pgvector-RAG és a "csak APPROVED chunk retrievelhető" invariáns ellenőrzendő/kiegészítendő. |
| 10 | RBAC + permission-modell (§11) | `UserRole` (admin/approver/operator/viewer), `RolePermission`, IAM domain | **Közepes (mismatch)** | Szerep-mismatch + a self-contained auth-elvárás ütközik a Clerk-kel (P1, §7). |
| 11 | payShield 10K TCP/IP bináris host-parancs (A0/A1) (§9) | — (a connector-motor HTTP-only) | **Hiányzik** | Új transport/connector-típus + bináris builder (P0). |
| 12 | Key Registry: keys, KCV, target parties, TP-key assignments, protection-relations (§6–7) | — | **Hiányzik** | Teljesen új domain (P0). |
| 13 | HSM Manager 120-perces aktivációs ablak, Dept Head bootstrap, KMO-kinevezés (§11) | — | **Hiányzik** | Új IAM-konstrukciók (P1). |
| 14 | MFA/TOTP + step-up minden approve/execute előtt + TOTP-seed HSM-mel védve (§11–12) | Clerk MFA (részleges) | **Hiányzik/részleges** | A friss step-up + plan-hash-kötés + HSM-védte seed új (P1). |
| 15 | Local Experience Records (terminológia, szinonima, heurisztika) (§10) | `Memory` / agent-knowledge-base (részleges) | **Közepes** | A scope/confidence/approval-struktúra és a "sosem authorizál, csak clarify-t segít" invariáns új (P2). |
| 16 | On-prem / no-cloud, PCI-adat nem megy felhőbe (§15) | Firebase App Hosting + Neon + Clerk (mind felhő) | **Konfliktus** | Deployment-szintű ellentét; PCI-audithoz külön on-prem profil kell (P1/döntés, §7). |

---

## 3. Hiányzó funkciók (gap-ek) prioritással

### 3.1 P0 — teljesen hiányzó, új domain nélkül nincs MVP

**P0-1. Key Registry domain.** A ZPK-spec szíve (§6–7). Nincs semmilyen kulcs-inventár modellünk. Új Prisma-modellek és `src/domain/key-registry` domain kell:
- `Key` — `key_type` (ZMK/ZPK), `environment` (TEST/PROD), `status` (PLANNED/ACTIVE/SUSPENDED/RETIRED/COMPROMISED), `kcv` + `kcv_format`, `encrypted_key_value`/`key_block`/`exported_key_cryptogram`, `protection_type` (LMK_HIERARCHY/ZMK/OTHER), `protected_under_key_id` (self-FK), `registration_method`, ticket-linkage.
- `TargetParty` + `TargetPartyProfile` (env-enkénti crypto-defaultok: algo/length/scheme/usage/kcv_format).
- `TargetPartyKey` — ZMK↔target-party **many-to-many**, ZPK **1:n** invariánssal (a spec `uq_zpk_single_target_party` partial-indexe: egy ZPK csak egy target-partyhoz köthető, ha `relationship_type='ZPK_OWNER' AND revoked_at IS NULL`).
- **Invariáns:** a registry az egyetlen igazságforrás a kulcs-metaadatra; az LMK-t **soha** nem tárolja.

**P0-2. payShield HSM-tool (mock előbb, valós később).** A meglévő connector-motor kizárólag HTTP (`http_api`, ld. `connector-template/template-descriptor.ts` — REST-metódusok + OAuth). A payShield bináris A0/A1 parancsot TCP/IP-n küldi. Kell:
- Új **transport-típus** (raw TCP + bináris payload) vagy dedikált Python-mellékszolgáltatás wrapper.
- **Determinisztikus parancs-builder**, ami csak jóváhagyott sablonból + validált strukturált inputból állítja össze a payloadot — a tool-broker `authorize()` mintáját követve (nincs nyers parancs-string agenttől/usertől).
- **MVP:** mock HSM tool, ami valósághű A1-választ ad + registry-t frissít.

**P0-3. HSM parancs-katalógus + parancs-sablon a bináris A0-hoz.** A connector-sablon minta (draft→approve, hash, verzió) újrahasznosítható, de a `command_fields`/`response_fields` séma + a bináris payload-összeállítás új réteg. A meglévő `ConnectorTemplate` állapotgépe adja a mintát.

**P0-4. Target-party crypto-profil hurok.** A "requester nem ismeri a kripto-paramétereket → rendszer feloldja prof.-ból, vagy az approver kitölti és **visszaperzisztálja**" folyamat (§5, §8) — új UI + domain-logika.

### 3.2 P1 — IAM / deployment, iránymeghatározó döntésekkel

**P1-1. Szerep-modell.** Platform: `admin/approver/operator/viewer`. Spec: `PM/KMO/HSM_MANAGER/DEPARTMENT_HEAD` finomabb, permission-alapú modellel (pl. `approve_key_operation`, `register_zmk`, `execute_hsm_tool`, `create_command_template`). Mappelhető a meglévő `RolePermission`-re, **de** a spec kifejezetten **self-contained, corporate-IdP-független** auth-ot ír elő — a Clerk viszont külső IdP. Ez PCI-kontextusban valós feszültség → **döntés (§7).**

**P1-2. HSM Manager aktivációs ablak + Dept Head bootstrap + KMO-kinevezés.** Új modellek: `hsm_manager_activation_windows` (max 120 perc, `CHECK` kényszerrel), `kmo_appointment_requests`. Új workflow: Dept Head engedélyezi az ablakot → HSM Manager csak azon belül admin-álhat template-et. Nincs analóg.

**P1-3. MFA/step-up + plan-hash-kötés HSM-műveletre.** A Clerk tud MFA-t, de a spec **friss step-up-ot** követel közvetlenül az `approve_key_operation`/`execute_hsm_tool` előtt, az execution-plan-hashhez kötve (§11 "Approval Binding"). A WriteGate-minta (P0/#4) általánosítandó. A HSM-mel titkosított TOTP-seed külön auth-secret command-template-tel teljesen új (és csak akkor releváns, ha a lokális auth-ot választjuk).

**P1-4. On-prem profil.** A PCI no-cloud követelmény (§15) a jelenlegi felhő-deploymenttel ütközik → külön on-prem telepítési profil (Neon → helyi Postgres, Clerk → lokális auth, egress-tiltás) kell, ha ez éles PCI-rendszer lesz. **Döntés (§7).**

### 3.3 P2 — mappelés / kiegészítés

**P2-1. Domain-specifikus 14 állapotú state-gép.** Vagy `TicketState` bővítés, vagy — javasolt — Playbook `ProcessStepInstance`-ekre képezés (a workflow-motor és a state-transition-audit már megvan).

**P2-2. Local Experience Records.** Struktúra: `experience_type` (REQUESTER_TERMINOLOGY/LOCAL_SYNONYM/LOCAL_POLICY_HINT/CLARIFICATION_HEURISTIC), `scope`, `statement`, `suggested_agent_behavior`, `confidence`, approval + `superseded_by` + valid_from/to. **Invariáns:** clarify-t/normalizálást segít, **de sosem authorizál végrehajtást és nem ír felül approved command-template-et** — a HSM-tool nem fogyasztja közvetlenül.

**P2-3. Jövőbeli kiterjesztések** (§16): Excel-import kulcs-inventárra, JIRA-szinkron, további kulcstípusok, aláírt approval-linkek, operatív dashboardok — mind Fázis 2+.

---

## 4. Fő invariánsok, amiket át kell vinni

Ezek a ZPK-spec biztonsági lelke; a platformra ültetve is kötelezőek:

1. **Nincs nyers HSM-parancs.** Az agent strukturált tervet ad; a bináris payloadot determinisztikus builder állítja össze jóváhagyott sablonból (§9, §12). → tool-broker `authorize()` + template-hash gate.
2. **Approval a konkrét execution-plan-hez kötve.** Input-változás után a régi approval érvénytelen (§11–12). → WriteGate-minta general­izálva.
3. **A chatben állított szerep nem authentikáció.** "I am KMO" nem ad jogot; kizárólag az authentikált session + authorization-DB számít (§11). → session-alapú `authorize()`, nincs NL-inferencia.
4. **TEST/PROD szigorú szeparáció.** Környezet-keresztező kulcs-hivatkozás tilos; nincs test→prod migráció (§12).
5. **Nincs auto-retry bizonytalan HSM-eredmény után** (idempotencia-hiány → dupla kulcs-generálás veszélye, §14).
6. **Append-only tamper-evident audit** a teljes evidence-package-re (§13). → meglévő `AuditLog` hash-lánc.
7. **Csak APPROVED artefaktum operatív** (knowledge-chunk, local-experience, command-catalog, command-template); verzió-frissítés nem visz át régi approval-t (§10).

---

## 5. Adatmodell-vázlat (új, javasolt)

Csak a P0/P1 új modellek fő kontúrja (nem végleges séma):

- **`key-registry`:** `Key`, `TargetParty`, `TargetPartyProfile`, `TargetPartyKey` (a §7 DDL leképezése Prismára; enum-ok: `KeyType`, `KeyStatus`, `ProtectionType`, `Environment`).
- **`keyops-ticket`:** a meglévő `Ticket`-re épített KeyOps-metaadat (a `TrainingTicket` mintájára first-class oldal-tábla), operation + resolved_inputs JSON + 14-státuszú process-mapping.
- **`hsm-command`:** `HsmCommandCatalog`, `HsmCommandTemplate`, `CommandTemplateAdminEvent` (a connector-template állapotgép mintájára).
- **`hsm-operation`:** `HsmOperation` + `HsmOperationResult` (execution_plan JSON, request/response hash, parsed response).
- **IAM-kiegészítés:** `KmoAppointmentRequest`, `HsmManagerActivationWindow`, plus a permission-katalógus KeyOps-permissionökkel.

Minden tábla `tenantId`-vel (a séma 58 helyen már multi-tenant), és minden governance-művelet pontosan egy `AuditLog`-sort ír.

---

## 6. Tesztterv — mit kell kitesztelni

### 6.1 Happy path & elágazások (mock HSM-mel)
- **T1** Teljes `GENERATE_EXPORT_ZPK_UNDER_ZMK` end-to-end: DRAFT → … → CLOSED, registry-rekord + KCV létrejön.
- **T2** Pontosan 1 aktív ZMK → automatikus használat.
- **T3** Több aktív ZMK → **KMO-választás** kötelező (PM nem választhat).
- **T4** 0 aktív ZMK → `PREREQUISITE_MISSING`, workflow blokkolva, KMO értesítve.
- **T5** Hiányzó crypto-profil → approver kitölti → **visszaperzisztál** → workflow policy-check-nél folytatódik.

### 6.2 Biztonsági / negatív tesztek (a PCI-lényeg)
- **N1** Approval-plan hash-kötés: input-változás approval után → régi approval **érvénytelen**, execute elutasítva.
- **N2** RBAC: PM **nem** éri el a Key Registry-t; PM nem lát idegen ticketet.
- **N3** "I am KMO" chat-állítás **nem** ad jogot (session-alapú döntés).
- **N4** HSM Manager 120-perces ablak lejárta/visszavonása után **nincs** template-admin.
- **N5** Friss step-up kikényszerítése `approve`/`execute` előtt; stale session elutasítva.
- **N6** TEST/PROD kereszthivatkozás elutasítva; test→prod migráció tilos.
- **N7** **Nincs auto-retry** bizonytalan HSM-válasz után (nem keletkezik második kulcs).
- **N8** Audit-lánc teljessége + tamper-evidence (`verifyChain` zöld) a teljes evidence-package-re.
- **N9** Module-hash + template-hash integritás-check végrehajtás előtt; nem egyező hash → execute megtagadva.
- **N10** Csak `APPROVED` command-template futtatható; draft/retired elutasítva.

### 6.3 Transport / protokoll (éles előtt)
- **T6** payShield A0 parancs-összeállítás bit-/mezőpontosan + A1 válasz-parse **payShield szimulátor** ellen, mielőtt bármi valós TEST HSM-hez kötődne.

---

## 7. Nyitott kérdések / döntést igénylő pontok

1. **Auth-modell (halasztva a user által).** Clerk-re mappelés (gyors, de nem self-contained, PCI-kockázat) **vagy** lokális auth-modul a §11 szerint (spec-konform, sok munka). A ZPK-spec §11 explicit: "self-contained identity model … does not depend on the corporate identity provider". Ez a döntés meghatározza P1-1, P1-3 és P1-4 nagy részét.
2. **On-prem vs. jelenlegi felhő-deployment.** Éles PCI-rendszernek a §15 no-cloud követelménye miatt on-prem profil kell (helyi Postgres + lokális auth + egress-tiltás). Ha ez PoC/belső pilot, a felhő-stack egyelőre elég.
3. **HSM-transport.** Dedikált Python-mellékszolgáltatás (a spec referencia-stackjéhez közel) **vagy** natív TS TCP-connector-típus a meglévő motorba. Az előbbi közelebb áll a payShield SDK-ökoszisztémához.
4. **14 státusz kezelése.** `TicketState`-bővítés **vagy** Playbook-process-lépések (javasolt: az utóbbi, mert a workflow-motor kész).

---

## 8. Javasolt megvalósítási sorrend (fázisok)

A ZPK-spec §15 MVP-ajánlása és a platform erősségei egybeesnek:

1. **F1 — Key Registry domain** (P0-1) + KeyOps-ticket metaadat + target-party profil (P0-4). Ez a fundamentum.
2. **F2 — Ticket-workflow a Playbook-orchestratorra** képezve, 14 ZPK-státusz process-lépésként (P2-1).
3. **F3 — Mock HSM tool** determinisztikus builderrel + command-katalógus/sablon (P0-2 mock, P0-3), connector-sablon minta újrahasznosítva.
4. **F4 — Approval hash-kötés** a WriteGate-mintából HSM-műveletre általánosítva (P1-3 mag) + email-értesítők (kész notify-réteg).
5. **F5 — IAM-kiterjesztés** (P1-1/P1-2): KeyOps-szerepek + permissionök, KMO-kinevezés, HSM Manager aktivációs ablak. **Itt dől el az auth-döntés (§7-1).**
6. **F6 — csak stabil MVP után:** valós payShield TEST-endpoint (P0-2 éles), a §15 lépés-6 szerint.

---

*Dokumentum-státusz: 0.1 tervezet. A §7 nyitott döntések (különösen az auth-modell) tisztázása után frissítendő. Nincs hozzá kód; a következő javasolt lépés az F1 (Key Registry) adatmodell részletes kidolgozása.*
