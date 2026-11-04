-- #1083: a mini app verzió élő adat-kötései. A meglévő verziók statikusak maradnak.
ALTER TABLE "mini_app_versions" ADD COLUMN "data_bindings" JSONB NOT NULL DEFAULT '[]';
