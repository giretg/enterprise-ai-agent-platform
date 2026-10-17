-- Pin the linked-account grant resolved at enqueue onto the approval-bound
-- operation. With several Gmail/Drive accounts per user (#816), the account
-- handle (nickname/email) is re-resolved at execution; a rename or revoke in
-- the approval window could redirect the approved write to a different mailbox.
-- Storing the resolved grant lets execution fail closed when it no longer
-- matches what the approver saw. Nullable: pre-existing rows and non-delegated
-- operations keep NULL (no enforcement).
ALTER TABLE "gateway_operations" ADD COLUMN "grant_id" UUID;
