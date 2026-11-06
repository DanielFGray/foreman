import { describe, expect, test } from "bun:test";
import { definitionRefusal } from "./definition.js";

describe("definitionRefusal", () => {
  test("refuses a definition the project draft made, naming the save that stores it", () => {
    const refusal = definitionRefusal("review-loop", {
      unsaved: ["review-loop"],
      composites: ["review-loop"],
    });
    expect(refusal).toContain("review-loop");
    expect(refusal).toContain("save that project's draft");
  });

  test("allows a definition already stored", () => {
    expect(
      definitionRefusal("review-loop", { unsaved: [], composites: ["review-loop"] }),
    ).toBeNull();
  });

  test("allows when the drawing has no choices yet", () => {
    expect(definitionRefusal("review-loop", undefined)).toBeNull();
  });
});
