# Composite blocks

A **composite** is a part of a pipeline that the operator saved as a block kind
of its own. The operator gives it a name, and places it in any project's
pipeline like a built-in block. Its **open ends**, the wires that left the saved
part, become its exits. Each place it is used is an **instance**. The operator
can name **parameters**: settings of the blocks inside, which each instance
fills in.

A composite is how an operator makes a new block without code. Scratch's "Make
a Block" and Factorio's blueprints serve the same purpose. A coded kind, through
the shared block interface (the epic this record sits under), is for a new
primitive that no drawing of existing blocks can make.

## Terms

- **definition**: a composite's name, blocks, entry, exits and parameters. One
  definition serves every instance of it, in every project.
- **instance**: a block of kind `composite` in a pipeline. It names its
  definition, wires each exit, and gives a value to each parameter.
- **entry**: the block inside the definition that a wire into the instance
  reaches.
- **open end**: a wire inside the definition whose `to` is `out:<exit id>`. It
  leaves the composite by that exit.
- **expansion**: the pipeline with each instance replaced by copies of its
  definition's blocks. Foreman runs, validates, places and traces the expansion.
  The operator draws and edits the pipeline as written, with instances.
- **prefix**: the text the instance puts before the id of each block it expands
  to.

## Stored form

The definitions live in the pipelines file, beside the pipelines, under
`composites`, keyed by name:

```jsonc
{
  "pipelines": { "foreman": { "nodes": [ /* ... */ ] } },
  "composites": {
    "review-loop": {
      "entry": "review-gate",
      "exits": [
        { "id": "exit-landable", "name": "landable" },
        { "id": "exit-rework", "name": "rework" }
      ],
      "params": [
        { "name": "reviewer", "default": "reviewers",
          "sets": [{ "block": "review", "field": "model" }] }
      ],
      "blocks": [
        { "kind": "gate", "id": "review-gate", "step": "review", "next": "review" },
        { "kind": "agent", "id": "review", "role": "review", "model": "reviewers",
          "exits": [
            { "id": "approved", "name": "approved", "to": "out:exit-landable" },
            { "id": "returned", "name": "returned", "to": "out:exit-rework", "fails": "author" }
          ] }
      ]
    }
  }
}
```

An instance in a pipeline:

```jsonc
{ "kind": "composite", "id": "checks", "of": "review-loop", "prefix": "checks.",
  "set": { "reviewer": "opus" },
  "exits": [
    { "id": "exit-landable", "to": "land-gate" },
    { "id": "exit-rework", "to": "climb" }
  ] }
```

- An exit has an id and a name, as an agent's exit does (`agent-exits.md`). A
  rename changes the name. The instance wires exits by id, so a rename leaves
  every instance wired.
- A parameter sets one or more fields of blocks inside. Its value replaces each
  field before validation, so the node schema of each block checks the value.
  Fields that a parameter can set: an agent's `model`, `instructions`, `slots`
  and `stopped`; a check's `command`; a gate's `step`; a land's `how` and
  `onto`. A parameter with no `default` must be set on every instance.
- A definition holds no source. A task enters a composite by a wire.
- A definition may hold instances of other composites. A definition that holds
  itself, directly or through others, is refused.

The drafts file holds the definitions being edited, under `composites`, each
with the definition it began from (`base`), as a project draft does.

## Expansion

`expand(pipeline, composites)` in `src/composite.ts` is a pure function. For
each instance:

1. Each block of the definition is copied, with id `<prefix><id>`. Each
   parameter's value (or default) replaces the fields it sets.
2. A wire inside the definition to a block id is rewritten to `<prefix><id>`. A
   wire to `out:<exit id>` is rewritten to the instance's wire for that exit. A
   wire to `queue` stays `queue`.
3. A wire in the pipeline to the instance's id is rewritten to
   `<prefix><entry>`.
4. A copied block that is itself an instance expands the same way, with the
   prefixes joined.

`pipelineFor`, `runningPipeline` and every reader of a draft call `expand`
before anything else reads the pipeline. The dispatcher, `pipeline trace`,
`pipeline simulate`, `pipeline prompt` and `foreman show` therefore read one
form. An expansion that fails (an unknown definition, an unwired exit, a
missing parameter, a recursion) is a validation problem of that project, and
that project takes no step. Other projects run on.

Validation runs on the expansion, so every rule in `pipeline-engine.md`,
`agent-exits.md` and `workspace-blocks.md` holds inside composites with no new
rule: gates before work blocks, cycles that can end, a review after the last
author, workspace order. A problem names the expanded id, and the page shows it
on the instance whose prefix the id has.

## Block ids

A run stores the block it ran at, and placement looks that id up in the
expansion. So an instance's ids must not move.

- **The prefix is stored on the instance.** It does not follow the instance's
  id, so nothing renames it.
