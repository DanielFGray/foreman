import { Clock, Effect, Exit, Option, Ref, Schedule, Schema as S } from "effect";
import type { Dependency, Item, ListFilter, Status } from "tasks";
import type { Fleet } from "./fleet.ts";
import { Github, GithubError } from "./github.ts";
import { openCheckouts, projectSet } from "./projects.ts";
import type { Repository } from "./repository.ts";
import { Tracker, TrackerError } from "./tracker.ts";

/**
 * GitHub issues as foreman's tasks, over `gh` (docs/issue-trackers.md,
 * sections 1 and 5).
 *
 * An issue's id is `<project>#<number>`. Status is the issue's state plus one
 * `status:*` label; priority is a `priority:*` label.
 *
 * Reads come from one snapshot per project: one GraphQL query for the open
 * issues, plus each closed issue a `lookup` found, by number. `refresh` reads
 * it anew, and the dispatcher calls it once at the start of each reading, so a
 * tick pays one query per project per reading. A write drops the snapshot of
 * its project, so the next read sees the write. A failed read is kept until
 * the next refresh too, so two reads in one reading cannot disagree about
 * whether the project answered.
 *
 * Below a tenth of the GraphQL allowance left, `refresh` reads only on every
 * fifth call until the allowance resets, and keeps the last snapshot between.
 */
