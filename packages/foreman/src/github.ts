import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Layer, Ref, Schema as S, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The `gh` command line, the one way foreman reads and writes GitHub.
 *
 * Every call to `gh` goes through `exec`, so a test swaps in a scripted `Gh`
 * and the parsing and the ETag cache in `Github` run unchanged over it.
 * foreman holds no token: `gh` uses the account `gh auth login` set up, or
 * `GH_TOKEN`.
 */
export class Gh extends Context.Service<
  Gh,
  {
    /**
     * Runs `gh` with `args` and reports its exit code and both streams. A
     * refusal prints to stderr and exits non-zero, so the caller reads all three.
     */
    readonly exec: (
      args: ReadonlyArray<string>,
      options?: GhOptions,
    ) => Effect.Effect<GhResult, GithubError>;
  }
>()("Gh") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Gh.of({
        exec: (args, options = {}) =>
          Effect.scoped(
            Effect.gen(function* () {
              const process = yield* spawner.spawn(
                ChildProcess.make("gh", args, {
                  ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                  // `env` adds to foreman's own environment, which holds `gh`'s
                  // PATH, HOME and login.
                  ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
                  stdin: Stream.make(options.input ?? "").pipe(Stream.encodeText),
                }),
              );
              const [exitCode, stdout, stderr] = yield* Effect.all(
                [
                  process.exitCode,
                  Stream.decodeText(process.stdout).pipe(Stream.mkString),
                  Stream.decodeText(process.stderr).pipe(Stream.mkString),
                ],
                { concurrency: 3 },
              );
              return { exitCode: Number(exitCode), stdout, stderr };
            }),
          ).pipe(
            Effect.mapError(
              (cause) => new GithubError({ command: commandOf(args), detail: String(cause) }),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(BunServices.layer));
}

/** Where `gh` runs, what it reads on stdin, and variables added to its environment. */
export interface GhOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface GhResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class GithubError extends S.TaggedError<GithubError>()("GithubError", {
  command: S.String,
  detail: S.String,
  /** The HTTP status, when GitHub answered with one. */
  status: S.optional(S.Finite),
}) {
  override get message() {
    return `${this.command}: ${this.detail}`;
  }
}

/**
 * GitHub through `gh`, with its output parsed.
 *
 * `get` holds an ETag cache in process memory, keyed by path. It sends the
 * cached ETag as `If-None-Match`, and answers the cached body on a `304 Not
 * Modified`. GitHub does not count a 304 against the REST limit, so a read that
 * repeats each second (the claim confirmation) costs one request until the
 * resource changes. A restart starts the cache empty, which costs one full read
 * per path and changes no answer. GraphQL has no ETag, so `graphql` takes no
 * cache.
 */
export class Github extends Context.Service<
  Github,
  {
    /** Runs `gh` and answers its exit code and both streams, for a call whose exit code says too little. */
    readonly exec: Gh["Service"]["exec"];
    /** Runs `gh` and answers its stdout; a non-zero exit is a `GithubError`. */
    readonly run: (
      args: ReadonlyArray<string>,
      options?: GhOptions,
    ) => Effect.Effect<string, GithubError>;
    /** A REST GET of `path` (`repos/OWNER/NAME/issues/1`), through the ETag cache. */
    readonly get: (path: string) => Effect.Effect<unknown, GithubError>;
    /** One GraphQL query; a response that names errors and holds no data is a `GithubError`. */
    readonly graphql: (
      query: string,
      variables?: Readonly<Record<string, string | number>>,
    ) => Effect.Effect<unknown, GithubError>;
  }
>()("Github") {
  static readonly make = Effect.gen(function* () {
    const gh = yield* Gh;
    const cache = yield* Ref.make(
      new Map<string, { readonly etag: string; readonly body: unknown }>(),
    );

    const run = (args: ReadonlyArray<string>, options?: GhOptions) =>
      gh
        .exec(args, options)
        .pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(
                  new GithubError({ command: commandOf(args), detail: failureOf(result) }),
                ),
          ),
        );

    const get = (path: string) =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(cache)).get(path);
        const args = [
          "api",
          "-i",
          ...(cached === undefined ? [] : ["-H", `If-None-Match: ${cached.etag}`]),
          path,
        ];
        const result = yield* gh.exec(args);
        const response = parseResponse(result.stdout);
        // `gh` exits non-zero on a 304, so the status line decides, not the exit code.
        if (response?.status === 304 && cached !== undefined) return cached.body;
        if (response === undefined || response.status >= 300 || result.exitCode !== 0) {
          return yield* new GithubError({
            command: commandOf(args),
            detail: failureOf(result),
            ...(response === undefined ? {} : { status: response.status }),
          });
        }
        const body = yield* parseJson(commandOf(args), response.body);
        if (response.etag !== undefined) {
          const etag = response.etag;
          yield* Ref.update(cache, (entries) => new Map(entries).set(path, { etag, body }));
        }
        return body;
      });

    const graphql = (query: string, variables: Readonly<Record<string, string | number>> = {}) =>
      Effect.gen(function* () {
        const args = [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          ...Object.entries(variables).flatMap(([name, value]) =>
            typeof value === "number" ? ["-F", `${name}=${value}`] : ["-f", `${name}=${value}`],
          ),
        ];
        // A query that partly fails (an alias for a number with no issue)
        // exits non-zero yet answers `data`, so stdout is read either way.
        const result = yield* gh.exec(args);
        const parsed = yield* parseJson("api graphql", result.stdout).pipe(
          Effect.mapError(
            (error) =>
              new GithubError({
                command: "api graphql",
                detail: `${failureOf(result)} ${error.detail}`,
              }),
          ),
        );
        const data = (parsed as { readonly data?: unknown }).data;
        if (data === undefined || data === null) {
          return yield* new GithubError({ command: "api graphql", detail: failureOf(result) });
        }
        return data;
      });

    return Github.of({ exec: gh.exec, run, get, graphql });
  });

  static readonly layerWith = Layer.effect(this, this.make);
  static readonly layer = this.layerWith.pipe(Layer.provide(Gh.layer));
}

