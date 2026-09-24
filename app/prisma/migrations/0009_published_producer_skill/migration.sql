-- A kiadott gyártó skillből egy lehet. A tenant-saját gyártó skill külön indexen van.
CREATE UNIQUE INDEX "skills_one_global_producer"
  ON "skills" ((1))
  WHERE "produces_skills" = true AND "tenant_id" IS NULL;
