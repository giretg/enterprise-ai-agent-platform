# Feature-spec - Tenant Management, tenant-valtas es platform-szintu adminisztracio

**Statusz:** implementalva — Fazis A-E kesz (elfogadasi kriteriumok §13 teljesitve);
egyetlen fokozatos, nem-blokkolo hatralek a `tenantId` DB-szintu not-null szigoritas (§11.1/E)  
**Datum:** 2026-07-05  
**Forrasok:** `AI-Agent-Platform-Koncepcio.md` 4.12.1, 4.14, 8.8; `AI-Agent-Platform-Feature-Spec-IAM-RBAC-done.md`; jelenlegi kod: `app/prisma/schema.prisma`, `app/src/auth/*`, `app/src/domain/iam/iam-service.ts`, `app/src/app/actions/platform.ts`, connector/provisioning/model-gateway/platform-settings modulok.

## 0. Implementacios statusz (2026-07-05)

Az elso resz (adatmodell + tiszta logika + domain-service + auth-kontekstus vaz)
elkeszult, forditodik (`tsc` tiszta), lintel es a tiszta-logika tesztek zoldek.
A tenant-kontekstus mar a kodban van, de a felhasznaloi feluletek es a
platform/tenant guard-atvagas MEG NEM tortent meg — a legacy `requireRole`-os utak
valtozatlanul mukodnek (visszafele kompatibilis).

**KESZ (ebben a korben):**
- [x] §4.1 Uj Prisma modellek: `Tenant`, `TenantMembership`, `PlatformMembership` + enumok
  (`TenantStatus`, `TenantMembershipStatus`, `PlatformRole`, `PlatformMembershipStatus`);
  `User`-relaciok. Prisma client generalva. *(migracio/`db push` MEG NEM futott — holnap.)*
- [x] §4.2 Connector `@@unique([type, name])` → `@@unique([tenantId, type, name])` bug-fix;
  az osszes hivasi hely atvezetve (`src/lib/connector-upsert.ts` helper a nullable-tenant
  compound-kulcs korlat kezelesere).
- [x] §5, §7 tiszta logika: `src/lib/tenant-policy.ts` (`resolveActiveTenant`, `decideSwitch`,
  platform-role rangsor, tenant-status kapuk, utolso-admin lock, slug/domain validacio)
  + 28 zold teszt: `scripts/tenant-management.test.ts` (`npm run test:tenant-management`).
- [x] §7, §8, §10 domain: `src/domain/tenant/tenant-service.ts` (`TenantService`:
  createTenant, lifecycle suspend/offboard/archive/reactivate, membership CRUD +
  utolso-admin lock, superadmin assume/exit audit); regisztralva a `services`-be.
- [x] §10 repository-k: `TenantRepository`, `TenantMembershipRepository`,
  `PlatformMembershipRepository` (interface + postgres impl + wiring).
- [x] §5.1–5.4 auth-kontekstus: `src/auth/context.ts` (`getAuthContext`, `active_tenant_id`
  cookie, legacy-fallback §11.2/§13-9), `src/auth/tenant-context.ts`
  (`requireTenantRole`, `requirePlatformRole`).
- [x] §5.3, §7, §8 server actions: `src/app/actions/tenant.ts` (`switchTenant`, `exitTenant`,
  `getTenantSwitcherState`, tenant lifecycle platform-guard alatt, membership tenant-guard alatt).

**KESZ (2. kor, 2026-07-05):**
- [x] §11.1 `prisma db push` a dev + test Neon DB-re (additiv schema + `connectors`
  `@@unique([tenant_id,type,name])` index-csere; adatvesztes nelkul).
- [x] §11.1 migracios adatatmozgatas: `scripts/backfill-tenant-demo.ts` (idempotens) —
  `demo` tenant fix UUID-del (`00000000-0000-4000-a000-000000000001`), minden aktiv userre
  `demo` membership (role=User.role), egy dev-superadmin platform-membership
  (`DEV_SUPERADMIN_EMAIL` / `admin@excellence.ai`), es a tenant-scope tablak `tenant_id IS NULL`
  sorai → demo. KIVETEL (null marad): connector_templates, role_templates,
  model_routing_policies, model_budgets (platform-globalis §3.2) + audit_log (append-only,
  §11.2 "legacy"). Dev+test DB backfillelve.
