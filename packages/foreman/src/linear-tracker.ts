import { Clock, Effect, Exit, Option, Ref, Schema as S } from "effect";
import type { Dependency, Item, ListFilter, Status } from "tasks";
import { confirm, splitBody } from "./github-tracker.ts";
import { Linear, LinearError, type LinearRate } from "./linear.ts";
import { Tracker, TrackerError } from "./tracker.ts";

import type { LinearPlace } from "./policy.ts";

/**
 * Linear issues as foreman's tasks, over Linear's GraphQL API
 * (docs/issue-trackers.md, section 7).
 *
 * An issue's id is `<project>#<identifier>`, for example `foreman#ENG-42`.
 * Status comes from the type of the issue's workflow state.
 *
 * Reads come from one snapshot per project: one paged query for the
 * project's issues that are not completed or canceled, the team's states and
 * labels, and each issue a `lookup` found outside that list, by id, so an
 * issue closed on Linear while foreman holds a run on it reads as closed.
 * `refresh` reads it anew; a write drops the snapshot of its project; a
 * failed read is kept until the next refresh, as for GitHub.
 *
 * A team with no state of a type foreman moves issues to (`unstarted`,
 * `started`, `completed`, `canceled`) fails the read, because foreman cannot make that
 * move, and a state of another type is a status the operator did not mean.
 *
 * Below a tenth of either hourly budget left, `refresh` reads only on every
 * fifth call until the budget resets, and keeps the last snapshot between.
 */
