-- #940: feladatátadás idempotencia-kulcs. Az ismételt (retry) MCP-hívás ugyanazzal a
-- kulccsal nem hoz létre duplikált átadást. A meglévő sorok kulcsa NULL marad; a
-- parciális unique-viselkedést a Postgres NULL-kezelése adja (a NULL-ok nem ütköznek),
-- ezért a kulcs nélküli (mini-app-megosztás) utak továbbra is korlátlanul írhatnak.
ALTER TABLE "handoffs" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "handoffs_tenant_id_from_agent_id_idempotency_key_key" ON "handoffs"("tenant_id", "from_agent_id", "idempotency_key");
