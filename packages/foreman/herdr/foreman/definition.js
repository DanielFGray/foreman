// Why the pane cannot open a composite definition, or null when it can.
// `choices` is the `choices` of `foreman pipeline show --json`. A definition a
// project draft made is stored only when that draft is saved, and `composite
// show` reads only stored definitions and definition drafts, so opening one
// first would fail after the pane had already switched to it.
export const definitionRefusal = (name, choices) =>
  choices?.unsaved?.includes(name)
    ? `${name} is made in a project draft: save that project's draft before opening it`
    : null;
