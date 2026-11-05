-- Egyszeri ütemezett futás időpontja (üres oszlop, a meglévő feladatok ismétlődők maradnak).
ALTER TABLE "scheduled_tasks" ADD COLUMN "run_once_at" TIMESTAMPTZ;
