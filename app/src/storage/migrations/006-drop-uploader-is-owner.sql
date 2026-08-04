-- Migration 006 - E5.1 live-testing round 4 (D-168), same session as migration 005. Reverses it: Hannah's
-- live call was that "name -> sub as fallback" is UNCONDITIONAL - every uploader, no owner gate and no
-- provider carve-out. (An earlier draft of the same round read her aside about EVE subs as a provider-based
-- exception and shipped that; it was corrected the same day in 5039229. Do not restore either gate without
-- a decision reversing D-168.) `uploader_is_owner` was captured for exactly the gate this replaces, has no
-- other consumer, and is
-- dropped outright rather than left as unused-but-tracked data (D-138: active development, no public users
-- yet, safe to evolve the schema freely).
ALTER TABLE files
  DROP COLUMN uploader_is_owner;
