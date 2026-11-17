import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option } from "effect";
import {
  dependencyMermaid,
  ITEM_ID,
  STATUSES,
  TaskError,
  Tasks,
  Runs,
  type TaskEvent,
} from "tasks";
import { PRIME } from "./prime.ts";
import { detail, detailJson, json, lines } from "./render.ts";
import { prose } from "./text.ts";

/**
 * `tasks`: the task commands an agent uses across sessions.
 *
 * Every status change goes through the task machine in the store, which
 * refuses a move it does not list. Every text argument accepts `-` to read
 * standard input.
 */

const id = Argument.String("id");
const text = (name: string) => Argument.String(name);
const labels = Flag.String("label").pipe(Flag.withAlias("l"), Flag.atLeast(0));
const asJson = Flag.Boolean("json").pipe(Flag.withDefault(false));

/** The root command owns `-p`: `tasks -p foo list` and `tasks list -p foo` both work. */
const root = Command.make("tasks").pipe(
  Command.withSharedFlags({
    project: Flag.String("project").pipe(Flag.withAlias("p"), Flag.optional),
  }),
);

const projectOf = () =>
  Effect.gen(function* () {
    return Option.getOrUndefined((yield* root).project);
  });

const add = Command.make(
  "add",
  {
    title: Argument.String("title"),
    description: Flag.String("desc").pipe(
      Flag.withAlias("d"),
      Flag.withAlias("description"),
      Flag.optional,
    ),
    labels,
    blocks: Flag.String("blocks").pipe(Flag.optional),
    epic: Flag.Boolean("epic").pipe(Flag.withAlias("e"), Flag.withDefault(false)),
    parent: Flag.String("parent").pipe(Flag.optional),
    priority: Flag.Int("priority").pipe(Flag.optional),
    status: Flag.Literals("status", ["proposed", "draft", "open"]).pipe(Flag.optional),
    dod: Flag.String("dod").pipe(Flag.optional),
  },
  (args) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      const project = yield* projectOf();
      if (project === undefined) {
        return yield* new TaskError({ id: "add", detail: "project is required (-p)" });
      }
      const { description, definitionOfDone } = yield* proseFields("add", args);
      if (Option.isSome(args.blocks)) yield* tasks.require(args.blocks.value);
      const added = yield* tasks.add({
        title: args.title,
        project,
        type: args.epic ? "epic" : "task",
        status: Option.getOrUndefined(args.status),
        priority: Option.getOrUndefined(args.priority),
        parent: Option.getOrUndefined(args.parent),
        description,
        definitionOfDone,
        labels: args.labels,
      });
      if (Option.isSome(args.blocks)) yield* tasks.block(added, args.blocks.value);
      yield* Console.log(added);
    }),
).pipe(
  Command.withDescription(
    "Create a task, or an epic with --epic. Prints the new id and nothing else, so $(tasks add ...) holds the id. --blocks makes the new task a prerequisite of another",
  ),
);

const show = Command.make("show", { id, json: asJson }, (args) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const runs = yield* Runs;
    const item = yield* tasks.require(args.id);
    const [dependencies, dependents, children, logs, recorded] = yield* Effect.all([
      tasks.dependencies(args.id),
      tasks.dependents(args.id),
      tasks.list({ parent: args.id }),
      tasks.logs(args.id),
      runs.runsOf([args.id]).pipe(Effect.map((byTask) => byTask.get(args.id) ?? [])),
    ]);
    yield* Console.log(
      args.json
        ? detailJson(item, dependencies, dependents, children, logs, recorded)
        : detail(item, dependencies, dependents, logs, recorded),
    );
  }),
).pipe(
  Command.withDescription(
    "Show a task: status, description, definition of done, dependencies both ways, the agent runs (role, rung, exit, commit) and the log. --json prints one object with those fields and the ids of an epic's children",
  ),
);

