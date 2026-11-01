import { describe, expect, test } from "bun:test";
import { harnessLaunch, launchArguments } from "./harness.ts";

describe("launchArguments", () => {
  test("spells the thinking level the way each harness takes it", () => {
    const model = "m";
    expect(launchArguments({ kind: "claude", model, thinking: "low" })).toEqual([
      "--model",
      "m",
      "--effort",
      "low",
    ]);
    expect(launchArguments({ kind: "codex", model, thinking: "low" })).toEqual([
      "--model",
      "m",
      "-c",
      "model_reasoning_effort=low",
    ]);
    expect(launchArguments({ kind: "pi", model, thinking: "medium" })).toEqual([
      "--model",
      "m",
      "--thinking",
      "medium",
    ]);
  });

  test("passes no flag for a level the harness picks or cannot take", () => {
    expect(launchArguments({ kind: "cursor", model: undefined, thinking: "auto" })).toEqual([]);
    expect(launchArguments({ kind: "claude", model: undefined, thinking: undefined })).toEqual([]);
  });
});

describe("harnessLaunch", () => {
  const base = { model: "m", prompt: "do the task", directory: "/w/t1" };

  test("hands the prompt to the harness as its last argument", () => {
    expect(harnessLaunch({ ...base, kind: "claude", thinking: "high" }).argv).toEqual([
      "claude",
      "--model",
      "m",
      "--effort",
      "high",
      "do the task",
    ]);
    expect(harnessLaunch({ ...base, kind: "cursor" }).argv).toEqual([
      "cursor-agent",
      "--trust",
      "--model",
      "m",
      "do the task",
    ]);
  });

  test("runs codex in a process of its own, so the rung's model holds", () => {
    expect(harnessLaunch({ ...base, kind: "codex" }).argv.slice(0, 2)).toEqual([
      "codex",
      "--no-daemon",
    ]);
  });

  test("gives opencode its model and write rules through its config, not its flags", () => {
    const launch = harnessLaunch({ ...base, kind: "opencode" });
    expect(launch.argv).toEqual(["opencode", "--standalone", "--auto", "--prompt", "do the task"]);
    const config = JSON.parse(launch.env["OPENCODE_CONFIG_CONTENT"]!);
    expect(config.model).toBe("m");
    // Last match wins, so the worktree's own allow must follow the checkouts' deny.
    expect(Object.entries(config.permission.edit).at(-1)).toEqual(["/w/t1/**", "allow"]);
  });
});
