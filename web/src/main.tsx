import { createRoot } from "react-dom/client";
import { DropZone } from "./components/DropZone.tsx";

// F1-F5: the drop zone is the whole landing page for now (D-64) - the full landing page with a file
// browser and admin-panel entry point is a later epic (E4).
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<DropZone />);
}
