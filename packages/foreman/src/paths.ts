/**
 * Where foreman's operator files live: config, policy, pipelines, state, tokens.
 *
 * One seam over `Config` and `Path`, so missing `HOME` fails typed and every
 * reader names the same directories. Env overrides (`FOREMAN_POLICY`, …) win when set.
 */
import { BunServices } from "@effect/platform-bun";
import { Config, Context, Effect, Layer, Path, Schema as S } from "effect";

export class PathsError extends S.TaggedError<PathsError>()("PathsError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

export class Paths extends Context.Service<
  Paths,
  {
    /** `~/.config/foreman`, or `$XDG_CONFIG_HOME/foreman`. */
    readonly configDirectory: string;
    /** Operator config file (`FOREMAN_CONFIG`, else `config.jsonc` in the config directory). */
    readonly configFile: string;
    readonly policy: string;
    readonly pipelines: string;
    readonly drafts: string;
    /** Published reading (`FOREMAN_STATE`, else under `$XDG_STATE_HOME/foreman`). */
    readonly published: string;
    readonly linearToken: string;
  }
>()("foreman/Paths") {
  static readonly make = Effect.gen(function* () {
    const path = yield* Path.Path;
    // HOME through Config: missing HOME is a typed failure. XDG and FOREMAN_*
    // come from the live process env — tests (and an operator) change them
    // between loads, and Config's provider can keep the first value seen.
    const home = yield* Config.String("HOME").pipe(
      Effect.mapError((cause) => new PathsError({ detail: String(cause) })),
    );
    const configDirectory = path.join(
      process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"),
      "foreman",
    );
    const stateDirectory = path.join(
      process.env["XDG_STATE_HOME"] ?? path.join(home, ".local", "state"),
      "foreman",
    );

    const override = (key: string, fallback: string) => process.env[key] ?? fallback;

    const configured = process.env["FOREMAN_CONFIG"];
    // A relative FOREMAN_CONFIG is resolved against the working directory: it
    // is handed to a dynamic import(), which treats a relative string as a
    // module specifier beside this file instead.
    const configFile =
      configured === undefined
        ? path.join(configDirectory, "config.jsonc")
        : path.resolve(configured);

    const pipelines = override("FOREMAN_PIPELINES", path.join(configDirectory, "pipelines.json"));
    // Drafts sit beside the live pipelines file (named after it), so a custom
    // FOREMAN_PIPELINES keeps draft and live in one directory.
    const drafts = override("FOREMAN_DRAFTS", pipelines.replace(/(\.json)?$/, ".draft.json"));

    return Paths.of({
      configDirectory,
      configFile,
      policy: override("FOREMAN_POLICY", path.join(configDirectory, "policy.json")),
      pipelines,
      drafts,
      published: override("FOREMAN_STATE", path.join(stateDirectory, "state.json")),
      linearToken: path.join(configDirectory, "linear-token.json"),
    });
  });

  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(BunServices.layer));
}

/**
 * Resolve operator paths now. For CLI help text and sync tests that mutate
 * env — program code yields `Paths` instead.
 */
export const resolve = (): {
  readonly configDirectory: string;
  readonly configFile: string;
  readonly policy: string;
  readonly pipelines: string;
  readonly drafts: string;
  readonly published: string;
  readonly linearToken: string;
} => Effect.runSync(Paths.make.pipe(Effect.provide(BunServices.layer)));

/** `$FOREMAN_POLICY`, else `policy.json` under the config directory. */
export const policyPath = (): string => resolve().policy;

/** `$FOREMAN_PIPELINES`, else `pipelines.json` under the config directory. */
export const pipelinesPath = (): string => resolve().pipelines;

/** Draft pipelines: `$FOREMAN_DRAFTS`, else beside the live pipelines file. */
export const draftsPath = (): string => resolve().drafts;

/** `$FOREMAN_STATE`, else under `$XDG_STATE_HOME/foreman`. */
export const publishedPath = (): string => resolve().published;

/** Linear OAuth token beside the config. */
export const tokenPath = (): string => resolve().linearToken;

/** The directory foreman's operator files live in. */
export const configDirectory = (): string => resolve().configDirectory;
