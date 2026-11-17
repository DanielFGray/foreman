import { Context, Effect, Layer, Schema } from "effect";
import { Paths } from "./paths.ts";
import { PathsError } from "./errors.ts";

/** Everything foreman needs to know before it can dispatch anything. */
export class Settings extends Context.Service<Settings, SettingsShape>()("Settings") {}

/**
 * Loads and resolves foreman's configuration.
 *
 * Command line beats config file, and both are folded in here rather than
 * anywhere later: one value of each setting exists for everything downstream.
 *
 * The projects are not configured: they are the operator's open spaces, read
 * every tick (`src/projects.ts`).
 */
const loadSettings: Effect.Effect<typeof Settings.Service, ConfigError, Paths> = Effect.gen(
  function* () {
    const paths = yield* Paths;
    const file = paths.configFile;

    // Imported rather than read and parsed: Bun's loader accepts comments and
    // trailing commas in .jsonc, so the config can explain itself without
    // pulling in a parser or stripping comments by hand — which breaks on the
    // first "//" inside a string. The loader keys this off the extension, so a
    // config named .json is parsed strictly and comments in it are an error.
    const raw = yield* Effect.tryPromise({
      try: () => import(file).then((module) => module.default as unknown),
      catch: (cause) => new ConfigError({ detail: `reading ${file}: ${cause}` }),
    }).pipe(
      Effect.flatMap((contents) =>
        Schema.decodeUnknownEffect(ConfigFile)(contents).pipe(
          Effect.mapError((cause) => new ConfigError({ detail: `parsing ${file}: ${cause}` })),
        ),
      ),
    );

    return Settings.of({
      pollInterval: raw.pollSeconds,
      // The signal path is appended to this, so a trailing slash would send
      // every span to a doubled path the collector does not serve.
      otlpEndpoint: raw.otlpEndpoint.replace(/\/+$/, ""),
      staleAfter: raw.staleAfterHours,
      coachWindow: raw.coachWindowMinutes,
      stallGrace: raw.stallGraceMinutes,
      landedWindow: raw.landedWindowDays,
      attemptsPerLevel: raw.attemptsPerLevel,
    });
  },
);

/** Settings over a `Paths` the caller provides, so tests can freshen paths. */
export const settingsLayer = Layer.effect(Settings, loadSettings);

/** Settings over the process config file. The ladder is not here: it is read from the registry each tick. */
export const settings: Layer.Layer<Settings, ConfigError | PathsError> = settingsLayer.pipe(
  Layer.provide(Paths.layer),
);

interface SettingsShape {
  readonly pollInterval: number;
  readonly staleAfter: number;

  /** OTLP/HTTP collector base URL, without the signal path. */
  readonly otlpEndpoint: string;

  /** Minutes an author's agent survives its handoff, for a reviewer to coach. */
  readonly coachWindow: number;

  /** Minutes an agent may sit idle without naming an exit before foreman takes over. */
  readonly stallGrace: number;
  readonly landedWindow: number;

  /**
   * How many attempts one level of the ladder gets before a task climbs.
   *
   * An agent that stops without finishing — a crash, a timeout, a usage wall —
   * has said nothing about its model, so the task retries the level rather
   * than paying for a stronger one. The peers of a level share the count, so a
   * level of several rungs is not tried more often than a level of one. Only
   * repeated failure exhausts the level.
   * A reviewer that sends work back is a judgement about the work and climbs
   * immediately, so it spends none of this budget.
   */
  readonly attemptsPerLevel: number;
}

/** A number above zero. */
const Positive = Schema.Number.check(Schema.isGreaterThan(0));

const ConfigFile = Schema.Struct({
  pollSeconds: Positive.pipe(Schema.withDecodingDefault(Effect.succeed(20))),

  /**
   * Where spans and metrics go — an OTLP/HTTP collector, without the signal
   * path.
   *
   * A local collector by default, and it should stay one: the collector is what
   * holds the history when a gateway is down, and what forwards it when one
   * comes back. Naming a remote host here instead moves both of those jobs into
   * foreman, which remembers nothing and would drop the telemetry instead.
   */
  otlpEndpoint: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("http://localhost:4318")),
  ),

  /**
   * How many times a task may stop without an exit at one level before it climbs.
   *
   * An agent that stops without finishing says nothing about its model — a
   * crash, a timeout and a usage wall all end the same way — so the task stays
   * at the level and is tried again, on whichever peer's turn it is. The
   * attempt that reaches this limit is the one that climbs; a reviewer rejecting the work climbs at once and spends
   * none of it. Both are written to the task as labels, so the count survives
   * a dispatch days later.
   */
  attemptsPerLevel: Positive.pipe(Schema.withDecodingDefault(Effect.succeed(2))),

  /**
   * How long a claimed task may go without activity before the queue takes it
   * back. Long enough that a human working slowly on their own claim is not
   * interrupted.
   */
  staleAfterHours: Positive.pipe(Schema.withDecodingDefault(Effect.succeed(24))),

  /**
   * How long an author's agent is kept alive after it hands off, so the
   * reviewer can send mechanical findings back to the session that wrote the
   * code instead of paying a rung climb to re-derive its context.
   *
   * The cost is a second resident model per task in review, so this bounds it:
   * past the window foreman closes the pane itself and the reviewer simply
   * loses the option. Reviews are filled before new work, so the window only
   * matters when reviews are queued behind a held project.
   */
  coachWindowMinutes: Positive.pipe(Schema.withDecodingDefault(Effect.succeed(30))),

  /**
   * How long an agent may sit idle without naming an exit before foreman takes
   * the task from it. An idle pane is an interrupted turn, a harness that
   * stopped mid-task, or an agent that forgot its exit; the window lets the
   * operator steer it by hand first. Typing in the pane starts a new turn, so
   * the window counts from the last turn either of them ended. Past it,
   * foreman closes the pane and a new agent continues from the worktree.
   */
  stallGraceMinutes: Positive.pipe(Schema.withDecodingDefault(Effect.succeed(5))),

  /**
   * How far back the dashboard's landed column reaches. tasks list has no
   * limit, so the dispatcher bounds the column by this window instead.
   */
  landedWindowDays: Positive.pipe(Schema.withDecodingDefault(Effect.succeed(7))),
});

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