export const githubTracker = (
  repoOf: (project: string) => Effect.Effect<string, TrackerError>,
): Effect.Effect<Tracker["Service"], never, Github> =>
  Effect.gen(function* () {
    const github = yield* Github;
    const snapshots = yield* Ref.make(new Map<string, Read>());
    // Closed issues a `lookup` found. Each snapshot asks for them by number,
    // because the open-issue list leaves out an issue closed on GitHub while
    // foreman still holds a run on it.
    const closed = yield* Ref.make(new Map<string, ReadonlySet<number>>());
    const viewer = yield* Ref.make<string | undefined>(undefined);
    const ensured = yield* Ref.make(new Set<string>());

    const fail = (command: string) => (error: GithubError | TrackerError) =>
      new TrackerError({ command, detail: error.detail });

    const fetch = (project: string): Effect.Effect<Snapshot, TrackerError> =>
      Effect.gen(function* () {
        const repo = yield* repoOf(project);
        const [owner = "", name = ""] = repo.split("/");
        const extra = [...((yield* Ref.get(closed)).get(project) ?? [])];
        const issues: Array<IssueNode> = [];
        let after: string | undefined;
        let rate: RateLimit | undefined;
        do {
          const data = yield* github.graphql(snapshotQuery(after === undefined ? extra : []), {
            owner,
            name,
            ...(after === undefined ? {} : { after }),
          });
          const page = yield* decode(SnapshotData, `read ${project}`)(data);
          if (page.repository === null) {
            return yield* new TrackerError({
              command: `read ${project}`,
              detail: `no repository ${repo}`,
            });
          }
          // `issues` is the open list; every other key is a closed issue asked for by number.
          const { issues: list, ...aliases } = page.repository;
          const open = yield* decode(OpenIssues, `read ${project}`)(list);
          const asked = yield* decode(
            S.Array(S.NullOr(IssueNode)),
            `read ${project}`,
          )(Object.values(aliases));
          issues.push(...open.nodes, ...asked.filter((node) => node !== null));
          after = open.pageInfo.hasNextPage ? (open.pageInfo.endCursor ?? undefined) : undefined;
          rate = page.rateLimit;
        } while (after !== undefined);
        return {
          repo,
          issues: new Map(issues.map((issue) => [issue.number, issue])),
          rate,
          skipped: 0,
        };
      }).pipe(Effect.mapError(fail(`read ${project}`)));

    /** The project's snapshot: the one this reading holds, else a new read. */
    const snapshot = (project: string) =>
      Effect.gen(function* () {
        const held = (yield* Ref.get(snapshots)).get(project);
        if (held !== undefined) return yield* held;
        return yield* load(project);
      });

    const load = (project: string, skipped = 0) =>
      fetch(project).pipe(
        Effect.map((read) => ({ ...read, skipped })),
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
        const held = (yield* Ref.get(snapshots)).get(project);
        const now = yield* Clock.currentTimeMillis;
        if (held !== undefined && held._tag === "Success") {
          const { rate, skipped } = held.value;
          if (rate !== undefined && starved(rate, now) && skipped < 4) {
            yield* Ref.update(snapshots, (all) =>
              new Map(all).set(project, Exit.succeed({ ...held.value, skipped: skipped + 1 })),
            );
            return;
          }
        }
        yield* load(project);
      }).pipe(Effect.asVoid);

    const items = (project: string) =>
      snapshot(project).pipe(
        Effect.map(({ repo, issues }) =>
          [...issues.values()].map((issue) => itemOf(project, repo, issue)),
        ),
      );

    const issueOf = (task: string) => {
      const parsed = parseId(task);
      return parsed === undefined
        ? Effect.fail(new TrackerError({ command: task, detail: "not a GitHub issue id" }))
        : Effect.succeed(parsed);
    };

    /**
     * The issue as REST reads it now, through the ETag cache: what a status
     * move checks before it writes, and what claim confirmation re-reads.
     */
    const current = (repo: string, number: number) =>
      github
        .get(`repos/${repo}/issues/${number}`)
        .pipe(Effect.flatMap(decode(RestIssue, `issue ${number}`)));

    const me = Effect.gen(function* () {
      const known = yield* Ref.get(viewer);
      if (known !== undefined) return known;
      const user = yield* github
        .get("user")
        .pipe(Effect.flatMap(decode(S.Struct({ login: S.String }), "user")));
      yield* Ref.set(viewer, user.login);
      return user.login;
    });

    /** Makes the label in the repo once per process; `--force` makes it safe to repeat. */
    const ensureLabel = (repo: string, label: string) =>
      Effect.gen(function* () {
        const key = `${repo} ${label}`;
        if ((yield* Ref.get(ensured)).has(key)) return;
        yield* github.run(["label", "create", label, "-R", repo, "--force"]);
        yield* Ref.update(ensured, (all) => new Set(all).add(key));
      });

    /**
     * Runs one write on an issue: resolves the repo, runs `write`, and drops
     * the project's snapshot whether or not the write finished, because a write
     * that failed half way may still have changed the issue.
     */
    const writing =
      (command: string) =>
      <A>(
        task: string,
        write: (repo: string, number: number) => Effect.Effect<A, GithubError | TrackerError>,
      ) =>
        Effect.gen(function* () {
          const { project, number } = yield* issueOf(task);
          const repo = yield* repoOf(project);
          return yield* write(repo, number).pipe(Effect.ensuring(forget(project)));
        }).pipe(Effect.mapError(fail(`${command} ${task}`)));

    const statusLabels = (labels: ReadonlyArray<{ readonly name: string }>) =>
      labels.map((label) => label.name).filter((name) => name.startsWith(STATUS_PREFIX));

    const lookup = (task: string): Effect.Effect<Option.Option<Item>, TrackerError> =>
      Effect.gen(function* () {
        const { project, number } = yield* issueOf(task);
        const read = yield* snapshot(project);
        const held = read.issues.get(number);
        if (held !== undefined) return Option.some(itemOf(project, read.repo, held));
        const [owner = "", name = ""] = read.repo.split("/");
        const data = yield* github.graphql(singleQuery, { owner, name, number });
        const single = yield* decode(SingleData, `show ${task}`)(data);
        const issue = single.repository?.issue;
        if (issue === null || issue === undefined) return Option.none();
        yield* Ref.update(closed, (all) =>
          new Map(all).set(project, new Set([...(all.get(project) ?? []), number])),
        );
        return Option.some(itemOf(project, read.repo, issue));
      }).pipe(Effect.mapError(fail(`show ${task}`)));

    const claim = (task: string) =>
      writing("claim")(task, (repo, number) =>
        Effect.gen(function* () {
          const login = yield* me;
          const claimed = (issue: RestIssue) =>
            issue.state === "open" &&
            issue.labels.some((label) => label.name === IN_PROGRESS) &&
            issue.assignees.some((assignee) => assignee.login === login);
          const before = yield* current(repo, number);
          if (claimed(before)) return;
          if (before.state === "closed")
            yield* github.run(["issue", "reopen", `${number}`, "-R", repo]);
          yield* ensureLabel(repo, IN_PROGRESS);
          const stale = statusLabels(before.labels).filter((name) => name !== IN_PROGRESS);
          yield* github.run([
            "issue",
            "edit",
            `${number}`,
            "-R",
            repo,
            "--add-label",
            IN_PROGRESS,
            "--add-assignee",
            "@me",
            ...(stale.length === 0 ? [] : ["--remove-label", stale.join(",")]),
          ]);
          yield* confirm(current(repo, number), claimed, `claim ${task}`);
        }),
      );

    const reopen = (task: string) =>
      writing("reopen")(task, (repo, number) =>
        Effect.gen(function* () {
          const login = yield* me;
          const before = yield* current(repo, number);
          const stale = statusLabels(before.labels);
          const mine = before.assignees.some((assignee) => assignee.login === login);
          if (before.state === "closed")
            yield* github.run(["issue", "reopen", `${number}`, "-R", repo]);
          if (stale.length === 0 && !mine) return;
          yield* github.run([
            "issue",
            "edit",
            `${number}`,
            "-R",
            repo,
            ...(stale.length === 0 ? [] : ["--remove-label", stale.join(",")]),
            ...(mine ? ["--remove-assignee", "@me"] : []),
          ]);
        }),
      );

    /**
     * Closes the issue with GitHub's `reason` (`completed` for done, `not
     * planned` for canceled) and drops its status labels.
     */
    const close = (event: string, reason: "completed" | "not planned") => (task: string) =>
      writing(event)(task, (repo, number) =>
        Effect.gen(function* () {
          const before = yield* current(repo, number);
          if (before.state !== "closed") {
            yield* github.run(["issue", "close", `${number}`, "-R", repo, "--reason", reason]);
          }
          const stale = statusLabels(before.labels);
          if (stale.length > 0) {
            yield* github.run([
              "issue",
              "edit",
              `${number}`,
              "-R",
              repo,
              "--remove-label",
              stale.join(","),
            ]);
          }
        }),
      );

    return Tracker.of({
      refresh: (project) => refresh(project).pipe(Effect.mapError(fail(`read ${project}`))),
      lookup,
      list: (filter) =>
        filter.project === undefined && filter.parent === undefined
          ? Effect.fail(
              new TrackerError({ command: "list", detail: "a GitHub list needs a project" }),
            )
          : items(filter.project ?? parseId(filter.parent ?? "")?.project ?? "").pipe(
              Effect.map((all) => all.filter(matches(filter))),
            ),
      dependencies: (project) =>
        snapshot(project).pipe(
          Effect.map(({ repo, issues }) =>
            [...issues.values()].flatMap((issue) =>
              issue.blockedBy.nodes.map((blocker): Dependency => ({
                item: `${project}#${issue.number}`,
                dependsOn:
                  blocker.repository.nameWithOwner === repo
                    ? `${project}#${blocker.number}`
                    : `${blocker.repository.nameWithOwner}#${blocker.number}`,
              })),
            ),
          ),
        ),
      ready: (project) =>
        project === undefined
          ? Effect.fail(
              new TrackerError({ command: "ready", detail: "a GitHub read needs a project" }),
            )
          : items(project).pipe(
              Effect.map((all) =>
                all.filter((item) => item.status === "open" && item.type === "task"),
              ),
            ),
      url: (task) =>
        Effect.gen(function* () {
          const { project, number } = yield* issueOf(task);
          const { repo } = yield* snapshot(project);
          return Option.some(`https://github.com/${repo}/issues/${number}`);
        }),
      logs: (task) =>
        Effect.gen(function* () {
          const { project, number } = yield* issueOf(task);
          const repo = yield* repoOf(project);
          const out = yield* github.run([
            "issue",
            "view",
            `${number}`,
            "-R",
            repo,
            "--json",
            "comments",
          ]);
          const { comments } = yield* decode(S.fromJsonString(Comments), `log of ${task}`)(out);
          return comments.map((comment) => ({
            message: `${comment.author?.login ?? "ghost"}: ${comment.body}`,
            createdAt: new Date(comment.createdAt),
          }));
        }).pipe(Effect.mapError(fail(`log of ${task}`))),
      add: (task) =>
        Effect.gen(function* () {
          const repo = yield* repoOf(task.project);
          yield* Effect.forEach(task.labels, (label) => ensureLabel(repo, label));
          const out = yield* github
            .run(
              [
                "issue",
                "create",
                "-R",
                repo,
                "--title",
                task.title,
                "--body-file",
                "-",
                ...task.labels.flatMap((label) => ["--label", label]),
              ],
              { input: task.description },
            )
            .pipe(Effect.ensuring(forget(task.project)));
          const number = /\/issues\/(\d+)\s*$/.exec(out.trim())?.[1];
          if (number === undefined) {
            return yield* new TrackerError({
              command: `add ${task.title}`,
              detail: `no issue URL in: ${out}`,
            });
          }
          return `${task.project}#${number}`;
        }).pipe(Effect.mapError(fail(`add ${task.title}`))),
      claim,
      reopen,
      complete: close("complete", "completed"),
      cancel: close("cancel", "not planned"),
      label: (task, label) =>
        writing("label")(task, (repo, number) =>
          ensureLabel(repo, label).pipe(
            Effect.andThen(
              github.run(["issue", "edit", `${number}`, "-R", repo, "--add-label", label]),
            ),
            Effect.asVoid,
          ),
        ),
      unlabel: (task, label) =>
        writing("unlabel")(task, (repo, number) =>
          github
            .run(["issue", "edit", `${number}`, "-R", repo, "--remove-label", label])
            .pipe(Effect.asVoid),
        ),
      relabel: (task, change) =>
        writing("relabel")(task, (repo, number) =>
          Effect.gen(function* () {
            const names = (yield* current(repo, number)).labels.map((label) => label.name);
            const before = names.filter((name) => !reserved(name));
            const after = change(before);
            yield* Effect.forEach(after, (label) => ensureLabel(repo, label));
            yield* github.run(
              ["api", "-X", "PUT", `repos/${repo}/issues/${number}/labels`, "--input", "-"],
              {
                input: JSON.stringify({ labels: [...names.filter(reserved), ...after] }),
              },
            );
            return before;
          }),
        ),
      log: (task, message) =>
        writing("log")(task, (repo, number) =>
          github
            .run(["issue", "comment", `${number}`, "-R", repo, "--body-file", "-"], {
              input: message,
            })
            .pipe(Effect.asVoid),
        ),
    });
  });