export const linearTracker = (
  placeOf: (project: string) => Effect.Effect<LinearPlace, TrackerError>,
): Effect.Effect<Tracker["Service"], never, Linear> =>
  Effect.gen(function* () {
    const linear = yield* Linear;
    const snapshots = yield* Ref.make(new Map<string, Read>());
    // Issues a `lookup` found outside the open list, by Linear's own id.
    const held = yield* Ref.make(new Map<string, ReadonlySet<string>>());

    const fail = (command: string) => (error: LinearError | TrackerError) =>
      new TrackerError({ command, detail: error.detail });

    const query = <A, I>(
      schema: S.Codec<A, I>,
      command: string,
      document: string,
      variables: Record<string, unknown>,
    ) =>
      linear
        .graphql(document, variables)
        .pipe(
          Effect.flatMap(({ data, rate }) =>
            decode(schema, command)(data).pipe(Effect.map((value) => ({ value, rate }))),
          ),
        );

    const fetch = (project: string): Effect.Effect<Snapshot, TrackerError> =>
      Effect.gen(function* () {
        const place = yield* placeOf(project);
        const ids = [...((yield* Ref.get(held)).get(project) ?? [])];
        const command = `read ${project}`;
        const first = yield* query(FirstPage, command, firstPageQuery, {
          ...place,
          held: ids.slice(0, HELD_PAGE),
        });
        const { team, projectId } = yield* placed(place, command, first.value.teams.nodes[0]);
        const issues: Array<IssueNode> = [...first.value.held.nodes, ...first.value.issues.nodes];
        for (let start = HELD_PAGE; start < ids.length; start += HELD_PAGE) {
          const more = yield* query(HeldData, command, heldQuery, {
            held: ids.slice(start, start + HELD_PAGE),
          });
          issues.push(...more.value.held.nodes);
        }
        let page = first.value.issues.pageInfo;
        let rate = first.rate;
        while (page.hasNextPage && page.endCursor !== null) {
          const next = yield* query(NextPage, command, nextPageQuery, {
            ...place,
            after: page.endCursor,
          });
          issues.push(...next.value.issues.nodes);
          page = next.value.issues.pageInfo;
          rate = next.rate ?? rate;
        }
        return {
          teamId: team.id,
          projectId,
          viewer: first.value.viewer.id,
          states: team.states.nodes,
          labels: new Map(team.labels.nodes.map((label) => [label.name, label.id])),
          issues: new Map(issues.map((issue) => [issue.identifier, issue])),
          rate,
          skipped: 0,
        };
      }).pipe(Effect.mapError(fail(`read ${project}`)));

    const snapshot = (project: string) =>
      Effect.gen(function* () {
        const read = (yield* Ref.get(snapshots)).get(project);
        if (read !== undefined) return yield* read;
        return yield* load(project);
      });

    const load = (project: string) =>
      fetch(project).pipe(
        Effect.exit,
        Effect.tap((exit) => Ref.update(snapshots, (all) => new Map(all).set(project, exit))),
        Effect.flatten,
      );

    const forget = (project: string) =>
      Ref.update(snapshots, (all) => {
        const next = new Map(all);
        next.delete(project);
        return next;
      });

    const refresh = (project: string) =>
      Effect.gen(function* () {
        const read = (yield* Ref.get(snapshots)).get(project);
        const now = yield* Clock.currentTimeMillis;
        if (read !== undefined && read._tag === "Success") {
          const { rate, skipped } = read.value;
          if (rate !== undefined && starved(rate, now) && skipped < 4) {
            yield* Ref.update(snapshots, (all) =>
              new Map(all).set(project, Exit.succeed({ ...read.value, skipped: skipped + 1 })),
            );
            return;
          }
        }
        yield* load(project);
      }).pipe(Effect.asVoid);

    const items = (project: string) =>
      snapshot(project).pipe(
        Effect.map((read) =>
          [...read.issues.values()].map((issue) => itemOf(project, read, issue)),
        ),
      );

    const issueOf = (task: string) => {
      const parsed = parseId(task);
      return parsed === undefined
        ? Effect.fail(new TrackerError({ command: task, detail: "not a Linear issue id" }))
        : Effect.succeed(parsed);
    };

    /** The issue as Linear reads it now: what a move checks before it writes. */
    const current = (identifier: string) =>
      query(CurrentData, `issue ${identifier}`, currentQuery, { id: identifier }).pipe(
        Effect.map(({ value }) => value.issue),
      );

    const mutate = (command: string, document: string, variables: Record<string, unknown>) =>
      query(Mutated, command, document, variables).pipe(
        Effect.flatMap(({ value }) =>
          value.result.success
            ? Effect.succeed(value.result)
            : Effect.fail(new TrackerError({ command, detail: "Linear answered success: false" })),
        ),
      );

    const update = (identifier: string, input: Record<string, unknown>) =>
      mutate(`update ${identifier}`, updateMutation, { id: identifier, input });

    /** The label's id in the team, made with `issueLabelCreate` when the team lacks it. */
    const labelId = (read: Snapshot, name: string) => {
      const known = read.labels.get(name);
      return known !== undefined
        ? Effect.succeed(known)
        : mutate(`label ${name}`, labelCreateMutation, {
            input: { name, teamId: read.teamId },
          }).pipe(
            Effect.flatMap((result) =>
              result.issueLabel === undefined || result.issueLabel === null
                ? Effect.fail(
                    new TrackerError({
                      command: `label ${name}`,
                      detail: "no label in the answer",
                    }),
                  )
                : Effect.succeed(result.issueLabel.id),
            ),
          );
    };

    /**
     * Runs one write on an issue with the project's snapshot in hand, and
     * drops the snapshot whether or not the write finished, because a write
     * that failed half way may still have changed the issue.
     */
    const writing =
      (command: string) =>
      <A>(
        task: string,
        write: (read: Snapshot, identifier: string) => Effect.Effect<A, LinearError | TrackerError>,
      ) =>
        Effect.gen(function* () {
          const { project, identifier } = yield* issueOf(task);
          const read = yield* snapshot(project);
          return yield* write(read, identifier).pipe(Effect.ensuring(forget(project)));
        }).pipe(Effect.mapError(fail(`${command} ${task}`)));

    const lookup = (task: string): Effect.Effect<Option.Option<Item>, TrackerError> =>
      Effect.gen(function* () {
        const { project, identifier } = yield* issueOf(task);
        const read = yield* snapshot(project);
        const known = read.issues.get(identifier);
        if (known !== undefined) return Option.some(itemOf(project, read, known));
        const { team, number } = splitIdentifier(identifier);
        const found = yield* query(LookupData, `show ${task}`, lookupQuery, { team, number });
        const issue = found.value.issues.nodes[0];
        if (issue === undefined) return Option.none();
        yield* Ref.update(held, (all) =>
          new Map(all).set(project, new Set([...(all.get(project) ?? []), issue.id])),
        );
        return Option.some(itemOf(project, read, issue));
      }).pipe(Effect.mapError(fail(`show ${task}`)));

    const claim = (task: string) =>
      writing("claim")(task, (read, identifier) =>
        Effect.gen(function* () {
          const claimed = (issue: CurrentIssue) =>
            issue.state.type === "started" && issue.assignee?.id === read.viewer;
          if (claimed(yield* current(identifier))) return;
          yield* update(identifier, {
            stateId: stateFor(read.states, "started").id,
            assigneeId: read.viewer,
          });
          yield* confirm(current(identifier), claimed, `claim ${task}`);
        }),
      );

    const reopen = (task: string) =>
      writing("reopen")(task, (read, identifier) =>
        Effect.gen(function* () {
          const before = yield* current(identifier);
          if (before.state.type === "unstarted" && before.assignee === null) return;
          yield* update(identifier, {
            stateId: stateFor(read.states, "unstarted").id,
            assigneeId: null,
          });
        }),
      );

    const complete = (task: string) =>
      writing("complete")(task, (read, identifier) =>
        Effect.gen(function* () {
          if ((yield* current(identifier)).state.type === "completed") return;
          yield* update(identifier, { stateId: stateFor(read.states, "completed").id });
        }),
      );

    const cancel = (task: string) =>
      writing("cancel")(task, (read, identifier) =>
        Effect.gen(function* () {
          if ((yield* current(identifier)).state.type === "canceled") return;
          yield* update(identifier, { stateId: stateFor(read.states, "canceled").id });
        }),
      );

    return Tracker.of({
      refresh: (project) => refresh(project).pipe(Effect.mapError(fail(`read ${project}`))),
      lookup,
      list: (filter) =>
        filter.project === undefined && filter.parent === undefined
          ? Effect.fail(
              new TrackerError({ command: "list", detail: "a Linear list needs a project" }),
            )
          : items(filter.project ?? parseId(filter.parent ?? "")?.project ?? "").pipe(
              Effect.map((all) => all.filter(matches(filter))),
            ),
      dependencies: (project) =>
        snapshot(project).pipe(
          Effect.map((read) =>
            [...read.issues.values()].flatMap((issue) =>
              blockersOf(issue).map((blocker): Dependency => ({
                item: `${project}#${issue.identifier}`,
                dependsOn:
                  blocker.project?.id === read.projectId
                    ? `${project}#${blocker.identifier}`
                    : blocker.identifier,
              })),
            ),
          ),
        ),
      ready: (project) =>
        project === undefined
          ? Effect.fail(
              new TrackerError({ command: "ready", detail: "a Linear read needs a project" }),
            )
          : items(project).pipe(
              Effect.map((all) =>
                all.filter((item) => item.status === "open" && item.type === "task"),
              ),
            ),
      logs: (task) =>
        Effect.gen(function* () {
          const { identifier } = yield* issueOf(task);
          const { value } = yield* query(CommentsData, `log of ${task}`, commentsQuery, {
            id: identifier,
          });
          return value.issue.comments.nodes
            .map((comment) => ({
              message: `${comment.user?.name ?? "ghost"}: ${comment.body}`,
              createdAt: new Date(comment.createdAt),
            }))
            .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        }).pipe(Effect.mapError(fail(`log of ${task}`))),
      add: (task) =>
        Effect.gen(function* () {
          const read = yield* snapshot(task.project);
          const labelIds = yield* Effect.forEach(task.labels, (label) => labelId(read, label));
          const created = yield* mutate(`add ${task.title}`, createMutation, {
            input: {
              teamId: read.teamId,
              projectId: read.projectId,
              title: task.title,
              description: task.description,
              stateId: stateFor(read.states, "unstarted").id,
              labelIds,
            },
          }).pipe(Effect.ensuring(forget(task.project)));
          if (created.issue === undefined || created.issue === null)
            return yield* new TrackerError({
              command: `add ${task.title}`,
              detail: "no issue in the answer",
            });
          return `${task.project}#${created.issue.identifier}`;
        }).pipe(Effect.mapError(fail(`add ${task.title}`))),
      claim,
      reopen,
      complete,
      cancel,
      label: (task, label) =>
        writing("label")(task, (read, identifier) =>
          labelId(read, label).pipe(
            Effect.flatMap((id) => update(identifier, { addedLabelIds: [id] })),
            Effect.asVoid,
          ),
        ),
      unlabel: (task, label) =>
        writing("unlabel")(task, (read, identifier) => {
          const id = read.labels.get(label);
          return id === undefined
            ? Effect.void
            : update(identifier, { removedLabelIds: [id] }).pipe(Effect.asVoid);
        }),
      relabel: (task, change) =>
        writing("relabel")(task, (read, identifier) =>
          Effect.gen(function* () {
            const before = (yield* current(identifier)).labels.nodes.map((label) => label.name);
            const after = change(before);
            const labelIds = yield* Effect.forEach(after, (label) => labelId(read, label));
            yield* update(identifier, { labelIds });
            return before;
          }),
        ),
      log: (task, message) =>
        writing("log")(task, (_read, identifier) =>
          mutate(`log ${task}`, commentMutation, {
            input: { issueId: identifier, body: message },
          }).pipe(Effect.asVoid),
        ),
    });
  });

