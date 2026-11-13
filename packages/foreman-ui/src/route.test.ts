import { assert, describe, it } from "@effect/vitest";
import { graphPath, routeOf } from "./route.ts";

describe("routeOf", () => {
  it("lists projects at /", () => {
    assert.deepStrictEqual(routeOf("/"), { _tag: "projects" });
  });

  it("reads a project at /p/<project>", () => {
    assert.deepStrictEqual(routeOf("/p/amux"), { _tag: "project", name: "amux" });
    assert.deepStrictEqual(routeOf("/p/foreman/"), { _tag: "project", name: "foreman" });
  });

  it("decodes the project name", () => {
    assert.deepStrictEqual(routeOf("/p/my%20app"), { _tag: "project", name: "my app" });
  });
});

describe("routeOf, the task graph", () => {
  it("reads a project's graph at /p/<project>/graph", () => {
    assert.deepStrictEqual(routeOf("/p/amux/graph"), { _tag: "graph", name: "amux" });
    assert.deepStrictEqual(routeOf("/p/my%20app/graph/"), { _tag: "graph", name: "my app" });
  });

  it("falls back to the list for any other path under a project", () => {
    assert.deepStrictEqual(routeOf("/p/amux/other"), { _tag: "projects" });
  });

  it("round-trips graphPath", () => {
    assert.deepStrictEqual(routeOf(graphPath("my app")), { _tag: "graph", name: "my app" });
  });
});
