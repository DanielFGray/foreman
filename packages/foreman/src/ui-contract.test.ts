import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

/**
 * The contract is imported by the browser page, so its module graph must hold
 * no Bun or Node built-in. A bundle with one fails the browser build.
 */
describe("ui-contract browser bundle", () => {
  test("bundles for the browser with no bun: or node: import", async () => {
    const outdir = mkdtempSync(join(tmpdir(), "ui-contract-"));
    try {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, "ui-contract.ts")],
        target: "browser",
        outdir,
      });
      const logs = result.logs.map((log) => log.message);
      expect(logs).toEqual([]);
      expect(result.success).toBe(true);
      const bundle = await result.outputs[0]!.text();
      expect(bundle).not.toMatch(/from\s+["'](bun|node):/);
      expect(bundle).not.toMatch(/require\(["'](bun|node):/);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