/** `<project>#<identifier>` split, or `undefined` for any other id. */
export const parseId = (
  id: string,
): { readonly project: string; readonly identifier: string } | undefined => {
  const match = /^(.+)#([A-Za-z0-9]+-\d+)$/.exec(id);
  return match ? { project: match[1]!, identifier: match[2]! } : undefined;
};

/** `ENG-42` as its team key and number. */
const splitIdentifier = (identifier: string) => {
  const dash = identifier.lastIndexOf("-");
  return { team: identifier.slice(0, dash), number: Number(identifier.slice(dash + 1)) };
};

/** The state types foreman moves issues to; a team without one of them cannot be worked. */
const MOVED_TO = ["unstarted", "started", "completed", "canceled"] as const;

/**
 * The team's state of `type`, preferring the name the table in section 7
 * names (`Todo`, a name containing `progress`), as lalph's `findState` does.
 * The read checked every type in `MOVED_TO` exists.
 */
export const stateFor = (
  states: ReadonlyArray<WorkflowState>,
  type: (typeof MOVED_TO)[number],
): WorkflowState => {
  const ofType = states.filter((state) => state.type === type);
  const preferred =
    type === "unstarted"
      ? ofType.find((state) => state.name.toLowerCase() === "todo")
      : type === "started"
        ? ofType.find((state) => state.name.toLowerCase().includes("progress"))
        : undefined;
  return preferred ?? ofType[0]!;
};

