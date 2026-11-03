import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Duration, Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { BunServices } from "@effect/platform-bun";
import { TestClock } from "effect/testing";
import { linearAuth, login, tokenPath, type LinearOAuth } from "./linear-auth.ts";

/** A local stand-in for Linear's token endpoint, which records every grant it is sent. */
const fakeTokenEndpoint = () => {
  const grants: Array<Record<string, string>> = [];
  let issued = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const grant = Object.fromEntries(new URLSearchParams(await request.text()));
      grants.push(grant);
      if (grant["refresh_token"] === "revoked")
        return new Response("invalid_grant", { status: 400 });
      if (grant["refresh_token"] === "unavailable") return new Response("down", { status: 503 });
      if (grant["refresh_token"] === "silent") return new Promise<Response>(() => {});
      issued++;
      return Response.json({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read,write",
      });
    },
  });
  const oauth: LinearOAuth = {
    authorizeUrl: "https://linear.example/oauth/authorize",
    tokenUrl: `http://localhost:${server.port}/oauth/token`,
    callbackPort: 0,
  };
  return { grants, oauth, stop: () => server.stop(true) };
};

const platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

let config: string;
const saved = { ...process.env };

beforeEach(() => {
  config = mkdtempSync(`${tmpdir()}/foreman-linear-`);
  process.env["XDG_CONFIG_HOME"] = config;
  process.env["FOREMAN_LINEAR_CLIENT_ID"] = "client-1";
  delete process.env["LINEAR_API_KEY"];
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(config, { recursive: true, force: true });
});

const writeStored = (expiresAt: number, refreshToken = "refresh-0") => {
  mkdirSync(`${config}/foreman`, { recursive: true });
  writeFileSync(tokenPath(), JSON.stringify({ accessToken: "access-0", refreshToken, expiresAt }));
};

describe("foreman linear login", () => {
  test("runs PKCE: the callback's code and the verifier of the printed challenge buy a 0600 token file", async () => {
    const endpoint = fakeTokenEndpoint();
    const printed: Array<string> = [];
    const log = spyOn(console, "log").mockImplementation(
      (line: unknown) => void printed.push(String(line)),
    );
    try {
      const run = login(endpoint.oauth).pipe(Effect.provide(platform), Effect.runPromise);
      while (!printed.some((line) => line.includes("oauth/authorize"))) await Bun.sleep(5);
      const authorize = new URL(
        printed
          .join("\n")
          .split("\n")
          .find((line) => line.startsWith("https://"))!,
      );
      expect(authorize.searchParams.get("client_id")).toBe("client-1");
      expect(authorize.searchParams.get("scope")).toBe("read,write");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      const redirect = authorize.searchParams.get("redirect_uri")!;
      expect((await fetch(`${redirect}?code=the-code`)).ok).toBe(true);
      await run;

      const [grant] = endpoint.grants;
      expect(grant).toMatchObject({
        grant_type: "authorization_code",
        code: "the-code",
        client_id: "client-1",
        redirect_uri: redirect,
      });
      const challenge = new Bun.CryptoHasher("sha256")
        .update(grant!["code_verifier"]!)
        .digest("base64url");
      expect(challenge).toBe(authorize.searchParams.get("code_challenge")!);
      expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(tokenPath(), "utf8"))).toMatchObject({
        accessToken: "access-1",
        refreshToken: "refresh-1",
      });
    } finally {
      log.mockRestore();
      await endpoint.stop();
    }
  });

  test("with LINEAR_API_KEY set, starts no flow and writes no file", async () => {
    process.env["LINEAR_API_KEY"] = "lin_api_key";
    const endpoint = fakeTokenEndpoint();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await login(endpoint.oauth).pipe(Effect.provide(platform), Effect.runPromise);
      expect(endpoint.grants).toEqual([]);
      expect(existsSync(tokenPath())).toBe(false);
    } finally {
      log.mockRestore();
      await endpoint.stop();
    }
  });

  test("with no client id and no key, says how to register the app and its callback URL", async () => {
    delete process.env["FOREMAN_LINEAR_CLIENT_ID"];
    const endpoint = fakeTokenEndpoint();
    const error = await login({ ...endpoint.oauth, callbackPort: 34338 }).pipe(
      Effect.flip,
      Effect.provide(platform),
      Effect.runPromise,
    );
    await endpoint.stop();
    expect(error.detail).toContain("http://localhost:34338/callback");
    expect(error.detail).toContain("FOREMAN_LINEAR_CLIENT_ID");
  });
});

