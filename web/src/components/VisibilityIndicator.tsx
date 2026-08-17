// D-103 (presentation amended by E4.1 Wave B3): the "why can I see this" indicator, all four cases -
// now an icon with a tooltip rather than a `.badge` pill, so it fits a table row without adding a wide
// column. `own` outranks `granted` in how the server computes the reason (isListedFor()) - this component
// still makes no precedence decision of its own, it only renders whichever reason it is handed.

import { Tooltip } from "@mosni/react";
import type { VisibilityReason } from "../../../app/src/lib/protection.ts";

const LABEL: Record<VisibilityReason, string> = {
  own: "Yours",
  hosted: "In your collection",
  granted: "Shared with you",
  admin: "Admin view",
  public: "Public",
};

// Any Lucide name is valid (mosni-icon takes them by name): a person for your own things, an open folder
// for a file hosted in your own collection (D-189), two people for a shared grant, a shield for the admin
// view, a globe for public - matching how each case reads.
const ICON: Record<VisibilityReason, string> = {
  own: "user",
  hosted: "folder-open",
  granted: "users",
  admin: "shield",
  public: "globe",
};

export function VisibilityIndicator({ reason }: { reason: VisibilityReason }) {
  const label = LABEL[reason];
  return (
    <Tooltip text={label}>
      {/* The tooltip text alone is not an accessible name for a hover-only trigger - role="img" plus
          aria-label keeps this announced the same as the old badge's visible text was. */}
      <span tabIndex={0} role="img" aria-label={label} style={{ display: "inline-flex" }}>
        <mosni-icon name={ICON[reason]} size={18} />
      </span>
    </Tooltip>
  );
}
