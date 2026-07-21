-- Operator-láthatóság: tenant admin elrejtheti az agentet az operátorok elől
-- anélkül, hogy a futást/dispatch-et megállítaná. Fail-open alapérték: false
-- (mindenki látja, amíg az admin be nem pipálja).
ALTER TABLE "agents"
  ADD COLUMN "hidden_from_operators" BOOLEAN NOT NULL DEFAULT false;