- [x] Seed integracio: `prisma/seed.ts` `ensureDemoTenant()` — fresh seed is letrehozza a demo
  tenantot + membershipeket + dev-superadmint (idempotens upsert).
- [x] §9.1 UI: AppShell tenant-switcher (`src/components/tenant/tenant-switcher.tsx`) — kivaltja az
  `OSTOROSBOR` hardcode-ot; aktiv tenant nev + legordulo valto, superadmin "assumed" jeloles +
  "kilepes platform-modba". `AppShell` uj `headerExtra` slot.
- [x] §9.2 Platform route: `/control-plane/platform/tenants` (+ `/platform` redirect) —
  `PlatformTenantPanel` (tenant-lista + create-form + suspend/offboard/archive/reactivate),
  mind a `requirePlatformRole` guard alatti actionokon. Nav-link a control-plane fejlecben.

**KESZ (3. kor, 2026-07-05 — Fazis C+D+E):**
- [x] §5.4 `requireTenantPermission(permissionKey)` guard: a `role_permissions` matrixbol oldja
  fel a minimum szerepet, es az AKTIV tenant-szerepre (membership / superadmin assume) dont —
  nem a legacy `User.role`-ra; ismeretlen kulcs ⇒ tilt; deny audit `user.authz.deny`
  (`src/auth/tenant-context.ts`).
- [x] Fazis C: IAM actionok membership-scope atvagasa (§10) — `listUsers/listInvitations/
  inviteUser/revokeInvitation/approveUser/changeUserRole/suspendUser/reactivateUser/
  setUserJobDescription` mostmar `requireTenantPermission`-on at, az AKTIV tenant kontextusban
  (tenant-switch + superadmin-assume korrekt scope). Egytenantos demo-modban valtozatlan viselkedes.
- [x] §9.3 Platform IAM felulet: `/control-plane/platform/iam` — platform-tagok (superadmin/
  operator/auditor) lista, platform-szerep grant/revoke (utolso-superadmin lock), tenant-lifecycle
  + assume audit-naplo. Uj service: `listPlatformMembers/grantPlatformRole/revokePlatformRole`,
  repo `findAll/delete`, actionok `listPlatformMembers/getPlatformAuditTrail/grant/revokePlatformRole`.
- [x] Fazis D: platform-globalis WRITE-actionok atkotese `requirePlatformRole('superadmin')`-ra:
  dispatcher/db-mode/db-sync, model policy/routing/budget, ticket-type, monitor-controls,
  web-search/web-fetch kill-switch + web-search policy, valamint a GLOBALIS connector-sablon
  create/deprecate (§13/6 — tenant-sablon tenant-admin, globalis csak platform). Uj route
  `/control-plane/platform/settings` (platform-guard); a `/system` es a settings `canEdit`-je
  platform-szerephez kotve (tenant-admin read-only). Backfill: `DEV_SUPERADMIN_EMAILS` lista.
- [x] Fazis E: cross-tenant regresszios tesztcsomag (`scripts/tenant-isolation.test.ts`,
  `npm run test:tenant-isolation`, 13 zold) — IamService/TenantService in-memory mock-repokon:
  cross-tenant user/membership "not found" (N-IAM-6, §13/3), utolso-admin lock membership-alapon
  (§13/8), superadmin assume audit (§13/5), platform grant/revoke audit, registry slug-utkozes.

**MEG HATRA (fokozatos, §11.1/E — nem blokkolo):**
- [ ] `tenantId` DB-szintu NOT NULL szigoritas a tenant-scope tablakon + a repository-interface-ekbol
  a nullable `tenantId` kivezetese. Tudatosan halasztva: §11.2 szerint az atmenetben a `tenantId`
  nullable marad (legacy alias), a KEEP_NULL platform-globalis tablak (`connector_templates`,
  `role_templates`, `model_routing_policies`, `model_budgets`, `platform_settings`, `audit_log`)
  legitim modon tartanak null-t, es a not-null migracio adatvesztes-kockazatot hordoz. A guard-
  es service-szintu tenant-izolacio (fent) mar kikenyszeriti az elfogadasi kriteriumokat (§13).

## 1. Problema

Az alkalmazas ma mar sok helyen tartalmaz `tenantId` mezot, de nincs elso osztalyu tenant-modell es nincs koherens tenant-kontekstus:

