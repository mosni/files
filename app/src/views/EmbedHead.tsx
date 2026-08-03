// E5 Wave H (D-140): the embeddable player route's own, minimal <head> - no OG/Twitter/JSON-LD richness
// (that lives on the ordinary preview page, which is what a platform actually unfurls); this document's
// only job is to be iframed and play. `renderEmbeddedContext` (PreviewHead.tsx) is reused as-is for the
// context splice - same script id, same escaping requirement, one mechanism.

import { renderToString } from "react-dom/server";
import type { PreviewContext } from "../lib/previewContext.ts";

function EmbedHead({ name }: { name: string }) {
  return (
    <>
      <title>{name}</title>
      {/* An embed frame is not a page anyone should land on directly from search - never indexed. */}
      <meta name="robots" content="noindex, nofollow" />
    </>
  );
}

export function renderEmbedHead(ctx: PreviewContext): string {
  return renderToString(<EmbedHead name={ctx.name} />);
}
