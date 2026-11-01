/**
 * The fleet as other programs read it: one projection of a reading, printed by
 * `foreman status --json` and written by the daemon to `state.json` after
 * every pass.
 *
 * A view, not a memory. Nothing in foreman reads the file back, so a restart
 * loses nothing by overwriting it, and a reader that finds it stale is told so
 * by `observedAt`. The herdr-app panel is the reader it is shaped for: plain
 * JavaScript that cannot share these types, which is why the shape carries a
 * `version` and is encoded through a schema rather than whatever
 * `JSON.stringify` makes of the state.
 */
import { DateTime, Effect, FileSystem, Path, Schema as S } from "effect";
import type { FleetState } from "./dispatcher.ts";
import { Policy } from "./policy.ts";
import { actionsFor, rowsForView, VIEWS, type Action } from "./view.ts";

/**
 * Bumped whenever a field a reader relies on changes meaning or goes away.
 * Two readers check it: the herdr-app panel (`herdr/foreman/main.js`) and
 * herdr-web's Foreman page (`src/shared/Foreman.ts` there).
 */
export const PUBLISHED_VERSION = 2;

export const PublishedRow = S.Struct({
  view: S.Literals(VIEWS),
  key: S.String,
  label: S.String,
  detail: S.NullOr(S.String),
  project: S.NullOr(S.String),
  /** The epic the row's task sits under, so a reader can group a queue by it. */
  parent: S.NullOr(S.String),
  /** Whether the row is an epic, which takes no launch: an epic has no branch and no worker. */
  epic: S.Boolean,
  /** The one-shot subcommands this row takes: `foreman <action> <key>`. */
  actions: S.Array(S.String),
});
export type PublishedRow = typeof PublishedRow.Type;

export const Published = S.Struct({
  version: S.Literal(PUBLISHED_VERSION),
  /** Whether a daemon wrote this, rather than a one-shot `status` read. */
  daemon: S.Boolean,
  /** The policy the reading decided from; `foreman policy` changes it. */
  policy: Policy,
  /** Why the policy file could not be read, which pauses the fleet. */
  policyError: S.NullOr(S.String),
  /** ISO instant of the reading, or null before the first one completes. */
  observedAt: S.NullOr(S.String),
  /** The managed projects and their checkouts, so a reader can tell which one a folder is in. */
  projects: S.Array(S.Struct({ name: S.String, directory: S.String })),
  rows: S.Array(PublishedRow),
});
export type Published = typeof Published.Type;

/** Every row of every view, with the commands each takes. */
export const publishedOf = (state: FleetState, daemon: boolean): Published => ({
  version: PUBLISHED_VERSION,
  daemon,
  policy: state.policy,
  policyError: state.policyError ?? null,
  observedAt: state.observedAt === undefined ? null : DateTime.formatIso(state.observedAt),
  projects: state.projects.map(({ name, directory }) => ({ name, directory })),
  rows: VIEWS.flatMap((view) =>
    rowsForView(view, state).map((row) => ({
      view,
      key: row.key,
      label: row.label,
      detail: row.detail ?? null,
      project: row.project ?? row.task?.project ?? row.ready?.project ?? null,
      parent: row.task?.parent ?? row.ready?.parent ?? null,
      epic: row.task?.type === "epic",
      actions: actionsFor(row.column, row).map(commandName),
    })),
  ),
});

/** An action as a command line writes it: `takeOver` is `take-over`. */
export const commandName = (action: Action): string =>
  action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** Where the daemon publishes, beside its log. */
export const publishedPath = (): string => {
  const stateHome = process.env["XDG_STATE_HOME"] ?? `${process.env["HOME"] ?? ""}/.local/state`;
  return process.env["FOREMAN_STATE"] ?? `${stateHome}/foreman/state.json`;
};

/**
 * Replaces the published file whole.
 *
 * Written to a dot-file in the same folder and renamed over, so a reader never
 * sees half a file: rename is atomic only within one filesystem, and a watcher
 * of the folder is told about the dot-file too, which is why it is hidden.
 */
export const writePublished = (path: string, published: Published) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const text = `${JSON.stringify(yield* S.encodeEffect(Published)(published))}\n`;
    const temporary = paths.join(paths.dirname(path), `.${paths.basename(path)}.tmp`);
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
    yield* fs.writeFileString(temporary, text);
    yield* fs.rename(temporary, path);
  });
