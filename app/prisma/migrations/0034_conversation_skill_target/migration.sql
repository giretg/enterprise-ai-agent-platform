-- Beszélgetésből jövő skill-javaslat meglévő skill új verziójaként.
ALTER TABLE "conversation_skill_proposals" ADD COLUMN "target_skill_id" UUID;
