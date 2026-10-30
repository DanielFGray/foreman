import { foldkit } from "@foldkit/vite-plugin"
import { defineConfig } from "vite"

// Builds the page into dist/, which the bridge serves. The page talks to the
// bridge on its own host, so it is checked against a running bridge, not a
// Vite dev server.
export default defineConfig({
  root: "src/page",
  build: { outDir: "../../dist", emptyOutDir: true },
  plugins: [foldkit()],
  // Tests cover the bridge as well as the page; they run on Bun (`bun --bun
  // vitest`), so the bridge's tests keep Bun's APIs.
  test: { dir: `${import.meta.dirname}/src` },
})
