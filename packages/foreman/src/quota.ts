import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunServices } from "@effect/platform-bun";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Ref,
  Result,
  Schema as S,
  Stream,
} from "effect";

/**
 * How much of a provider's allowance is already spent.
 *
 * The allowance belongs to the **account**, not to the rung: two rungs naming
 * one model share one, and a rung on a provider with nothing left cannot be
 * dispatched to however much the ladder wants it. So this is keyed by provider
 * and the ladder is folded onto that set.
 *
 * Percent used rather than tokens or dollars remaining, because it is the only
 * number every provider agrees to state. A provider reports several windows —
 * a rolling hour, a week, a month — and any one of them at 100% stops the rung.
 */
export class Quota extends Context.Service<Quota>()("Quota", {
  make: Effect.gen(function* () {
    const [go, codex, claude, cursor] = yield* Effect.all([
      goProbe,
      codexProbe,
      claudeProbe,
      cursorProbe,
    ]);

    const probe = (provider: string): Effect.Effect<Usage, QuotaError> =>
      Match.value(provider).pipe(
        Match.when("claude", () => claude(provider)),
        Match.when("anthropic", () => claude(provider)),
        Match.when("cursor", () => cursor(provider)),
        Match.when("openai", () => codex(provider)),
        Match.when("opencode-go", () => go(provider)),
        Match.when(
          () => provider.startsWith("opencode"),
          () =>
            Effect.fail(
              new QuotaError({
                provider,
                detail: "no zen usage endpoint — the pay-as-you-go balance is not exposed",
                permanent: true,
              }),
            ),
        ),
        Match.orElse(() =>
          Effect.fail(
            new QuotaError({
              provider,
              detail: "no quota probe knows this provider",
              permanent: true,
            }),
          ),
        ),
      );

    const usage = heldWhileSpent(probe, yield* Ref.make(new Map<string, Spent>()));

    return { usage } as const;
  }),
}) {
  static readonly Default = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  );
}

export interface Allowance {
  /** The window this allowance covers, in the provider's own words. */
  readonly window: string;
  readonly usedPercent: number;
  readonly resetsAt: Date | undefined;
}

export interface Usage {
  readonly provider: string;
  readonly plan: string | undefined;
  readonly allowances: ReadonlyArray<Allowance>;
}

/**
 * Whether this provider has room for another agent.
 *
 * Any window at its limit is the whole answer: the shortest one is what the
 * next request meets, and a monthly allowance spent does not become spendable
 * because the rolling hour is empty.
 */
export const exhausted = (usage: Usage): boolean =>
  usage.allowances.some((allowance) => allowance.usedPercent >= 100);

/**
 * Every rung a spent account stops paying for.
 *
 * The one derivation of "unaffordable" in the tree. Both the gate that passes
 * a task over and the dispatch that picks its agent read this, so they cannot
 * come to different answers about the same reading.
 */
export const walledRungs = (
  providers: ReadonlyArray<Usage & { readonly rungs: ReadonlyArray<string> }>,
): ReadonlySet<string> =>
  new Set(providers.filter(exhausted).flatMap((provider) => provider.rungs));

/** A reading that cannot change again until the instant the provider named. */
export interface Spent {
  readonly usage: Usage;
  readonly until: number;
}

/**
 * Skips the probe for a provider that has already said when it next has room.
 *
 * Not a cache with a lifetime foreman invented. A spent allowance carries the
 * provider's own `resetsAt`, so "this account has nothing left" is an answer
 * the provider has declared good until a stated instant — and re-asking before
 * it is asking a question whose answer is already in hand. Foreman never
 * decides the reading went stale; the clock reaching the provider's own
 * deadline does, and until then no other writer can make the answer wrong.
 *
 * Only a spent provider is held. A healthy one moves as agents spend it — the
 * gate has to see it reach the wall — so it is probed every time. What freezes
 * with a held reading is the sub-window percentages of an account that cannot
 * be spent from, which is why nothing actionable goes stale: a rolling window
 * ticking down inside a spent month buys no dispatch.
 *
 * The hold is in-process, like the dispatch tally: a restart forgets it and
 * pays one probe per provider to relearn it.
 */