- nincs `Tenant` entitas, csak sok optionalis `tenantId`;
- a `User` jelenleg egyszerre identitas, tenant-tagsag es szerepkor (`role/status/tenantId`);
- nincs tenant-valtas, mert egy userhez csak egy aktiv `tenantId` tartozik;
- a tenant-admin es a platform-superadmin ugyanabba az `admin` szerepbe keveredik;
- a `tenantId = null` tobb jelentest hordoz: globalis platform-eroforras, dev fallback, tenant nelkuli user, nehol "minden tenant";
- a rendszeroldali beallitasok (`platform_settings`, global connector-sablonok, dispatcher/model policy/web fetch kontrollok) tenant-admin szamara is elerhetok lehetnek, mert `requireRole('admin')` eleg;
- a tenant-szintu objektumok hozzarendelese userhez/tenanthez nem domain-muvelet, hanem szetszort szurofeltetel.

A koncepcio 8.8 szerint a by-design multi-tenancy alapelv: ket tenant nem osztozik agenten, Playbookon, connectoron, sessionon vagy beallitason. A megosztott control plane csak infrastruktura es kod, nem adat- vagy agent-megosztas.

## 2. Celallapot

Legyen explicit tenant-kezelese az alkalmazasnak:

1. A tenant egy ceg/ugyfel elso osztalyu entitasa.
2. Minden tenantnak sajat agentjei, Playbookjai, folyamatai, connectorai, knowledge base-ei, sandbox appjai, beallitasai es audit-nezete van.
3. Egy user tobb tenant tagja is lehet, es valthat az elerheto tenantok kozott.
4. A tenant-admin csak a sajat tenantjan belul admin.
5. A superadmin platform-szintu szerep, nem tenant-role. Platform-szintu konfiguraciot kezel: tenant provisioning, bepitett/provisioning agentek, global connector-sablonok, global model/dispatcher/web fetch policy, app-szintu feature flag, global audit/uzemeltetes.
6. A superadmin tenant-kontekstusba csak explicit "assume tenant" muvelettel lephet be, auditnyommal.
7. Minden tenant-scope-os query es mutation egy kozos tenant-kontekstuson megy at, nem kezzel adogatott optionalis `tenantId`-okon.

## 3. Dontesi javaslat

### 3.1 Ne `User.role = superadmin` legyen

Ne bovitsuk a `UserRole` enumot `superadmin`-nal. A `UserRole` mar tenant-szerepet jelent (`admin | approver | operator | viewer`). Ha ide kerulne a `superadmin`, minden `hasMinimumRole(role, 'admin')` hivas automatikusan tenant-adminnak tekintene a superadmint is, es osszemosna a platform- es tenant-jogokat.

Javaslat:

- `User` = globalis emberi identitasprofil.
- `TenantMembership` = tenanton beluli szerep es statusz.
- `PlatformMembership` = platform-szintu szerep es statusz.

### 3.2 A `tenantId = null` csak platform-globalis eroforrast jelenthet

Migracio utan:

- tenant-scope entitasnal `tenantId` kotelezo legyen;
- `tenantId = null` csak olyan tablakban maradhat, ahol valodi globalis fallback van: `ConnectorTemplate`, `RoleTemplate`, `ModelRoutingPolicy`, `ModelBudget` ha global policy, `PlatformSetting`, esetleg bepitett referencia-adat;
- user es invitation eseteben a tenant viszonyt ne `tenantId = null`, hanem membership hianya vagy pending membership jelentse.

Ez a legfontosabb izolacios tisztitas.

### 3.3 Elfogadott grilling dontesek

Az elso tervezesi korben az alabbi dontesek elfogadva:

1. Superadmin tenant-adatba csak explicit `assume tenant` utan irhat, audit mellett.
2. Superadmin soha nem impersonate-el mas usert; az actor mindig a superadmin, mellette `assumedTenantId` jeloli a tenant-kontekstust.
3. Tenantok kozti user-megosztas globalis `User` + tobb `TenantMembership` modellel tortenik.
4. Tenanton beluli csoport/team nem MVP-resz, de a modell ne zarja ki.
5. Platform-globalis connector template tenantba klonozhato, de az uj rekord tenant-scope es auditolt.
6. Model policy/budget kaphat tenant override-ot; dispatcher kill-switch platform-globalis marad.
7. Legacy `tenantId = null` tenant-scope sorok a migracioban a `demo` tenantba kerulnek.
8. Dedikalt instance-ban is marad `Tenant` modell, egyetlen tenanttal.
9. Clerk Organization / kulso IdP nem authorization truth source; az app DB a jog forrasa.
10. MVP-ben eleg a `superadmin` platform szerep, de a schema bovitheto enumot kap.

