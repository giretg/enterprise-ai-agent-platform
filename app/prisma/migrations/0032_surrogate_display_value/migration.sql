-- AI Privacy Gateway (spec §5 R19): a megjelenítési érték perzisztens, titkosított
-- másolata. A leképezés eddig is perzisztens volt, de a NÉV csak a szerverpéldány
-- memóriájában élt — újraindítás vagy második példány után a felhasználó `[[COMPANY_1]]`-et
-- látott a cégnév helyett, és az ismert-érték csere sem működött a következő fordulóban.
--
-- A titkosítás a per-conversation adatkulccsal történik, ezért a beszélgetés
-- törlésekor (crypto-shredding) ez a másolat is visszafejthetetlenné válik.
ALTER TABLE "surrogate_map" ADD COLUMN "display_value_enc" TEXT;
