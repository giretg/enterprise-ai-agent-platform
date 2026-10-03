-- #759: a retenciós sweep `expires_at <= now` szerint töröl; index nélkül a napi járat
-- teljes táblát szkennelne. A 90 napos tartalom-retenció (D5) ettől a járattól él.
CREATE INDEX "ai_interaction_events_expires_at_idx" ON "ai_interaction_events"("expires_at");