export const heldWhileSpent =
  (
    probe: (provider: string) => Effect.Effect<Usage, QuotaError>,
    held: Ref.Ref<Map<string, Spent>>,
  ) =>
  (provider: string): Effect.Effect<Usage, QuotaError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const standing = (yield* Ref.get(held)).get(provider);
      if (standing !== undefined && standing.until > now) return standing.usage;

      const fresh = yield* probe(provider);
      const until = freeAt(fresh);
      yield* Ref.update(held, (readings) => {
        const next = new Map(readings);
        // A provider that came back with room deletes its hold rather than
        // keeping a spent reading nothing will consult again.
        if (until === undefined) next.delete(provider);
        else next.set(provider, { usage: fresh, until: until.getTime() });
        return next;
      });
      return fresh;
    });

/** When this provider next has room, or `undefined` if it already does. */
export const freeAt = (usage: Usage): Date | undefined => {
  const resets = usage.allowances
    .filter((allowance) => allowance.usedPercent >= 100)
    .map((allowance) => allowance.resetsAt)
    .filter((at): at is Date => at !== undefined)
    .map((at) => at.getTime());
  return resets.length === 0 ? undefined : new Date(Math.max(...resets));
};

export class QuotaError extends S.TaggedError<QuotaError>()("QuotaError", {
  provider: S.String,
  detail: S.String,
  /**
   * The read cannot succeed until the operator changes something. A permanent
   * failure repeats on every poll, so it is carried to the dashboard and never
   * logged as a warning; a transient one (an outage, a changed reply shape) is
   * worth a line every time it happens.
   */
  permanent: S.Boolean,
}) {
  override get message() {
    return `${this.provider}: ${this.detail}`;
  }
}

// ------------------------------------------------------------- opencode go

const GoAllowance = S.Struct({
  status: S.String,
  percent: S.Number,
  resetsAt: S.DateFromString,
});

const GoUsage = S.Struct({
  usage: S.Record(S.String, GoAllowance),
});

const GoRefusal = S.Struct({ error: S.Struct({ message: S.String }) });

/**
 * Go states a subscription's usage on the host that serves its models.
 *
 * One GET answers every window. The endpoint accepts any key of the account —
 * the allowance is the account's, not the key's — which is how a zen key could
 * be read as go and the two conflated. Zen has no usage endpoint of its own:
 * its quota is a pay-as-you-go balance that nothing on the public host answers
 * for, so the `opencode` account is carried to the dashboard as unreadable
 * rather than read as go.
 */
const goProbe = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;

  return (provider: string): Effect.Effect<Usage, QuotaError> =>
    Effect.gen(function* () {
      const key = yield* apiKey(fs, provider);
      const response = yield* client.execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.bearerToken(key),
        ),
      );
      // opencode does not renew an expired key on sign-in, so the error body's
      // own message is the instruction worth showing.
      if (response.status === 401) {
        const body = yield* response.json.pipe(
          Effect.flatMap(S.decodeUnknownEffect(GoRefusal)),
          Effect.option,
        );
        return yield* new QuotaError({
          provider,
          detail: Option.match(body, {
            onNone: () => `${provider} key refused — replace it in opencode`,
            onSome: (refusal) => refusal.error.message,
          }),
          permanent: true,
        });
      }
      const decoded = yield* S.decodeUnknownEffect(GoUsage)(yield* response.json);
      return {
        provider,
        plan: undefined,
        allowances: Object.entries(decoded.usage).map(([window, allowance]) => ({
          window,
          usedPercent: allowance.percent,
          resetsAt: allowance.resetsAt,
        })),
      } satisfies Usage;
    }).pipe(Effect.mapError((cause) => asQuotaError(provider, cause)));
});

const OpencodeAuth = S.Record(S.String, S.Struct({ key: S.optional(S.String) }));

/**
 * The key opencode already holds, read where opencode keeps it.
 *
 * Foreman must not hold a second copy: a credential written into foreman's own
 * config is one more place for it to go stale, and the harness whose key it is
 * is the harness that renews it. The environment wins where it is set, because
 * that is how the operator overrides the stored one for a single run.
 */
