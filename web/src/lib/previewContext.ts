// B2c: reads the JSON the server embeds at `<script type="application/json" id="preview-context">`
// (see app/src/lib/previewContext.ts's renderEmbeddedContext) so the SPA can paint the preview page on
// first frame with zero network round trips. `web` importing the type from `app/src/lib` is established
// practice - see web/src/components/DropZone.tsx's import of roles.ts.
//
// E4.1 Wave C: that same script element now carries EITHER a file's PreviewContext or a
// CollectionLocation (D-107/§1.2) - `readEmbeddedTarget` is the one place that tells the two apart, using
// CollectionLocation's `kind: "collection"`, which can never collide with PreviewContext's own `kind`
// (always "image" | "video" | "pdf" | "text" | "other").
//
// D-160 (E5.1 Wave B, finding 3): the server also stamps `embeddedFor` - the pathname the document was
// rendered for - on the SAME wrapper object it serializes, so the page can tell "this embedded content is
// for the URL I'm actually at" apart from "this is stale content left over from an earlier mount" (see
// pages/Preview.tsx). It is a property of the EMBEDDING, not of the file/collection itself, so it is
// stripped back out of `context` here rather than living on PreviewContext (which is also the /api/preview
// response body, which has no embedding to describe).

import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import type { CollectionLocation } from "../../../app/src/lib/browseContext.ts";

export type EmbeddedTarget =
  | { kind: "file"; context: PreviewContext; embeddedFor: string }
  | { kind: "collection"; collectionId: string; embeddedFor: string };

export function readEmbeddedTarget(): EmbeddedTarget | null {
  try {
    const text = document.getElementById("preview-context")?.textContent;
    if (!text) return null;
    const { embeddedFor, ...rest } = JSON.parse(text) as (PreviewContext | CollectionLocation) & {
      embeddedFor: string;
    };
    return rest.kind === "collection"
      ? { kind: "collection", collectionId: rest.collectionId, embeddedFor }
      : { kind: "file", context: rest, embeddedFor };
  } catch {
    return null;
  }
}
