-- Migration 004 - E5 preview & delivery (D-136/D-137). Both columns are nullable and NEVER backfilled
-- (D-138: until the roadmap completes, this is active development with no public users yet, and gets a
-- full data reset on first release - a nullable column simply stays null on every pre-existing row).
--
-- uploader_name: the display name captured from claims.name at upload (D-136). NEVER falls back to the
-- sub (D-92) - a null renders as "Unknown"/no uploader block, never a parsed identity.
-- thumb_name: the thumbnail's bare filename WITHIN the source's own "<YYYY>/<mm>/" directory (D-137), or
-- null when no thumbnail exists (non-image, generation failed, or uploaded before this migration).
ALTER TABLE files
  ADD COLUMN uploader_name VARCHAR(255) NULL,
  ADD COLUMN thumb_name    VARCHAR(255) NULL;