/**
 * Re-reads each second until `shows` holds of the read, because GitHub's
 * reads can lag its writes, and a claim the next read does not show would let
 * a second dispatch start a second worker. Gives up after 30 seconds.
 */
export const confirm = <A, E>(
  read: Effect.Effect<A, E>,
  shows: (value: A) => boolean,
  command: string,
) =>
  read.pipe(
    Effect.repeat({ until: shows, schedule: Schedule.spaced("1 second") }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(new TrackerError({ command, detail: "the claim did not show in 30 seconds" })),
    }),
    Effect.asVoid,
  );

const STATUS_PREFIX = "status:";
const PRIORITY_PREFIX = "priority:";
const IN_PROGRESS = "status:in_progress";

/** Labels that carry status and priority, which `Item.labels` leaves out. */
const reserved = (name: string) =>
  name.startsWith(STATUS_PREFIX) || name.startsWith(PRIORITY_PREFIX);

/** Decodes `input`, naming `command` in the failure. */
const decode =
  <A, I>(schema: S.Codec<A, I>, command: string) =>
  (input: unknown) =>
    S.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => new TrackerError({ command, detail: String(error) })),
    );

/** `<project>#<number>` split, or `undefined` for any other id. */
export const parseId = (
  id: string,
): { readonly project: string; readonly number: number } | undefined => {
  const match = /^(.+)#(\d+)$/.exec(id);
  return match ? { project: match[1]!, number: Number(match[2]) } : undefined;
};

