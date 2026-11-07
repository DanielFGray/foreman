// The editor's text settings, and which of them a reading changed. This module
// uses no herdr-app globals, so `bun test` runs it.

// Each text setting: its label, what the empty input says, and the value it
// starts with for a block (`when`, `newRoute`, `newSource`, `exitName` and
// `newExit` always start empty).
export const FIELDS = {
  filter: { label: "filter", placeholder: "empty takes every task", of: (node) => node.filter },
  model: { label: "model", placeholder: "ladder, above, or a rung's name", of: (node) => node.model },
  slots: { label: "slots", placeholder: "how many at once; empty is no limit", of: (node) => node.slots ?? "" },
  command: { label: "command", placeholder: "the command that must pass", of: (node) => node.command },
  onto: { label: "onto", placeholder: "a branch; empty lands on the branch the checkout has out", of: (node) => node.onto ?? "" },
  when: { label: "when", placeholder: "a tasks filter", of: () => "" },
  newRoute: { label: "new route", placeholder: "a tasks filter, then Enter", of: () => "" },
  newSource: { label: "filter", placeholder: "a tasks filter; empty takes every task", of: () => "" },
  exitName: { label: "name", placeholder: "lower-case words and hyphens, then Enter", of: () => "" },
  newExit: { label: "new exit", placeholder: "a name for the agent to end its run with, then Enter", of: () => "" },
  setVar: { label: "var", placeholder: "name=value, then Enter; name= removes it", of: () => "" },
  // The name a MakeComposite selection is saved under.
  compositeName: { label: "name", placeholder: "a name for the new kind, then Enter", of: () => "" },
};

// What each input shows for a block, or for no block.
export const settingsOf = (node) =>
  Object.entries(FIELDS).map(([key, field]) => [key, node === undefined ? "" : String(field.of(node) ?? "")]);

// The inputs a reading refills: each setting of the selected block that the
// reading changed, such as by a discard or a save. The rest may hold text the
// operator has not sent yet, so they keep it.
export const changedSettings = (before, after) => {
  if (after === undefined) return [];
  const was = new Map(settingsOf(before));
  return settingsOf(after).filter(([key, value]) => before === undefined || was.get(key) !== value);
};

// The instructions an agent block reads, as foreman's `instructionsOf` names
// them: its own `instructions`, else its role. Nothing for another kind of block.
export const instructionsOf = (node) =>
  node?.kind === "agent" ? node.instructions ?? node.role : undefined;

// An agent's vars after the operator typed `name=value` (a value sets the var,
// an empty one removes it). Undefined when the text names no var. Foreman
// validates the name.
export const varsAfter = (vars, text) => {
  const at = text.indexOf("=");
  const name = (at < 0 ? text : text.slice(0, at)).trim();
  if (at < 0 || name === "") return undefined;
  const { [name]: _removed, ...rest } = vars ?? {};
  const value = text.slice(at + 1).trim();
  return value === "" ? rest : { ...rest, [name]: value };
};

// The vars of an agent block as lines of `name=value`, for the inspector.
export const varLines = (node) =>
  Object.entries(node?.vars ?? {}).map(([name, value]) => `${name}=${value}`);
