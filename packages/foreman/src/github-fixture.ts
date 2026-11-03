import { Effect, Layer } from "effect";
import { Gh, type GhOptions, type GhResult, Github } from "./github.ts";

/**
 * A `Github` over a `gh` that answers each call from `answer` and records its
 * arguments, and the options of each call in `options` at the same index.
 */
export const fakeGh = (answer: (args: ReadonlyArray<string>, options: GhOptions) => GhResult) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const options: Array<GhOptions> = [];
  const layer = Github.layerWith.pipe(
    Layer.provide(
      Layer.succeed(
        Gh,
        Gh.of({
          exec: (args, given = {}) =>
            Effect.sync(() => {
              calls.push(args);
              options.push(given);
              return answer(args, given);
            }),
        }),
      ),
    ),
  );
  return { calls, options, layer };
};
