import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Linear, linearApi } from "./linear.ts";
import { LinearAuth, LinearAuthError } from "./linear-auth.ts";

/** A local GraphQL endpoint: each request is recorded and answered by `reply`. */
let reply: () => Response = () => Response.json({ data: {} });
const seen: Array<{ authorization: string | null; body: unknown }> = [];
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    seen.push({ authorization: request.headers.get("authorization"), body: await request.json() });
    return reply();
  },
});
afterAll(() => server.stop(true));

const graphql = (token: Effect.Effect<string, LinearAuthError>) =>
  Effect.gen(function* () {
    const linear = yield* Linear;
    return yield* linear.graphql("query { viewer { id } }", { a: 1 });
  }).pipe(
    Effect.provide(
      Layer.effect(Linear, linearApi(`http://localhost:${server.port}/graphql`)).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(LinearAuth, LinearAuth.of({ token })),
            FetchHttpClient.layer,
          ),
        ),
      ),
    ),
  );

describe("Linear", () => {
  test("posts the document with the token, and reads data and the rate-limit headers", async () => {
    seen.length = 0;
    reply = () =>
      Response.json(
        { data: { viewer: { id: "me" } } },
        {
          headers: {
            "X-RateLimit-Requests-Remaining": "90",
            "X-RateLimit-Requests-Limit": "1500",
            "X-RateLimit-Requests-Reset": "1800000000000",
            "X-RateLimit-Complexity-Remaining": "5000",
            "X-RateLimit-Complexity-Limit": "250000",
          },
        },
      );
    const answer = await Effect.runPromise(graphql(Effect.succeed("lin_oauth_x")));
    expect(answer).toEqual({
      data: { viewer: { id: "me" } },
      rate: {
        requests: { remaining: 90, limit: 1500 },
        complexity: { remaining: 5000, limit: 250000 },
        reset: 1800000000000,
      },
    });
    expect(seen).toEqual([
      {
        authorization: "Bearer lin_oauth_x",
        body: { query: "query { viewer { id } }", variables: { a: 1 } },
      },
    ]);
  });

  test("sends a personal API key with no scheme", async () => {
    seen.length = 0;
    reply = () => Response.json({ data: {} });
    await Effect.runPromise(graphql(Effect.succeed("lin_api_y")));
    expect(seen[0]?.authorization).toBe("lin_api_y");
  });

  test("a GraphQL errors answer, an HTTP failure and a missing login each fail with their reason", async () => {
    reply = () => Response.json({ errors: [{ message: "Entity not found" }] });
    const errors = await Effect.runPromise(Effect.flip(graphql(Effect.succeed("t"))));
    expect(errors.detail).toBe("Entity not found");

    reply = () => new Response("down", { status: 503 });
    const http = await Effect.runPromise(Effect.flip(graphql(Effect.succeed("t"))));
    expect(http.detail).toBe("HTTP 503: down");

    const login = await Effect.runPromise(
      Effect.flip(
        graphql(Effect.fail(new LinearAuthError({ detail: "run `foreman linear login`" }))),
      ),
    );
    expect(login.detail).toBe("run `foreman linear login`");
  });
});
