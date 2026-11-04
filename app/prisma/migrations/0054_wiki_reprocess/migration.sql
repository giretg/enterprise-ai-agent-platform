-- #1085: a wiki-tálca tétel legutóbbi újrafeldolgozási kérése (üres oszlop, adat nem változik).
ALTER TABLE "documents" ADD COLUMN "wiki_reprocess" JSONB;
