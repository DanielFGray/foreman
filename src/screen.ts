import { Command, FetchHttpClient, FileSystem, Path } from "@effect/platform";
import { Effect, Layer, Option, Ref, Schedule, Schema, Stream } from "effect";

/**
 * The terminal, as the dashboard needs it: a list of rows with a preview each,
 * a header, a footer, and the keys the operator pressed.
 *
 * fzf is the implementation, and the reason it can be one is that everything
 * foreman draws is already a list. Nothing above this file knows that, in the
 * same way nothing above `Fleet` knows about herdr — a second implementation
 * would be another driver, not a rewrite of the dashboard.
 *
 * The driver holds no view state. Which rows exist, which one the cursor is
 * on and what the footer says are all recomputed from the dispatcher's last
 * reading and pushed here whole, so the screen is a projection rather than a
 * thing to keep in step.
 */
export class Screen extends Effect.Tag("Screen")<
  Screen,
  {
    /** Replaces everything on screen with this frame. */
    readonly show: (frame: Frame) => Effect.Effect<void, ScreenError>;

    /**
     * Replaces the header alone.
     *
     * The header carries how long ago the world was read, which advances on
     * its own clock rather than on the fleet changing. Redrawing the whole
     * frame to move that number would rewrite every preview on screen once a
     * second.
     */
    readonly header: (text: string) => Effect.Effect<void, ScreenError>;

    /**
     * Which row the cursor is on, read back from the screen rather than
     * remembered.
     *
     * The operator moves the cursor with keys the screen handles itself, so
     * foreman only learns where it is by asking — and it only needs to ask
     * when it is about to redraw. Absent when the list is empty.
     */
    readonly cursor: Effect.Effect<string | undefined, ScreenError>;

    /** Every key the operator pressed that the screen did not handle itself. */
    readonly keys: Stream.Stream<Keypress, ScreenError>;

    /** Which keys type into the prompt instead of acting. */
    readonly mode: (mode: InputMode) => Effect.Effect<void, ScreenError>;

    /** Rings the terminal bell, for a key the selected row cannot take. */
    readonly reject: Effect.Effect<void, ScreenError>;

    /** Completes when the operator closed the screen. */
    readonly closed: Effect.Effect<void>;

    /** Closes the screen, ending `closed`. */
    readonly close: Effect.Effect<void, ScreenError>;
  }
>() {}

/** One selectable line, its identity, and everything behind it. */
export interface ScreenRow {
  /** Stable across redraws: the screen keeps the cursor on this, not on a position. */
  readonly key: string;
  readonly line: string;
  readonly preview: string;

  /**
   * What the footer says while the cursor is on this row — the keys it takes.
   *
   * Carried by the row rather than sent with the frame because the cursor
   * moves without foreman: `j` is a key the screen handles by itself, and a
   * footer foreman had to be asked for would name the previous row's actions
   * until the next redraw caught up.
   */
  readonly footer: string;
}

export interface Frame {
  readonly rows: ReadonlyArray<ScreenRow>;

  /** The tab strip and the status line, which belong to the frame, not a row. */
  readonly header: string;
  readonly prompt: string;

  /**
   * The row to put the cursor on, for a redraw that moves it deliberately.
   *
   * Absent for an ordinary tick, where the screen keeps the cursor on whatever
   * row it was already tracking — by key, so a tick that reorders the list
   * cannot hand the next keypress to a different task.
   */
  readonly cursor: string | undefined;
}

export interface Keypress {
  /** The key's name, as the screen reports it: `r`, `enter`, `escape`, `f12`. */
  readonly key: string;

  /** The key of the row the cursor was on, absent when the list is empty. */
  readonly row: string | undefined;

  /** What is typed in the prompt, which is the answer when the prompt asked for one. */
  readonly query: string;
}

/**
 * What the typed query is for.
 *
 * Typing is never a mode — every command is modified, so a letter always
 * types. What changes is whether the list narrows to what was typed, and the
 * one prompt that takes a sentence must not throw rows away while it is
 * written.
 */
export type InputMode =
  /** What is typed filters the list. */
  | "search"
  /** What is typed is recorded and the list is left alone. */
  | "answer";

/**
 * fzf as the screen, binding exactly the keys it is given.
 *
 * The list is a parameter rather than a constant because which keys mean
 * something is foreman's rule, not the terminal's: `view.ts` owns the map and
 * this owns the terminal. A second implementation would take the same list.
 */
export const fzfScreen = (keys: ReadonlyArray<string>) =>
  Layer.scoped(Screen, running(keys)).pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch)),
  );