describe("LinearAuth.token", () => {
  test("LINEAR_API_KEY is the token, with no file and no request", async () => {
    process.env["LINEAR_API_KEY"] = "lin_api_key";
    const endpoint = fakeTokenEndpoint();
    const token = await Effect.flatMap(linearAuth(endpoint.oauth), (auth) => auth.token).pipe(
      Effect.provide(platform),
      Effect.runPromise,
    );
    await endpoint.stop();
    expect(token).toBe("lin_api_key");
    expect(endpoint.grants).toEqual([]);
  });

  test("with no token, fails with the login reason and starts no browser flow", async () => {
    const endpoint = fakeTokenEndpoint();
    const error = await Effect.flatMap(linearAuth(endpoint.oauth), (auth) =>
      Effect.flip(auth.token),
    ).pipe(Effect.provide(platform), Effect.runPromise);
    await endpoint.stop();
    expect(error.detail).toContain("run `foreman linear login`");
    expect(endpoint.grants).toEqual([]);
  });

  test("refreshes 30 minutes early, once for two calls in one tick, and keeps the file 0600", async () => {
    const endpoint = fakeTokenEndpoint();
    writeStored(Duration.toMillis(Duration.hours(1)));
    await Effect.gen(function* () {
      const auth = yield* linearAuth(endpoint.oauth);
      expect(yield* auth.token).toBe("access-0");
      yield* TestClock.adjust(Duration.minutes(29));
      expect(yield* auth.token).toBe("access-0");
      expect(endpoint.grants).toEqual([]);

      yield* TestClock.adjust(Duration.minutes(2));
      const both = yield* Effect.all([auth.token, auth.token], { concurrency: 2 });
      expect(both).toEqual(["access-1", "access-1"]);
      expect(endpoint.grants).toEqual([
        { grant_type: "refresh_token", refresh_token: "refresh-0", client_id: "client-1" },
      ]);
    }).pipe(Effect.provide(Layer.merge(platform, TestClock.layer())), Effect.runPromise);
    await endpoint.stop();
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(tokenPath(), "utf8")).refreshToken).toBe("refresh-1");
  });

  const refreshFailure = (oauth: LinearOAuth, during = Effect.void) =>
    Effect.gen(function* () {
      const auth = yield* linearAuth(oauth);
      const fiber = yield* Effect.forkChild(Effect.flip(auth.token));
      yield* during;
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.merge(platform, TestClock.layer())), Effect.runPromise);

  test("Linear refusing the refresh token (4xx) removes the token file", async () => {
    const endpoint = fakeTokenEndpoint();
    writeStored(0, "revoked");
    const error = await refreshFailure(endpoint.oauth);
    await endpoint.stop();
    expect(error.detail).toContain("Linear refused the refresh token");
    expect(existsSync(tokenPath())).toBe(false);
  });

  test("a 5xx answer keeps the token file and fails this read", async () => {
    const endpoint = fakeTokenEndpoint();
    writeStored(0, "unavailable");
    const error = await refreshFailure(endpoint.oauth);
    await endpoint.stop();
    expect(error.detail).toContain("HTTP 503");
    expect(existsSync(tokenPath())).toBe(true);
  });

  test("a network error keeps the token file and fails this read", async () => {
    const endpoint = fakeTokenEndpoint();
    await endpoint.stop();
    writeStored(0);
    const error = await refreshFailure(endpoint.oauth);
    expect(error.detail).toContain("Linear token request failed");
    expect(existsSync(tokenPath())).toBe(true);
  });

  test("a refresh with no answer times out at 30 seconds and keeps the token file", async () => {
    const endpoint = fakeTokenEndpoint();
    writeStored(0, "silent");
    const error = await refreshFailure(
      endpoint.oauth,
      Effect.gen(function* () {
        while (endpoint.grants.length === 0) yield* Effect.promise(() => Bun.sleep(5));
        yield* TestClock.adjust(Duration.seconds(30));
      }),
    );
    await endpoint.stop();
    expect(error.detail).toContain("Linear token request failed");
    expect(existsSync(tokenPath())).toBe(true);
  });
});
