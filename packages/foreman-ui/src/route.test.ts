import { assert, describe, it } from "@effect/vitest";
import { routeOf } from "./route.ts";

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
