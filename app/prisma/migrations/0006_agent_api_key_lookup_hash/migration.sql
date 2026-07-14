-- Agent API-kulcs skálázható hitelesítés: gyors, egyedi-indexelt kereső-hash.
--
-- A korábbi hitelesítés MINDEN aktív kulcson végig-bcrypt-elt (O(n) lassú hash minden
-- kérésnél), ami több száz/ezer agent esetén másodperces késleltetést és DoS-felületet
-- jelentett. Ez az oszlop a nyers kulcs szerveroldali kulccsal képzett HMAC-SHA-256
-- kereső-lenyomatát tárolja, amin
-- egyedi index van, így a hitelesítés O(1) megkereséssel megtalálja a pontos kulcssort.
-- A nyugalmi titok továbbra is a `key_hash` (bcrypt) — a HMAC csak keresésre szolgál.
--
-- Nullable: a régi kulcsoknak nincs kereső-hash-ük; azokat a hitelesítés visszafelé
-- kompatibilis módon kezeli (legacy fallback + első használatkor feltöltött hash).
ALTER TABLE "agent_api_keys"
  ADD COLUMN "lookup_hash" TEXT;

CREATE UNIQUE INDEX "agent_api_keys_lookup_hash_key"
  ON "agent_api_keys" ("lookup_hash");
