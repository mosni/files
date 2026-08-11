-- Migration 007 - content-based text detection (live-testing, 2026-08-06, Hannah: whether a file previews
-- as text must be decided by "human readable characters or random bytes", not by its file ending).
--
-- Determined ONCE at ingest by lib/textDetect.ts's looksLikeText() over the file's first bytes, and stored
-- here because both delivery (Content-Disposition / Content-Type) and the preview page (which component to
-- render) need the answer without re-reading bytes on a request path - re-reading would put file I/O back
-- on the delivery hot path, which security invariant 2 exists to keep out of Node entirely.
--
-- NOT NULL DEFAULT 0 rather than nullable: "we have not looked at this file" and "this file is not text"
-- want the same behaviour (download it), so a third state would only be a way to get it wrong. Existing
-- rows keep 0 and are NEVER backfilled (D-138 - active development, full data reset on first release), so
-- a file uploaded before this migration keeps the old extension-based behaviour, which for .txt is
-- unchanged anyway since .txt remains on the inline allowlist independently.
ALTER TABLE files
  ADD COLUMN is_text TINYINT(1) NOT NULL DEFAULT 0;
