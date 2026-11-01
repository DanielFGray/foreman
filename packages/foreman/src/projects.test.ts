import { describe, expect, test } from "bun:test";
import { projectOf, projectSet } from "./projects.ts";

describe("projectOf", () => {
  test("names the project from its git common directory, so a linked worktree gets its checkout's name", () => {
    expect(projectOf("/build/foo/.git")).toBe("foo");
    expect(projectOf("/home/me/build/foo/.git")).toBe("foo");
  });
});

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