## 4. Adatmodell

### 4.1 Uj modellek

```prisma
enum TenantStatus {
  active
  suspended
  offboarding
  archived
}

enum TenantMembershipStatus {
  pending
  active
  suspended
}

enum PlatformRole {
  superadmin
  platform_operator
  platform_auditor
}

enum PlatformMembershipStatus {
  active
  suspended
}

model Tenant {
  id             String       @id @default(uuid()) @db.Uuid
  slug           String       @unique
  displayName    String       @map("display_name")
  legalName      String?      @map("legal_name")
  status         TenantStatus @default(active)
  domainAllowlist Json        @default("[]") @map("domain_allowlist")
  settings       Json         @default("{}")
  createdById    String?      @map("created_by") @db.Uuid
  createdAt      DateTime     @default(now()) @map("created_at") @db.Timestamptz
  updatedAt      DateTime     @updatedAt @map("updated_at") @db.Timestamptz

  @@map("tenants")
}

model TenantMembership {
  id          String                 @id @default(uuid()) @db.Uuid
  tenantId    String                 @map("tenant_id") @db.Uuid
  userId      String                 @map("user_id") @db.Uuid
  role        UserRole
  status      TenantMembershipStatus @default(pending)
  isDefault   Boolean                @default(false) @map("is_default")
  invitedById String?                @map("invited_by") @db.Uuid
  activatedAt DateTime?              @map("activated_at") @db.Timestamptz
  createdAt   DateTime               @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime               @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id])
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([tenantId, userId])
  @@index([userId, status])
  @@index([tenantId, role, status])
  @@map("tenant_memberships")
}

model PlatformMembership {
  id        String                   @id @default(uuid()) @db.Uuid
  userId    String                   @map("user_id") @db.Uuid
  role      PlatformRole
  status    PlatformMembershipStatus @default(active)
  createdAt DateTime                 @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime                 @updatedAt @map("updated_at") @db.Timestamptz

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, role])
  @@index([role, status])
  @@map("platform_memberships")
}
```

### 4.2 Meglevo modellek valtozasa

`User`:

- megtartja: `id`, `externalAuthId`, `email`, `name`, `jobDescription`, audit/profile mezok;
- deprecated: `role`, `status`, `tenantId`, `invitedById`, `activatedAt`, `suspended*`;
- atmenetileg compatibility mezok maradhatnak, de az igazsag forrasa a membership legyen.

`Invitation`:

- vagy `tenantId` kotelezo tenant-meghivonal;
- vagy kulon `TenantInvitation`, mert a meghivo valojaban membership-et hoz letre, nem usert;
- platform meghivohoz kulon `PlatformInvitation` vagy `scope = tenant | platform`.

Tenant-scope tablak:

- `Agent`, `Playbook*`, `Process*`, `Connector`, `ConnectorGrant`, `KnowledgeArtifact`, `Conversation`, `Ticket`, `ScheduledTask`, `MonitorDefinition`, `AuditLog`, `Sandbox*`, `BehaviorProfile`, `RetentionPolicy` hosszu tavon `tenantId String @db.Uuid` legyen, nullable nelkul.
- `ConnectorTemplate`, `RoleTemplate`, `ModelRoutingPolicy`, `ModelBudget` tarthat `tenantId String?`, de a `null` jelentese csak platform-globalis fallback.
- Tenant-scope egyedisegi indexekben a `tenantId` legyen benne. Konkret jelenlegi bug-jelolt: `Connector` most `@@unique([type, name])`, ez cross-tenant nevutkozest okoz. Cel: `@@unique([tenantId, type, name])`.
- Ugyanez auditot erdemel minden olyan egyedi kulcsnal, ahol a rekord tenant-scope, de az index nem tartalmaz tenantot.

## 5. Auth es tenant-kontekstus

### 5.1 AuthUser cel-tipus

