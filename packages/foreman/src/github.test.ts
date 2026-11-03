import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createPullRequest, Github, pullRequestsOf, requiredChecksOf } from "./github.ts";
import { fakeGh } from "./github-fixture.ts";

const response = (status: string, headers: ReadonlyArray<string>, body: string) =>
  [`HTTP/2.0 ${status}`, ...headers, "", body].join("\r\n");

describe("Github.get", () => {
  test("a second read sends the ETag and answers the cached body on a 304", async () => {
    const { calls, layer } = fakeGh((args) =>
      args.includes("-H")
        ? {
            exitCode: 1,
            stdout: response("304 Not Modified", ['Etag: W/"a"'], ""),
            stderr: "gh: HTTP 304",
          }
        : { exitCode: 0, stdout: response("200 OK", ['Etag: W/"a"'], '{"n":1}'), stderr: "" },
    );
    const [first, second] = await Effect.runPromise(
      Github.use((github) =>
        Effect.all([github.get("repos/o/r/issues/1"), github.get("repos/o/r/issues/1")]),
      ).pipe(Effect.provide(layer)),
    );
    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 });
    expect(calls[0]).toEqual(["api", "-i", "repos/o/r/issues/1"]);
    expect(calls[1]).toEqual(["api", "-i", "-H", 'If-None-Match: W/"a"', "repos/o/r/issues/1"]);
  });

  test("a changed resource replaces the cached body", async () => {
    let n = 0;
    const { layer } = fakeGh(() => {
      n += 1;
      return {
        exitCode: 0,
        stdout: response("200 OK", [`Etag: "${n}"`], `{"n":${n}}`),
        stderr: "",
      };
    });
    const bodies = await Effect.runPromise(
      Github.use((github) => Effect.all([github.get("p"), github.get("p")])).pipe(
        Effect.provide(layer),
      ),
    );
    expect(bodies).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("a 404 fails with its status", async () => {
    const { layer } = fakeGh(() => ({
      exitCode: 1,
      stdout: response("404 Not Found", [], '{"message":"Not Found"}'),
      stderr: "gh: Not Found (HTTP 404)",
    }));
    const error = await Effect.runPromise(
      Github.use((github) => github.get("p").pipe(Effect.asVoid, Effect.flip)).pipe(
        Effect.provide(layer),
      ),
    );
    expect(error.status).toBe(404);
  });
});

describe("pull requests", () => {
  const answering = (stdout: string, exitCode = 0, stderr = "") =>
    fakeGh(() => ({ exitCode, stdout, stderr })).layer;

  test("a PR reads with the commits its reviews were posted on", async () => {
    const layer = answering(
      JSON.stringify([
        {
          number: 3,
          state: "OPEN",
          headRefOid: "c1",
          mergeStateStatus: "CLEAN",
          reviews: [{ commit: { oid: "c0" } }, { commit: null }],
        },
      ]),
    );
    const pulls = await Effect.runPromise(
      pullRequestsOf("o/r", "foreman/ts-1").pipe(Effect.provide(layer)),
    );
    expect(pulls).toEqual([
      { number: 3, state: "OPEN", head: "c1", mergeState: "CLEAN", reviewed: ["c0"] },
    ]);
  });

  test("create answers the number at the end of the URL gh prints", async () => {
    const number = await Effect.runPromise(
      createPullRequest("o/r", { head: "h", base: "main", title: "t", body: "b" }).pipe(
        Effect.provide(answering("https://github.com/o/r/pull/12\n")),
      ),
    );
    expect(number).toBe(12);
  });

  test.each([
    [
      [
        { name: "a", bucket: "pass" },
        { name: "b", bucket: "skipping" },
      ],
      "pass",
    ],
    [
      [
        { name: "a", bucket: "pass" },
        { name: "b", bucket: "pending" },
      ],
      "pending",
    ],
    [
      [
        { name: "a", bucket: "pending" },
        { name: "b", bucket: "fail" },
      ],
      "fail",
    ],
    [[{ name: "a", bucket: "cancel" }], "fail"],
  ] as const)("required checks %j fold to %s, whatever gh exits with", async (checks, verdict) => {
    const result = await Effect.runPromise(
      requiredChecksOf("o/r", 3).pipe(Effect.provide(answering(JSON.stringify(checks), 8))),
    );
    expect(result.verdict).toBe(verdict);
  });

  test("a repo that requires no checks reads as none", async () => {
    const result = await Effect.runPromise(
      requiredChecksOf("o/r", 3).pipe(
        Effect.provide(answering("", 1, "no required checks reported on the 'x' branch")),
      ),
    );
    expect(result).toEqual({ verdict: "none", output: "" });
  });
});
