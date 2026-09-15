-- Beágyazott agent-chat (feature-spec #481, D3): per-user szál-egyediség —
-- ugyanaz az app-slug + külső thread-id + user mindig ugyanazt a beszélgetést
-- nyitja meg. Részleges egyedi index — csak az embedded_app csatornán érvényes,
-- a Prisma-séma ezt nem tudja kifejezni (mint az agent_turns aktív-forduló indexe).

CREATE UNIQUE INDEX "conversations_embedded_thread_key"
  ON "conversations" ("channel", "channel_external_id", "created_by")
  WHERE "channel" = 'embedded_app';
