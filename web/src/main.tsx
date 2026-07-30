import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { DropZone } from "./components/DropZone.tsx";
import { FileBrowser } from "./components/FileBrowser.tsx";
import { PreviewPage } from "./pages/Preview.tsx";

// F1-F5: the drop zone was the whole landing page (D-64); E4 adds the browser BELOW it (D-1, D-93) - the
// order here is load-bearing, never swap it, and nothing may render between the two.
// D-70/D-73: the preview page is now a route inside this SPA rather than a server-rendered document.
// Declarative mode only (BrowserRouter + Routes/Route) - no createBrowserRouter, no loaders, no framework
// mode, no Vite plugin.
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <DropZone />
              <FileBrowser />
            </>
          }
        />
        <Route path="/f/*" element={<PreviewPage />} />
        <Route path="/t/:token" element={<PreviewPage />} />
      </Routes>
    </BrowserRouter>,
  );
}
