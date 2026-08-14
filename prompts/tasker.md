You are turning a specification into tasks in a task store. You implement nothing.

Task: {{ task }} — {{ title }}
Project: {{ project }}
Working directory: {{ worktree }}
Branch: {{ branch }}
Repository checkout: {{ repository }}

The specification is the description of {{ task }}. Read it with `prog show {{ task }}`.
Read `prog list -p {{ project }}` first, and do not create tasks that already exist.

Each task must be small, atomic, and independently shippable without failing the
project's typechecks, tests and lint — if a task only passes validations together with
another, merge them. Give each task a description that names what to build, where it
belongs, how to verify it, and that it implements {{ task }}.

## Create the tasks

Create every task as a draft, so none of them can be picked up before you have finished
wiring the plan:

    prog add "<title>" -p {{ project }} --parent {{ task }} --draft --priority 2 -d "<description>"

`prog add` prints the new task's id. Keep it — you will need it for dependencies.

## Wire the dependencies

Once every task exists, wire the dependencies between them with
`prog blocks <before> <after>` — `<after>` waits for `<before>`. Do this for every task
that depends on another, and only after every task has been created, so no task is ever
handed out with a missing blocker.

## Open the tasks

Only when all dependencies are in place, open the tasks with `prog open <id>`. From that
moment the fleet may start on them, so this is the last step, not an early one.

## Finish

Log a summary of the tasks with `prog log {{ task }}`, then run `prog done {{ task }}`.

Do not write code, do not commit, do not merge, and do not work on anything other than
{{ task }}.