/** Below a tenth of either hourly budget left, `refresh` reads every fifth call. */
const starved = (rate: LinearRate, now: number) =>
  now < rate.reset &&
  (rate.requests.remaining < rate.requests.limit / 10 ||
    (rate.complexity !== undefined && rate.complexity.remaining < rate.complexity.limit / 10));

const matches =
  (filter: ListFilter) =>
  (item: Item): boolean =>
    (filter.status === undefined || item.status === filter.status) &&
    (filter.type === undefined || item.type === filter.type) &&
    (filter.parent === undefined || item.parent === filter.parent) &&
    (filter.labels ?? []).every((label) => item.labels.includes(label));

const closedTypes = new Set(["completed", "canceled"]);

const blockersOf = (issue: IssueNode) =>
  issue.inverseRelations.nodes
    .filter((relation) => relation.type === "blocks")
    .map((relation) => relation.issue);

/** The issue as foreman's `Item` (docs/issue-trackers.md, "The issue as an `Item`"). */
export const itemOf = (
  project: string,
  read: { readonly projectId: string },
  issue: IssueNode,
): Item => {
  const { description, definitionOfDone } = splitBody(issue.description ?? "");
  const updatedAt = new Date(issue.updatedAt);
  const lastComment = issue.comments.nodes[0]?.createdAt;
  return {
    id: `${project}#${issue.identifier}`,
    project,
    type: issue.children.nodes.length > 0 ? "epic" : "task",
    title: issue.title,
    description,
    definitionOfDone,
    status: statusOf(issue),
    priority: priorityOf(issue.priority),
    parent:
      issue.parent && issue.parent.project?.id === read.projectId
        ? `${project}#${issue.parent.identifier}`
        : undefined,
    labels: issue.labels.nodes.map((label) => label.name),
    createdAt: new Date(issue.createdAt),
    updatedAt,
    lastActivityAt:
      lastComment !== undefined && new Date(lastComment) > updatedAt
        ? new Date(lastComment)
        : updatedAt,
  };
};

