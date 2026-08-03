import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// The authenticated SPA (drop zone, file browser, admin panel) - built into the image
// and served by Fastify via @fastify/static (D-48), not by nginx.
export default defineConfig({
  plugins: [react()],
  root: "web",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // E5 Wave G: web/src/sw.ts (the service worker) is a second, independent entry point - it shares no
      // modules with the SPA entry (main.tsx never imports it; it is registered by URL at runtime), so
      // Rollup bundles it self-contained rather than splitting a shared chunk. It must land at a FIXED,
      // unhashed path (`dist/sw.js`, i.e. served at `/sw.js`) because main.tsx registers it by that exact
      // literal string - a hashed filename would change on every build and break the registration.
      //
      // E5 Wave H: web/embed.html (the embeddable player route's document) is a THIRD, independent HTML
      // entry - unlike sw.ts it does not need a fixed filename, since app/src/storage/embedShell.ts reads
      // it by its own literal path (`web/dist/embed.html`) and its internal asset references are rewritten
      // by Vite's normal HTML processing, the same as index.html's.
      input: {
        main: path.resolve(rootDir, "web/index.html"),
        embed: path.resolve(rootDir, "web/embed.html"),
        sw: path.resolve(rootDir, "web/src/sw.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
