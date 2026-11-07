import { afterEach, describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { resolve } from "./paths.ts";

const saved = { state: process.env["XDG_STATE_HOME"], data: process.env["XDG_DATA_HOME"] };

afterEach(() => {
  for (const [key, value] of [
    ["XDG_STATE_HOME", saved.state],
    ["XDG_DATA_HOME", saved.data],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("checkouts", () => {
  // The pane watches the published file's folder, and a checkout's dependency
  // folders would fill that watch.
  test("live outside the folder of the published file", () => {
    delete process.env["XDG_STATE_HOME"];
    delete process.env["XDG_DATA_HOME"];
    const paths = resolve();
    expect(paths.checkouts.startsWith(dirname(paths.published))).toBe(false);
  });

  test("follow XDG_DATA_HOME", () => {
    process.env["XDG_DATA_HOME"] = "/data";
    expect(resolve().checkouts).toBe("/data/foreman");
  });
});