const apiKey = (fs: FileSystem.FileSystem, provider: string): Effect.Effect<string, QuotaError> =>
  Effect.gen(function* () {
    const configured = process.env["OPENCODE_API_KEY"];
    if (configured !== undefined && configured.length > 0) return configured;

    const file = `${process.env["HOME"] ?? ""}/.local/share/opencode/auth.json`;
    const decoded = yield* S.decodeUnknownEffect(OpencodeAuth)(
      JSON.parse(yield* fs.readFileString(file)),
    );
    return yield* Option.match(Option.fromNullishOr(decoded[provider]?.key), {
      onNone: () =>
        new QuotaError({
          provider,
          detail: `no api key for ${provider} in ${file}`,
          permanent: true,
        }),
      onSome: Effect.succeed,
    });
  }).pipe(Effect.mapError((cause) => asQuotaError(provider, cause)));

// -------------------------------------------------------------- openai (codex)

const RateLimitWindow = S.Struct({
  usedPercent: S.Number,
  resetsAt: S.optional(S.NullOr(S.Number)),
  windowDurationMins: S.optional(S.NullOr(S.Number)),
});

const RateLimitsReply = S.Struct({
  id: S.Number,
  result: S.Struct({
    rateLimits: S.Struct({
      planType: S.optional(S.NullOr(S.String)),
      primary: S.optional(S.NullOr(RateLimitWindow)),
      secondary: S.optional(S.NullOr(RateLimitWindow)),
    }),
  }),
});

const LIMITS_ID = 2;

const REQUESTS: ReadonlyArray<unknown> = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "foreman", title: null, version: "0.1.0" }, capabilities: null },
  },
  { jsonrpc: "2.0", method: "initialized", params: {} },
  { jsonrpc: "2.0", id: LIMITS_ID, method: "account/rateLimits/read" },
];

/**
 * OpenAI states a ChatGPT plan's remaining allowance only to a signed-in
 * client, and `codex app-server` is that client.
 *
 * There is no endpoint to call instead: chatgpt.com refuses a plain request for
 * the same numbers. The app server is JSON-RPC over stdio, and it answers from
 * the login in `~/.codex`, which is the account opencode's own oauth holds — so
 * asking codex is asking about the allowance an `openai/*` rung will spend.
 *
 * The process is killed rather than closed. It answers asynchronously and reads
 * EOF on stdin as a shutdown, so closing the pipe after writing loses the reply;
 * stdin stays open behind the requests and the scope's teardown ends it once the
 * reply has arrived.
 */
const codexProbe = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return (provider: string): Effect.Effect<Usage, QuotaError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* spawner.spawn(
          ChildProcess.make("codex", ["app-server"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        yield* Stream.fromIterable(REQUESTS).pipe(
          Stream.map((request) => `${JSON.stringify(request)}\n`),
          Stream.encodeText,
          Stream.concat(Stream.never),
          Stream.run(process.stdin),
          Effect.forkScoped,
        );

        const reply = yield* Stream.decodeText(process.stdout).pipe(
          Stream.splitLines,
          Stream.filterMap((line) =>
            Result.fromOption(
              S.decodeUnknownOption(S.fromJsonString(RateLimitsReply))(line).pipe(
                Option.filter((message) => message.id === LIMITS_ID),
              ),
              () => line,
            ),
          ),
          Stream.take(1),
          Stream.runHead,
          Effect.flatMap(Effect.fromOption),
        );

        const limits = reply.result.rateLimits;
        return {
          provider,
          plan: limits.planType ?? undefined,
          allowances: [
            ["primary", limits.primary] as const,
            ["secondary", limits.secondary] as const,
          ].flatMap(([window, limit]) =>
            limit === undefined || limit === null
              ? []
              : [
                  {
                    window: windowName(window, limit.windowDurationMins ?? undefined),
                    usedPercent: limit.usedPercent,
                    resetsAt:
                      limit.resetsAt === undefined || limit.resetsAt === null
                        ? undefined
                        : new Date(limit.resetsAt * 1000),
                  },
                ],
          ),
        } satisfies Usage;
      }),
    ).pipe(Effect.mapError((cause) => asQuotaError(provider, cause)));
});

// ----------------------------------------------------------- claude (anthropic)

const ClaudeOAuth = S.Struct({
  claudeAiOauth: S.Struct({
    accessToken: S.String,
    subscriptionType: S.optional(S.NullOr(S.String)),
  }),
});

const ClaudeWindow = S.Struct({
  utilization: S.optional(S.NullOr(S.Number)),
  resets_at: S.optional(S.NullOr(S.String)),
});

