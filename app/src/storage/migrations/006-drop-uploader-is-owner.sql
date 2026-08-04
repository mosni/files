-- Migration 006 - E5.1 live-testing round 4 (D-168), same session as migration 005. Reverses it: Hannah's
-- live call was "name -> sub as fallback" should be PROVIDER-based, not owner-gated - a Google/link sub is
-- fine to show (she confirmed a Google account id is not sensitive information), only an EVE identity is
-- not. `uploader_is_owner` was captured for exactly the gate this replaces, has no other consumer, and is
-- dropped outright rather than left as unused-but-tracked data (D-138: active development, no public users
-- yet, safe to evolve the schema freely).
ALTER TABLE files
  DROP COLUMN uploader_is_owner;
