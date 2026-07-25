# perf: `findByIdWithDetails` szétbontása runtime vs display loaderre

## Üzleti / UX hatás

Az agent detail oldal, a chat és a `kb_search` ugyanazt a „teljes” agent-lekérdezést használja: betölti a memória verziókat, API kulcs előnézetet, resource-okat és recipe-t akkor is, ha a hívónak csak a memória-tartalom / model config kell. Nagyobb agent-állománynál ez **lassabb chat-fordulókat**, lassabb tudásbázis-keresést és felesleges Neon IO/költséget okoz.

## Kontextus

- Hol: `app/src/repositories/postgres/agent-repository.ts` (`findByIdWithDetails`)
- Hívók: agent detail SSR, `kbSearch`, wiki/chat/general-task runtime
- Kapcsolódó: `docs/perf/optimization-plan.md` (P1 — nyitott)

A 2026-07-25-ös perf kör (grant-revoke, aggregációk, indexek, KB/sandbox over-fetch) után ez a következő legnagyobb kódoldali nyereség.

## Javasolt megoldás

1. `findByIdForRuntime(id)` — csak futáshoz kellő mezők (agent + current memory content/version + model routing szempontú mezők).
2. `findByIdForDisplay(id)` — UI detail (resources, recipe, behavior profile, opcionális apiKeyPreview szerepkör szerint).
3. Hívók átvezetése: `kbSearch` / chat runtime → runtime loader; detail oldal → display/admin loader.
4. Regressziós smoke: agent detail render, egy chat forduló, egy `kb_search` hívás.

## Elfogadási kritériumok

- [ ] Runtime útvonal nem tölti a `memory.versions` listát és az `apiKeys` include-ot.
- [ ] Agent detail UI funkcionálisan változatlan (admin és viewer nézet).
- [ ] `kb_search` és chat path kevesebb Prisma include-dal fut (mérhető / logolható).
- [ ] Nincs behavior regresszió a meglévő acceptance / smoke teszteken.

## Becsült méret

M / 1–2 nap

## Címkék (javasolt)

`perf`, `database`, `agent-runtime`