```ts
type AuthUser = {
  id: string
  externalAuthId: string
  email: string
  name: string
  platformRoles: PlatformRole[]
  activeTenantId: string | null
  activeTenantRole: UserRole | null
  activeTenantStatus: 'pending' | 'active' | 'suspended' | null
}

type TenantAuthContext = AuthUser & {
  activeTenantId: string
  activeTenantRole: UserRole
  activeTenantStatus: 'active'
}

type PlatformAuthContext = AuthUser & {
  platformRoles: PlatformRole[]
}
```

### 5.2 Kontextus-feloldas

Legyen egy kozponti `getAuthContext()`:

1. Providerbol feloldja a subjectet (`Clerk`, dev provider, kesobb Keycloak).
2. Upserteli a globalis `User` rekordot.
3. Beolvassa a platform memberships sort.
4. Beolvassa a tenant memberships listat.
5. Meghatarozza az aktiv tenantot:
   - explicit session/cookie/header valasztas alapjan;
   - ha nincs, a default active membership;
   - ha egyetlen active membership van, automatikusan az;
   - ha nincs tenant, de van platform szerep, platform-kontekstus;
   - ha nincs egyik sem, pending/no-access allapot.

### 5.3 Tenant-valtas

Uj domain muvelet:

```ts
switchTenant(tenantId: string)
```

Szabaly:

- tenant tag csak sajat active membershipre valthat;
- superadmin barmely active tenantot "assume" modban valaszthat;
- minden superadmin assume es tenant exit auditalt: `tenant.assume`, `tenant.switch`, `tenant.exit`;
- a valasztott tenant session cookie-ba kerul: `active_tenant_id`;
- dev modban `DEV_AUTH_TENANT_ID` seedelheti az alap tenantot.

### 5.3.1 Clerk / kulso IdP viszony

A jelenlegi `syncClerkUser` helyesen abba az iranyba mutat, hogy az app DB a jog forrasa, a Clerk csak kulso subject/email/name forras. Ezt tartsuk meg:

- Clerk Organization hasznalhato UX/provisioning integraciora, de nem authorization truth source;
- Clerk publicMetadata-ban legfeljebb bootstrap/provisioning hint legyen, ne tartos tenant-role;
- tenant membership, platform membership, lock-out es audit dontes mindig a sajat DB-ben tortenjen;
- Keycloak/SCIM upgrade-pathnal ugyanez a kontraktus marad.

### 5.4 Kotelezo guardok

```ts
requireTenantRole(minimum: UserRole | UserRole[]): Promise<TenantAuthContext>
requireTenantPermission(permissionKey: string): Promise<TenantAuthContext>
requirePlatformRole(minimum: PlatformRole | PlatformRole[]): Promise<PlatformAuthContext>
requirePlatformPermission(permissionKey: string): Promise<PlatformAuthContext>
```

Migracios elv:

- a mai `requireRole()` marad compatibility wrapper, de csak tenant-kontekstusban mukodhet;
- platform-szintu action nem hasznalhat `requireRole('admin')`-t;
- uj kodban `requireTenantRole` vagy `requirePlatformRole` kotelezo.

## 6. Jogosultsagi modell

### 6.1 Tenant szerepek

A mai `UserRole` jelentese valtozatlan, de tenanton beluli:

- `viewer`: olvasas tenanton belul;
- `operator`: futtatas, ticket/folyamat kezeles;
- `approver`: jovahagyas, audit olvasas, write-gate approvals;
- `admin`: tenant konfiguracio, tenant user/provisioning, tenant connectorok, tenant agentek.

### 6.2 Platform szerepek

Minimum:

- `superadmin`: teljes platform-szintu konfiguracio es tenant lifecycle;
- `platform_operator`: uzemeltetesi kapcsolok, dispatcher/model/web-fetch monitorozas, de nem tenant-adat szerkesztes;
- `platform_auditor`: global audit/health read-only.

MVP-ben eleg lehet csak `superadmin`, de az enumot erdemes bovithetoen bevezetni.

### 6.3 Permission-matrix szetvalasztas

A mai `role_permissions` tenant-role matrix. Ezt vagy:

- atnevezzuk/ertelmezzuk `tenant_role_permissions`-kent, vagy
- bovitsuk `scope = tenant | platform` mezovel.

Javaslat: ket kulcster:

- `tenant:user.invite`, `tenant:agent.write`, `tenant:connector.write`;
- `platform:tenant.create`, `platform:connector_template.global.write`, `platform:settings.write`.

MVP-ben a platform permission matrix lehet kodolt `requirePlatformRole('superadmin')`, de a hosszu tavu cel adatvezerelt.

