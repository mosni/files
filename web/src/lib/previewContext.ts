// B2c: reads the JSON the server embeds at `<script type="application/json" id="preview-context">`
// (see app/src/lib/previewContext.ts's renderEmbeddedContext) so the SPA can paint the preview page on
// first frame with zero network round trips. `web` importing the type from `app/src/lib` is established
// practice - see web/src/components/DropZone.tsx's import of roles.ts.

import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

export function readEmbeddedContext(): PreviewContext | null {
  try {
    const text = document.getElementById("preview-context")?.textContent;
    if (!text) return null;
    return JSON.parse(text) as PreviewContext;
  } catch {
    return null;
  }
}
