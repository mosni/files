-- Migration 005 - E5.1 Wave C (D-154/D-155). Nullable-equivalent (BOOLEAN NOT NULL DEFAULT FALSE) and NEVER
-- backfilled (D-138: active development, no public users yet, full data reset on first release) - every
-- pre-existing row gets FALSE, the safe value: it renders avatar-only, never the sub.
--
-- Captures whether the uploader was the OWNER account at upload time (from the JWT's `mosni_owner` claim),
-- so the client's uploader-identity fallback can be gated STRUCTURALLY on this flag rather than on
-- "the name happens to be missing" - the owner is the only account whose sub is safe to ever show (D-92),
-- and only because its sub is not a real provider-id/account-id the way a Google/EVE sub is.
ALTER TABLE files
  ADD COLUMN uploader_is_owner BOOLEAN NOT NULL DEFAULT FALSE;