/** Below this share of the GraphQL allowance, `refresh` reads every fifth call. */
const starved = (rate: RateLimit, now: number) =>
  rate.remaining < rate.limit / 10 && now < new Date(rate.resetAt).getTime();

const matches =
  (filter: ListFilter) =>
  (item: Item): boolean =>
    (filter.status === undefined || item.status === filter.status) &&
    (filter.type === undefined || item.type === filter.type) &&
    (filter.parent === undefined || item.parent === filter.parent) &&
    (filter.labels ?? []).every((label) => item.labels.includes(label));

/** The issue as foreman's `Item` (docs/issue-trackers.md, "The issue as an `Item`"). */
export const itemOf = (project: string, repo: string, issue: IssueNode): Item => {
  const labels = issue.labels.nodes.map((label) => label.name);
  const { description, definitionOfDone } = splitBody(issue.body);
  const priority = labels.flatMap((name) => {
    const value = /^priority:([123])$/.exec(name)?.[1];
    return value === undefined ? [] : [Number(value)];
  })[0];
  const updatedAt = new Date(issue.updatedAt);
  const lastComment = issue.comments.nodes[0]?.createdAt;
  return {
    id: `${project}#${issue.number}`,
    project,
    type: issue.subIssuesSummary.total > 0 || issue.issueType?.name === "Epic" ? "epic" : "task",
    title: issue.title,
    description,
    definitionOfDone,
    status: statusOf(issue, labels),
    priority: priority ?? 2,
    parent:
      issue.parent && issue.parent.repository.nameWithOwner === repo
        ? `${project}#${issue.parent.number}`
        : undefined,
    labels: labels.filter((name) => !reserved(name)),
    createdAt: new Date(issue.createdAt),
    updatedAt,
    lastActivityAt:
      lastComment !== undefined && new Date(lastComment) > updatedAt
        ? new Date(lastComment)
        : updatedAt,
  };
};

