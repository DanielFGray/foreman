import { Effect, Layer } from "effect";
import { Gh, type GhResult, Github } from "./github.ts";

/** A `Github` over a `gh` that answers each call from `answer` and records its arguments. */
export const fakeGh = (answer: (args: ReadonlyArray<string>) => GhResult) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Github.layerWith.pipe(
    Layer.provide(
      Layer.succeed(
        Gh,
        Gh.of({
          exec: (args) =>
            Effect.sync(() => {
              calls.push(args);
              return answer(args);
            }),
        }),
      ),
    ),
  );
  return { calls, layer };
};