/** Linear's 1 urgent and 2 high are foreman's 1; 3 medium and 0 none are 2; 4 low is 3. */
const priorityOf = (priority: number) =>
  priority === 1 || priority === 2 ? 1 : priority === 4 ? 3 : 2;

/**
 * Status by the state's type, so a state with any name reads right. An
 * unstarted issue with an assignee is a claim a person made, which reads as
 * `in_progress` and is its owner's, as on GitHub.
 */
const statusOf = (issue: IssueNode): Status => {
  switch (issue.state.type) {
    case "triage":
      return "proposed";
    case "backlog":
      return "draft";
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "canceled":
      return "canceled";
  }
  if (issue.assignee !== null) return "in_progress";
  if (blockersOf(issue).some((blocker) => !closedTypes.has(blocker.state.type))) return "blocked";
  return "open";
};

/** Decodes `input`, naming `command` in the failure. */
const decode =
  <A, I>(schema: S.Codec<A, I>, command: string) =>
  (input: unknown) =>
    S.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => new TrackerError({ command, detail: String(error) })),
    );

const ISSUE_FIELDS = `
  id identifier title description priority createdAt updatedAt
  state { type }
  assignee { id }
  project { id }
  parent { identifier project { id } }
  children(first: 1) { nodes { id } }
  labels(first: 50) { nodes { name } }
  inverseRelations(first: 50) { nodes { type issue { identifier state { type } project { id } } } }
  comments(last: 1) { nodes { createdAt } }`;

const PAGE_FILTER = `filter: {
      team: { key: { eq: $team } }
      project: { name: { eq: $project } }
      state: { type: { nin: ["completed", "canceled"] } }
    }`;

/**
 * The held issues by id, archived ones included, because Linear archives a
 * closed issue after a while and a run may still be held on it. One id filter
 * takes at most `HELD_PAGE` ids, the size of one page, so no held issue is
 * cut off.
 */
const HELD_PAGE = 100;
const HELD_FIELD = `held: issues(first: ${HELD_PAGE}, includeArchived: true, filter: { id: { in: $held } }) { nodes { ...issue } }`;

const heldQuery = `
query($held: [ID!]!) {
  ${HELD_FIELD}
}
fragment issue on Issue { ${ISSUE_FIELDS} }`;

/**
 * The first page also reads the viewer, the team's states and labels, the
 * Linear project's id, and the first held issues. The held issues come by an
 * `id: { in: }` filter rather than one `issue(id:)` alias each: the schema
 * types `issue(id:)` as `Issue!`, so Linear can answer an id it does not
 * have only with an error, and an error fails the whole query. A filter
 * answers no node.
 */
