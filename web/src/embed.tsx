// E5 Wave H (D-140): the embeddable player route's client entry - mounts ONLY the Wave F video player,
// with no header, no DropZone/FileBrowser, no react-router. The server (controllers/embed.ts) has already
// gated this document to a video-kind, public/unlisted file before ever serving it, so there is no
// "not found"/collection branch to handle here the way pages/Preview.tsx has.

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
