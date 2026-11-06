-- A kód a 0022 óta új típusokat és forrást ír ide (`tool_unclassified` #872, `voice_transcript` + `voice` #1117),
-- de a CHECK-szabály nem bővült, ezért ezek a sorok nem kerülhettek be.
-- Az új lista a régi bővítése, így a meglévő sorok megfelelnek neki: a NOT VALID megspórolja a teljes tábla
-- átvizsgálását zár alatt, az új írásokra a szabály ettől még érvényes.
ALTER TABLE "ai_interaction_events"
  DROP CONSTRAINT "ai_interaction_events_kind_check",
  ADD CONSTRAINT "ai_interaction_events_kind_check"
    CHECK ("kind" IN ('user_prompt', 'model_call', 'tool_call', 'final', 'tool_unclassified', 'voice_transcript')) NOT VALID,
  DROP CONSTRAINT "ai_interaction_events_source_check",
  ADD CONSTRAINT "ai_interaction_events_source_check"
    CHECK ("source" IN ('gateway', 'guard', 'voice')) NOT VALID;
