/**
 * `foreman open <project>`: the project's page in the operator's browser.
 *
 * The address is not looked up: `foreman serve` listens on the port that
 * `uiPort` reads from FOREMAN_UI_PORT, and this command reads the same
 * setting. Whether a server runs is what its flock says (`serve.lock`), the
 * same test that refuses a second `foreman serve`.
 */
import { Console, Data, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { publishedPath } from "./paths.ts";
import { serveRunning } from "./serve.ts";
import { uiPort } from "./ui-server.ts";

export class ServeNotRunning extends Data.TaggedError("ServeNotRunning")<{}> {
  override get message() {
    return "no foreman serve is running, so there is no page to open; start it with `foreman serve`";
  }
}

/** The page's address for one project. */
export const pageUrl = (port: number, project: string) =>
  `http://localhost:${port}/p/${encodeURIComponent(project)}`;

const project = Argument.String("project").pipe(
  Argument.withDescription("The project whose pipeline page opens"),
);

export const openCommand = Command.make("open", { project }, ({ project }) =>
  Effect.gen(function* () {
    if (!(yield* serveRunning(publishedPath()))) return yield* new ServeNotRunning();
    const url = pageUrl(yield* uiPort, project);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* Effect.scoped(
      spawner
        .spawn(ChildProcess.make("xdg-open", [url]))
        .pipe(Effect.flatMap((child) => child.exitCode)),
    );
    yield* Console.log(url);
  }),
).pipe(Command.withDescription("Open a project's pipeline page in the browser"));
