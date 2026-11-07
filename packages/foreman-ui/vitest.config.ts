import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { startUiServer, stopUiServer } from "./test/browser/commands.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium", headless: true }],
            commands: { startUiServer, stopUiServer },
            // Give Chromium time to start before the first test.
            connectTimeout: 120_000,
          },
        },
      },
    ],
  },
});
