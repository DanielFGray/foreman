import type { Item, LogEntry } from "tasks";

/** One line: id, status, priority, project, then the title behind its labels. */
export const line = (item: Item): string =>
  [
    item.id.padEnd(12),
    item.status.padEnd(12),
    String(item.priority).padEnd(4),
    item.project.padEnd(12),
    [...item.labels.map((label) => `[${label}]`), item.title].join(" "),
  ].join(" ");

export const lines = (items: ReadonlyArray<Item>): string =>
  items.length === 0 ? "No items" : items.map(line).join("\n");

/** The items as a JSON array, in the field names the Go `prog` prints with `--json`. */
export const json = (items: ReadonlyArray<Item>): string =>
  JSON.stringify(items.map(fieldsOf), null, 2);

/**
 * One task as a JSON object: the fields `json` prints, plus what `detail`
 * shows (dependencies both ways and the log) and the ids of an epic's
 * children, so a script reads any part with `jq` instead of parsing text.
 */
export const detailJson = (
  item: Item,
  dependencies: ReadonlyArray<string>,
  dependents: ReadonlyArray<string>,
  children: ReadonlyArray<Item>,
  logs: ReadonlyArray<LogEntry>,
): string =>
  JSON.stringify(
    {
      ...fieldsOf(item),
      dependencies,
      dependents,
      children: children.map((child) => child.id),
      logs: logs.map((log) => ({ message: log.message, created_at: log.createdAt.toISOString() })),
    },
    null,
    2,
  );

/** What an agent needs to start or judge a task. */
export const detail = (
  item: Item,
  dependencies: ReadonlyArray<string>,
  dependents: ReadonlyArray<string>,
  logs: ReadonlyArray<LogEntry>,
): string => {
  const section = (title: string, body: ReadonlyArray<string>) =>
    body.length === 0 ? [] : ["", `${title}:`, ...body];
  return [
    `ID:          ${item.id}`,
    `Type:        ${item.type}`,
    `Project:     ${item.project}`,
    `Title:       ${item.title}`,
    `Status:      ${item.status}`,
    `Priority:    ${item.priority}`,
    ...(item.parent === undefined ? [] : [`Parent:      ${item.parent}`]),
    ...(item.labels.length === 0 ? [] : [`Labels:      ${item.labels.join(", ")}`]),
    ...section("Description", item.description === "" ? [] : [item.description]),
    ...section(
      "Definition of Done",
      item.definitionOfDone === undefined || item.definitionOfDone === ""
        ? []
        : [item.definitionOfDone],
    ),
    ...section(
      "Dependencies",
      dependencies.map((id) => `  - ${id}`),
    ),
    ...section(
      "Blocks",
      dependents.map((id) => `  - ${id}`),
    ),
    ...section(
      "Logs",
      logs.map((entry) => `  [${minute(entry.createdAt)}] ${entry.message}`),
    ),
  ].join("\n");
};

const minute = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const fieldsOf = (item: Item) => ({
  id: item.id,
  title: item.title,
  type: item.type,
  status: item.status,
  priority: item.priority,
  project: item.project,
  parent: item.parent ?? null,
  description: item.description,
  definition_of_done: item.definitionOfDone ?? null,
  labels: item.labels,
  created_at: item.createdAt.toISOString(),
  updated_at: item.updatedAt.toISOString(),
  last_activity_at: item.lastActivityAt.toISOString(),
});