/**
 * An open issue's status is its `status:*` label. With no such label, an
 * assignee is a claim a person made, which reads as `in_progress` and is its
 * owner's, because foreman holds no author run on it.
 */
const statusOf = (issue: IssueNode, labels: ReadonlyArray<string>): Status => {
  if (issue.state === "CLOSED") return issue.stateReason === "COMPLETED" ? "done" : "canceled";
  const label = labels.find((name) => name.startsWith(STATUS_PREFIX))?.slice(STATUS_PREFIX.length);
  if (label === "proposed" || label === "draft" || label === "in_progress") return label;
  if (issue.assignees.nodes.length > 0) return "in_progress";
  if (issue.blockedBy.nodes.some((blocker) => blocker.state === "OPEN")) return "blocked";
  return "open";
};

/** The body less its `## Definition of done` section, and that section. */
export const splitBody = (
  body: string,
): { readonly description: string; readonly definitionOfDone: string | undefined } => {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+definition of done\s*$/i.test(line));
  if (start === -1) return { description: body.trim(), definitionOfDone: undefined };
  const after = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const end = after === -1 ? lines.length : after;
  return {
    description: [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim(),
    definitionOfDone: lines
      .slice(start + 1, end)
      .join("\n")
      .trim(),
  };
};

const ISSUE_FIELDS = `
  number title body state stateReason createdAt updatedAt
  labels(first: 50) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  parent { number repository { nameWithOwner } }
  subIssuesSummary { total }
  issueType { name }
  blockedBy(first: 20) { nodes { number state repository { nameWithOwner } } }
  comments(last: 1) { nodes { createdAt } }`;

/** The project's read: open issues by page, and on the first page the closed issues asked for by number. */
const snapshotQuery = (numbers: ReadonlyArray<number>) => `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ...issue }
    }
    ${numbers.map((number) => `n${number}: issue(number: ${number}) { ...issue }`).join("\n    ")}
  }
  rateLimit { remaining limit resetAt }
}
fragment issue on Issue { ${ISSUE_FIELDS} }`;

