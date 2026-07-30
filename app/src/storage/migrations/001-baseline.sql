-- Migration 001 - the pre-E3 baseline, frozen verbatim from the old self-healing schema.sql (D-83).
-- storage/db.ts's applyMigrations() already runs its own CREATE DATABASE / USE against the configured
-- database name before any migration executes (schema_version itself needs a selected database to be
-- created in), so the two statements below are redundant but harmless - both are idempotent and kept so
-- this file remains the exact historical schema-at-rest for whoever reads it.
CREATE DATABASE IF NOT EXISTS files;
USE files;

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
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  duration_seconds DECIMAL(10,3) NULL,
  text_preview VARCHAR(400) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (path),
  UNIQUE KEY uniq_link_token (link_token)
);

-- Security invariant 6: sub is a plain string, matched byte-for-byte, NEVER parsed. No FK to any accounts
-- table - this app does not own accounts, auth does.
CREATE TABLE IF NOT EXISTS file_acl (
  path VARCHAR(700) NOT NULL,
  sub VARCHAR(255) NOT NULL,
  KEY idx_acl (path(191), sub)
);
