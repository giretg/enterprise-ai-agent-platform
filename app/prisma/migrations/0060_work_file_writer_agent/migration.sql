-- #1113 WP-1: melyik agent hozta létre és írta utoljára a munkafájlt.
-- NULL: emberi mentés vagy a rögzítés előtt készült fájl. A régi sorokat nem töltjük vissza,
-- mert az írójuk csak becsülhető. A régi kód ezeket az oszlopokat nem használja, így a telepítés
-- alatt együtt futhat az újjal.
ALTER TABLE "work_files"
  ADD COLUMN "created_by_agent_id" UUID,
  ADD COLUMN "last_writer_agent_id" UUID;

ALTER TABLE "work_files"
  ADD CONSTRAINT "work_files_created_by_agent_id_fkey"
    FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "work_files_last_writer_agent_id_fkey"
    FOREIGN KEY ("last_writer_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
