-- A Windows-csomag más config.yaml-t (és ezért más hash-t) ad, mint a posix.
-- A két hash egymás mellett él, hogy a Windows-letöltés ne érvénytelenítse a másik gépet.
ALTER TABLE "client_machine_floors" ADD COLUMN "windows_managed_dir_hash" TEXT;
