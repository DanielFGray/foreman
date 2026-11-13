import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import {
  draftPipeline,
  grantScopes,
  removeDraftBlock,
  savedPipeline,
  startUiServer,
  stopUiServer,
} from "./test/browser/commands.ts";

const react = fileURLToPath(new URL("./node_modules/react", import.meta.url));
const reactDom = fileURLToPath(new URL("./node_modules/react-dom", import.meta.url));
const jsxRuntime = fileURLToPath(new URL("./node_modules/react/jsx-runtime", import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react,
      "react-dom": reactDom,
      "react/jsx-runtime": jsxRuntime,
    },
  },
  optimizeDeps: {
    include: ["dragology", "react", "react-dom", "react/jsx-runtime"],
  },
  test: {
    // One Chromium worker: both browser files share the fixture UI server process.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: {
          dedupe: ["react", "react-dom"],
          alias: {
            react,
            "react-dom": reactDom,
            "react/jsx-runtime": jsxRuntime,
          },
        },
        optimizeDeps: {
          include: ["dragology", "react", "react-dom", "react/jsx-runtime"],
        },
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          fileParallelism: false,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium", headless: true }],
            // A desktop screen; a phone test sets its own viewport.
            viewport: { width: 1280, height: 800 },
            commands: {
              startUiServer,
              stopUiServer,
              savedPipeline,
              draftPipeline,
              grantScopes,
              removeDraftBlock,
            },
            // Give Chromium time to start before the first test.
            connectTimeout: 120_000,
          },
        },
      },
    ],
  },
});
