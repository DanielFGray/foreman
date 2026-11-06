// Pure rules the Foreman pane reads the published file and the world by. This
// module uses no herdr-app globals, so `bun test` runs it.

// A reading older than this is stale: its host is gone or it is wedged inside
// a tick, and the pane says so rather than showing it as live.
export const STALE_MS = 120000;

// A step cycles through its modes: on runs it, ask waits for one approval per
// task, off does nothing.
export const NEXT_MODE = { on: "ask", ask: "off", off: "on" };

// A row's key is a task id, a workspace label that holds one (`foreman/<id>`),
// or a project or account name, which has no task to show. A local task id is
// `ts-` or `ep-` and six hex digits; an issue id is `<project>#<number>` on
// GitHub and `<project>#<TEAM-number>` on Linear.
export const TASK_ID = /\b(?:ts|ep)-[0-9a-f]{6}\b|[\w.-]+#(?:[A-Za-z][A-Za-z0-9]*-)?\d+\b/;

const WAITING = { checks: "waits for its checks", you: "waits for your approval", github: "waits for a merge on GitHub" };

// What the dispatcher is doing, as the file names it: running, paused, idle
// (no step on and no grant) or failed (its host is starting it again). A file
// a one-shot `foreman status` wrote names no dispatcher, and a reading older
// than STALE_MS is stale. `age` is in milliseconds, or null with no reading.
export const dispatcherState = (published, now) => {
  const age = published?.observedAt ? now - Date.parse(published.observedAt) : null;
  const dispatcher = published?.dispatcher;
  const state = !published ? "offline"
    : !dispatcher ? "no dispatcher"
    : dispatcher.state === "failed" ? "failed"
    : age === null || age >= STALE_MS ? "stale"
    : dispatcher.state;
  return { state, age };
};

// The project of a folder, by the rule foreman uses: the folder name of the
// main checkout, from git's absolute common dir (`<checkout>/.git`), so a
// worktree reads as its project. Null for a folder in no checkout.
export const projectOfCommonDir = (common) => {
  const checkout = common.slice(0, common.lastIndexOf("/"));
  return checkout ? checkout.slice(checkout.lastIndexOf("/") + 1) : null;
};

// The keys in Landed now that were not in it at the last reading. The first
// reading (`before` null) answers none, so opening the pane replays no history.
export const newlyLanded = (before, landedKeys) =>
  before === null ? [] : landedKeys.filter((key) => !before.has(key));

// A task's pull request as one line: its number, state, checks and what the merge waits for.
export const pullRequestLine = (pr) =>
  [`PR #${pr.number} ${pr.state}`, pr.checks ? `checks ${pr.checks}` : null, pr.waiting ? WAITING[pr.waiting] : null, pr.url]
    .filter(Boolean).join(" · ");

// What a refused foreman command said, on stderr, as the one line the pane has
// for a problem: the error's message without the log prefix or the stack under
// it, and a listed reason after its heading rather than on a line of its own.
export const refusalOf = (result) => {
  const message = result.stderr.split("\n    at ")[0].replace(/^.*?Error: /s, "");
  const [heading = "", ...reasons] = message.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return [heading, reasons.join("; ")].filter((part) => part !== "").join(" ") || `foreman exited ${result.code}`;
};

// The published rows the pane shows while `project` is the shown space's. A row
// with no project is attention for the whole fleet (accounts, and work whose
// project has no open space), so every pane shows it.
export const rowsShownIn = (rows, project) => rows.filter((row) => row.project === null || row.project === project);

// Whether a batch from herdr's watchFolder on `folder` may hold a change to
// `file`. herdr bounds the paths it keeps between reads: a batch that names the
// watched folder itself stands for any change under it, so busy siblings (the
// worktrees and the log beside state.json) cannot hide a publish.
export const touches = (changed, folder, file) => changed.includes(file) || changed.includes(folder);
