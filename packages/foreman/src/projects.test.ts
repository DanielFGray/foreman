import { describe, expect, test } from "bun:test";
import { projectSet } from "./projects.ts";

describe("projectSet", () => {
  test("names a project for its checkout, and only an open space takes new work", () => {
    expect(projectSet(["/build/foreman"], ["/build/foreman", "/build/prog"])).toEqual({
      projects: [
        { name: "foreman", directory: "/build/foreman", open: true },
        // Its space was closed while an agent still ran: the work drains.
        { name: "prog", directory: "/build/prog", open: false },
      ],
      ambiguous: [],
    });
  });

  test("holds a name two checkouts share rather than picking one", () => {
    expect(projectSet(["/build/herdr-web", "/old/herdr-web"], [])).toEqual({
      projects: [],
      ambiguous: [{ name: "herdr-web", directories: ["/build/herdr-web", "/old/herdr-web"] }],
    });
  });
});
