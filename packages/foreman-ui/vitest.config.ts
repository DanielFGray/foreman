import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** Fixed Vite port so the UI server can trust this page origin in browser tests. */
export const VITEST_PAGE_PORT = 17341;

export default defineConfig({
  server: {
    port: VITEST_PAGE_PORT,
    strictPort: true,
    host: "127.0.0.1",
  },
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
        server: {
          port: VITEST_PAGE_PORT,
          strictPort: true,
          host: "127.0.0.1",
        },
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          globalSetup: ["./test/browser/globalSetup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium", headless: true }],
            // Give Chromium time after globalSetup's UI server build.
            connectTimeout: 120_000,
          },
        },
      },
    ],
  },
});
