import { FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { dispatchable, type Ladder, providerOf, type Rung } from "./ladder.ts";

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

      // A FOREMAN_CONFIG that is relative must be resolved against the working
      // directory here: it is handed to a dynamic import() below, which treats
      // a relative string as a module specifier and looks for it beside this
      // file instead. Absolute paths pass through resolve unchanged.
      const configured = process.env["FOREMAN_CONFIG"];
      const file =
        configured === undefined
          ? path.join(
              process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"),
              "foreman",
              "config.jsonc",
            )
          : path.resolve(configured);

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
      // A bare string is a project with nothing to say beyond its name, which
      // is most of them; the object form exists for the few that need to name
      // a verification command.
      const projects = yield* Effect.forEach(raw.projects, (entry) =>
        Effect.gen(function* () {
          const { name, verify, verificationSkill } =
            typeof entry === "string"
              ? { name: entry, verify: undefined, verificationSkill: undefined }
              : entry;
          const directory = path.join(home, "build", name);
          const exists = yield* fs
            .exists(directory)
            .pipe(Effect.mapError((cause) => new ConfigError({ detail: String(cause) })));
          if (!exists) {
            return yield* new ConfigError({
              detail: `project "${name}" has no directory at ${directory} — rename the project to match its directory, or drop it from ${file}`,
            });
          }
          const skill =
            verificationSkill === undefined
              ? undefined
              : verificationSkill.startsWith("/")
                ? verificationSkill
                : path.join(directory, verificationSkill);
          if (skill !== undefined) {
            const exists = yield* fs.exists(skill).pipe(
              Effect.mapError((cause) => new ConfigError({ detail: String(cause) })),
            );
            if (!exists) {
              return yield* new ConfigError({
                detail: `project "${name}" names verification skill ${skill}, but that file does not exist`,
              });
            }
          }
          return { name, directory, verify, verificationSkill: skill } as const;
        }),
      );

      // A bare string is a rung that is only a harness — `claude`, running
      // whichever model it defaults to. Everything else names its model.
      const rungOf = (entry: (typeof raw.ladder)[number]): Rung =>
        typeof entry === "string"
          ? { name: entry, harness: entry, model: undefined, provider: undefined, enabled: true }
          : {
              name: entry.name,
              harness: entry.harness,
              model: entry.model,
              provider: entry.provider,
              enabled: entry.enabled,
            };
      const [bottom, ...rest] = raw.ladder;
      const ladder: Ladder = [rungOf(bottom), ...rest.map(rungOf)];

      // A duplicate name makes both "the next rung up" and "which rung failed
      // this task" ambiguous, and the second is durable: tasks record rung
      // names, so a name that means two things corrupts work already filed.
      const duplicate = ladder.find(
        (rung, index) => ladder.findIndex((other) => other.name === rung.name) !== index,
      );
      if (duplicate) {
        return yield* new ConfigError({
          detail: `two rungs in ${file} are named "${duplicate.name}" — rung names are how tasks record which models have failed them, so they must be unique`,
        });
      }
      // A ladder of nothing but retired rungs has ranks and no models. Every
      // task in the queue would resolve to the operator, which reads as a
      // backlog that needs a hundred decisions rather than a config with a
      // line commented out.
      if (dispatchable(ladder).length === 0) {
        return yield* new ConfigError({
          detail: `every rung in ${file} is disabled — a retired rung keeps its rank so old failures still position, but at least one rung must be dispatchable`,
        });
      }

      // A rung whose account cannot be named is dispatched blind: foreman
      // cannot ask whether it has room left, so the fleet learns it is out of
      // quota by spending a run on it. Not an error — a ladder that works
      // today keeps working — but the operator is the only one who can say
      // which plan a bare harness is signed in to, so they are told which rung
      // to write it on. The claude harness is never blind: it always spends
      // the claude.ai account.
      const blind = dispatchable(ladder).filter((rung) => providerOf(rung) === undefined);
      if (blind.length > 0) {
        yield* Effect.logWarning(
          `no provider derivable for ${blind
            .map((rung) => `"${rung.name}"`)
            .join(
              ", ",
            )} in ${file} — add "provider" to each so foreman can read its remaining quota before dispatching`,
        );
      }

      return {
        projects,
        slots: Option.getOrElse(overrides.slots, () => raw.slots),
        running: overrides.running,
        ladder,
        pollInterval: raw.pollSeconds,
        // The signal path is appended to this, so a trailing slash would send
        // every span to a doubled path the collector does not serve.
        otlpEndpoint: raw.otlpEndpoint.replace(/\/+$/, ""),
        staleAfter: raw.staleAfterHours,
        coachWindow: raw.coachWindowMinutes,
        landedWindow: raw.landedWindowDays,
        attemptsPerRung: raw.attemptsPerRung,
      } as const;
    }),
  ).pipe(Layer.provide(BunContext.layer));

/**
 * What the command line says: values that stand in for the config file, and
 * values only a single run can have.
 *
 * `running` is the second kind. Whether dispatch is paused is an intention, not
 * a description of the fleet, so it has no place in a file that outlives the
 * run — but it does have to survive a restart, because `bun --watch` restarts
 * the daemon whenever foreman's own source changes and the command line is the
 * only thing a restart inherits.
 */
export interface Overrides {
  readonly slots: Option.Option<number>;
  readonly running: boolean;
}

