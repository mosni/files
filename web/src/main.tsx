import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { DropZone } from "./components/DropZone.tsx";
import { PreviewPage } from "./pages/Preview.tsx";

// F1-F5: the drop zone is the whole landing page for now (D-64) - the full landing page with a file
// browser and admin-panel entry point is a later epic (E4).
// D-70/D-73: the preview page is now a route inside this SPA rather than a server-rendered document.
// Declarative mode only (BrowserRouter + Routes/Route) - no createBrowserRouter, no loaders, no framework
// mode, no Vite plugin.
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DropZone />} />
        <Route path="/f/*" element={<PreviewPage />} />
        <Route path="/t/:token" element={<PreviewPage />} />
      </Routes>
    </BrowserRouter>,
  );
}
