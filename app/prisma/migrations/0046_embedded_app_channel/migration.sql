-- Beágyazott agent-chat (feature-spec #481): új csatorna-típus a külön ablakos
-- platform-chathez idegen alkalmazásból (D1).

ALTER TYPE "ChannelType" ADD VALUE 'embedded_app';
