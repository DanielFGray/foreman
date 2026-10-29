import { foldkit } from "@foldkit/vite-plugin"
import { defineConfig } from "vite"

// Builds the page into dist/, which the bridge serves. The page talks to the
// bridge on its own host, so it is checked against a running bridge, not a
// Vite dev server.
export default defineConfig({
  root: "src/page",
  build: { outDir: "../../dist", emptyOutDir: true },
  plugins: [foldkit()],
})