const singleQuery = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } }
}`;

const Repo = S.Struct({ nameWithOwner: S.String });

const IssueNode = S.Struct({
  number: S.Finite,
  title: S.String,
  body: S.String,
  state: S.String,
  stateReason: S.NullOr(S.String),
  createdAt: S.String,
  updatedAt: S.String,
  labels: S.Struct({ nodes: S.Array(S.Struct({ name: S.String })) }),
  assignees: S.Struct({ nodes: S.Array(S.Struct({ login: S.String })) }),
  parent: S.NullOr(S.Struct({ number: S.Finite, repository: Repo })),
  subIssuesSummary: S.Struct({ total: S.Finite }),
  issueType: S.NullOr(S.Struct({ name: S.String })),
  blockedBy: S.Struct({
    nodes: S.Array(S.Struct({ number: S.Finite, state: S.String, repository: Repo })),
  }),
  comments: S.Struct({ nodes: S.Array(S.Struct({ createdAt: S.String })) }),
});
export type IssueNode = typeof IssueNode.Type;

const RateLimit = S.Struct({ remaining: S.Finite, limit: S.Finite, resetAt: S.String });
type RateLimit = typeof RateLimit.Type;

const OpenIssues = S.Struct({
  pageInfo: S.Struct({ hasNextPage: S.Boolean, endCursor: S.NullOr(S.String) }),
  nodes: S.Array(IssueNode),
});

const SnapshotData = S.Struct({
  repository: S.NullOr(S.Record(S.String, S.Unknown)),
  rateLimit: S.optional(RateLimit),
});

const SingleData = S.Struct({
  repository: S.NullOr(S.Struct({ issue: S.NullOr(IssueNode) })),
});

const RestIssue = S.Struct({
  state: S.String,
  labels: S.Array(S.Struct({ name: S.String })),
  assignees: S.Array(S.Struct({ login: S.String })),
});
type RestIssue = typeof RestIssue.Type;

const Comments = S.Struct({
  comments: S.Array(
    S.Struct({
      author: S.NullOr(S.Struct({ login: S.String })),
      body: S.String,
      createdAt: S.String,
    }),
  ),
});

interface Snapshot {
  readonly repo: string;
  readonly issues: ReadonlyMap<number, IssueNode>;
  readonly rate: RateLimit | undefined;
  /** How many refreshes in a row kept this snapshot because the allowance was low. */
  readonly skipped: number;
}

/** A project's read for this reading: the snapshot, or the failure every read repeats until the next refresh. */
type Read = Exit.Exit<Snapshot, TrackerError>;

/**
 * A project's GitHub repo, `OWNER/NAME`, read with `gh repo view` in its
 * checkout, so the repo is never stored. The checkout is found as the
 * dispatcher finds projects: the open spaces and the checkouts running
 * workers belong to. Each checkout's repo is read once per process.
 */
export const checkoutRepo = (fleet: Fleet["Service"], repository: Repository["Service"]) =>
  Effect.gen(function* () {
    const github = yield* Github;
    const known = yield* Ref.make(new Map<string, string>());
    return (project: string): Effect.Effect<string, TrackerError> =>
      Effect.gen(function* () {
        const open = yield* openCheckouts(fleet, repository);
        const running = (yield* fleet.roster).flatMap((worker) =>
          worker.repository === undefined ? [] : [worker.repository],
        );
        const directory = projectSet(open, running).projects.find(
          (candidate) => candidate.name === project,
        )?.directory;
        if (directory === undefined) {
          return yield* new TrackerError({
            command: `repo of ${project}`,
            detail: "no open space or running worker is in a checkout of that name",
          });
        }
        const cached = (yield* Ref.get(known)).get(directory);
        if (cached !== undefined) return cached;
        const repo = (yield* github.run(
          ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
          {
            cwd: directory,
          },
        )).trim();
        yield* Ref.update(known, (all) => new Map(all).set(directory, repo));
        return repo;
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "TrackerError"
            ? error
            : new TrackerError({ command: `repo of ${project}`, detail: error.message }),
        ),
      );
  });
