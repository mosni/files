// D-103: the "why can I see this" indicator, all four cases. `own` outranks `granted` in how the server
// computes the reason (isListedFor()) - this component just renders whichever one it is handed, it makes
// no precedence decision itself. Uses mosni-chrome's `.badge` class (see
// ../mosni-chrome/docs/examples/badge.html) rather than a bespoke pill (D-31's spirit: reuse the chrome).

import type { VisibilityReason } from "../../../app/src/lib/protection.ts";

const LABEL: Record<VisibilityReason, string> = {
  own: "Yours",
  granted: "Shared with you",
  admin: "Admin view",
  public: "Public",
};

// success (green) for "public" reads as a positive, inviting state; primary (purple) makes "own" the most
// prominent, matching how the rest of the app treats the owner's own things; cyan and indigo are otherwise
// unused in this app so `granted`/`admin` stay visually distinct from both of those and from each other.
const VARIANT: Record<VisibilityReason, string> = {
  own: "primary",
  granted: "cyan",
  admin: "indigo",
  public: "success",
};

export function VisibilityBadge({ reason }: { reason: VisibilityReason }) {
  return <span className={`badge ${VARIANT[reason]}`}>{LABEL[reason]}</span>;
}
