-- #1020: céges webes keresés (tenantonként saját Brave-kulccsal).
ALTER TYPE "ConnectorType" ADD VALUE IF NOT EXISTS 'web_search';
