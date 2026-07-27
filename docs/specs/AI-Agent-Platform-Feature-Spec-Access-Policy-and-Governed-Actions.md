# AI Agent Platform — Feature Spec: Hozzáférés-policy és Governed Action-ok (jóváhagyás-kapuzott képesség-hívás)

> Státusz: **draft**; az `agent-scope` gráf fejlesztésre átadható, a Governed Action további részeihez kód még nincs. Frissítve: 2026-07-27.
> Kiváltó use-case: a KeyOps/ZPK payShield HSM-agent (lásd [ZPK-KeyOps-Gap-Analysis](AI-Agent-Platform-Feature-Spec-ZPK-KeyOps-Gap-Analysis.md)), de ez a spec **kulcskezelés-független, általános platform-képesség**. A KeyOps ennek csak egy konfigurációja.

## Problem Statement

A platform ma nem tud biztonságosan olyan folyamatot futtatni, amelyben egy **agent kezdeményez** egy nagy kockázatú külső műveletet, de a végrehajtást egy **ember hagyja jóvá**, és a jóváhagyás után a művelet **determinisztikusan, pontosan a jóváhagyott formában** fut le. Két hiány áll ennek útjában:

1. **Nincs finomhangolt, erőforrás-szintű hozzáférés-policy.** A tenant-role-ok (`admin/approver/operator/viewer`) durvák: nem lehet beállítani, hogy egy konkrét user mely agenteket lássa vagy szólíthassa meg, mely agent mely másik agenthez delegálhat, ki csak a saját ticketjeit lássa, vagy ki hagyhat jóvá. A szerepek közti feladatmegosztás (kérelmező ≠ jóváhagyó) és az agentek delegációs határa nem kikényszeríthető.
2. **Nincs jóváhagyás-kapuzott, determinisztikus képesség-hívás.** A Governed Flow Builderben van `await_human` kapu, de nincs olyan lépés, amely (a) egy **reference-only** tervet köt egy gated képességhez, (b) a jóváhagyás pillanatában **feladat-szétválasztást (SoD) + friss step-up-ot** kényszerít, és (c) jóváhagyáskor **LLM nélkül**, a befagyasztott tervhez kötve elindítja a külső hívást.

A cél a KeyOps use-case-ből jött (PM kér ZPK-t → KMO jóváhagy → a payShield HSM-modul végrehajt), de a hiány generikus: bármely magas-kockázatú külső művelet (fizetés, jogosultság-változás, kulcsművelet, visszafordíthatatlan API-hívás) ugyanezt a mintát igényli.

## Solution

Öt, egymásra épülő **generikus platform-képességet** vezetünk be. A domain-specifikus munka (Key Registry, bináris HSM-tool, command-template-ek) **külön modulban** marad, amelyet a platform generikus connectoron / MCP-n ér el — így a platform kód kulcskezelés-független.

### A hiányzó platform-képességek

1. **Resource-scope authorization policy** — három külön dimenzióval:
   - `agent-scope`: az alább részletezett, konkrét user és agent principalokra épülő irányított gráf, két független igével (`view`, `address`) és per-agent fail-closed kapcsolókkal;
   - `ticket-scope`: mely ticketeket lát (`own` = requester==user | `all` | `by-status`, például csak `READY_FOR_APPROVAL`);
   - `action-set`: mit tehet (`initiate, answer_clarification, approve, reject, request_clarification, execute, view_audit`).
   - Az `agent-scope` nem szerep-alapú: minden él konkrét userből vagy agentből indul. A ticket- és action-policy ettől függetlenül támaszkodhat szerepekre.
   - Kikényszerítés server-side: az agent-listák és célzott műveletek közös access-modult, a ticket-lekérdezések repository-szintű szűrést, az approval-akciók governance-guardot, az `execute` út a tool-broker capability-gate-et használja.

2. **Governed action step** a Governed Flow Builderben — jóváhagyás-kapuzott, reference-only képesség-hívás (a részletes szemantika lentebb).

3. **Step-up / reverification** (Clerk) — magas `riskTier` esetén friss újra-hitelesítés a jóváhagyás pillanatában, az approval-rekordhoz + plan-hash-hez kötve (`mfa_step_up_event_id`).

4. **On-behalf-of identitás-átadás** — a platform átadja az acting-user identitását a külső képességnek (modul), hogy a modul user-szintű jogot (pl. `execute_hsm_tool`) tudjon kényszeríteni. Mechanizmus nagyrészt megvan (delegált-OAuth / Bearer-injekció a `http_api` connectoron), **bekötés** kell.

5. **Érzékeny-válasz adat-minimalizálás a connector-határon** — a külső képesség/modul csak **nem-érzékeny referenciát** ad vissza (státusz, `registry_key_id`, `operation_id`); az érzékeny adat (pl. kulcs-cryptogram) a modulban marad, és a modul bocsátja ki az azt hordozó értesítéseket. A platform sensitivity-routere csak **backstop**, nem az elsődleges kontroll.

### A Governed Action Step szemantikája

Egy tool-lépés a kanavászon, amely:

- egy **reference-only** tervet céloz egy gated képességre (a bemenet egy referencia — pl. `ticket_id` —, nem a nyers művelet-paraméterek);
- **emberi approval-kapuval** rendelkezik, amelynek jogosultsági horgonya **capability + risk-osztály + SoD** (nem a hozzárendelés);
- jóváhagyáskor **determinisztikusan** (LLM nélkül), **aszinkron** meghívja a célzott képességet a **befagyasztott terv-referenciával**;
- az eredményt rögzíti, és átadja egy **closure-lépésnek** (nem-érzékeny, agenttel megfogalmazható narratíva + értesítés-trigger).

A kapu **automatikusan megjelenik** a lépésen, ha a célzott képesség gated (a `riskTier`-ből levezetve), a kanavászon **látható**, és a jóváhagyó szerep **felülírható**.

### Agent-scope: agent-hozzáférési gráf

> Ez a fejezet a [#52 Agent-hozzáférési gráf](https://github.com/giretg/enterprise-ai-agent-platform/issues/52) wayfinder lezárt döntéseinek normatív összefoglalója. Az `agent-scope` tekintetében ez a fejezet felülírja a spec korábbi, szerep-alapú `all | allow-list {view, initiate}` modelljét. A `ticket-scope` és az `action-set` ettől független dimenziók maradnak.

#### Hatókör és alapfogalmak

A gráf az ad-hoc user→agent és agent→agent elérési utakat szabályozza:

- `view`: a subject megtudhatja, hogy a célagent létezik, és böngésző/katalógus felületen láthatja;
- `address`: a subject chatet indíthat, ticketet címezhet vagy agent-delegációt kezdeményezhet a célagent felé.

A két jog **független boolean**. Az `address` nem implikál `view`-t, és a `view` nem implikál `address`-t. A chat, ticket és `agent_ask` külön csatorna, de ugyanannak az `address` igének a kikényszerítési pontjai.

Nem része ennek a gráfnak:

- az agent→user névsor- és ticketcímzési irány; ennek ismert adatminimalizálási kitettsége a [#80](https://github.com/giretg/enterprise-ai-agent-platform/issues/80);
- a `ticket-scope`, `action-set`, step-up/reverification, on-behalf-of és Governed Action szemantika;
- Group/Team/OrgUnit alany: a jelenlegi modell szándékosan konkrét userekkel dolgozik; csoportos alany csak külön domain-entitás és külön migráció után vezethető be;
- a delegált agent skill-katalógusának láthatósága: az `address` él csak elérést ad, capabilityt vagy skillt nem kölcsönöz;
- a `requireRole` → `requirePermission` általános refaktor.

Ezek nem blokkolják az itt leírt gráf implementációját.

#### Normatív invariánsok

1. **Az agent önálló principal.** Ha A agent B-t hívja, A a saját `address` jogán jár el. A kezdeményező user joga nem metsződik A jogával, és nem öröklődik tovább. A user→A grant ezért A teljes elérhetőségi kúpjára ad tudatos hozzáférést.
2. **A láthatóság és a megszólíthatóság külön jog.** Minden explicit ID-alapú művelet a megfelelő igét szerveroldalon ellenőrzi; az ID ismerete vagy UI-beli elrejtése nem jogosultság.
3. **A policy explicit, irányított allow-élekből áll.** Nincs címke-, szerep- vagy deny-szabály. A→B és B→A két külön él.
4. **A normál tenant-agentek kompatibilitási alapértéke nyitott.** Ha egyik releváns korlátozás sincs bekapcsolva, a tenanton belüli kapcsolat grant nélkül engedett. Nincs migrációs élgenerálás, shadow rollout vagy tenant-szintű „mindent lezár” kapcsoló.
5. **A Playbook/Process runtime és Monitor-cron külön principal.** A gráf az ad-hoc utat köti. A folyamat-definícióból eredő útvonalakat külön vizuális csatorna és shadow audit teszi láthatóvá, de a folyamat végrehajtását nem blokkolja az ad-hoc gráf.
6. **Az org-ábra maga a policy-szerkesztő.** A csomópont agent, az irányított él delegációs jog; a konkrét userek külön sávban élforrások.
7. **A tenant-határ abszolút.** Normál grant csak azonos tenant gráfján belül érvényes. Egy grant nem tehet elérhetővé más tenant agentjét.
8. **Az él csak elérést ad.** Nem ad tool capabilityt, nem másolja a célagent skilljeit, és nem írja felül a csatorna saját érvényességi szabályait.

#### Adatmodell

Az `Agent` két új kapcsolót kap:

```prisma
model Agent {
  // ...
  inboundRestricted  Boolean @default(false) @map("inbound_restricted")
  outboundRestricted Boolean @default(false) @map("outbound_restricted")

  accessGrantsAsSubject AgentAccessGrant[] @relation("AgentAccessSubjectAgent")
  accessGrantsAsTarget  AgentAccessGrant[] @relation("AgentAccessTarget")
}
```

- `inboundRestricted`: a célagent felé a bejövő `view` és `address` kapcsolatok csak explicit granttal engedettek;
- `outboundRestricted`: az agentből induló `view` és `address` kapcsolatok csak explicit granttal engedettek.

A usernek nincs `outboundRestricted` mezője. User→agent kapcsolatnál kizárólag a célagent `inboundRestricted` kapcsolója dönti el, kell-e explicit grant. Agent→agent kapcsolatnál a forrás `outboundRestricted` **vagy** a cél `inboundRestricted` igaz értéke esetén grant szükséges.

Az élek új, célzott táblában élnek:

```prisma
enum AgentAccessSubjectType {
  user
  agent

  @@map("agent_access_subject_type")
}

model AgentAccessGrant {
  id             String                 @id @default(uuid()) @db.Uuid
  tenantId       String                 @map("tenant_id") @db.Uuid
  subjectType    AgentAccessSubjectType @map("subject_type")
  subjectUserId  String?                @map("subject_user_id") @db.Uuid
  subjectAgentId String?                @map("subject_agent_id") @db.Uuid
  targetAgentId  String                 @map("target_agent_id") @db.Uuid
  canView        Boolean                @default(false) @map("can_view")
  canAddress     Boolean                @default(false) @map("can_address")
  grantedById    String                 @map("granted_by") @db.Uuid
  grantedAt      DateTime               @default(now()) @map("granted_at") @db.Timestamptz
  updatedAt      DateTime               @updatedAt @map("updated_at") @db.Timestamptz

  tenant       Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  subjectUser User?  @relation("AgentAccessSubjectUser", fields: [subjectUserId], references: [id], onDelete: Cascade)
  subjectAgent Agent? @relation("AgentAccessSubjectAgent", fields: [subjectAgentId], references: [id], onDelete: Cascade)
  targetAgent  Agent  @relation("AgentAccessTarget", fields: [targetAgentId], references: [id], onDelete: Cascade)
  grantedBy    User   @relation("AgentAccessGrantedBy", fields: [grantedById], references: [id])

  @@unique([tenantId, subjectUserId, targetAgentId])
  @@unique([tenantId, subjectAgentId, targetAgentId])
  @@index([tenantId, targetAgentId])
  @@index([tenantId, subjectAgentId])
  @@map("agent_access_grants")
}
```

A teljes Prisma-változás a fordított relációkat is hozzáadja:

```prisma
model User {
  // ...
  agentAccessGrantsAsSubject AgentAccessGrant[] @relation("AgentAccessSubjectUser")
  agentAccessGrantsIssued    AgentAccessGrant[] @relation("AgentAccessGrantedBy")
}

model Tenant {
  // ...
  agentAccessGrants AgentAccessGrant[]
}
```

A migráció adatbázis-`CHECK` constraintjei:

- `subjectType=user` esetén `subjectUserId` kötelező és `subjectAgentId` null;
- `subjectType=agent` esetén `subjectAgentId` kötelező és `subjectUserId` null;
- `canView OR canAddress` igaz; mindkettő hamisra állítása a sor törlését jelenti;
- self-edge nem szükséges és nem hozható létre;
- egy subject→target párhoz legfeljebb egy sor tartozik; a két boolean együtt hordozza a két vizuális sávot.

A cross-table tenant-invariánst PostgreSQL `CHECK` nem tudja kifejezni, ezért a grant domain service tranzakcióban ellenőrzi:

- user subjectnél létezik aktív `TenantMembership(subjectUserId, tenantId)`;
- agent subjectnél `subjectAgent.tenantId = tenantId`;
- minden esetben `targetAgent.tenantId = tenantId`;
- a cél nem gráfon kívüli panel-varázsló, és a Web-Egress-speciális szabályok teljesülnek.

Nem a meglévő `ResourceGrant` táblát használjuk. Annak alanya csak user lehet, egyetlen `view | operate | approve` skála-igéje ütközik a két független booleannel, és az IAM/RBAC spec más erőforrásaira fenntartott, üres táblán fail-open horgony. A két tábla összevonása mindkettő szemantikáját elrontaná.

#### Döntési függvény

A policy egyetlen közös modulból érhető el:

```ts
type AgentAccessSubject =
  | { kind: "user"; userId: string; tenantId: string }
  | { kind: "agent"; agentId: string; tenantId: string };

type AgentAccessVerb = "view" | "address";

type AgentAccessDecision =
  | { allowed: true; basis: { kind: "grant"; grantId: string } | { kind: "default-open" } }
  | { allowed: false; reason: "tenant_boundary" | "target_hidden" | "missing_grant" | "platform_agent_unreachable" };

canAccessAgent(
  subject: AgentAccessSubject,
  targetAgentId: string,
  verb: AgentAccessVerb,
): Promise<AgentAccessDecision>;

listAccessibleAgents(
  subject: AgentAccessSubject,
  verb: AgentAccessVerb,
  options?: { includeAdminOnly?: boolean },
): Promise<Agent[]>;
```

A `listAccessibleAgents` és `canAccessAgent` ugyanazt a belső predicate-et használja. Tilos a C4 defaultot, a platform-agent kivételeket vagy a grant-feloldást külön-külön újraimplementálni a route-okban.

Normál tenant-agentre a predicate:

```text
user → target:
  tenant egyezik
  AND (
    target.inboundRestricted = false
    OR grant(subject=user, target, verb)=true
  )

source agent → target:
  tenant egyezik
  AND (
    (source.outboundRestricted = false AND target.inboundRestricted = false)
    OR grant(subject=agent, target, verb)=true
  )
```

A grant csak a benne igazra állított igét engedi. A másik boolean értéke ettől független. A döntés visszaadja az engedés alapját (`grantId` vagy `default-open`), hogy ugyanaz az adat kerüljön az auditba.

A gráf-gate az agent megszólításának **további** feltétele: nem írja felül a capability-checket, az agent státuszát, az orchestrator/delegálhatósági szabályt vagy a csatorna input-validációját. Tool-úton a sorrend:

1. hitelesítés és tenant-kontextus;
2. meglévő durva capability-check (`AllowlistAuthorizer`);
3. cél feloldása és csatorna-alkalmassága;
4. `canAccessAgent(..., "address")`;
5. végrehajtás és audit.

A meglévő `hiddenFromOperators` mező katalógus-alkalmassági szabály marad: non-admin user `view` listáján a gráf előtt szűr, és grant nem írja felül. Az `address` döntést nem befolyásolja, ezért egy agent továbbra is lehet nem listázható, de explicit módon megszólítható. Az admin org-ábra management felületként ettől függetlenül minden tenant-gráfcsomópontot megkap.

#### Kikényszerítési chokepointok

| Chokepoint | Subject → target | Ige | Lista vagy explicit próba |
| --- | --- | --- | --- |
| `formatOrgRoster` system-prompt névsor | agent→agent | `address` | szűrt lista |
| `agent_catalog` lista | agent→agent | `view` | szűrt lista |
| `agent_resolve` találatok | agent→agent | `view` | lista; explicit egyedi feloldásnál deny-szemantika |
| `agent_ask` | agent→agent | `address` | explicit |
| `ticket_create` agent-felelőssel | agent→agent | `address` | explicit |
| `web_research_request` a tenant Web-Egress felé | agent→agent | `address` | explicit |
| agent-chat stream indítása | user→agent | `address` | explicit |
| operátori agent-katalógus (`listAgents`) | user→agent | `view` | szűrt lista |
| felelős-választó (`listBoardAssignees`) | user→agent | `address` | szűrt lista |
| `agents/suitable` ajánlás | user→agent | `address` | szűrt lista |

A prompt-roster szándékosan `address`, nem `view`: ez a modell cselekvési listája, ezért nem kínálhat olyan kollégát, akit a hívó agent nem szólíthat meg. A mai szűretlen `findMany()` hívásokat a közös `listAccessibleAgents(..., "address")` váltja fel; más tenant agentjének neve, persona-traitje és ID-ja nem kerülhet a system promptba.

A felelős-választó és a „suitable” ajánló is `address` alapján szűr, így a UI nem kínál utólag elutasított célpontot.

#### Elutasítási szemantika

Az explicit célpróba csak annyit fed fel, amennyit a subject `view` joga már enged:

- ha `view` engedett, de `address` nem: HTTP-felületen 403; tool-válaszban tanulságos, nem újrapróbálkozó hiba — „Ehhez az agenthez nincs megszólítási jogod. Kérj adminisztrátori segítséget vagy add vissza a feladatot a felhasználónak.”;
- ha `view` sem engedett: 404-jellegű „Agent nem található”; a cél létezése nem szivárog;
- szűrt listából kimaradó agentre nem keletkezik deny-esemény.

A domain-hibák stabil kódokat kapnak (`AGENT_ACCESS_FORBIDDEN`, `AGENT_NOT_FOUND`), a route/tool adapterek ezekből képeznek HTTP- vagy tool-választ. Nyers `Error` szöveg nem lehet a policy szerződése.

#### Audit

Minden célzott hozzáférési döntés és minden policy-módosítás strukturált esemény:

| Esemény | Mikor | Kötelező mezők |
| --- | --- | --- |
| `agent.access.granted` | sikeres explicit chat/delegálás/ticket | `tenantId`, subject type/id, `targetAgentId`, `verb`, `channel`, `decisionBasis: grantId | default-open`, correlation/ticket/conversation id |
| `agent.access.denied` | sikertelen explicit célpróba | ugyanazok + `reason`, `disclosure: forbidden | not_found` |
| `agent.access.bypass` | folyamat útja átmegy, de a shadow ad-hoc check elbukna | process/playbook/run id + shadow döntés és subject/target |
| `agent_access.grant.create` | admin létrehoz vagy bővít egy élt | actor, subject, target, előző/új `canView` és `canAddress`, grantId |
| `agent_access.grant.revoke` | admin szűkít vagy töröl egy élt | actor, subject, target, előző/új érték, grantId |
| `agent_access.restriction.update` | admin kapcsolót vált | actor, agentId, inbound/outbound előző és új értéke |

Az `agent.access.denied` és `agent.access.granted` `channel` értéke `chat | agent_ask | ticket | web_research`; a `web_research_request` mindig `web_research`. A csatorna adat, ezért egyik út sem kap külön eseménynevet.

A sikeres elérés naplózása az engedő éllel teszi utólag rekonstruálhatóvá a C1 szerinti confused-deputy láncot. A kezdeményező ember, ha feloldható, auditkorrelációként megőrzendő, de **nem** authorization subjectként öröklődik tovább.

Grantot és restriction-kapcsolót csak tenant admin módosíthat. Superadmin csak assume-tenant kontextusban, a tenant nevében járhat el. A grant táblába írás és az audit-esemény ugyanabban a tranzakciós/outbox határban történik.

#### Playbook- és Monitor-megkerülő út

A folyamat-definíció maga a runtime principal jogosítványa; ezért a Playbook/Process és Monitor-cron út nem áll meg az ad-hoc gráf deny döntésénél. Ez nevesített kockázat, három kompenzáló kontrollal:

1. az org-ábra a folyamatból eredő éleket külön vizuális csatornán mutatja;
2. Playbookot tervezni/szerkeszteni csak szűk, dedikált jogosultsággal lehet;
3. a folyamat-motor minden agent-elérésnél shadow módban lefuttatja az ad-hoc `canAccessAgent` ellenőrzést, és deny esetén `agent.access.bypass` eseményt ír.

A shadow check auditál, de nem blokkolja a folyamatot. Ha később enforcementté válna, az külön policy-döntés és migráció.

#### Platform-agentek

Két kategória eltérő szabályokkal:

1. **Dedikált-panel varázslók** — Playbook Author, Provisioning Assistant, Skill Distiller/Review:
   - egy közös `tenantId = null` példány marad;
   - nem gráfcsomópont, és chatből, ticketből, katalógusból vagy `agent_ask`-ból nem érhető el;
   - csak a saját, jogosultsággal védett server actionje indíthatja;
   - a korábbi „`tenantId=null` minden tenantból elérhető” tool-kivételt meg kell szüntetni.
2. **Web-Egress**:
   - tenantonként materializált, normál tenant-agent és teljes gráfcsomópont;
   - provisioningkor `inboundRestricted=true`, `outboundRestricted=true` és a connector/capability sablon létrejön;
   - csak agent→Web-Egress `address` granttal hívható a `web_research_request`;
   - user→Web-Egress `view`/`address` nincs a napi felületeken;
   - kimenő él nem hozható létre, mert egyirányú szolgáltató;
   - az org-ábrán és admin kormányzási felületen látszik, az operátori katalógusban, felelős-választóban és chat-indítóban nem;
   - Provisioning „discover” a tenant példányán, admin panel-actionnel fut; ez nem `address` grant.

Nincs tenantközi agent-él, ezért kétoldalú tenant-jóváhagyási protokoll sem szükséges. A `AgentAccessGrant.tenantId` mindig a subject és target közös tenantja.

#### Org-ábra szerkesztő

Az admin felület szabad vásznas, node-link szerkesztő:

- felül külön user-sáv, alatta agent-csomópontok;
- management felületként minden tenant-agentet mutat, beleértve a `hiddenFromOperators` és admin-only Web-Egress csomópontokat is;
- kék `V` fogantyú hozza létre vagy kapcsolja be a `view` jogot;
- bordó `A` fogantyú hozza létre vagy kapcsolja be az `address` jogot;
- subject-target páronként legfeljebb két, párhuzamos sáv látszik; az irányt nyíl jelöli, nem négy átfedő él;
- az ige levétele sávonkénti törlés; ha mindkettő lekerül, a grant sora törlődik;
- jobb oldali Focus-panel mutatja az `inboundRestricted`/`outboundRestricted` állapotot, a bejövő/kimenő explicit és implicit kapcsolatokat, folyamat-éleket és az elérhetőségi kúpot;
- szűrők: `view`, `address`, folyamat; egy konkrét Playbook külön kiválasztható;
- a folyamatból származó él vizuálisan nem keverhető össze a gráf grantjával, és nem szerkeszthető grantként.

Restriction bekapcsolása előtt kötelező dry-run előnézet mutatja:

- mely jelenlegi implicit kapcsolatok szűnnek meg;
- mely aktív chat/ticket/delegációs utak érintettek;
- mely explicit éleket kellene megtartani;
- a változás után mekkora lesz az elérhetőségi kúp.

A művelet megerősítést kér, de nem generál automatikusan éleket.

#### Tranzitív elérhetőségi kúp

A kúp a C1 biztonsági hatását mutatja, nem külön authorization szabály:

- teljesen default-open útvonalon a UI nem rajzol implicit N² élt; bannert mutat: **„Nincs korlátozás; ez a jog az egész tenant agenthálózatára kiterjed.”**;
- korlátozott gráfban őszinte bejárás fut: ahol mindkét releváns kapcsoló nyitott, implicit él; ahol bármelyik zárt, csak megfelelő explicit `address` grant;
- ciklus engedett, a bejárás visited-halmazzal minden agentet egyszer vesz fel; a szerkesztő a visszacsatolást külön jelzi;
- nincs policy-szintű mélységplafon; legalább 5 hopos kúpra soft figyelmeztetés jelenik meg;
- külön cache-tábla nincs. A szerver és a kliens ugyanazt a tiszta reachability-algoritmust használja: szerveren egyedi döntésekhez, kliensen a betöltött gráfmásolaton a kúp megjelenítéséhez.

A futó delegáció maximális mélysége/időkerete nem hozzáférési él-szabály, hanem külön runtime-védelem.

#### User story-k

1. Tenant adminként konkrét user→agent és agent→agent `view`/`address` kapcsolatokat akarok szerkeszteni, hogy az org-ábra pontosan a tényleges policy legyen.
2. Tenant adminként bekapcsolás előtt látni akarom, mely utak szűnnek meg és mekkora kúpot engedek meg, hogy ne okozzak rejtett működési hibát vagy túl széles delegációt.
3. Operátorként csak azokat az agenteket akarom látni, amelyekhez `view` jogom van, és csak azokat kiválasztani, amelyeket meg is szólíthatok.
4. Agentként csak megszólítható kollégák kerüljenek a prompt-rosterembe, hogy ne próbáljak tiltott delegációt.
5. Agentként értelmes hibát akarok kapni, ha egy látható, de nem megszólítható célt próbálok hívni, és nem akarok tudomást szerezni rejtett agentek létezéséről.
6. Biztonsági felelősként minden sikeres és sikertelen explicit hozzáférést az engedő éllel vagy `default-open` alappal akarok auditálni.
7. Compliance-felelősként látni akarom, ha egy Playbook olyan agent-utat használ, amelyet az ad-hoc gráf nem engedne.
8. Tenant adminként a Web-Egress használatát explicit opt-inként akarom engedélyezni, miközben azt user közvetlenül nem címezheti.

#### Elfogadási feltételek

- Ugyanaz a tesztmátrix fut user és agent subjecttel, mindkét igére, nyitott/zárt inbound/outbound kombinációkkal.
- Cross-tenant target minden esetben tiltott, függetlenül a grant-adattól.
- `view=false, address=true` és `view=true, address=false` külön teszteset, egyikből sem következik a másik.
- A szűrt listák eredménye megegyezik az elemenkénti `canAccessAgent` döntések halmazával.
- Prompt-rosterben csak `address`-engedett, aktív, csatorna-alkalmas tenant-agentek vannak.
- Explicit deny `view` függvényében determinisztikusan 403 vagy 404; lista-szűrés nem ír deny auditot.
- Sikeres explicit elérés auditja tartalmaz `grantId`-t vagy `default-open` értéket.
- Grant- és restriction-módosítás csak adminnak engedett és auditált.
- Panel-varázsló tool-úton nem érhető el; tenant Web-Egress csak explicit agent→agent `address` granttal.
- Ciklusos gráf terminál, 5 hopnál UI-warning jelenik meg, de a policy nem vágja el az utat.
- Restriction dry-run és megerősítés nélkül nem kapcsolható be az admin UI-ból.

## Rögzített invariánsok

1. **SoD:** `approver ≠ createdById` — a kérelmező sosem hagyhatja jóvá a sajátját.
2. **Jog-horgony:** az approval-jog **capability + risk-osztály + SoD**; a `assigneeId` **csak routing/inbox**, nem jogforrás.
3. **Osztály-levezetés:** a ticket kockázati/művelet-osztálya **determinisztikusan** a terv célzott gated-capability `riskTier`-jéből jön (a Folyamat előre is deklarálhatja korai routinghoz); az intake puha, **nem** jogforrás. Alul-osztályozás lehetetlen, mert az osztály a platform által számolt függvény, nem LLM-állítás; egy nem-gated tervet célzó út inert (nem tudja a nagy-kockázatú műveletet elvégezni).
4. **Trigger:** determinisztikus platform-hook jóváhagyáskor (**LLM nincs a triggerben**), aszinkron (`EXECUTION_STARTED` → dispatcher → eredmény → closure); az agent csak utólag, a nem-érzékeny closure/notify-ra.
5. **Kapu megjelenése:** automatikus a `riskTier`-ből + **látható + felülírható** a kanavászon (convention over configuration, de nem rejtett).
6. **Step-up:** magas tier → friss újra-hitelesítés kötelező a jóváhagyáskor, a tierből levezetve, az approval-rekordhoz + plan-hash-hez kötve.
7. **Approval-inbox:** osztály-szintű jóváhagyási sor (az osztály `approve`-jogú userei látják a `READY_FOR_APPROVAL` ticketeket), nem egyénhez rendelt.

### A végrehajtási képesség szerződése (a modul oldalán kikényszerítve)

A platform reference-only hív; a **modul a végső hatóság** és fail-closed újra-ellenőriz:

- ticket létezik + `APPROVED`; approval érvényes, ehhez a tickethez tartozik, van friss step-up esemény;
- **plan-hash** újraszámítás a befagyasztott tervből → egyeznie kell az approval-lal (integritás);
- előfeltételek **még mindig állnak** (frissesség);
- acting-user user-szintű joga (on-behalf-of);
- **idempotencia** (a művelet nem automatikusan idempotens): a modul execution-rekordot vezet; `IN_PROGRESS`/`SUCCEEDED`/`UNCERTAIN`/`FAILED_TERMINAL` esetén **nem futtat újra**; bizonytalan (timeout) eredmény → `UNCERTAIN`, **nincs auto-retry**, emberi egyeztetés;
- a modul **atomikusan** írja a saját nyilvántartását, és ő bocsátja ki az érzékeny értesítést.

## User Stories

1. Platform-adminként konkrét user→agent és agent→agent `view`/`address` kapcsolatokat akarok beállítani, hogy a kérelmező csak a beviteli agentet, az agent pedig csak a jóváhagyott delegációs célokat érje el.
2. Platform-adminként be akarom állítani, hogy egy szerep csak a **saját** ticketjeit lássa, hogy a kérelmezők ne lássák egymás kéréseit.
3. Jóváhagyóként csak a **jóváhagyásra váró** (`READY_FOR_APPROVAL`) ticketeket akarom látni egy osztály-szintű sorban, hogy ne kelljen keresgélnem.
4. Biztonsági felelősként azt akarom, hogy a kérelmező **soha** ne hagyhassa jóvá a saját kérését, hogy a négy-szem elv kikényszerüljön.
5. Folyamat-szerzőként azt akarom, hogy egy gated képességet célzó lépés **magától** jóváhagyás-kapuzottá váljon és a kanavászon látszódjon, hogy ne felejthessem el a kaput.
6. Folyamat-szerzőként a jóváhagyó szerepet **felül akarom tudni írni** egy adott folyamatra, hogy a levezetett alapot finomíthassam.
7. Jóváhagyóként a döntés pillanatában **friss újra-hitelesítést** akarok, hogy egy nyitva felejtett session ne hagyhasson jóvá helyettem.
8. Platform-üzemeltetőként azt akarom, hogy a jóváhagyás **pontosan a bemutatott tervet** engedélyezze, és ha a terv változik, az engedély érvénytelen legyen.
9. Platform-üzemeltetőként azt akarom, hogy a jóváhagyás után a végrehajtás **LLM nélkül, determinisztikusan** induljon, hogy ne legyen elmaradó/kései/dupla hívás.
10. Agent-fejlesztőként azt akarom, hogy az agent az érzékeny adatot **ne is kapja meg** — a modul csak nem-érzékeny referenciát adjon vissza —, hogy a kulcsanyag ne utazzon a platformon át.
11. Compliance-felelősként a teljes láncot (kérés → osztály → jóváhagyó + step-up → végrehajtás → eredmény → lezárás) auditálni akarom, hogy rekonstruálható legyen.
12. Platform-adminként azt akarom, hogy a policy **kevés helyen** konfigurálódjon (agent-gráf egyszer, capability-gating egyszer), a többi **levezetett** legyen, hogy ne legyen bonyolult üzemeltetni.
13. Platform-üzemeltetőként azt akarom, hogy egy **bizonytalan** (timeout) végrehajtás ne induljon újra automatikusan, hanem emberi egyeztetésre várjon, hogy ne jöjjön létre dupla művelet.
14. Folyamat-futtatóként azt akarom, hogy ugyanez a garancia az **ad-hoc** (chatben feladott) ticketre is érvényes legyen, ne csak a strukturált Folyamatra.

## Implementation Decisions

A grillezés során rögzített döntések (a `## Rögzített invariánsok` normatív; itt az indoklás):

- **D1 — SoD kikényszerítés.** `approver ≠ createdById` kemény invariáns; az approval külön képesség, nem jár a tulajdonlással. *Indok:* a KeyOps teljes modellje a kérelmező≠jóváhagyó elven áll.
- **D2 — Jog-horgony = capability + osztály + SoD.** A hozzárendelés csak routing. *Indok:* a hozzárendelés integritása nem megbízható az ad-hoc úton (self-assign/haver-routing); a valódi kényszer a végrehajtási capability-chokepoint (tool-broker gate + modul re-verify).
- **D3 — Osztály determinisztikus levezetése a `riskTier`-ből (+ opcionális Folyamat-előredeklaráció).** *Indok:* az intake puha marad; az alul-osztályozás lehetetlen, mert az osztály a célzott képességből számolt.
- **D4 — Determinisztikus trigger jóváhagyáskor, LLM nélkül; agent csak utólag closure/notify.** *Indok:* a modul úgyis re-verifikál + idempotens, az agent a triggerben csak fölösleges nem-determinizmust adna. Az agent eredeti motivációja (nyilvántartás-kitöltés) elesett, mert a **modul** írja a nyilvántartást.
- **D5 — Kapu automatikus + látható + felülírható.** *Indok:* a teljesen automatikus „mágia" nem áttekinthető, a kézi huzalozás felejthető; a látható-levezetett kapu biztonságos **és** felhasználóbarát.
- **D6 — Friss step-up a jóváhagyáskor, tierből levezetve, Clerk reverification-ből.** *Indok:* ez zárja be az approval-integritást (session-eltérítés az egyetlen maradó rés); generikus, nem KeyOps-kód.
- **D7 — Osztály-szintű jóváhagyási sor.** *Indok:* következik a D2-ből; az ad-hoc utat is tisztán fedi.

## Nemfunkcionális követelmények

- **Közérthető, önmagyarázó UI:** hétköznapi magyar szöveg, magyarázó dobozok, üres állapotok és példák; a felhasználónak nem kell ismernie a `view`, `address`, inbound/outbound vagy principal szakkifejezéseket.
- **Biztonságos szerkesztés:** restriction bekapcsolása és nagy kúp létrehozása előtt dry-run előnézet, hatásösszegzés és megerősítés.
- **Konzisztens policy:** lista és explicit gate ugyanabból a forrásból; UI-elrejtés önmagában sosem kontroll.
- **Tenantizoláció:** minden hozzáférési query tenant-scoped; cross-tenant grant hibás adat esetén is fail-closed.
- **Auditálhatóság:** a hozzáférési döntés és az azt engedő grant/default-open alap korrelálható a chat-, ticket-, tool- és process-run rekordokkal.
- **Teljesítmény:** tucat–pár száz agentes tenantnál a döntés indexelt adatbázis-lekérdezéssel, a kúp cache nélkül számolható; N+1 lekérdezés nem megengedett a listákon.
- **Tesztelhetőség:** a policy-mag tiszta, adapterfüggetlen függvényként unit tesztelhető; minden chokepoint contract/integration tesztet kap.
- **Hozzáférhetőség:** a két jog nem csak színnel különül el; a fogantyúk felirata, ikonja, fókuszállapota és billentyűzetes művelete elérhető.

## KeyOps referencia-konfiguráció

A generikus képességek KeyOps-leképezése (a domain a modulban). A sorok konfigurációs sablonok; az `agent-scope` grantjai ténylegesen konkrét userekhez jönnek létre, nem szerep-alanyhoz:

| KeyOps szerep | `agent-scope` | `ticket-scope` | `action-set` |
|---|---|---|---|
| **PM** | konkrét PM user→intake/Sec-Officer agent: `view` + `address` | `own` | `initiate`, `answer_clarification` |
| **KMO / Approver** | szükséges célokra konkrét user-grantok; nincs implicit szerep-`all` | `all` + approval-sor (`READY_FOR_APPROVAL`) | `approve`, `reject`, `request_clarification`, `execute`, `view_audit` |

- A **HSM Manager** és a **Department Head** privilegizált governance-e (120p aktivációs ablak, KMO-kinevezés) a **modulban** marad, nem ebben a platform-authz-ban.
- A végrehajtási képesség = a modul reference-only connectora/MCP-je (`keyops_execute_ticket(ticket_id)`); a modul re-verifikál + idempotens + írja a Key Registryt + kibocsátja a kulcs-cryptogramot hordozó értesítést.

## Vállalt eltérés a KeyOps-spectől

A Clerk-választással a KeyOps-**a-platformon** *nem* a payShield-spec §11 szerinti on-prem, self-contained, corporate-IdP-független appliance. Ez tudatos kompromisszum (általános platform Clerk identitással + MFA-val + reverification-nel). Ha a szigorú on-prem appliance külön követelmény, azt külön kell kezelni (az identitás a modulba csúszik).

## Out of Scope (a modulban, nem platform-munka)

Key Registry domain, payShield bináris TCP/IP HSM-tool, HSM command-katalógus/template-ek, HSM Manager / Department Head privilegizált governance, LAK/TOTP-seed HSM-védelem, a kulcsanyagot hordozó érzékeny értesítések kibocsátása.

## Build-időben ellenőrizendő tények (nem döntések)

- a gate-réteg olvassa-e már a `riskTier`-t az `await_human` kiváltásához (ha igen, ez annak kiterjesztése, nem új mechanizmus);
- a Folyamat-runtime tud-e LLM nélküli tool-lépést futtatni (a `board_write`/tool-lépés mintája alapján valószínű);
- a Clerk reverification API elérhető-e és a step-up-esemény id beköthető-e az approval-rekordba;
- a ticket `createdById`/requester mező az `own`-scope-hoz — **megvan** (a séma tartalmazza `createdById` + `assigneeType`/`assigneeId`).

## Javasolt fejlesztési sorrend

1. Agent-hozzáférési gráf: Prisma modell és migráció → közös `canAccessAgent`/`listAccessibleAgents` modul → valamennyi chokepoint és audit → admin org-ábra, dry-run és tranzitív kúp. Ezután a fennmaradó ticket-scope/action-set policy.
2. Governed action step a Governed Flow Builderben (reference-only kötés + automatikus-látható-felülírható kapu + determinisztikus on-approve trigger).
3. Step-up integráció (Clerk reverification → approval-rekord kötés).
4. On-behalf-of identitás-átadás bekötése a végrehajtási connectorra + érzékeny-válasz minimalizálás ellenőrzése.
5. KeyOps referencia-konfiguráció rákötése (a modul mint külön app).