const list = Command.make(
  "list",
  {
    status: Flag.Literals("status", STATUSES).pipe(Flag.optional),
    type: Flag.Literals("type", ["task", "epic"]).pipe(Flag.optional),
    parent: Flag.String("parent").pipe(Flag.optional),
    labels,
    json: asJson,
  },
  (args) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      const found = yield* tasks.list({
        project: yield* projectOf(),
        status: Option.getOrUndefined(args.status),
        type: Option.getOrUndefined(args.type),
        parent: Option.getOrUndefined(args.parent),
        labels: args.labels,
      });
      yield* Console.log(args.json ? json(found) : lines(found));
    }),
).pipe(
  Command.withDescription(
    "List tasks, one line each: id, status, priority, project, title. Each --label, --status, --type and --parent narrows the list. --json prints an array of objects",
  ),
);

const ready = Command.make("ready", { labels, json: asJson }, (args) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const found = yield* tasks.ready(yield* projectOf(), args.labels);
    yield* Console.log(args.json ? json(found) : lines(found));
  }),
).pipe(
  Command.withDescription(
    "List the open tasks whose dependencies are resolved, best first. A task labelled question is never ready. --json prints an array of objects",
  ),
);

/** A command that sends one event to a task's machine, and says what happened. */
const move = (name: TaskEvent, past: string, description: string) =>
  Command.make(name, { id }, ({ id }) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      yield* tasks.send(id, name);
      yield* Console.log(`${past} ${id}`);
    }),
  ).pipe(Command.withDescription(description));

/**
 * The ids to cancel and the reason, from the arguments of `tasks cancel`.
 *
 * With --reason, every argument is an id. Without it, the arguments are all ids
 * only when every one has the id shape; otherwise the first is the id and the
 * rest are the reason, as `tasks cancel <id> <words>` has always read them.
 */
const cancelTargets = (
  args: ReadonlyArray<string>,
  flagged: Option.Option<string>,
): { readonly ids: ReadonlyArray<string>; readonly reason: Option.Option<string> } => {
  if (Option.isSome(flagged)) return { ids: args, reason: flagged };
  if (args.every((arg) => ITEM_ID.test(arg))) return { ids: args, reason: Option.none() };
  const [first, ...words] = args;
  return {
    ids: [first!],
    reason: words.length === 0 ? Option.none() : Option.some(words.join(" ")),
  };
};

const cancel = Command.make(
  "cancel",
  {
    targets: Argument.String("id").pipe(Argument.atLeast(1)),
    reason: Flag.String("reason").pipe(Flag.optional),
  },
  ({ targets, reason }) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      const picked = cancelTargets(targets, reason);
      const why = Option.isSome(picked.reason)
        ? Option.some(yield* prose(picked.reason.value))
        : Option.none<string>();
      yield* tasks.cancelAll(picked.ids, why);
      for (const id of picked.ids) {
        yield* Console.log(
          Option.match(why, {
            onNone: () => `Canceled ${id}`,
            onSome: (text) => `Canceled ${id}: ${text}`,
          }),
        );
      }
    }),
).pipe(
  Command.withDescription(
    "Cancel one or more tasks that are no longer relevant, all or none. --reason logs the reason on each. With one id, trailing words are the reason too",
  ),
);

/**
 * The text of `log` or `append`, refused when blank: a blank entry is almost
 * always an empty standard input, so the error names the stdin form.
 */
const nonBlank = (id: string, command: string, value: string) =>
  value.trim() === ""
    ? Effect.fail(
        new TaskError({
          id,
          detail: `empty message: pass the text, or read it from standard input: tasks ${command} ${id} - <<'EOF'`,
        }),
      )
    : Effect.succeed(value);

const log = Command.make(
  "log",
  { id, message: Argument.String("message").pipe(Argument.atLeast(1)) },
  ({ id, message }) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      const entry = yield* nonBlank(id, "log", yield* prose(message.join(" ")));
      yield* tasks.log(id, entry);
      yield* Console.log(`Logged to ${id}`);
    }),
).pipe(Command.withDescription("Add a log entry to a task. Log results and decisions, not steps"));

const append = Command.make(
  "append",
  { id, text: text("text").pipe(Argument.atLeast(1)) },
  ({ id, text }) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      const added = yield* nonBlank(id, "append", yield* prose(text.join(" ")));
      yield* tasks.append(id, added);
      yield* Console.log(`Appended to ${id}`);
    }),
).pipe(Command.withDescription("Add text to the end of a task's description"));

