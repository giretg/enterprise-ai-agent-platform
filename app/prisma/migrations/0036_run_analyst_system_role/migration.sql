-- Futás-elemző rendszer-szerep: tenantonkénti materializáció (#345).
--
-- A Web-Egress mintájára: perzisztált systemRole, nem név-alapú azonosítás.
-- Szándékosan NINCS név-alapú backfill — a következő idempotens materializáció
-- hozza létre a hiányzó példányt.

ALTER TYPE "agent_system_role" ADD VALUE 'run_analyst';
