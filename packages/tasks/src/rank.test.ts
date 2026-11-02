import { describe, expect, test } from "bun:test";
import { scoreOf } from "./rank.ts";

const now = new Date("2026-11-01T12:00:00Z");
const item = { priority: 2, project: "a", labels: [], createdAt: now };
const credit = (epicDone: number) => scoreOf(item, now, 0) - scoreOf(item, now, epicDone);

describe("scoreOf", () => {
  test("the epic credit grows quadratically, so it stays small until an epic is nearly done", () => {
    expect(credit(0)).toBe(0);
    expect(credit(0.5)).toBeCloseTo(0.5, 5);
    expect(credit(0.99)).toBeCloseTo(1.9602, 3);
    expect(credit(1)).toBeCloseTo(2, 5);
  });
});
