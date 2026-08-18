-- Migration 009 - E8 (D-219, D-220): a grant records when it was made and when it ends.
--
-- WHY expires_at exists at all: the share dialog's duration slider (D-203/D-204) has only ever governed
-- auth's LINK ttl. An invitee who registered inside that window kept the grant forever, because the ACL
-- row carried no expiry - so a 30-minute invite silently became permanent access. D-220 resolves that in
-- favour of the slider and AMENDS D-23's "permanent until revoked".
--
-- granted_at is NOT NULL DEFAULT CURRENT_TIMESTAMP: ACL rows have carried no timestamp since migration
-- 002, so there is nothing to backfill from. Rows that predate this migration will read as granted at
-- migration time. That is inaccurate-but-harmless and is deliberately not disguised - the admin panel
-- shows the date it has.
ALTER TABLE file_acl
  ADD COLUMN granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN expires_at DATETIME NULL DEFAULT NULL;

ALTER TABLE collection_acl
  ADD COLUMN granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN expires_at DATETIME NULL DEFAULT NULL;

CREATE INDEX idx_file_acl_expires ON file_acl (expires_at);
CREATE INDEX idx_collection_acl_expires ON collection_acl (expires_at);
