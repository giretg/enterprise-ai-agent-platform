-- Sensitivity router (§4.7.2): per-agent felmentés a `sensitive` szintű tartalom
-- külső modellnek küldése alól. Fail-closed alapérték: false.
-- A `forbidden` szint (PAN/IBAN/privát kulcs) ezzel NEM hatástalanítható.
ALTER TABLE "agents"
  ADD COLUMN "allow_sensitive_external_model" BOOLEAN NOT NULL DEFAULT false;