const firstPageQuery = `
query($team: String!, $project: String!, $held: [ID!]!) {
  viewer { id }
  teams(filter: { key: { eq: $team } }) {
    nodes {
      id
      states(first: 100) { nodes { id name type } }
      labels(first: 250) { nodes { id name } }
      projects(first: 1, filter: { name: { eq: $project } }) { nodes { id } }
    }
  }
  ${HELD_FIELD}
  issues(first: 100, ${PAGE_FILTER}) {
    pageInfo { hasNextPage endCursor }
    nodes { ...issue }
  }
}
fragment issue on Issue { ${ISSUE_FIELDS} }`;

const nextPageQuery = `
query($team: String!, $project: String!, $after: String!) {
  issues(first: 100, after: $after, ${PAGE_FILTER}) {
    pageInfo { hasNextPage endCursor }
    nodes { ...issue }
  }
}
fragment issue on Issue { ${ISSUE_FIELDS} }`;

const lookupQuery = `
query($team: String!, $number: Float!) {
  issues(first: 1, includeArchived: true, filter: { team: { key: { eq: $team } }, number: { eq: $number } }) { nodes { ...issue } }
}
fragment issue on Issue { ${ISSUE_FIELDS} }`;

const currentQuery = `
query($id: String!) {
  issue(id: $id) { state { type } assignee { id } labels(first: 50) { nodes { name } } }
}`;

const commentsQuery = `
query($id: String!) {
  issue(id: $id) { comments(first: 250) { nodes { body createdAt user { name } } } }
}`;

const updateMutation = `
mutation($id: String!, $input: IssueUpdateInput!) {
  result: issueUpdate(id: $id, input: $input) { success }
}`;

const createMutation = `
mutation($input: IssueCreateInput!) {
  result: issueCreate(input: $input) { success issue { identifier } }
}`;

const labelCreateMutation = `
mutation($input: IssueLabelCreateInput!) {
  result: issueLabelCreate(input: $input) { success issueLabel { id } }
}`;

const commentMutation = `
mutation($input: CommentCreateInput!) {
  result: commentCreate(input: $input) { success }
}`;

const Id = S.Struct({ id: S.String });
const StateType = S.Struct({ type: S.String });

const WorkflowState = S.Struct({ id: S.String, name: S.String, type: S.String });
export type WorkflowState = typeof WorkflowState.Type;

const IssueNode = S.Struct({
  id: S.String,
  identifier: S.String,
  title: S.String,
  description: S.NullOr(S.String),
  priority: S.Finite,
  createdAt: S.String,
  updatedAt: S.String,
  state: StateType,
  assignee: S.NullOr(Id),
  project: S.NullOr(Id),
  parent: S.NullOr(S.Struct({ identifier: S.String, project: S.NullOr(Id) })),
  children: S.Struct({ nodes: S.Array(Id) }),
  labels: S.Struct({ nodes: S.Array(S.Struct({ name: S.String })) }),
  inverseRelations: S.Struct({
    nodes: S.Array(
      S.Struct({
        type: S.String,
        issue: S.Struct({ identifier: S.String, state: StateType, project: S.NullOr(Id) }),
      }),
    ),
  }),
  comments: S.Struct({ nodes: S.Array(S.Struct({ createdAt: S.String })) }),
});
export type IssueNode = typeof IssueNode.Type;

const Page = S.Struct({
  pageInfo: S.Struct({ hasNextPage: S.Boolean, endCursor: S.NullOr(S.String) }),
  nodes: S.Array(IssueNode),
});

const FirstPage = S.Struct({
  viewer: Id,
  teams: S.Struct({
    nodes: S.Array(
      S.Struct({
        id: S.String,
        states: S.Struct({ nodes: S.Array(WorkflowState) }),
        labels: S.Struct({ nodes: S.Array(S.Struct({ id: S.String, name: S.String })) }),
        projects: S.Struct({ nodes: S.Array(Id) }),
      }),
    ),
  }),
  held: S.Struct({ nodes: S.Array(IssueNode) }),
  issues: Page,
});

const NextPage = S.Struct({ issues: Page });

const HeldData = S.Struct({ held: S.Struct({ nodes: S.Array(IssueNode) }) });

