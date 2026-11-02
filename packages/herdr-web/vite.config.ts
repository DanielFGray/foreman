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
  // vitest`), so the bridge's tests keep Bun's APIs. Half the cores: the suite
  // runs on the machine the bridge and the fleet's agents share, and vitest's
  // default of one worker per core starves them.
  test: { dir: `${import.meta.dirname}/src`, maxWorkers: "50%" },
})