const running = (keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fetch = yield* FetchHttpClient.Fetch;

    // Everything the screen and its child commands read lives here, and it
    // goes when the dashboard does. fzf's own children are only ever `cat` and
    // `printf`, so a directory of files is the whole data channel.
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "foreman-screen-" });
    const rowsFile = path.join(dir, "rows");
    const previews = path.join(dir, "previews");
    const socket = path.join(dir, "fzf.sock");
    const keysFile = path.join(dir, "keys");
    const placeFile = path.join(dir, "place");
    yield* fs.makeDirectory(previews);
    yield* fs.writeFileString(rowsFile, "");
    yield* fs.writeFileString(keysFile, "");
    yield* fs.writeFileString(placeFile, "");

    /**
     * The keypress channel: a file every binding appends one line to, watched.
     *
     * A pipe is the obvious shape and the wrong one — reading it needs a
     * positionless read, which the platform's file handles do not do, and it
     * ends whenever its last writer closes, which every binding does. An
     * append-only file has neither problem: the handle keeps its own position,
     * so each read continues where the last one stopped, and a write that
     * arrives between two reads is still there to be found.
     */
    const keyHandle = yield* fs.open(keysFile, { flag: "r" });
    const partial = yield* Ref.make("");
    const drain = Effect.gen(function* () {
      let text = "";
      while (true) {
        const chunk = yield* keyHandle.readAlloc(8192);
        if (Option.isNone(chunk)) break;
        text += decoder.decode(chunk.value);
      }
      // A line is only a keypress once it is whole. Nothing guarantees a read
      // lands on the end of one, and half a key name is not a key.
      return yield* Ref.modify(partial, (held) => {
        const lines = (held + text).split("\n");
        return [lines.slice(0, -1), lines.at(-1) ?? ""];
      });
    });

    const fzf = yield* Command.make(
      "fzf",
      ...args(keys, { rowsFile, socket, keysFile, placeFile }),
    ).pipe(
      Command.stdin("inherit"),
      Command.stdout("inherit"),
      Command.stderr("inherit"),
      Command.start,
      Effect.mapError((cause) => new ScreenError({ action: "spawn", cause: String(cause) })),
    );

    // The socket appears when fzf is ready for it, which is a moment after the
    // process exists. Waiting for the file is the readiness signal; there is
    // no other, and posting before it exists is the one failure that would
    // leave a blank screen with a live fleet behind it.
    yield* fs.exists(socket).pipe(
      Effect.filterOrFail(
        (ready) => ready,
        () => new ScreenError({ action: "start", cause: "fzf never opened its socket" }),
      ),
      Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.upTo("10 seconds"))),
      Effect.mapError((cause) =>
        cause instanceof ScreenError
          ? cause
          : new ScreenError({ action: "start", cause: String(cause) }),
      ),
    );

    const post = (body: string) =>
      Effect.promise(() =>
        fetch("http://localhost/", { method: "POST", body, unix: socket } as RequestInit),
      ).pipe(Effect.asVoid);

    const current = Effect.promise(() =>
      fetch("http://localhost/", { unix: socket } as RequestInit).then((r) => r.json()),
    ).pipe(Effect.map(currentKey));

    return Screen.of({
      show: (frame) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            frame.rows,
            (row) =>
              Effect.all([
                fs.writeFileString(
                  path.join(previews, `${fileName(row.key)}.preview`),
                  row.preview,
                ),
                fs.writeFileString(path.join(previews, `${fileName(row.key)}.footer`), row.footer),
              ]),
            { concurrency: 8, discard: true },
          );
          // NUL-separated, which is what lets a row be more than one line:
          // the exceptional states have a name and a reason, and a reason is
          // the half a narrow pane would truncate away.
          yield* fs.writeFileString(
            rowsFile,
            frame.rows
              .map((row) =>
                [
                  row.key,
                  path.join(previews, `${fileName(row.key)}.preview`),
                  path.join(previews, `${fileName(row.key)}.footer`),
                  row.line.replace(/\t/g, "  "),
                ].join("\t"),
              )
              .join("\0"),
          );
          const at =
            frame.cursor === undefined
              ? -1
              : frame.rows.findIndex((row) => row.key === frame.cursor);
          // Where the cursor goes is left for the screen to apply once the new
          // list is in, and that is not a preference. A reload discards
          // whatever is chained behind it, and a request that arrives while
          // one is running is discarded too — so a position sent with the
          // frame is a position that lands sometimes. The screen reads it back
          // itself on its `load` event, which is exactly the moment the list a
          // row number indexes into exists. Empty means leave the cursor
          // alone, which is the ordinary tick: tracking already keeps it on
          // the row it was on however the list was reordered.
          yield* fs.writeFileString(placeFile, at === -1 ? "" : `pos(${at + 1})`);
          // The header is allowed a second line, and a request body is read a
          // line at a time, so it cannot be chained with anything. Everything
          // else goes ahead of the reload, where chaining still works.
          //
          // The footer is not sent at all: it belongs to whichever row the
          // reload leaves the cursor on, and the screen sets it from that row.
          yield* post(`change-header(${safe(frame.header)})`);
          yield* post(`change-prompt(${safe(frame.prompt)})+reload-sync(cat ${rowsFile})`);
        }).pipe(
          Effect.catchTags({
            BadArgument: (cause) =>
              Effect.fail(new ScreenError({ action: "show", cause: String(cause) })),
            SystemError: (cause) =>
              Effect.fail(new ScreenError({ action: "show", cause: String(cause) })),
          }),
        ),

      header: (text) => post(`change-header(${safe(text)})`),

      cursor: current,

      keys: fs.watch(keysFile).pipe(
        Stream.mapEffect(() => drain),
        Stream.flattenIterables,
        Stream.filter((line) => line.length > 0),
        Stream.map(parseKey),
        Stream.mapError((cause) => new ScreenError({ action: "read", cause: String(cause) })),
      ),

      mode: (mode) =>
        post(mode === "search" ? "enable-search+clear-query" : "disable-search+clear-query"),

      reject: post("bell"),

      closed: fzf.exitCode.pipe(Effect.ignore),

      close: post("abort"),
    });
  });