interface SettingsShape {
  readonly projects: ReadonlyArray<{
    readonly name: string;
    readonly directory: string;
    readonly verificationSkill?: string;
    readonly verify: string | undefined;
  }>;
  readonly slots: number;
  /** Whether this run starts dispatching, rather than paused. */
  readonly running: boolean;
  readonly ladder: Ladder;
  readonly pollInterval: number;
  readonly staleAfter: number;

  /** OTLP/HTTP collector base URL, without the signal path. */
  readonly otlpEndpoint: string;

  /** Minutes an author's agent survives its handoff, for a reviewer to coach. */
  readonly coachWindow: number;
  readonly landedWindow: number;

  /**
   * How many attempts one rung of the ladder gets before a task climbs.
   *
   * An agent that stops without finishing — a crash, a timeout, a usage wall —
   * has said nothing about its model, so the task retries the same rung rather
   * than paying for a stronger one. Only repeated failure exhausts the rung.
   * A reviewer that sends work back is a judgement about the work and climbs
   * immediately, so it spends none of this budget.
   */
  readonly attemptsPerRung: number;
}

const ConfigFile = Schema.Struct({
  /**
   * Only these projects feed the queue; everything else stays untouched. A name
   * is both the prog project and, under ~/build, its directory.
   */
  projects: Schema.NonEmptyArray(
    Schema.Union(
      Schema.String,
      Schema.Struct({
        name: Schema.String,

        /**
         * The command that decides whether this project works — its test
         * suite, usually, written as the operator would type it.
         *
         * Foreman runs it before and after every landing and undoes a merge
         * that turns a green checkout red. A project that names none is landed
         * on git's exit code alone, which says the merge applied and nothing
         * whatever about whether the code still runs.
         */
        verify: Schema.optional(Schema.String),

        /**
         * Project-local instructions for driving user-visible behavior.
         * Relative paths start at the project root. Foreman gives this pointer
         * to authors and reviewers; the skill owns the drive and evidence recipe.
         */
        verificationSkill: Schema.optional(Schema.String),
      }),
    ),
  ),

  /** Concurrent workers. Each claimed task occupies one until it lands. */
  slots: Schema.optionalWith(Schema.Positive, { default: () => 3 }),

  /**
   * Every model foreman may use, cheapest first. Required: a fleet with no
   * ladder has nothing to dispatch, and a default here would silently pick
   * somebody's models for them.
   *
   * A task starts at the bottom and climbs one rung on real evidence that the
   * rung it is on failed it — a reviewer sending work back, a branch that
   * would not land, or `attemptsPerRung` attempts ending unfinished. `name` is
   * what tasks record and the dashboard shows, `harness` is a herdr agent
   * kind, and `model` is passed to that harness as `--model`. A bare string is
   * a rung that is only a harness, running whatever that program defaults to.
   */
  ladder: Schema.NonEmptyArray(
    Schema.Union(
      Schema.String,
      Schema.Struct({
        name: Schema.String,
        harness: Schema.String,
        model: Schema.optional(Schema.String),

        /**
         * The account this rung spends, for the rungs where the model does not
         * already say. Quota is the account's, not the rung's, so several rungs
         * naming one provider share one allowance.
         */
        provider: Schema.optional(Schema.String),

        /**
         * Whether foreman may dispatch this rung. A retired model stays listed
         * and disabled so it keeps its rank: the tasks it failed still record
         * that failure, and the rank is what turns the name into "cheaper than
         * the rung above was not enough". Deleting the entry says the model is
         * no longer part of the rating at all.
         */
        enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
      }),
    ),
  ),

  pollSeconds: Schema.optionalWith(Schema.Positive, { default: () => 20 }),

  /**
   * Where spans and metrics go — an OTLP/HTTP collector, without the signal
   * path.
   *
   * A local collector by default, and it should stay one: the collector is what
   * holds the history when a gateway is down, and what forwards it when one
   * comes back. Naming a remote host here instead moves both of those jobs into
   * foreman, which remembers nothing and would drop the telemetry instead.
   */
  otlpEndpoint: Schema.optionalWith(Schema.String, {
    default: () => "http://localhost:4318",
  }),

  /**
   * How many times a task may end unfinished on one rung before it climbs.
   *
   * An agent that stops without finishing says nothing about its model — a
   * crash, a timeout and a usage wall all end the same way — so the task stays
   * on the rung and is tried again. The attempt that reaches this limit is the
   * one that climbs; a reviewer rejecting the work climbs at once and spends
   * none of it. Both are written to the task as labels, so the count survives
   * a dispatch days later.
   */
  attemptsPerRung: Schema.optionalWith(Schema.Positive, { default: () => 2 }),

  /**
   * How long a claimed task may go without activity before the queue takes it
   * back. Long enough that a human working slowly on their own claim is not
   * interrupted.
   */
  staleAfterHours: Schema.optionalWith(Schema.Positive, { default: () => 24 }),

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
  coachWindowMinutes: Schema.optionalWith(Schema.Positive, { default: () => 30 }),

  /**
   * How far back the dashboard's landed column reaches. prog list has no
   * limit, so the dispatcher bounds the column by this window instead.
   */
  landedWindowDays: Schema.optionalWith(Schema.Positive, { default: () => 7 }),
});

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  detail: Schema.String,
}) {}
