-- #1111 hang-pilot: hang-beállítás a munkatárson (üres oszlop, a meglévő munkatársaknak nincs hang-képessége).
ALTER TABLE "agents" ADD COLUMN "voice_config" JSONB;