## 7. Tenant lifecycle

### 7.1 Tenant letrehozas

Csak superadmin:

```ts
createTenant({
  slug,
  displayName,
  legalName?,
  domainAllowlist?,
  initialAdminEmail?,
})
```

Mellekhatasok:

- `Tenant` rekord;
- default tenant settings;
- optionalis elso tenant-admin meghivo;
- optionalis starter agent/playbook/template materializacio;
- audit: `tenant.create`.

### 7.2 Tenant admin onboarding

Ket ut:

1. Superadmin letrehoz tenantot es meghivja az elso tenant admint.
2. Mar letezo tenant-admin hiv meg tovabbi tagokat.

Az "utolso admin" lock tovabbra is tenanton belul ellenorzott, de mar `TenantMembership` alapon.

### 7.3 Tenant felfuggesztes/offboarding

Tenant statusz:

- `suspended`: login lehet, tenant muvelet nem; superadmin visszaallithatja;
- `offboarding`: uj futas nincs, export/purge elokeszites;
- `archived`: read-only metadata, tenant-scope adat torolve vagy archivalva.

A meglevo `purgeTenantWorkspaces` csak sandbox workspace torles. Ez nem tenant offboarding. Kell kulon `TenantLifecycleService`.

## 8. Tenanthez rendeles

### 8.1 User tenanthez rendelese

User tenanthez rendelese = membership letrehozas vagy aktivalas.

Tenant-admin teheti a sajat tenantjan belul:

- meghivas emailre;
- pending user jovahagyasa;
- role/status change membershipen.

Superadmin teheti barmely tenantban, de auditban platform-aktorkent jelenjen meg.

### 8.2 Objektum tenanthez rendelese

Fo szabaly: tenant-scope objektum tenantja immutable legyen letrehozas utan.

Peldak:

- Agent nem mozgathato tenantok kozott. Clone/export-import lehet, de uj id-val es audit-esemennyel.
- Connector nem mozgathato tenantok kozott, mert secret/grant/provenance tenant-kotott.
- Knowledge artifact nem mozgathato tenantok kozott.
- Playbook sablon lehet platform-globalis template, de a tenantban materializalt Playbook mar tenant-kotott.

Ha tenyleg kell "atadas", az export/import, nem `tenantId` update.

## 9. UI

### 9.1 Tenant switcher

Az `AppShell` kapjon tenant switchert:

- lathato minden tobb tenanttal rendelkezo usernek;
- superadminnak lathato platform/tenant mod valaszto;
- aktiv tenant neve legyen a headerben, ne csak hardcoded `OSTOROSBOR`;
- tenant valtaskor redirect ugyanarra az oldalra, de uj tenant kontekstussal.

### 9.2 Platform admin felulet

Javasolt uj route:

```txt
/control-plane/platform
/control-plane/platform/tenants
/control-plane/platform/settings
/control-plane/platform/connector-templates
/control-plane/platform/provisioning
```

A mai `/control-plane/system` tartalmat szet kell valasztani:

- platform-globalis kapcsolok: platform route, `requirePlatformRole`;
- tenant-szintu policy/budget/connector/model beallitasok: tenant route, `requireTenantRole('admin')`.

### 9.3 IAM felulet

Tenant IAM:

- aktiv tenant tagjai;
- meghivok;
- role/status;
- job description;
- pending approvals.

Platform IAM:

- superadminok/platform operatorok;
- tenant lista;
- tenant assume audit.

## 10. API es service reteg

Uj modulok:

- `app/src/domain/tenant/tenant-service.ts`
- `app/src/repositories/postgres/tenant-repository.ts`
- `app/src/auth/context.ts`
- `app/src/auth/tenant-context.ts`
- `app/src/auth/platform-permission.ts`

Atalakitando hivasok:

- `listUsers`, `inviteUser`, `changeUserRole`, `suspendUser`: `TenantMembership` alapu;
- `listWorkspaceTenants`: megszunik, helyette `TenantRepository.findMany`;
- `purgeTenantWorkspaces`: csak workspace purge marad, tenant offboarding kulon;
- `adminUpsert...` platform/system actionok: `requirePlatformRole`;
- connector-template global create: csak platform role; tenant template create: tenant admin.

## 11. Migracio

### 11.1 Fajdalommentes fazisok

**Fazis A - additive schema**

