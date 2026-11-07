import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The page imports these pure modules in the browser. A node: or bun: import,
 * or a browser polyfill warning, means a Schema or rule still pulls file I/O.
 */
describe("pipeline modules browser bundle", () => {
  const folder = mkdtempSync(join(tmpdir(), "foreman-pipeline-browser-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  test("Bun.build for the browser has no node: or bun: import and no warning", async () => {
    const here = import.meta.dir;
    const entry = join(folder, "entry.ts");
    writeFileSync(
      entry,
      [
        `import { problemsOf } from ${JSON.stringify(`${here}/pipeline.ts`)};`,
        `import { expand } from ${JSON.stringify(`${here}/composite.ts`)};`,
        `import { beltOf } from ${JSON.stringify(`${here}/pipeline-belt.ts`)};`,
        `import { layoutOf } from ${JSON.stringify(`${here}/pipeline-layout.ts`)};`,
        `import { PipelineChange } from ${JSON.stringify(`${here}/pipeline-edit.ts`)};`,
        `void [problemsOf, expand, beltOf, layoutOf, PipelineChange];`,
        "",
      ].join("\n"),
    );

    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      metafile: true,
    });

    // Bun 1.4 emits build warnings with level "warn", which its types do not list, so
    // only the non-warning levels are allowed through.
    const quiet = ["debug", "verbose", "info"];
    const warnings = result.logs.filter((log) => !quiet.includes(log.level));
    expect(warnings.map((log) => log.message)).toEqual([]);
    expect(result.success).toBe(true);

    // String literals such as Effect's optional getBuiltinModule("node:async_hooks")
    // are not imports. The metafile lists real module edges.
    const nodeOrBun = Object.entries(result.metafile?.inputs ?? {}).flatMap(([file, info]) =>
      (info.imports ?? [])
        .filter((imp) => /^(node:|bun:)/.test(imp.path))
        .map((imp) => `${file} -> ${imp.path}`),
    );
    expect(nodeOrBun).toEqual([]);
  });
});