const LookupData = S.Struct({ issues: S.Struct({ nodes: S.Array(IssueNode) }) });

const CurrentIssue = S.Struct({
  state: StateType,
  assignee: S.NullOr(Id),
  labels: S.Struct({ nodes: S.Array(S.Struct({ name: S.String })) }),
});
type CurrentIssue = typeof CurrentIssue.Type;

const CurrentData = S.Struct({ issue: CurrentIssue });

const CommentsData = S.Struct({
  issue: S.Struct({
    comments: S.Struct({
      nodes: S.Array(
        S.Struct({
          body: S.String,
          createdAt: S.String,
          user: S.NullOr(S.Struct({ name: S.String })),
        }),
      ),
    }),
  }),
});

const Mutated = S.Struct({
  result: S.Struct({
    success: S.Boolean,
    issue: S.optional(S.NullOr(S.Struct({ identifier: S.String }))),
    issueLabel: S.optional(S.NullOr(Id)),
  }),
});

interface Snapshot {
  readonly teamId: string;
  readonly projectId: string;
  readonly viewer: string;
  readonly states: ReadonlyArray<WorkflowState>;
  readonly labels: ReadonlyMap<string, string>;
  readonly issues: ReadonlyMap<string, IssueNode>;
  readonly rate: LinearRate | undefined;
  /** How many refreshes in a row kept this snapshot because a budget was low. */
  readonly skipped: number;
}

/** A project's read for this reading: the snapshot, or the failure every read repeats until the next refresh. */
type Read = Exit.Exit<Snapshot, TrackerError>;

/**
 * Fails unless Linear knows the team by its key, the Linear project by its
 * name in that team, and the team has a state of every type foreman moves
 * issues to. `foreman policy tracker linear` runs it before it writes the
 * place, because the dispatcher has no person to ask when a name is wrong.
 */
export const checkPlace = (place: LinearPlace): Effect.Effect<void, TrackerError, Linear> =>
  Effect.gen(function* () {
    const linear = yield* Linear;
    const command = `check ${place.team} ${place.project}`;
    const { data } = yield* linear
      .graphql(checkQuery, { ...place })
      .pipe(Effect.mapError((error) => new TrackerError({ command, detail: error.detail })));
    const found = yield* decode(CheckData, command)(data);
    yield* placed(place, command, found.teams.nodes[0]);
  });

/**
 * The team and the Linear project's id, or the reason foreman cannot work
 * there: no such team, no such project in it, or no state of a type in
 * `MOVED_TO`.
 */
const placed = <T extends TeamPlace>(place: LinearPlace, command: string, team: T | undefined) =>
  Effect.gen(function* () {
    if (team === undefined)
      return yield* new TrackerError({ command, detail: `Linear has no team ${place.team}` });
    const project = team.projects.nodes[0];
    if (project === undefined)
      return yield* new TrackerError({
        command,
        detail: `team ${place.team} has no Linear project ${place.project}`,
      });
    const missing = MOVED_TO.filter(
      (type) => !team.states.nodes.some((state) => state.type === type),
    );
    if (missing.length > 0)
      return yield* new TrackerError({
        command,
        detail: `team ${place.team} has no workflow state of type ${missing.join(", ")}`,
      });
    return { team, projectId: project.id };
  });

interface TeamPlace {
  readonly states: { readonly nodes: ReadonlyArray<{ readonly type: string }> };
  readonly projects: { readonly nodes: ReadonlyArray<{ readonly id: string }> };
}

const checkQuery = `
query($team: String!, $project: String!) {
  teams(filter: { key: { eq: $team } }) {
    nodes {
      states(first: 100) { nodes { type } }
      projects(first: 1, filter: { name: { eq: $project } }) { nodes { id } }
    }
  }
}`;

const CheckData = S.Struct({
  teams: S.Struct({
    nodes: S.Array(
      S.Struct({
        states: S.Struct({ nodes: S.Array(StateType) }),
        projects: S.Struct({ nodes: S.Array(Id) }),
      }),
    ),
  }),
});