- `Tenant`, `TenantMembership`, `PlatformMembership` hozzaadas;
- migration script:
  - letrehoz egy `demo` tenantot, es minden legacy `tenantId = null` tenant-scope sort ebbe mozgat;
  - minden letezo nem-null `users.tenant_id` alapjan `Tenant` placeholdert hoz letre;
  - `users.role/status/tenant_id` alapjan membership;
  - `tenantId = null` active admin/dev userbol `demo` tenant membership legyen, ne platform admin automatikusan;
- dev seed: egy `demo` tenant + egy tenant admin + opcionais superadmin.

**Fazis B - auth context**

- `getAuthContext`, `requireTenantRole`, `requirePlatformRole`;
- `requireRole` compatibility wrapper;
- tenant switch action + cookie.

**Fazis C - IAM atvagas**

- user list/invite/approve/suspend/change role membership alapu;
- UI-ban tenant switcher es tenant IAM.

**Fazis D - platform route szetvalasztas**

- `/system`, provisioning global funkciok, global connector-template, dispatcher/model/web controls athelyezese platform guard ala;
- tenant-szintu beallitasok explicit tenant guard ala.

**Fazis E - tenantId nullable felszamolas**

- tenant-scope modellekben `tenantId` not null;
- repository interface-ekbol optionalis tenantId kivezetese;
- ESLint vagy kodreview szabaly: tenant-scope repository method nem fogadhat `undefined` tenantot.

### 11.2 Visszafele kompatibilitas

Atmenetileg:

- `AuthUser.role` es `AuthUser.tenantId` maradhat deprecated alias az aktiv membershipre;
- regi actionok mukodhetnek egytenantos dev/demo modban;
- audit es model call riportok a regi null tenant sorokat `legacy` tenantkent jelenithetik meg.

## 12. Tesztstrategia

Unit:

- tenant switch dontesi logika;
- membership role/status gate;
- platform role gate;
- utolso tenant-admin lock;
- superadmin assume tenant audit;
- `tenantId = null` policy validacio.

Integration:

- tenant A admin nem lat tenant B usert/agentet/connectorot;
- tenant A admin nem hozhat letre global connector template-et;
- superadmin platform beallitast modosithat, tenant admin nem;
- superadmin tenant assume utan tenant-scope listak az assumed tenantot mutatjak;
- user ket tenant membershipgel valtani tud;
- suspended tenantban nincs agent run / connector use / model call.

Regression:

- `per-user connector grant` tenant/user/connector kulcs megmarad;
- Tool Broker authorizacio actor user + active tenant szerint dont;
- scheduled/run-as grant nem mukodik mas tenantban;
- audit export tenant-szurve es platform-szinten is determinisztikus.

## 13. Elfogadasi kriteriumok

1. Van `Tenant` registry es platform admin tenant lista.
2. Egy user tobb tenant tagja lehet, es UI-bol tud tenantot valtani.
3. Tenant-admin csak sajat tenant objektumait latja es kezeli.
4. Superadmin platform-kontekstusban tud globalis beallitasokat kezelni.
5. Superadmin tenant-kontekstusba lepes audit-esemennyel tortenik.
6. Globalis connector-sablont tenant-admin nem tud letrehozni vagy modositani.
7. Tenant-scope agent, connector, Playbook, conversation, ticket, sandbox app nem oszthato meg tenantok kozott.
8. Az utolso aktiv tenant-admin lock mukodik membership alapon.
9. A regi egytenantos demo/seed mukodik a migracio utan.
10. A tesztek bizonyitjak, hogy nincs cross-tenant read/write az erintett fo feluleteken.

## 14. Lezart grilling dontesek

A korabbi grilling kerdesekre adott javaslatok elfogadva, lasd a 3.3 szakaszt. Nyitott dontes jelenleg nincs; a kovetkezo lepes az implementacios bontas es PR-sorrend veglegesitese.

## 15. Javasolt implementacios sorrend

1. Additiv Prisma schema + migration script + seed.
2. `TenantService` es `AuthContext` bevezetese.
3. Tenant switcher cookie/action + AppShell header.
4. IAM membership atvagas.
5. Platform guard es platform route bevezetese.
6. Global-vs-tenant connector template/provisioning policy szigoritas.
7. Repository-k tenantId not-null szigoritasa fokozatosan.
8. Cross-tenant regresszios tesztcsomag.


