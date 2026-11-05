-- A `[[path\|címke]]` linkből korábban `path\.md` vagy `path.md\.md` került az out_links-be,
-- ezért a céloldal visszahivatkozásaiból hiányzott. A helyes alakra hozzuk; a törzs változatlan.
UPDATE "wiki_pages"
SET "out_links" = ARRAY(
  SELECT DISTINCT regexp_replace(link, '(\.md)?\s*\\\.md$', '.md')
  FROM unnest("out_links") AS link
  ORDER BY 1
)
WHERE EXISTS (SELECT 1 FROM unnest("out_links") AS link WHERE link ~ '\\\.md$');