/**
 * fzf's whole configuration, and the three that carry the design.
 *
 * `--id-nth 1` names the first field as the row's identity, and `--track` then
 * keeps the cursor on that row across a reload however the list was reordered
 * — the one property the dashboard cannot be correct without, because a tick
 * reorders rows and moves tasks between views every poll. It resolves against
 * the original line, so the fields carrying the preview and footer paths stay
 * hidden by `--with-nth 4..` while the identity is still what tracking reads.
 *
 * Search is always live, and that is why every command carries a modifier: an
 * operator finds the row you named to them by typing its id, so no bare letter
 * can also be a command.
 *
 * Every binding writes one line to the pipe and decides nothing. A key's
 * meaning depends on the selected row and on which prompt is open, and both of
 * those live in foreman; a binding that guessed would be a second copy of the
 * rules in `view.ts`.
 */
const args = (
  keys: ReadonlyArray<string>,
  paths: {
    rowsFile: string;
    socket: string;
    keysFile: string;
    placeFile: string;
  },
): ReadonlyArray<string> => [
  "--delimiter",
  "\t",
  "--read0",
  "--with-nth=4..",
  "--id-nth=1",
  "--track",
  "--no-sort",
  "--layout=reverse",
  "--header-first",
  "--info=inline-right",
  "--scheme=default",
  `--listen=${paths.socket}`,
  "--preview=< {2}",
  // The row's own footer, swapped in by the screen as the cursor lands on it.
  // Both events are needed and neither is spare: `focus` covers the cursor
  // moving, and `result` covers the list being replaced under a cursor that
  // did not move — a reload fires focus while the outgoing row is still the
  // current one, so focus alone leaves the previous row's keys advertised
  // until the operator moves. Backgrounded because this runs on every cursor
  // movement, and a synchronous transform makes holding `j` down stutter.
  "--bind=focus:bg-transform-footer(< {3})",
  "--bind=result:bg-transform-footer(< {3})",
  // Applied by the screen the moment a reloaded list is ready, which is the
  // only moment a row number means anything.
  `--bind=load:transform(< ${paths.placeFile})`,
  "--wrap-sign=",
  "--preview-window=right,45%,wrap-word,border-left",
  "--footer-border=line",
  ...keys.flatMap((key) => [
    "--bind",
    `${key}:execute-silent(printf '%s\\t%s\\t%s\\n' ${shellQuote(key)} {1} {q} >> ${paths.keysFile})`,
  ]),
  // A click on the tab strip is a keypress like any other: the word under the
  // pointer is the whole address of the tab, and it rides in the row field.
  "--bind",
  `click-header:execute-silent(printf 'click-tab\\t%s\\t\\n' "$FZF_CLICK_HEADER_WORD" >> ${paths.keysFile})`,
];

/** fzf reports the whole original line; the row's identity is its first field. */
const currentKey = (state: unknown): string | undefined => {
  const text = (state as { current?: { text?: string } } | null)?.current?.text;
  return text === undefined ? undefined : text.split("\t")[0];
};

const parseKey = (line: string): Keypress => {
  const [key = "", row = "", query = ""] = line.split("\t");
  return { key, row: row.length > 0 ? row : undefined, query };
};

/**
 * A preview and a footer file per row, named after the row.
 *
 * Row keys include branch names, which carry slashes, so the key cannot be a
 * file name as it stands. The mapping only has to be stable within one frame
 * and reversible by nobody, because the names travel to the preview and footer
 * commands in the row itself rather than being recomputed there.
 */
const fileName = (key: string): string => key.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * Header and footer text, made safe to send as an action argument.
 *
 * Actions are chained with `+` and their arguments are delimited by brackets,
 * so a bracket in the text ends the argument early and the rest of the frame
 * is read as actions. Nothing foreman puts in a header or footer needs one.
 * Newlines are kept, because both are allowed more than one line and the
 * footer uses a second for the keys that act on the selected row.
 */
const safe = (text: string): string => text.replace(/[\r\t]/g, " ").replace(/[()]/g, "");

const decoder = new TextDecoder();

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

export class ScreenError extends Schema.TaggedError<ScreenError>()("ScreenError", {
  action: Schema.String,
  cause: Schema.String,
}) {
  override get message(): string {
    return `screen ${this.action} failed: ${this.cause}`;
  }
}