const desc = Command.make(
  "desc",
  { id, text: text("text").pipe(Argument.atLeast(1)) },
  ({ id, text }) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      yield* tasks.edit(id, { description: yield* prose(text.join(" ")) });
      yield* Console.log(`Updated description of ${id}`);
    }),
).pipe(Command.withDescription("Replace a task's description"));

const edit = Command.make(
  "edit",
  {
    id,
    title: Flag.String("title").pipe(Flag.optional),
    dod: Flag.String("dod").pipe(Flag.optional),
    description: Flag.String("description").pipe(Flag.optional),
  },
  (args) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      const change = {
        title: Option.getOrUndefined(args.title),
        ...(yield* proseFields(args.id, args)),
      };
      if (Object.values(change).every((value) => value === undefined)) {
        return yield* new TaskError({
          id: args.id,
          detail: "nothing to edit: give --title, --dod or --description",
        });
      }
      yield* tasks.edit(args.id, change);
      yield* Console.log(`Updated ${args.id}`);
    }),
).pipe(
  Command.withDescription(
    "Change a task's title, description or definition of done. An empty --dod clears it",
  ),
);

const label = Command.make("label", { id, name: text("label") }, ({ id, name }) =>
  Effect.gen(function* () {
    yield* (yield* Tasks).label(id, name);
    yield* Console.log(`Added label ${name} to ${id}`);
  }),
).pipe(Command.withDescription("Add a label to a task"));

const unlabel = Command.make("unlabel", { id, name: text("label") }, ({ id, name }) =>
  Effect.gen(function* () {
    yield* (yield* Tasks).unlabel(id, name);
    yield* Console.log(`Removed label ${name} from ${id}`);
  }),
).pipe(Command.withDescription("Remove a label from a task"));

const blocks = Command.make(
  "blocks",
  { first: Argument.String("first"), second: Argument.String("second") },
  ({ first, second }) =>
    Effect.gen(function* () {
      yield* (yield* Tasks).block(first, second);
      yield* Console.log(`${second} now waits for ${first}`);
    }),
).pipe(
  Command.withDescription(
    "Make the second task wait for the first. An edge that makes a cycle is refused",
  ),
);

const unblocks = Command.make(
  "unblocks",
  { first: Argument.String("first"), second: Argument.String("second") },
  ({ first, second }) =>
    Effect.gen(function* () {
      yield* (yield* Tasks).unblock(first, second);
      yield* Console.log(`${second} no longer waits for ${first}`);
    }),
).pipe(Command.withDescription("End the wait of the second task for the first"));

const parent = Command.make("parent", { id, epic: Argument.String("epic") }, ({ id, epic }) =>
  Effect.gen(function* () {
    yield* (yield* Tasks).setParent(id, epic);
    yield* Console.log(`${id} is now under ${epic}`);
  }),
).pipe(Command.withDescription("Put a task under an epic"));

const priority = Command.make(
  "priority",
  { id, priority: Argument.Int("priority") },
  ({ id, priority }) =>
    Effect.gen(function* () {
      yield* (yield* Tasks).setPriority(id, priority);
      yield* Console.log(`${id} is now priority ${priority}`);
    }),
).pipe(Command.withDescription("Set a task's priority: 1 is high, 2 is medium, 3 is low"));

const status = Command.make(
  "status",
  {
    labels,
    all: Flag.Boolean("all").pipe(Flag.withDefault(false)),
  },
  (args) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      const project = yield* projectOf();
      const found = yield* tasks.list({ project, labels: args.labels });
      const counts = STATUSES.map(
        (s) => [s, found.filter((item) => item.status === s).length] as const,
      )
        .filter(([, count]) => count > 0)
        .map(([s, count]) => `${s} ${count}`);
      yield* Console.log(`Tasks: ${found.length} (${counts.join(", ")})`);
      const section = (title: string, items: typeof found) =>
        items.length === 0 ? Effect.void : Console.log(`\n${title}:\n${lines(items)}`);
      const of = (s: string) => found.filter((item) => item.status === s && item.type === "task");
      const open = (item: (typeof found)[number]) =>
        item.status !== "done" && item.status !== "canceled";
      yield* section("In progress", of("in_progress"));
      yield* section("Proposals awaiting authorisation", of("proposed"));
      yield* section(
        "Questions (open decisions)",
        found.filter((item) => item.labels.includes("question") && open(item)),
      );
      const ready = yield* tasks.ready(project, args.labels);
      yield* section(`Ready (${ready.length})`, args.all ? ready : ready.slice(0, 10));
    }),
).pipe(
  Command.withDescription(
    "Count tasks by status and list what is under way, what waits on a decision and what is ready. --all lists every ready task, not the first 10",
  ),
);

