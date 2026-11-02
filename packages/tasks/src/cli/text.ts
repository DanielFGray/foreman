import { Effect, Stdio, Stream } from "effect";

/**
 * A prose argument: the text itself, or all of standard input when it is `-`.
 * A trailing newline is dropped, as a heredoc always adds one.
 */
export const prose = (value: string) =>
  value === "-"
    ? Stdio.Stdio.pipe(
        Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        Effect.map((text) => text.replace(/\r?\n$/, "")),
      )
    : Effect.succeed(value);
