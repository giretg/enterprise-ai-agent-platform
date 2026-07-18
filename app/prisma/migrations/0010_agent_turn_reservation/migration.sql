-- Aktív-forduló invariáns kikényszerítése a kérés-úton (D7, issue #61).
--
-- A 0009 óta a forduló-rekord a user-üzenet PERZISZTÁLÁSA UTÁN jött létre, ezért
-- az `user_message_id` kötelező volt. Ahhoz viszont, hogy az elutasított küldés
-- (409) ne hagyjon maga után árva felhasználói üzenetet a beszélgetésben, a
-- sorrend megfordul: előbb a forduló-hely FOGLALÁSA (ezen csattan a részleges
-- egyedi index), és csak a sikeres foglalás után íródik a user-üzenet, amit
-- utólag kötünk a rekordhoz. A foglalás és a bekötés között a mező üres.
ALTER TABLE "agent_turns" ALTER COLUMN "user_message_id" DROP NOT NULL;
