-- Migration 003 - E4's collection-level protection (D-95) and the shared token namespace (D-98).
-- `protection` is the collection's OWN visibility (the same four levels a file has); `default_protection`
-- keeps its D-86 meaning (what new uploads into it inherit) - the two columns must never be blurred.
--
-- The `link_token` backfill and its unique index are NOT in this file: DEFAULT '' would let every
-- existing collection collide on '', so each row needs a freshly minted, cross-table-unique token before
-- the unique index can even be created - that requires the same collision-checking logic
-- lib/tokens.ts's mintUniqueToken() already implements, which plain SQL cannot express. storage/db.ts's
-- applyMigrations() runs that backfill immediately after this file's statements, then creates the index.
ALTER TABLE collections
  ADD COLUMN protection ENUM('public','unlisted','secret','private') NOT NULL DEFAULT 'unlisted'
    AFTER owner_sub,
  ADD COLUMN link_token VARCHAR(16) NOT NULL DEFAULT '' AFTER protection;
