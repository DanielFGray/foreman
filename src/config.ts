import { FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Context, Effect, Layer, Option, Schema } from "effect";

/** Everything foreman needs to know before it can dispatch anything. */
export class Settings extends Context.Tag("Settings")<Settings, SettingsShape>() {}

/**
 * Loads and resolves foreman's configuration.
 *
 * Command line beats config file, and both are folded in here rather than
 * anywhere later: one value of each setting exists, and no code downstream has
 * to know an override was ever possible.
 *
 * Resolution fails loudly rather than skipping a project: a queue that silently
 * drops half its work looks identical to a queue that is empty, and the
 * operator would have no reason to look.
 */
export const settings = (overrides: Overrides): Layer.Layer<Settings, ConfigError> =>
  Layer.effect(
    Settings,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* Effect.sync(() => process.env["HOME"] ?? "");

      const file =
        process.env["FOREMAN_CONFIG"] ??
        path.join(
          process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"),
          "foreman",
          "config.jsonc",
        );

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
          Schema.decodeUnknown(ConfigFile)(contents).pipe(
            Effect.mapError((cause) => new ConfigError({ detail: `parsing ${file}: ${cause}` })),
          ),
        ),
      );

      // A project's directory is ~/build/<name>. There is no override, because a
      // project whose name does not match its directory is a naming mistake to
      // fix at the source — `prog projects rename` exists for exactly that — and
      // an override field would let the two drift apart forever instead.
      const projects = yield* Effect.forEach(raw.projects, (name) =>
        Effect.gen(function* () {
          const directory = path.join(home, "build", name);
          const exists = yield* fs
            .exists(directory)
            .pipe(Effect.mapError((cause) => new ConfigError({ detail: String(cause) })));
          if (!exists) {
            return yield* new ConfigError({
              detail: `project "${name}" has no directory at ${directory} — rename the project to match its directory, or drop it from ${file}`,
            });
          }
          return { name, directory } as const;
        }),
      );

      return {
        projects,
        slots: Option.getOrElse(overrides.slots, () => raw.slots),
        author: raw.author,
        escalateTo: raw.escalateTo,
        reviewers: raw.reviewers,
        pollInterval: raw.pollSeconds,
        staleAfter: raw.staleAfterHours,
        landedWindow: raw.landedWindowDays,
      } as const;
    }),
  ).pipe(Layer.provide(BunContext.layer));

/** What the command line may say instead of the config file. */
export interface Overrides {
  readonly slots: Option.Option<number>;
}

interface SettingsShape {
  readonly projects: ReadonlyArray<{ readonly name: string; readonly directory: string }>;
  readonly slots: number;
  readonly author: string;
  readonly escalateTo: string;
  readonly reviewers: Readonly<Record<string, string>>;
  readonly pollInterval: number;
  readonly staleAfter: number;
  readonly landedWindow: number;
}

const ConfigFile = Schema.Struct({
  /**
   * Only these projects feed the queue; everything else stays untouched. A name
   * is both the prog project and, under ~/build, its directory.
   */
  projects: Schema.NonEmptyArray(Schema.String),

  /** Concurrent workers. Each claimed task occupies one until it lands. */
  slots: Schema.optionalWith(Schema.Positive, { default: () => 3 }),

  /**
   * The kind that writes code by default. Make this the cheap one: most tasks
   * are ordinary, and paying frontier prices for all of them to catch the few
   * that are hard is the expensive way round.
   */
  author: Schema.optionalWith(Schema.String, { default: () => "opencode" }),

  /**
   * The kind a task escalates to once cheap has demonstrably failed on it —
   * work returned unfinished, or sent back by a reviewer. Escalation is a
   * property of the task, not of which slot was free when it was picked up.
   */
  escalateTo: Schema.optionalWith(Schema.String, { default: () => "claude" }),

  /**
   * Which kind reviews which kind's work, as author -> reviewer.
   *
   * An unmapped kind gets any other configured kind, falling back to its own if
   * the fleet is uniform. Fresh eyes on the same model still catch things — the
   * reviewer arrives with no sunk cost in the implementation — but escalating a
   * cheap author to an expensive reviewer is where most of the value is.
   */
  reviewers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    default: () => ({}),
  }),

  pollSeconds: Schema.optionalWith(Schema.Positive, { default: () => 20 }),

  /**
   * How long a claimed task may go without activity before the queue takes it
   * back. Long enough that a human working slowly on their own claim is not
   * interrupted.
   */
  staleAfterHours: Schema.optionalWith(Schema.Positive, { default: () => 24 }),

  /**
   * How far back the dashboard's landed column reaches. prog list has no
   * limit, so the dispatcher bounds the column by this window instead.
   */
  landedWindowDays: Schema.optionalWith(Schema.Positive, { default: () => 7 }),
});

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  detail: Schema.String,
}) {}
