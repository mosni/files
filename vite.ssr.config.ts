import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The server build (D-44). Node's type-stripping erases annotations but cannot transform JSX, so the
// server cannot run from `.ts` source directly - it must be built. This is what makes a `.tsx` view
// loadable at all; without it `node app/src/server.ts` cannot import a view.
export default defineConfig({
  plugins: [react()],
  build: {
    ssr: "app/src/server.ts",
    outDir: "app/dist",
    target: "node24",
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: "server.js" },
    },
  },
});