/** The words of a `gh` call a log line names it by: `gh issue edit 42`. */
const commandOf = (args: ReadonlyArray<string>) =>
  ["gh", ...args.filter((arg) => !arg.startsWith("query="))].slice(0, 5).join(" ");

const failureOf = (result: GhResult) =>
  (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`).slice(0, 500);

const parseJson = (command: string, text: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new GithubError({ command, detail: `not JSON: ${text.slice(0, 200)}` }),
  });

/**
 * The status, ETag and body of `gh api -i` output: an HTTP status line, the
 * headers, a blank line, then the body.
 */
export const parseResponse = (
  output: string,
):
  | { readonly status: number; readonly etag: string | undefined; readonly body: string }
  | undefined => {
  const split = output.search(/\r?\n\r?\n/);
  const head = split === -1 ? output : output.slice(0, split);
  const body = split === -1 ? "" : output.slice(split).replace(/^\r?\n\r?\n/, "");
  const [statusLine = "", ...headers] = head.split(/\r?\n/);
  const status = /^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1];
  if (status === undefined) return undefined;
  const etag = headers
    .map((line) => /^etag:\s*(.+)$/i.exec(line)?.[1]?.trim())
    .find((value) => value !== undefined);
  return { status: Number(status), etag, body };
};

/**
 * A pull request as foreman reads it: found by its head branch, never stored.
 * `reviewed` holds the commits a review was posted on, so a repeat of the
 * review post finds it already made.
 */
export interface PullRequest {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly head: string;
  /** GitHub's `mergeStateStatus`: `CLEAN`, `DIRTY` (a conflict), `BLOCKED`, `BEHIND` and others. */
  readonly mergeState: string;
  readonly reviewed: ReadonlyArray<string>;
}

/** The required checks of a pull request, folded to one verdict, with the output for a task log. */
export interface RequiredChecks {
  readonly verdict: "none" | "pending" | "pass" | "fail";
  readonly output: string;
}

const PullRequestJson = S.Array(
  S.Struct({
    number: S.Finite,
    state: S.Literals(["OPEN", "CLOSED", "MERGED"]),
    headRefOid: S.String,
    mergeStateStatus: S.String,
    reviews: S.Array(S.Struct({ commit: S.NullOr(S.Struct({ oid: S.String })) })),
  }),
);

const ChecksJson = S.Array(S.Struct({ name: S.String, bucket: S.String }));

const PULL_REQUEST_FIELDS = "number,state,headRefOid,mergeStateStatus,reviews";

/**
 * Every pull request whose head is `branch`, open, closed and merged. One
 * branch can have several: a requeued task opens a new one beside the one the
 * operator closed.
 */
export const pullRequestsOf = (repo: string, branch: string) =>
  Effect.gen(function* () {
    const github = yield* Github;
    const command = `gh pr list --head ${branch}`;
    const out = yield* github.run([
      "pr",
      "list",
      "-R",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      PULL_REQUEST_FIELDS,
    ]);
    const rows = yield* parseJson(command, out).pipe(
      Effect.flatMap((json) => S.decodeUnknownEffect(PullRequestJson)(json)),
      Effect.mapError((error) =>
        error._tag === "GithubError" ? error : new GithubError({ command, detail: error.message }),
      ),
    );
    return rows.map((row): PullRequest => ({
      number: row.number,
      state: row.state,
      head: row.headRefOid,
      mergeState: row.mergeStateStatus,
      reviewed: row.reviews.flatMap((review) => (review.commit ? [review.commit.oid] : [])),
    }));
  });

/** Opens a pull request from `head` into `base`, and answers its number. */
export const createPullRequest = (
  repo: string,
  pull: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  },
) =>
  Effect.gen(function* () {
    const github = yield* Github;
    const out = yield* github.run(
      [
        "pr",
        "create",
        "-R",
        repo,
        "--head",
        pull.head,
        "--base",
        pull.base,
        "--title",
        pull.title,
        "--body-file",
        "-",
      ],
      { input: pull.body },
    );
    // `gh pr create` prints the new PR's URL, which ends in its number.
    const number = Number(/\/pull\/(\d+)\s*$/.exec(out.trim())?.[1]);
    if (!Number.isInteger(number)) {
      return yield* new GithubError({ command: "gh pr create", detail: `no PR URL in: ${out}` });
    }
    return number;
  });

/**
 * Posts a review on the pull request's head. A `comment` review approves
 * nothing; an `approve` review runs with `GH_TOKEN` set to `token`, because
 * GitHub refuses an approval from the PR's own author.
 */
export const reviewPullRequest = (
  repo: string,
  number: number,
  review: { readonly kind: "comment" } | { readonly kind: "approve"; readonly token: string },
  body: string,
) =>
  Effect.gen(function* () {
    const github = yield* Github;
    yield* github.run(
      [
        "pr",
        "review",
        `${number}`,
        "-R",
        repo,
        review.kind === "comment" ? "--comment" : "--approve",
        "--body-file",
        "-",
      ],
      review.kind === "comment"
        ? { input: body }
        : { input: body, env: { GH_TOKEN: review.token } },
    );
  });

/**
 * Merges the pull request with a merge commit, only while its head is
 * `commit`: GitHub refuses the merge when the head moved, so what lands is
 * the commit the reviewer read.
 */
export const mergePullRequest = (repo: string, number: number, commit: string) =>
  Effect.gen(function* () {
    const github = yield* Github;
    yield* github.run([
      "pr",
      "merge",
      `${number}`,
      "-R",
      repo,
      "--merge",
      "--match-head-commit",
      commit,
    ]);
  });

/**
 * The required checks of a pull request. `gh pr checks` exits non-zero while
 * a check is pending or failed, and when the repo requires none, so the
 * output decides, not the exit code.
 */
export const requiredChecksOf = (repo: string, number: number) =>
  Effect.gen(function* () {
    const github = yield* Github;
    const args = ["pr", "checks", `${number}`, "-R", repo, "--required", "--json", "name,bucket"];
    const result = yield* github.exec(args);
    if (result.stdout.trim() === "") {
      if (/no (required )?checks reported/i.test(result.stderr)) {
        return { verdict: "none", output: "" } satisfies RequiredChecks;
      }
      return yield* new GithubError({ command: commandOf(args), detail: failureOf(result) });
    }
    const checks = yield* parseJson(commandOf(args), result.stdout).pipe(
      Effect.flatMap((json) => S.decodeUnknownEffect(ChecksJson)(json)),
      Effect.mapError(
        (error) =>
          new GithubError({
            command: commandOf(args),
            detail: error._tag === "GithubError" ? error.detail : error.message,
          }),
      ),
    );
    const output = checks.map((check) => `${check.bucket}\t${check.name}`).join("\n");
    const buckets = new Set(checks.map((check) => check.bucket));
    const verdict: RequiredChecks["verdict"] =
      checks.length === 0
        ? "none"
        : buckets.has("fail") || buckets.has("cancel")
          ? "fail"
          : buckets.has("pending")
            ? "pending"
            : "pass";
    return { verdict, output } satisfies RequiredChecks;
  });
