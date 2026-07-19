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

CREATE TABLE IF NOT EXISTS collections (
  id CHAR(36) NOT NULL,
  owner_sub VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

-- D-17: bytes is recorded from day one even with no quota, so a usage breakdown and quotas later are a
-- small change rather than a backfill. D-14: files are stored under an opaque id; display_name is
-- metadata only, never the on-disk path.
CREATE TABLE IF NOT EXISTS files (
  id CHAR(36) NOT NULL,
  collection_id CHAR(36) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  bytes BIGINT UNSIGNED NOT NULL,
  protection ENUM('public', 'semi-private', 'private') NOT NULL DEFAULT 'semi-private',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (collection_id) REFERENCES collections (id)
);

-- Security invariant 6 / D-14: sub is a plain string, matched byte-for-byte, NEVER parsed. No FK to any
-- accounts table - this app does not own accounts, auth does.
CREATE TABLE IF NOT EXISTS file_acl (
  file_id CHAR(36) NOT NULL,
  sub VARCHAR(255) NOT NULL,
  PRIMARY KEY (file_id, sub),
  FOREIGN KEY (file_id) REFERENCES files (id)
);