const graph = Command.make("graph", {}, () =>
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const edges = yield* tasks.allDependencies(yield* projectOf());
    const ids = [...new Set(edges.flatMap((edge) => [edge.item, edge.dependsOn]))];
    const nodes = yield* Effect.forEach(ids, (taskId) =>
      tasks
        .require(taskId)
        .pipe(Effect.map((item) => ({ id: item.id, title: item.title, status: item.status }))),
    );
    yield* Console.log(dependencyMermaid(nodes, edges));
  }),
).pipe(
  Command.withDescription(
    "Print the dependency graph as a Mermaid flowchart. An arrow runs from a task to the tasks that wait for it",
  ),
);

/**
 * The exits `tasks verdict` names, and the status move each makes. Foreman
 * reads its agents' exits from the pipeline drawing; these are the standard
 * ones, for work tracked with `tasks` alone.
 */
const VERDICT_MOVES = {
  approved: undefined,
  returned: "open",
  "already-done": undefined,
} as const satisfies Record<string, TaskEvent | undefined>;
type VerdictName = keyof typeof VERDICT_MOVES;

const verdictCommand = Command.make(
  "verdict",
  {
    id,
    said: Argument.Literals(
      "verdict",
      Object.keys(VERDICT_MOVES) as [VerdictName, ...Array<VerdictName>],
    ),
  },
  ({ id, said }) =>
    Effect.gen(function* () {
      const runs = yield* Runs;
      yield* runs.nameExit(id, { ending: said, event: VERDICT_MOVES[said] });
      yield* Console.log(`${id}: ${said}`);
    }),
).pipe(
  Command.withDescription(
    "Name the exit that ends your run: approved or returned (a reviewer), already-done (an author whose task the trunk already does). returned reopens the task; already-done leaves the status and records the exit; a second verdict replaces the first",
  ),
);

const prime = Command.make("prime", {}, () => Console.log(PRIME)).pipe(
  Command.withDescription("Print the workflow an agent follows with tasks"),
);

export const tasksCommand = root.pipe(
  Command.withDescription("Track tasks across sessions"),
  Command.withSubcommands([
    add,
    show,
    list,
    ready,
    move("start", "Started", "Start open, done or canceled work: it becomes in_progress"),
    move("done", "Completed", "Mark a task done"),
    move(
      "open",
      "Opened",
      "Authorise a proposal or draft, or reopen a started, done or canceled task",
    ),
    cancel,
    move(
      "propose",
      "Proposed",
      "Return a draft or open task to proposed: nobody has authorised it",
    ),
    move("draft", "Drafted", "Return a proposal or open task to draft: it is still being scoped"),
    log,
    append,
    desc,
    edit,
    label,
    unlabel,
    blocks,
    unblocks,
    parent,
    priority,
    status,
    graph,
    verdictCommand,
    prime,
  ]),
);

const optionalProse = (value: Option.Option<string>) =>
  Option.isSome(value) ? prose(value.value) : Effect.undefined;

/**
 * The description and definition of done of `add` or `edit`. Standard input
 * can be read only once, so when both are `-` the second would be silently
 * empty; that is refused instead.
 */
const proseFields = (
  id: string,
  args: { readonly description: Option.Option<string>; readonly dod: Option.Option<string> },
) =>
  Option.contains(args.description, "-") && Option.contains(args.dod, "-")
    ? Effect.fail(
        new TaskError({
          id,
          detail:
            "--description and --dod cannot both read standard input (-): pass one as text, or set the other with tasks edit",
        }),
      )
    : Effect.all({
        description: optionalProse(args.description),
        definitionOfDone: optionalProse(args.dod),
      });