const ClaudeUsage = S.Struct({
  five_hour: S.optional(S.NullOr(ClaudeWindow)),
  seven_day: S.optional(S.NullOr(ClaudeWindow)),
  extra_usage: S.optional(S.NullOr(ClaudeWindow)),
});

/**
 * Claude states a plan's remaining allowance only to a signed-in client, and
 * the signed-in client is `claude` itself.
 *
 * `GET https://api.anthropic.com/api/oauth/usage` answers the five-hour and seven-day
 * windows plus the spend-based `extra_usage` credits in one call, using the
 * OAuth access token claude keeps in `~/.claude/.credentials.json` — the same
 * token and endpoint the binary's own fetch reads. The endpoint sits behind a
 * Cloudflare TLS-fingerprint check that curl fails but Bun passes, which is
 * why this runs in-process. A token past its expiry answers 401; claude
 * refreshes it on its own runs, so the fix is to run claude, not for foreman
 * to hold a second credential.
 */
const claudeProbe = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;

  const allowanceOf = (
    window: string,
    limit: S.Schema.Type<typeof ClaudeWindow> | null | undefined,
  ): ReadonlyArray<Allowance> =>
    limit === undefined || limit === null || typeof limit.utilization !== "number"
      ? []
      : [
          {
            window,
            usedPercent: limit.utilization,
            resetsAt:
              limit.resets_at === undefined || limit.resets_at === null
                ? undefined
                : new Date(limit.resets_at),
          },
        ];

  return (provider: string): Effect.Effect<Usage, QuotaError> =>
    Effect.gen(function* () {
      const home = process.env["HOME"] ?? "";
      const decoded = yield* S.decodeUnknownEffect(ClaudeOAuth)(
        JSON.parse(yield* fs.readFileString(`${home}/.claude/.credentials.json`)),
      );
      const response = yield* client.execute(
        HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage").pipe(
          HttpClientRequest.bearerToken(decoded.claudeAiOauth.accessToken),
          HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
          HttpClientRequest.setHeader("User-Agent", "claude-cli/2.1.0 (external, cli)"),
        ),
      );
      if (response.status === 401) {
        return yield* new QuotaError({
          provider,
          detail: "claude oauth token expired — run claude once to refresh it",
          permanent: true,
        });
      }
      const usage = yield* S.decodeUnknownEffect(ClaudeUsage)(yield* response.json);
      return {
        provider,
        plan: decoded.claudeAiOauth.subscriptionType ?? undefined,
        allowances: [
          allowanceOf("five_hour", usage.five_hour),
          allowanceOf("seven_day", usage.seven_day),
          allowanceOf("extra_usage (credits)", usage.extra_usage),
        ].flat(),
      } satisfies Usage;
    }).pipe(Effect.mapError((cause) => asQuotaError(provider, cause)));
});

/**
 * codex names its windows by rank rather than by length, so the length is put
 * back: "primary" says nothing an operator can plan around, and the same rank
 * means a week on one plan and a day on another.
 */

// ----------------------------------------------------------- cursor
/**
 * Cursor states a personal plan's usage on its dashboard host, read with the
 * session cookie its login leaves in `~/.config/cursor/auth.json`.
 *
 * `https://cursor.com/api/usage-summary` answers the billing cycle, the model
 * family splits (`auto` vs `api`) and the on-demand meter in one call. The
 * JWT's `sub` names the user for the session cookie; the same token is the
 * bearer for the legacy request-count endpoint, which is only a fallback.
 */
