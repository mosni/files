// E5 Wave H (D-140): the embeddable player route's client entry - mounts ONLY the Wave F video player,
// with no header, no DropZone/FileBrowser, no react-router. The server (controllers/embed.ts) has already
// gated this document to a video-kind, public/unlisted file before ever serving it, so there is no
// "not found"/collection branch to handle here the way pages/Preview.tsx has.
//
// embed.html is deliberately minimal - no <mosni-header>, no auth SDK, no mosnicat.js. That document
// exists to be iframed by a platform's unfurler and play one video, nothing else (moved here, round 4:
// a .html entry file's comments ship verbatim in the response; a .ts/.tsx comment does not survive
// `vite build`'s minifier).

import { createRoot } from "react-dom/client";
import { readEmbeddedTarget } from "./lib/previewContext.ts";
import { VideoPreview } from "./components/VideoPreview.tsx";

const root = document.getElementById("root");
if (root) {
  const target = readEmbeddedTarget();
  if (target !== null && target.kind === "file") {
    createRoot(root).render(<VideoPreview ctx={target.context} />);
  }
}
