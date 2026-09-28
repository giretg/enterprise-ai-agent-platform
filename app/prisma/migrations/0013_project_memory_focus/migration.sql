-- Jelenlegi fókusz (#656): új memória-típus, egy aktív elem agentenként/projektenként.
-- Írás mindig replace (felülírás), nem hoz létre új elemet.
ALTER TYPE "ProjectMemoryKind" ADD VALUE IF NOT EXISTS 'focus';