- **An instance made from a selection has the prefix `""`.** Its blocks keep
  the ids they had, so a task standing at one of them stays there. Every later
  instance of the definition gets the prefix `<instance id>.`. Validation
  refuses two blocks with one id in the expansion, as it does now.
- **Unpack keeps the expanded ids.** Replacing an instance with its expanded
  blocks gives the same expansion, so no task moves.
- A definition edit that removes a block inside, or an exit of a block inside,
  makes each task whose last exit names it a decision for the operator
  (`ExitGone`), as removing a block does now.

The `.` in a prefix appears in run rows, in `state.json` and in the drawing's
keys. Mermaid output is unaffected: `Graph.toMermaid` names each node by its
graph index, not by its block id.

## Editing

New `PipelineChange` verbs, sent through `foreman pipeline edit` like the
others:

- `MakeComposite { ids, name }`: saves the selected blocks as a new definition
  and replaces them with one instance with prefix `""`. It refuses when the
  wires that enter the selection reach more than one block (no single entry),
  or the selection holds a source. Each distinct block outside the selection
  that a wire from inside reaches becomes one exit. Its name is that of the
  first such wire's exit, else the target's id. The operator can rename it.
- `Unpack { id }`: replaces an instance with its expanded blocks.
- `InsertOn { wire, kind: "composite", of }`: places an instance on a wire, as
  for the other kinds. Its first exit takes the wire's old target. Its prefix
  is `<instance id>.`.
- `SetParam { id, name, value }`: sets a parameter on an instance.

A definition is edited as a draft of its own: `foreman composite edit <name>
<change>`, `save` and `discard`. The same `PipelineChange` verbs act on its
blocks, with `out:<exit id>` as a valid wire end. The definition verbs are
`AddParam`, `RemoveParam`, `RenameCompositeExit` and `SetEntry`.

`foreman composite save <name>` validates the expansion of every pipeline that
uses the definition, with the new definition. It refuses when any of them has a
problem, and it names the projects and the problems. It also refuses when the
definition changed since the draft began. A save of a project draft refuses
when a definition it uses changed since that draft began.

## The page

The Pipeline view draws an instance as one block with its exits. A task that
stands at a block inside it is drawn on the instance. Opening the instance
shows its definition, which the operator edits as above. A definition that a
project draft made opens once that draft is saved: until then it is not stored,
and `composite show` cannot read it. The palette lists
each definition beside the built-in kinds.

## What it replaces, and conflicts

Each rule below is changed by this record. The record wins in each case.

| Rule | Where it stands | Change |
| --- | --- | --- |
| The pipelines file is `{ pipelines }` and the drafts file is `{ drafts }` | `AGENTS.md`, "The world holds the work" | The files also hold `composites`. |
| A pipelines file that does not decode stops every project | `AGENTS.md`, same section | Still true. A definition that decodes but fails validation stops only the projects that use it. |
| Durable state beyond the policy, pipelines, drafts and instructions files is a wall | `AGENTS.md` | No conflict: the definitions live in the pipelines and drafts files. |
| "Block kinds and props as above" | `pipeline-engine.md`, Validation | Adds the kind `composite`. |
| A pipeline is standard when it holds the standard blocks (`standardOf`) | `pipeline-engine.md`, The standard pipeline | `standardOf` reads the pipeline as written, so a pipeline with an instance is not standard, and `pipeline use` does not rewrite it. |
| Each page action is a `PipelineChange` | `agent-exits.md`, The page | Adds `MakeComposite`, `Unpack`, `SetParam`, and `InsertOn` for kind `composite`. |
| Block ids can be reused | open task "Block ids can be reused" | Not fixed here. A removed instance's prefix can come back, as a removed block's id can. The fix for that task covers prefixes too. |

## Checks

- Making a composite from a selection of the standard pipeline, then expanding,
  gives the same graph as before, with the same ids, and the same validation
  result. Run it on three selections: the review loop (review gate and review),
  the author alone (the start and climb gates stay outside), and the land tail
  (land gate and land).
- A selection of the start gate, the climb gate and the author is refused: the
  wires into it reach two blocks.
- Unpacking an instance gives the same expansion.
- A second instance of one definition gets prefixed ids, and validates when its
  exits are wired.
- A parameter's value reaches the field it sets. A value the field's schema
  refuses is a validation problem named on the instance.
- A definition save that would break one project's pipeline is refused, and
  names that project.

## Open questions

- Two instances of one definition declare the same inner exit names, so a
  router filter `exits:<name>>=N` counts both together. Whether a filter can
  name an instance's exit by its prefix is open.
- A composite has one entry. A part with two ways in, such as the start and
  climb gates in front of the author, is saved without them. Whether a
  composite may have several named entries is open.
- A parameter that sets text inside an instructions file (a placeholder in the
  prompt) is not in the first slice.
