/**
 * How each coding-agent harness is started on a rung's model, thinking level
 * and first prompt. Pure: the fleet adapter runs what this returns.
 */

import { Option } from "effect";

/** A program to start: its argv and the environment it needs on top. */
export interface Launch {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The command that starts a harness working on `prompt` in `directory`.
 *
 * The prompt is the harness's own first argument rather than text typed into
 * its input box afterwards: typed input races the harness's start-up, and a
 * prompt sent before the input box exists is lost whole.
 */
export const harnessLaunch = (options: {
  readonly kind: string;
  readonly model: string | undefined;
  readonly thinking?: string | undefined;
  readonly prompt: string;
  readonly directory: string;
}): Launch => {
  const { kind, prompt } = options;
  switch (kind) {
    case "opencode":
      return {
        argv: ["opencode", "--standalone", "--auto", "--prompt", prompt],
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify(
            opencodeConfig({
              model: options.model,
              workspace: options.directory,
              checkouts: checkoutRoot(),
            }),
          ),
        },
      };
    case "codex":
      // The shared daemon runs whichever model it last loaded, so a rung's
      // model only holds in a process of its own.
      return { argv: ["codex", "--no-daemon", ...launchArguments(options), prompt], env: {} };
    case "cursor":
      // A task worktree is a folder cursor has never seen, and it asks before
      // working in one; foreman made this one, so the answer is known.
      return { argv: ["cursor-agent", "--trust", ...launchArguments(options), prompt], env: {} };
    default:
      return { argv: [kind, ...launchArguments(options), prompt], env: {} };
  }
};

/**
 * The flags that start a harness on a rung's model and thinking level. Each
 * harness spells the level its own way; one with no such flag, or a rung whose
 * level the harness picks (`auto`), gets none.
 */
export const launchArguments = (options: {
  readonly kind: string;
  readonly model: string | undefined;
  readonly thinking?: string | undefined;
}): ReadonlyArray<string> => {
  const level =
    options.thinking === undefined || options.thinking === "auto" ? undefined : options.thinking;
  const effort =
    level === undefined
      ? []
      : options.kind === "claude"
        ? ["--effort", level]
        : options.kind === "codex"
          ? ["-c", `model_reasoning_effort=${level}`]
          : options.kind === "pi"
            ? ["--thinking", level]
            : [];
  return [...(options.model ? ["--model", options.model] : []), ...effort];
};

/**
 * opencode's permission rules for an unattended agent, and the model it runs.
 *
 * `--auto` approves every permission no rule denies, so the deny list is the
 * whole safety story. It separates reading from writing, because opencode
 * gates those separately: `external_directory` covers any tool touching a path
 * outside the working directory and is allowed wholesale, so a measurement
 * task reads the filesystem it is measuring, while `edit` — every `edit`,
 * `write` and `patch` — is denied across the operators' checkouts. Rules are
 * last-match-wins, so the catch-all comes first and each exception after it.
 *
 * The exception is this workspace, because onboarding is dispatched into a
 * checkout and must be able to salvage what it finds; its own directory is
 * last, so it wins over the checkout rule above it.
 *
 * What this cannot reach is `bash`, where any command can write anywhere. The
 * denials that matter there are the ones a command *names*, and only pushing
 * is named. The prompts carry the rest, and that gap is deliberate rather than
 * hidden: a deny list over arbitrary shell would have to enumerate every way to
 * write a file.
 */
export const opencodeConfig = (options: {
  readonly model: string | undefined;
  readonly workspace: string;
  readonly checkouts: string;
}): Record<string, unknown> => ({
  permission: {
    bash: { "git push*": "deny" },
    external_directory: { "*": "allow" },
    edit: {
      "*": "allow",
      [`${options.checkouts}/**`]: "deny",
      [`${options.workspace}/**`]: "allow",
    },
  },
  ...(options.model === undefined ? {} : { model: options.model }),
});

/**
 * Where the operators' project checkouts live, which opencode may not write to.
 * The same `~/build/<name>` the settings derive a project's directory from.
 */
const checkoutRoot = (): string => `${process.env["HOME"] ?? ""}/build`;

/**
 * The wall text a screen ends on, or none. Matches literal substrings only,
 * in the tail of the screen named by `WALL_WINDOW_LINES`.
 */
export const hitWall = (kind: string, screen: string): Option.Option<string> => {
  const tail = screen
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-WALL_WINDOW_LINES)
    .join("\n");
  return Option.fromNullishOr(wallTexts(kind).find((text) => tail.includes(text)));
};

/**
 * How many non-blank lines at the bottom of a screen are read for a wall. A
 * harness prints its stop as its last message, so the screen's history above
 * is not searched: an agent's own prompt quotes these strings, and a match in
 * that history would wall a run that merely read about walls.
 */
const WALL_WINDOW_LINES = 12;

/**
 * The literal text each harness prints when its account has no allowance left.
 *
 * Only strings read out of the harness's own binary are listed. Empty means
 * the text is not confirmed, so a run that stops on that harness is never read
 * as a wall: it stays an ordinary unfinished ending.
 *
 * Claude's session limit is built from a template in its binary, so only its
 * literal spend-limit and shared-budget messages are listed. Cursor's text was
 * not found in its binary.
 */
const wallTexts = (kind: string): ReadonlyArray<string> => {
  switch (kind) {
    case "opencode":
      return ["Free usage limit reached"];
    case "codex":
      // The binary prints U+2019, not an ASCII apostrophe; a literal with the
      // ASCII mark never matches the screen.
      return ["You’ve hit your usage limit"];
    case "claude":
      return ["You've hit your monthly spend limit", "You've hit your team's shared budget"];
    default:
      return [];
  }
};
