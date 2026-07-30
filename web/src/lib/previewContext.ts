// B2c: reads the JSON the server embeds at `<script type="application/json" id="preview-context">`
// (see app/src/lib/previewContext.ts's renderEmbeddedContext) so the SPA can paint the preview page on
// first frame with zero network round trips. `web` importing the type from `app/src/lib` is established
// practice - see web/src/components/DropZone.tsx's import of roles.ts.
//
// E4.1 Wave C: that same script element now carries EITHER a file's PreviewContext or a
// CollectionLocation (D-107/§1.2) - `readEmbeddedTarget` is the one place that tells the two apart, using
// CollectionLocation's `kind: "collection"`, which can never collide with PreviewContext's own `kind`
// (always "image" | "video" | "pdf" | "text" | "other").

import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import type { CollectionLocation } from "../../../app/src/lib/browseContext.ts";

export type EmbeddedTarget = { kind: "file"; context: PreviewContext } | { kind: "collection"; collectionId: string };

export function readEmbeddedTarget(): EmbeddedTarget | null {
  try {
    const text = document.getElementById("preview-context")?.textContent;
    if (!text) return null;
    const data = JSON.parse(text) as PreviewContext | CollectionLocation;
    return data.kind === "collection" ? { kind: "collection", collectionId: data.collectionId } : { kind: "file", context: data };
  } catch {
    return null;
  }
}
