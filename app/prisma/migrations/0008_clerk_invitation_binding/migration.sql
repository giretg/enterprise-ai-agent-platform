-- A provider-oldali meghívó azonosítója a helyi onboarding-rekordhoz kötődik.
-- A webhook csak az általa kijelölt, még pending helyi meghívót aktiválhatja;
-- e-mail alapú, cross-tenant tömeges beváltás nincs.
ALTER TABLE "invitations"
  ADD COLUMN "clerk_invitation_id" TEXT;

CREATE UNIQUE INDEX "invitations_clerk_invitation_id_key"
  ON "invitations" ("clerk_invitation_id");
