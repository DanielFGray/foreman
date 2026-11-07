import { afterAll, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect } from "effect";
import { Command } from "effect/cli";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scheduleCommand } from "./schedule-command.ts";

const folder = mkdtempSync(join(tmpdir(), "foreman-schedule-command-"));
const policyPath = join(folder, "policy.json");
const previousPolicyPath = process.env["FOREMAN_POLICY"];
process.env["FOREMAN_POLICY"] = policyPath;
afterAll(() => {
  if (previousPolicyPath === undefined) delete process.env["FOREMAN_POLICY"];
  else process.env["FOREMAN_POLICY"] = previousPolicyPath;
  rmSync(folder, { recursive: true, force: true });
});

describe("foreman schedule add", () => {
  test("rejects a non-positive cadence as a CLI argument error", async () => {
    const exit = await Effect.runPromiseExit(
      Command.runWith(scheduleCommand, { version: "test" })([
        "add",
        "demo",
        "retro",
        "--every-landed",
        "0",
        "--title",
        "Retro",
        "--template",
        "retro.md",
      ]).pipe(Effect.provide(BunServices.layer)),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.pretty(exit.cause)).toContain("Help requested");
      expect(Cause.pretty(exit.cause)).not.toContain("SchemaError");
    }
    expect(existsSync(policyPath)).toBe(false);
  });
});
