-- Migration 002 - E3's collections & protection model (D-80, D-81, D-82, D-84, D-85, D-86, D-87, D-88).
-- A file's identity moves from its on-disk path to a surrogate id; collections become real nested DB
-- entities; the disk layout is fixed at ingest and addressed only through the database from here on.
--
-- DROP rather than ALTER (D-91, Hannah's explicit call): the box's existing `files`/`file_acl` rows are
-- first-deploy test data with no migration path to the new shape (there is no collection for an orphan
-- path-keyed row to belong to). The underlying bytes are left on disk at her direction; under D-81 they
-- become addressable by nothing, which is known and accepted.
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS file_acl;

-- '' (empty string) means "root", NOT NULL. A NULL parent_id would break uniq_sibling_name: MariaDB
-- treats NULLs as distinct in a UNIQUE index, so two root collections could share a name.
CREATE TABLE IF NOT EXISTS collections (
  id CHAR(16) NOT NULL,
  parent_id CHAR(16) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  owner_sub VARCHAR(255) NOT NULL,
  default_protection ENUM('public','unlisted','secret','private') NOT NULL DEFAULT 'unlisted',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_sibling_name (parent_id, name),
  KEY idx_collection_owner (owner_sub)
);

CREATE TABLE IF NOT EXISTS files (
  id CHAR(16) NOT NULL,
  collection_id CHAR(16) NOT NULL,
  name VARCHAR(255) NOT NULL,        -- display name; renameable (D-82)
  disk_dir CHAR(7) NOT NULL,         -- "YYYY/mm", fixed at ingest, never changes
  disk_name VARCHAR(300) NOT NULL,   -- "<id>-<original filename>", fixed at ingest, never changes
  bytes BIGINT UNSIGNED NOT NULL,
  protection ENUM('public','unlisted','secret','private') NOT NULL DEFAULT 'unlisted',
  link_token VARCHAR(16) NOT NULL,
  state ENUM('pending','committed') NOT NULL DEFAULT 'pending',  -- D-85
  owner_sub VARCHAR(255) NULL,
  uploader_sub VARCHAR(255) NULL,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  duration_seconds DECIMAL(10,3) NULL,
  text_preview VARCHAR(400) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_name_in_collection (collection_id, name),
  UNIQUE KEY uniq_link_token (link_token),
  KEY idx_file_owner (owner_sub)
);

-- Re-keyed from `path` onto the file id (D-81). Security invariant 6 unchanged: sub is a plain string,
-- matched byte-for-byte, never parsed, no FK to any accounts table.
CREATE TABLE IF NOT EXISTS file_acl (
  file_id CHAR(16) NOT NULL,
  sub VARCHAR(255) NOT NULL,
  PRIMARY KEY (file_id, sub)
);

-- D-87: the STRUCTURE lands in E3 so multiple users can hold upload rights on a collection. NOTHING in
-- E3 writes to this table and no UI grants rows - E7 owns the granting flow. Reads must already honour it
-- (storage/collections.ts's canUploadTo) so E7 is a UI change, not a re-architecture.
CREATE TABLE IF NOT EXISTS collection_acl (
  collection_id CHAR(16) NOT NULL,
  sub VARCHAR(255) NOT NULL,
  can_upload TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (collection_id, sub)
);
