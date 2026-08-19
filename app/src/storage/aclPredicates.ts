// E8 Wave A2 (D-221): the ACL reads collapse to three predicates written twice each (once per table) -
// "is there a grant", "…with can_upload", "list the grants" - not twelve distinct queries. Centralised
// here so a future fourth read path cannot silently omit the expiry condition (D-220).
//
// A grant is LIVE when it has no expiry, or its expiry is still in the future. Review 060/OPS-4: the
// comparison is against UTC_TIMESTAMP(), never NOW() - NOW() is whatever the connection's session zone
// says, and this predicate decides authorization. storage/db.ts pins that session zone to UTC as well;
// this is the half that stays correct even if that ever fails to apply. Columns are always
// table-qualified - an unqualified `expires_at` inside an EXISTS subquery would become ambiguous the day
// either parent table gains a column of that name.
export const FILE_GRANT_LIVE = "(file_acl.expires_at IS NULL OR file_acl.expires_at > UTC_TIMESTAMP())";
export const COLLECTION_GRANT_LIVE = "(collection_acl.expires_at IS NULL OR collection_acl.expires_at > UTC_TIMESTAMP())";
export const FILE_GRANT_EXISTS = `EXISTS (SELECT 1 FROM file_acl WHERE file_acl.file_id = files.id AND file_acl.sub = ? AND ${FILE_GRANT_LIVE})`;
export const COLLECTION_GRANT_EXISTS = `EXISTS (SELECT 1 FROM collection_acl WHERE collection_acl.collection_id = collections.id AND collection_acl.sub = ? AND ${COLLECTION_GRANT_LIVE})`;

// These are constants, never built from input - the repo's parameterized-queries-only posture is intact
// because no value is interpolated, only fixed SQL text.
