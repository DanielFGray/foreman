import { Argument, Command, Flag } from "effect/cli";
import { Console, Effect, Option } from "effect";
import {
  dependencyMermaid,
  STATUSES,
  TaskError,
  Tasks,
  handOff,
  nameExit,
  type TaskEvent,
} from "tasks";
import { PRIME } from "./prime.ts";
import { detail, json, lines } from "./render.ts";
import { prose } from "./text.ts";

/**
 * `tasks`: the task commands an agent uses, with the names and flags of the Go
 * `prog` they replace, so a brief that says `prog X` works as `tasks X`.
 *
 * Every status change goes through the task machine in the store, which
 * refuses a move it does not list. Every text argument accepts `-` to read
 * standard input.
 */

const id = Argument.String("id");
const text = (name: string) => Argument.String(name);
const labels = Flag.String("label").pipe(Flag.withAlias("l"), Flag.atLeast(0));
const asJson = Flag.Boolean("json").pipe(Flag.withDefault(false));

/** The root command owns `-p`, as the Go `prog` does: `tasks -p foo list` and `tasks list -p foo` both work. */
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
      const description = yield* optionalProse(args.description);
      const definitionOfDone = yield* optionalProse(args.dod);
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

const show = Command.make("show", { id }, ({ id }) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const item = yield* tasks.require(id);
    const [dependencies, dependents, logs] = yield* Effect.all([
      tasks.dependencies(id),
      tasks.dependents(id),
      tasks.logs(id),
    ]);
    yield* Console.log(detail(item, dependencies, dependents, logs));
  }),
).pipe(
  Command.withDescription(
    "Show a task: status, description, definition of done, dependencies both ways, and the log",
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

const cancel = Command.make(
  "cancel",
  { id, reason: Argument.String("reason").pipe(Argument.atLeast(0)) },
  ({ id, reason }) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      yield* tasks.send(id, "cancel");
      if (reason.length === 0) return yield* Console.log(`Canceled ${id}`);
      const why = yield* prose(reason.join(" "));
      yield* tasks.log(id, `Canceled: ${why}`);
      yield* Console.log(`Canceled ${id}: ${why}`);
    }),
).pipe(
  Command.withDescription("Cancel a task that is no longer relevant. An optional reason is logged"),
);

const log = Command.make(
  "log",
  { id, message: Argument.String("message").pipe(Argument.atLeast(1)) },
  ({ id, message }) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      yield* tasks.log(id, yield* prose(message.join(" ")));
      yield* Console.log(`Logged to ${id}`);
    }),
).pipe(Command.withDescription("Add a log entry to a task. Log results and decisions, not steps"));

const append = Command.make(
  "append",
  { id, text: text("text").pipe(Argument.atLeast(1)) },
  ({ id, text }) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks;
      yield* tasks.append(id, yield* prose(text.join(" ")));
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
        description: yield* optionalProse(args.description),
        definitionOfDone: yield* optionalProse(args.dod),
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
      yield* section("Reviewing", of("reviewing"));
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
  "already-done": "review",
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
    nameExit(id, { name: said, commit: undefined, event: VERDICT_MOVES[said] }).pipe(
      Effect.andThen(Console.log(`${id}: ${said}`)),
    ),
).pipe(
  Command.withDescription(
    "Name the exit that ends your run: approved or returned (a reviewer), already-done (an author whose task the trunk already does). returned reopens the task and already-done sends it to review; a second verdict replaces the first",
  ),
);

const review = Command.make("review", { id }, ({ id }) =>
  handOff(id).pipe(Effect.andThen(Console.log(`Moved to review: ${id}`))),
).pipe(
  Command.withDescription(
    "Mark started work as waiting for a reviewer. An open author run ends with the exit done",
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
    move("start", "Started", "Claim an open task: it becomes in_progress"),
    review,
    move("done", "Completed", "Mark a task done"),
    move(
      "open",
      "Opened",
      "Authorise a proposal or draft, or reopen a started, reviewed, done or canceled task",
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
