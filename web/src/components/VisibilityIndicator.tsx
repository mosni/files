// D-103 (presentation amended by E4.1 Wave B3): the "why can I see this" indicator, all four cases -
// now an icon with a tooltip rather than a `.badge` pill, so it fits a table row without adding a wide
// column. `own` outranks `granted` in how the server computes the reason (isListedFor()) - this component
// still makes no precedence decision of its own, it only renders whichever reason it is handed.

import type { VisibilityReason } from "../../../app/src/lib/protection.ts";

const LABEL: Record<VisibilityReason, string> = {
  own: "Yours",
  granted: "Shared with you",
  admin: "Admin view",
  public: "Public",
};

// Any Lucide name is valid (mosni-icon takes them by name): a person for your own things, two people for
// a shared grant, a shield for the admin view, a globe for public - matching how each case reads.
const ICON: Record<VisibilityReason, string> = {
  own: "user",
  granted: "users",
  admin: "shield",
  public: "globe",
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "mosni-icon": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { name?: string; size?: string | number },
        HTMLElement
      >;
      "mosni-tooltip": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { text?: string }, HTMLElement>;
    }
  }
}

export function VisibilityIndicator({ reason }: { reason: VisibilityReason }) {
  const label = LABEL[reason];
  return (
    <mosni-tooltip text={label}>
      {/* The tooltip text alone is not an accessible name for a hover-only trigger - role="img" plus
          aria-label keeps this announced the same as the old badge's visible text was. */}
      <span tabIndex={0} role="img" aria-label={label} style={{ display: "inline-flex" }}>
        <mosni-icon name={ICON[reason]} size="18" />
      </span>
    </mosni-tooltip>
  );
}
