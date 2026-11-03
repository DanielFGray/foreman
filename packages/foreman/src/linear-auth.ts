import {
  Clock,
  Duration,
  Console,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema as S,
  Semaphore,
} from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { BunServices } from "@effect/platform-bun";
import { configDirectory } from "./shared-file.ts";

/** Where foreman's Linear OAuth app talks to Linear, and where Linear sends the browser back. */
export interface LinearOAuth {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** The callback server's port. Linear accepts only the redirect URL registered for the app. */
  readonly callbackPort: number;
}

export const LINEAR_OAUTH: LinearOAuth = {
  authorizeUrl: "https://linear.app/oauth/authorize",
  tokenUrl: "https://api.linear.app/oauth/token",
  callbackPort: 34338,
};

/**
 * The bearer token for Linear's API.
 *
 * `token` never starts the browser flow: the dispatcher calls it inside a tick,
 * and a tick must not wait for a person. With no token it fails with the
 * reason "run `foreman linear login`". `LINEAR_API_KEY`, when set, is the
 * token, with no refresh. Else the token file holds an OAuth token, which is
 * refreshed 30 minutes before it expires. One lock holds every read and
 * refresh, so two calls in one tick refresh once.
 */
export class LinearAuth extends Context.Service<
  LinearAuth,
  { readonly token: Effect.Effect<string, LinearAuthError> }
>()("LinearAuth") {
  static readonly layer = Layer.effect(LinearAuth, linearAuth(LINEAR_OAUTH)).pipe(
    Layer.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  );
}

const REFRESH_EARLY_MS = 30 * 60 * 1000;

export const tokenPath = (): string => `${configDirectory()}/linear-token.json`;

/** Builds the `token` effect over the token file, with its one lock. */
export function linearAuth(oauth: LinearOAuth) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;
    const lock = Semaphore.makeUnsafe(1);
    const services = Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, paths));

    const unlocked = Effect.gen(function* () {
      const key = process.env["LINEAR_API_KEY"];
      if (key) return key;
      const stored = yield* readToken;
      if (Option.isNone(stored)) return yield* new LinearAuthError({ detail: NO_TOKEN });
      const now = yield* Clock.currentTimeMillis;
      if (stored.value.expiresAt - REFRESH_EARLY_MS > now) return stored.value.accessToken;
      const clientId = process.env["FOREMAN_LINEAR_CLIENT_ID"];
      if (!clientId)
        return yield* new LinearAuthError({
          detail: "the Linear token expired, and refresh needs FOREMAN_LINEAR_CLIENT_ID",
        });
      // Only Linear's refusal of the refresh token ends the login. A network
      // error, a timeout or a 5xx says nothing about the token, so the file
      // stays and the next read tries again.
      const refreshed = yield* exchange(client, oauth, {
        grant_type: "refresh_token",
        refresh_token: stored.value.refreshToken,
        client_id: clientId,
      }).pipe(
        Effect.catchTag("TokenRejected", (rejected) =>
          fs.remove(tokenPath()).pipe(
            Effect.ignore,
            Effect.andThen(
              new LinearAuthError({
                detail: `Linear refused the refresh token (${rejected.detail}): ${NO_TOKEN}`,
              }),
            ),
          ),
        ),
      );
      yield* writeToken(refreshed);
      return refreshed.accessToken;
    }).pipe(Effect.provideContext(services));

    return { token: lock.withPermit(unlocked) };
  });
}

/**
 * `foreman linear login`: runs the OAuth authorization-code flow with PKCE and
 * writes the token file. A local server on `callbackPort` takes Linear's
 * redirect; the authorize URL is printed for the operator to open.
 */
