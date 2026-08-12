-- Migration 008 - review session 045 (E7): make every `sub` column compare BYTE-FOR-BYTE.
--
-- Security invariant 6 says a sub is matched byte-for-byte and never parsed. The "never parsed" half has
-- always held (there is no LIKE, no SUBSTRING, no split anywhere - grep proves it). The "byte-for-byte"
-- half did NOT: these columns were created with no explicit collation in migration 002, so they inherited
-- the database default, which on mariadb:11 is `utf8mb4_uca1400_ai_ci` - case-insensitive, accent-
-- insensitive and trailing-space-insensitive. Measured against a real MariaDB 11 this session:
--
--   INSERT INTO file_acl VALUES ('f1', 'user:abc');
--   SELECT ... WHERE sub = 'USER:ABC'   -> 1 row     (should be 0)
--   SELECT ... WHERE sub = 'user:abc '  -> 1 row     (should be 0)
--
-- Both `hasAclGrant` and `hasCollectionAclGrant`/`hasAclGrantOnChain` compare the request's sub in SQL, so
-- that folding was an authorization decision: a viewer whose sub differed from a granted one only in case,
-- accent or trailing whitespace would have been let through `authorizePrivate`. The equivalent folding on
-- `owner_sub`/`uploader_sub` decides LISTING breadth in listVisibleFilesIn / listOwnedFilesIn /
-- listVisibleChildCollections, which is the same class of leak one layer out.
--
-- Not exploitable with the subs auth issues TODAY - `google:<numeric id>`, `eve:<characterID>` and
-- `link:<randomHexId()>` are all lowercase/numeric, so no two of them can fold together. That is a
-- property of auth's current IdP set, not of this app, and it is exactly the kind of premise that a
-- future IdP (an email- or username-derived sub) breaks silently. Invariant 6 is supposed to hold on its
-- own terms, so it is pinned here rather than left resting on that coincidence.
--
-- `utf8mb4_nopad_bin`, NOT `utf8mb4_bin`: MariaDB's plain `utf8mb4_bin` is still a PAD SPACE collation, so
-- it fixes case and accents while leaving `'user:x '` matching `'user:x'` - measured this session, it was
-- the one of the three adversarial cases that survived the first attempt. Only the `_nopad_` variant makes
-- the comparison genuinely byte-for-byte, which is what invariant 6 actually says.
--
-- Direction is safe: ci -> nopad_bin only ever makes comparisons STRICTER, so no existing row can become a
-- new duplicate under the (file_id, sub) / (collection_id, sub) primary keys this rebuilds.
ALTER TABLE file_acl
  MODIFY COLUMN sub VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL;

ALTER TABLE collection_acl
  MODIFY COLUMN sub VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL;

ALTER TABLE files
  MODIFY COLUMN owner_sub VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL,
  MODIFY COLUMN uploader_sub VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL;

ALTER TABLE collections
  MODIFY COLUMN owner_sub VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL;
