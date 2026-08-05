-- Embernek szóló feladatnév a skillen (#displayName): a feladatválasztó select,
-- az indító modál és a ticket cím ezt mutatja. A technikai `name` (slug) változatlan.
-- NULL = fallback a `name`-re a UI-ban.

ALTER TABLE "skills"
  ADD COLUMN "display_name" TEXT;