export const login = (oauth: LinearOAuth) =>
  Effect.gen(function* () {
    if (process.env["LINEAR_API_KEY"])
      return yield* Console.log("LINEAR_API_KEY is set: foreman uses it, and needs no login");
    const clientId = process.env["FOREMAN_LINEAR_CLIENT_ID"];
    if (!clientId) return yield* new LinearAuthError({ detail: registerHelp(oauth) });
    const client = yield* HttpClient.HttpClient;
    const code = yield* Deferred.make<string, LinearAuthError>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: oauth.callbackPort,
          fetch: (request) => {
            const url = new URL(request.url);
            if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
            const value = url.searchParams.get("code");
            Deferred.doneUnsafe(
              code,
              value
                ? Effect.succeed(value)
                : new LinearAuthError({
                    detail: `Linear refused the login: ${url.searchParams.get("error") ?? "no code"}`,
                  }),
            );
            return new Response(
              value
                ? "foreman: Linear login done. You can close this window."
                : "foreman: Linear login failed.",
            );
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );
    const redirectUri = `http://localhost:${server.port}/callback`;
    const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
    const authorize = new URL(oauth.authorizeUrl);
    for (const [name, value] of Object.entries({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "read,write",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      authorize.searchParams.set(name, value);
    yield* Console.log(`Open this URL to log in to Linear:\n${authorize.href}`);
    const token = yield* exchange(client, oauth, {
      grant_type: "authorization_code",
      code: yield* Deferred.await(code),
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).pipe(
      Effect.catchTag(
        "TokenRejected",
        (rejected) =>
          new LinearAuthError({ detail: `Linear refused the login code: ${rejected.detail}` }),
      ),
    );
    yield* writeToken(token);
    yield* Console.log(`Linear token written to ${tokenPath()}`);
  }).pipe(Effect.scoped);

const NO_TOKEN = "no Linear token: run `foreman linear login`, or set LINEAR_API_KEY";

const registerHelp = (oauth: LinearOAuth) =>
  [
    "FOREMAN_LINEAR_CLIENT_ID is not set, and neither is LINEAR_API_KEY.",
    "Set LINEAR_API_KEY to a personal API key from Linear's Settings > Security & access, or",
    "register foreman as an OAuth application at https://linear.app/settings/api/applications/new",
    `with the callback URL http://localhost:${oauth.callbackPort}/callback, then set`,
    "FOREMAN_LINEAR_CLIENT_ID to its client id and run `foreman linear login` again.",
  ].join("\n");

/** The token file. `expiresAt` is epoch milliseconds. */
const StoredToken = S.Struct({
  accessToken: S.String,
  refreshToken: S.String,
  expiresAt: S.Finite,
});
type StoredToken = typeof StoredToken.Type;

const TokenResponse = S.Struct({
  access_token: S.String,
  refresh_token: S.String,
  expires_in: S.Finite,
});

/**
 * Posts one grant to the token endpoint, and stamps the expiry from the clock.
 * A 4xx answer is Linear refusing the grant (`TokenRejected`); every other
 * failure, a timeout after 30 seconds included, is a `LinearAuthError`.
 */
const exchange = (
  client: HttpClient.HttpClient,
  oauth: LinearOAuth,
  grant: Record<string, string>,
) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.post(oauth.tokenUrl).pipe(
      HttpClientRequest.bodyUrlParams(grant),
      client.execute,
      Effect.timeout(Duration.seconds(30)),
    );
    if (response.status >= 400 && response.status < 500)
      return yield* new TokenRejected({
        detail: `HTTP ${response.status}: ${yield* response.text}`,
      });
    if (response.status >= 300)
      return yield* new LinearAuthError({
        detail: `Linear token request answered HTTP ${response.status}`,
      });
    const body = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response);
    const now = yield* Clock.currentTimeMillis;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: now + body.expires_in * 1000,
    } satisfies StoredToken;
  }).pipe(
    Effect.catchIf(
      (error) => error._tag !== "TokenRejected" && error._tag !== "LinearAuthError",
      (error) => new LinearAuthError({ detail: `Linear token request failed: ${error.message}` }),
    ),
  );

/** Linear refused a grant: the code or the refresh token is no good. */
class TokenRejected extends S.TaggedError<TokenRejected>()("TokenRejected", {
  detail: S.String,
}) {}

/** A missing file is no token; a file that does not decode is an error the operator fixes by logging in again. */
const readToken = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(tokenPath()).pipe(Effect.option);
  if (Option.isNone(text)) return Option.none<StoredToken>();
  return Option.some(
    yield* S.decodeEffect(S.fromJsonString(StoredToken))(text.value).pipe(
      Effect.mapError(
        () =>
          new LinearAuthError({
            detail: `${tokenPath()} does not decode: run \`foreman linear login\``,
          }),
      ),
    ),
  );
});

/**
 * Writes the token file with mode 0600 through a temporary and a rename, so a
 * reader never sees half a token and the token is never readable by others.
 */
const writeToken = (token: StoredToken) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const path = tokenPath();
    const temporary = `${path}.${process.pid}.tmp`;
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
    yield* fs.writeFileString(temporary, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    yield* fs.chmod(temporary, 0o600);
    yield* fs.rename(temporary, path);
  }).pipe(
    Effect.mapError(
      (error) => new LinearAuthError({ detail: `cannot write the Linear token: ${error.message}` }),
    ),
  );

/** Why foreman has no Linear token to use. */
export class LinearAuthError extends S.TaggedError<LinearAuthError>()("LinearAuthError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** `foreman linear login`, the one way to write the token file. */
export const linearCommand = Command.make("linear").pipe(
  Command.withDescription("Linear's login"),
  Command.withSubcommands([
    Command.make("login", {}, () =>
      login(LINEAR_OAUTH).pipe(Effect.provide(FetchHttpClient.layer)),
    ).pipe(
      Command.withDescription(
        "Log in to Linear with OAuth and write the token file; with LINEAR_API_KEY set, do nothing",
      ),
    ),
  ]),
);
