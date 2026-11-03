import { Context, Duration, Effect, Layer, Schema as S } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { LinearAuth } from "./linear-auth.ts";

/**
 * Linear's GraphQL API, the one place foreman sends HTTP to Linear. Nothing
 * above this file knows the endpoint or the token, so a test gives the tracker
 * a fake `Linear` instead of a network.
 */
export class Linear extends Context.Service<
  Linear,
  {
    /**
     * Runs one GraphQL document. Answers its `data` and the request budget the
     * response headers report. A GraphQL `errors` answer, an HTTP failure or
     * no answer in 30 seconds is a `LinearError`.
     */
    readonly graphql: (
      document: string,
      variables: Record<string, unknown>,
    ) => Effect.Effect<LinearAnswer, LinearError>;
  }
>()("Linear") {
  static readonly layerWith = Layer.effect(Linear, linearApi("https://api.linear.app/graphql"));

  static readonly layer = Linear.layerWith.pipe(
    Layer.provide(Layer.mergeAll(LinearAuth.layer, FetchHttpClient.layer)),
  );
}

/** `Linear` over the GraphQL API at `endpoint`, with the token `LinearAuth` gives. */
export function linearApi(endpoint: string) {
  return Effect.gen(function* () {
    const auth = yield* LinearAuth;
    const client = yield* HttpClient.HttpClient;
    return Linear.of({
      graphql: (document, variables) =>
        Effect.gen(function* () {
          const token = yield* auth.token;
          const response = yield* HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.setHeader("authorization", authorization(token)),
            HttpClientRequest.bodyJsonUnsafe({ query: document, variables }),
            client.execute,
            Effect.timeout(Duration.seconds(30)),
          );
          const text = yield* response.text;
          if (response.status >= 300)
            return yield* new LinearError({ detail: `HTTP ${response.status}: ${text}` });
          const body = yield* S.decodeEffect(S.fromJsonString(Envelope))(text);
          if (body.errors !== undefined && body.errors.length > 0)
            return yield* new LinearError({
              detail: body.errors.map((error) => error.message).join("; "),
            });
          return { data: body.data, rate: rateOf(response.headers) };
        }).pipe(
          Effect.catchIf(
            (error) => error._tag !== "LinearError",
            (error) => Effect.fail(new LinearError({ detail: error.message })),
          ),
        ),
    });
  });
}

export interface LinearAnswer {
  readonly data: unknown;
  readonly rate: LinearRate | undefined;
}

/**
 * What is left of Linear's hourly budgets, from the response headers. Linear
 * limits both the request count and the summed query complexity; `reset` is
 * when the request budget refills, in epoch milliseconds.
 */
export interface LinearRate {
  readonly requests: { readonly remaining: number; readonly limit: number };
  readonly complexity: { readonly remaining: number; readonly limit: number } | undefined;
  readonly reset: number;
}

export class LinearError extends S.TaggedError<LinearError>()("LinearError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

/**
 * A personal API key goes in the header as it is; an OAuth token takes the
 * `Bearer` scheme. Linear marks its personal keys with the `lin_api_` prefix.
 */
const authorization = (token: string) => (token.startsWith("lin_api_") ? token : `Bearer ${token}`);

const Envelope = S.Struct({
  data: S.optional(S.Unknown),
  errors: S.optional(S.Array(S.Struct({ message: S.String }))),
});

const rateOf = (headers: Readonly<Record<string, string | undefined>>): LinearRate | undefined => {
  const number = (name: string) => {
    const value = headers[name];
    return value === undefined || value === "" ? undefined : Number(value);
  };
  const remaining = number("x-ratelimit-requests-remaining");
  const limit = number("x-ratelimit-requests-limit");
  if (remaining === undefined || limit === undefined) return undefined;
  const complexityRemaining = number("x-ratelimit-complexity-remaining");
  const complexityLimit = number("x-ratelimit-complexity-limit");
  return {
    requests: { remaining, limit },
    complexity:
      complexityRemaining === undefined || complexityLimit === undefined
        ? undefined
        : { remaining: complexityRemaining, limit: complexityLimit },
    reset: number("x-ratelimit-requests-reset") ?? 0,
  };
};
