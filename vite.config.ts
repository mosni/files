import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The authenticated SPA (drop zone, file browser, admin panel) - built into the image
// and served by Fastify via @fastify/static (D-48), not by nginx.
export default defineConfig({
  plugins: [react()],
  root: "web",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
