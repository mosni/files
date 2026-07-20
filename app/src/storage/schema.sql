-- Additive-only, idempotent (technical-baseline.md §3). Re-applied on every boot via storage/db.ts's
-- applySchema(), non-fatal on failure - a long-lived DB self-heals a table/column added after it was
-- first created. A column TYPE/constraint change still needs a real one-off migration; CREATE TABLE IF
-- NOT EXISTS only protects a fresh/missing table.
--
-- E1 creates only the durable spine E2/E3 extend: collections, files, file_acl. No upload/browsing
-- behaviour ships in E1 (this is scaffolding, not a feature).
--
-- Split on `;` at the call site (storage/db.ts), so this file must never put `--` or `;` inside a string
-- literal.
--
-- Rewritten 2026-07-20 (session 006, D-56/D-58/D-59): the filesystem is now the source of truth for a
-- file's existence and naming (D-14, opaque IDs on disk, is struck). Nothing has been deployed yet, so
-- these CREATE TABLE bodies are edited directly rather than migrated - see current-plan.md's caveat that
-- a real one-off migration is needed for any enum/column change made AFTER the first box deploy.

-- owner_sub is nullable (D-57): a bare `mkdir` on disk auto-creates a collection row with no owner until
-- an admin assigns one. name is globally unique (D-58) since the tree is flat and there is no stable
-- per-user slug to nest under.
CREATE TABLE IF NOT EXISTS collections (
  id CHAR(36) NOT NULL,
  owner_sub VARCHAR(255) NULL,
  name VARCHAR(255) NOT NULL,
  protection ENUM('public', 'unlisted', 'secret', 'private') NOT NULL DEFAULT 'unlisted',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_collection_name (name)
);

-- D-56: files.id and the opaque-ID model are struck. A file is identified by (collection_id,
-- display_name) - the same pair that is also its path on disk. link_token is what a `secret`/`unlisted`
-- share URL resolves through (D-59); uploader_sub is null for a file that was never uploaded through this
-- app (hand-copied, then reconciled). D-17: bytes is recorded from day one even with no quota.
CREATE TABLE IF NOT EXISTS files (
  collection_id CHAR(36) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  bytes BIGINT UNSIGNED NOT NULL,
  protection ENUM('public', 'unlisted', 'secret', 'private') NOT NULL DEFAULT 'unlisted',
  link_token CHAR(22) NOT NULL,
  uploader_sub VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_file_in_collection (collection_id, display_name),
  UNIQUE KEY uniq_link_token (link_token),
  FOREIGN KEY (collection_id) REFERENCES collections (id)
);

-- Security invariant 6: sub is a plain string, matched byte-for-byte, NEVER parsed. No FK to any accounts
-- table - this app does not own accounts, auth does. References files by (collection_id, display_name)
-- now that files.id is gone (D-56); the composite FK relies on files' uniq_file_in_collection key.
CREATE TABLE IF NOT EXISTS file_acl (
  collection_id CHAR(36) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  sub VARCHAR(255) NOT NULL,
  PRIMARY KEY (collection_id, display_name, sub),
  FOREIGN KEY (collection_id, display_name) REFERENCES files (collection_id, display_name)
);
