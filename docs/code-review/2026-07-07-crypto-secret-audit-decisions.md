# Code review — döntést igénylő pontok

**Terület:** Kriptográfiai bizalmi határ — aláíró/titkosító titkok + audit hash-lánc lefedettség
**Dátum:** 2026-07-07
**Reviewer:** automatizált code-review futás (Claude Code)
**Státusz:** 1 fő javítás elvégezve (fail-closed titok-feloldás); 1 pont döntést igényel

A javítást (beégetett dev-titkok fail-closed feloldása production alatt) lásd a
`code_review.md`-ben és a PR-ben. Az alábbi pont **szándékosan nem lett automatikusan
javítva**, mert visszafelé nem kompatibilis és termék/architektúra-döntést igényel.

---

## D1 — Az audit hash-lánc NEM fedi le a `policyDecision` / `metadata` / `modelUsed` mezőket

**Hol:**
- `app/src/lib/crypto/hash-chain.ts` — `computeAuditHash(...)`
- `app/src/repositories/postgres/audit-repository.ts` — `append(...)`
- `app/src/domain/audit/audit-chain-service.ts` — `verifyChain(...)`

**Mi a helyzet:** a tamper-evidens audit hash jelenleg pontosan 8 mezőt hashel:
`seq, prevHash, actorType, actorId, action, targetType, targetId, createdAt`. A sor többi
mezője — `policyDecision` (engedélyezett/megtagadott/kapuzott döntés), `metadata`,
`modelUsed`, `inputRef`, `outputRef`, `agentVersion` — **kívül esik a hash-láncon**.

Enterprise-audit szempontból pont ezek a legérzékenyebb mezők: egy DB-hozzáféréssel
rendelkező belső szereplő átírhatná egy sor `policyDecision`-ját `deny`-ról `allow`-ra,
kiüríthetné a `metadata`-t, vagy megváltoztathatná, hogy melyik modell/adat vett részt —
**a lánc törése nélkül**, mert a `verifyChain` ezeket a mezőket nem számolja bele az
elvárt hashbe. A tamper-evidence így nem terjed ki a compliance-döntés tartalmára.

**Miért nem javítottam magamtól:** a `computeAuditHash` kiterjesztése **visszafelé nem
kompatibilis** — az összes meglévő láncolt sor azonnal érvénytelenné válna a `verifyChain`
alatt, és az append-only DB-trigger (BEFORE UPDATE/DELETE) miatt a régi sorok nem
hash-elhetők újra a helyükön. Ez pontosan az a „hash-lánc eltörése", amit korábban
tudatosan elkerültünk. A helyes megoldás verziózott hash bevezetése, ami sémamódosítást
igényel — nem alkalmas néma, autonóm javításra.

**Javasolt döntés (megvitatásra):** verziózott audit-hash.
1. Új oszlop: `AuditLog.hashVersion` (`int`, default `1`).
2. `computeAuditHash` fogadjon `version` paramétert; `v2` a jelenlegi 8 mező + a
   `policyDecision`, `metadata` (kanonikus JSON), `modelUsed`, `inputRef`, `outputRef`,
   `agentVersion` mezőket is hasheli.
3. Az `append` új sorokat `v2`-vel ír; a `verifyChain` **sor-szintű** `hashVersion` alapján
   választ képletet, így a régi (`v1`) sorok érvényesek maradnak, az újak pedig teljes
   lefedettséggel bővülnek. Nincs re-hash, nincs láncszakadás.
4. Az `exportJsonLines` és a backfill-eszközök is a `hashVersion`-t tiszteletben tartva
   verifikálnak.

**Kockázat, ha nem történik semmi:** a compliance-audit „tamper-evident" ígérete csak a
ki/mi/mikor csontvázra igaz; a governance-DÖNTÉS és a művelet érzékeny részletei (metadata)
utólag módosíthatók a lánc feltűnő törése nélkül. Enterprise-audit / SOC2 / GDPR
bizonyíték-értéket gyengít.

---

## Nyugtázott erős pontok (nincs teendő)

- **Egyetlen append belépési pont** az audit_log-ba, `pg_advisory_xact_lock` alatt, INSERT
  előtti hash-számítással → utólagos UPDATE nélkül teljesíthető a DB-szintű append-only.
- **Konstans-idejű aláírás-összehasonlítás** (`timingSafeEqual`, ill. manuális XOR) a
  write-gate, oauth-state és preview-token verifikációban.
- **Write-gate**: TTL + státusz-életciklus (`issued→consumed/expired`) + tartalom-hash kötés
  (`expectedDiffHash`) → a jóváhagyott diff nem cserélhető ki a fogyasztáskor.
- **OAuth-state**: v2 AES-256-GCM (authentikált titkosítás) a PKCE `code_verifier` és a
  user/tenant védelmére, TTL-lel; a legacy signed formátumot csak visszafelé olvassa.
- **Preview-token**: nem hordoz sessiont, csak `tenant+app+version+contentHash`-re érvényes,
  TTL-lel — a tartalom változása érvényteleníti.
