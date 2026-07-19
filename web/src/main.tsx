import { createRoot } from "react-dom/client";

// Placeholder SPA entry. E1 ships no drop zone, file browser, or admin panel yet (those land in later
// epics) - this exists only so the Vite/React toolchain has something real to build against.
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(null);
}