const cursorProbe = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;

  const userIdOf = (token: string): string | undefined => {
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[1] === undefined) return undefined;
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
      if (typeof payload !== "object" || payload === null) return undefined;
      const sub = (payload as Record<string, unknown>).sub;
      if (typeof sub !== "string") return undefined;
      const pieces = sub.split("|");
      const userId = pieces.length > 1 ? pieces[1] : sub;
      return userId !== undefined && userId.length > 0 ? userId : undefined;
    } catch {
      return undefined;
    }
  };

  const allowanceOf = (
    window: string,
    usedPercent: number,
    resetsAt: Date | undefined,
  ): Allowance => ({
    window,
    usedPercent,
    resetsAt,
  });

  return (provider: string): Effect.Effect<Usage, QuotaError> =>
    Effect.gen(function* () {
      const home = process.env["HOME"] ?? "";
      const file = `${home}/.config/cursor/auth.json`;
      const raw = yield* fs.readFileString(file);
      let decoded: { accessToken?: string };
      try {
        decoded = JSON.parse(raw) as { accessToken?: string };
      } catch {
        return yield* new QuotaError({
          provider,
          detail: "cursor auth.json is not JSON",
          permanent: true,
        });
      }
      const token = decoded.accessToken;
      if (token === undefined || token.length === 0) {
        return yield* new QuotaError({
          provider,
          detail: `no access token in ${file}`,
          permanent: true,
        });
      }
      const userId = userIdOf(token);
      if (userId === undefined) {
        return yield* new QuotaError({
          provider,
          detail: "cursor token names no user",
          permanent: true,
        });
      }

      const cookie = encodeURIComponent(`${userId}::${token}`);
      const response = yield* client.execute(
        HttpClientRequest.get("https://cursor.com/api/usage-summary").pipe(
          HttpClientRequest.setHeader("Accept", "application/json"),
          HttpClientRequest.setHeader("Cookie", `WorkosCursorSessionToken=${cookie}`),
        ),
      );
      if (response.status === 401 || response.status === 403) {
        return yield* new QuotaError({
          provider,
          detail: "cursor session expired — run `cursor-agent login` to refresh it",
          permanent: true,
        });
      }
      const body = (yield* response.json) as Record<string, unknown>;
      const individual = body.individualUsage;
      if (typeof individual !== "object" || individual === null) {
        return yield* new QuotaError({
          provider,
          detail: "cursor usage response had no individualUsage",
          permanent: false,
        });
      }
      const plan = (individual as Record<string, unknown>).plan;
      if (typeof plan !== "object" || plan === null) {
        return yield* new QuotaError({
          provider,
          detail: "cursor usage response had no plan bucket",
          permanent: false,
        });
      }
      const planRecord = plan as Record<string, unknown>;
      const billingCycleEnd =
        typeof body.billingCycleEnd === "string" ? new Date(body.billingCycleEnd) : undefined;
      const allowances: Allowance[] = [];
      const autoPct = planRecord.autoPercentUsed;
      if (typeof autoPct === "number") {
        allowances.push(allowanceOf("cursor_models (cycle)", autoPct, billingCycleEnd));
      }
      const apiPct = planRecord.apiPercentUsed;
      if (typeof apiPct === "number") {
        allowances.push(allowanceOf("other_models (cycle)", apiPct, billingCycleEnd));
      }
      if (allowances.length === 0) {
        const totalPct = planRecord.totalPercentUsed;
        if (typeof totalPct === "number") {
          allowances.push(allowanceOf("included (cycle)", totalPct, billingCycleEnd));
        }
      }
      // On-demand meter, if enabled and capped.
      const onDemand = (individual as Record<string, unknown>).onDemand;
      if (typeof onDemand === "object" && onDemand !== null) {
        const onDemandRecord = onDemand as Record<string, unknown>;
        const enabled = onDemandRecord.enabled;
        const used = onDemandRecord.used;
        const limit = onDemandRecord.limit;
        if (
          enabled === true &&
          typeof used === "number" &&
          typeof limit === "number" &&
          limit > 0
        ) {
          // Expose it as a percent of the on-demand cap.
          allowances.push({
            window: "on_demand (cycle)",
            usedPercent: (used / limit) * 100,
            resetsAt: billingCycleEnd,
          });
        }
      }

      if (allowances.length === 0) {
        return yield* new QuotaError({
          provider,
          detail: "cursor usage response carried no metered window",
          permanent: false,
        });
      }

      return {
        provider,
        plan: typeof body.membershipType === "string" ? body.membershipType : undefined,
        allowances,
      } satisfies Usage;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof QuotaError ? cause : asQuotaError(provider, cause),
      ),
    );
});

export const windowName = (rank: string, durationMins: number | undefined): string =>
  durationMins === undefined
    ? rank
    : durationMins >= 10080
      ? `${rank} (${Math.round(durationMins / 10080)}w)`
      : durationMins >= 1440
        ? `${rank} (${Math.round(durationMins / 1440)}d)`
        : `${rank} (${Math.round(durationMins / 60)}h)`;

const asQuotaError = (provider: string, cause: unknown): QuotaError =>
  cause instanceof QuotaError
    ? cause
    : new QuotaError({ provider, detail: String(cause), permanent: false });
