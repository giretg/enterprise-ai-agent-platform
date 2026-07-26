# perf: paginálás / hard limit a korlátlan listalekérdezéseken

> **Állapot (2026-07-26):** implementálva a control-plane hot pathokon —
> shared `list-pagination` helper, `listPage`/`count` a ticket/agent repo-n,
> limitált process/IAM/playbook/recipe listák, slim playbook versionCount,
> dashboard `count`, active-runs DB `take`. Regresszió: `npm run test:list-pagination`.

## Üzleti / UX hatás

Több control-plane lista (ticket board, agent registry, process/recipe/playbook katalógus) **az összes sort** behúzza. Ahogy nő a tenant adatmennyisége, az oldalak lassulnak vagy timeoutolnak, a Neon IO és a Cloud Run memória nő — a felhasználó „befagyott listát” lát.

## Kontextus

Ismert unbounded `findMany` minták (audit 2026-07-25):

| Hely | Probléma |
|------|----------|
| `ticket-repository` listák | nincs alapértelmezett `take` |
| `agent-repository.findMany` | összes agent, teljes sor |
| `process-repository` | tenant összes process instance |
| `iam-repository` | users / invitations unbounded |
| `recipe-repository` | összes recipe + összes version |
| `playbook-v2-repository` | összes playbook + version |

Kapcsolódó: `docs/perf/optimization-plan.md` P2 / medium batch.

## Javasolt megoldás

1. Cursor- vagy offset-alapú paginálás a repository interfészeken (default `take`, pl. 50–100).
2. UI: „Továbbiak betöltése” / infinite scroll ahol már van minta (sandbox lista).
3. Admin export útvonalak külön, explicit „full dump” flaggel — ne az alap lista legyen az.
4. Slim `select` a listanézetekhez (ne full row + nested versions).

## Elfogadási kritériumok

- [x] A fenti listák alapból limitáltak; teljes dump csak explicit admin/export úton (`unbounded: true`).
- [x] UI nem törik el üres / egyoldalas / többoldalas adaton (board `hasMore` figyelmeztetés).
- [ ] Nagy tenant fixture-rel (pl. 1k+ sor) a lista p95 elfogadható marad. *(mérés deploy után)*

## Becsült méret

M–L / 2–4 nap (több UI felület)

## Címkék (javasolt)

`perf`, `database`, `control-plane`, `pagination`
