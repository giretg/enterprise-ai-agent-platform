-- Bejövő levél feldolgozása: alapból minden írás jóváhagyásra vár (a feladó címe hamisítható).
ALTER TABLE "agent_inbound_mail_rules" ADD COLUMN "allow_direct_writes" BOOLEAN NOT NULL DEFAULT false;
