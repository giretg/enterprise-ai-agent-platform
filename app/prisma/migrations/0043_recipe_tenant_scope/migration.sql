-- Recept-katalógus több-bérlős kapuja.
--
-- A `recipes` eddig bérlő-oszlop nélkül létezett: a RecipeService (services.recipes)
-- listázás/létrehozás/jóváhagyás nélkül szűrt bérlőre, és az audit-esemény sem
-- hordozta a tenantId-t. A tábla ma csak platform-szintű seed-recepteket tartalmaz
-- (key-ceremony, wiki-answer), ezért a bevezetés biztonságos: az oszlop NULLABLE,
-- a meglévő sorok NULL-lal maradnak = globális sablon (minden bérlő agentje köthető).
-- Bérlő által létrehozott recept a jövőben nem-NULL tenant_id-t kap, és a szolgáltatás
-- csak a saját bérlőjének engedi.

ALTER TABLE "recipes" ADD COLUMN "tenant_id" UUID;

CREATE INDEX "recipes_tenant_id_idx" ON "recipes"("tenant_id");
