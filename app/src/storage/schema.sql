-- Split on `;` at the call site (storage/db.ts), so this file must never put `--` or `;` inside a string
-- literal.
--
-- Rewritten 2026-07-21 (session 007, preliminary-review P5/P6/P7/P8): reconciliation is dropped and the
-- `collections` table with it. URLs mirror the on-disk tree at arbitrary depth, so a file is identified
-- by its relative path from STORAGE_ROOT. Ownership is per-file now (owner_sub) - folder-level ownership
-- returns with E4 browsing. Nothing is deployed yet, so these bodies are edited directly; after the first
-- box deploy any column/enum change needs a real one-off migration.
--
-- path is VARCHAR(700): utf8mb4 is 4 bytes/char, and 700*4 = 2800 < InnoDB's 3072-byte index-key limit,
-- so it can be the PRIMARY KEY directly. A relative path deeper or longer than 700 chars is rejected at
-- ingest rather than truncated.

CREATE TABLE IF NOT EXISTS files (
  path VARCHAR(700) NOT NULL,
  bytes BIGINT UNSIGNED NOT NULL,
  protection ENUM('public', 'unlisted', 'secret', 'private') NOT NULL DEFAULT 'unlisted',
  link_token VARCHAR(16) NOT NULL,
  owner_sub VARCHAR(255) NULL,
  uploader_sub VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (path),
  UNIQUE KEY uniq_link_token (link_token)
);

-- Security invariant 6: sub is a plain string, matched byte-for-byte, NEVER parsed. No FK to any accounts
-- table - this app does not own accounts, auth does. A prefix index on path (path is up to 2800 bytes, too
-- long to combine with sub in one 3072-byte key) - lookups are always exact WHERE path = ? AND sub = ?, so
-- the prefix narrows and the exact comparison finishes the match. file_acl is an E7 stub; only per-object
-- grant checks read it today.
CREATE TABLE IF NOT EXISTS file_acl (
  path VARCHAR(700) NOT NULL,
  sub VARCHAR(255) NOT NULL,
  KEY idx_acl (path(191), sub)
);
