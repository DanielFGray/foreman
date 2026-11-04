---
name: foreman
description: Drive foreman's task lifecycle by hand — dispatch a task, wait for it, read its prompt, act on any row, and set what the fleet may do by itself — from a shell. Use when coordinating agents on a project foreman manages.
---

# Foreman by hand

Foreman moves tasks through agents in herdr workspaces. Each task gets
its own git worktree and branch, `foreman/<task-id>`. One task goes through
these steps:

1. **Queue.** The task is ready in the task store.
2. **Author.** An agent works in the task's worktree, commits, and names its exit.
3. **Review.** An agent one rung up reads the diff and names its exit with `foreman exit <id> approved` or `foreman exit <id> returned`.
4. **Land.** Foreman proves the merge in a scratch checkout, runs the project's verify command, merges, and marks the task done in its tracker. A pull-request landing opens a pull request instead, and merges it once its required checks pass.

Every command below reads the world (the task store, herdr, git) once, does one thing,
and exits. Foreman keeps no state between runs. So you can run these commands
while `foreman serve` runs the dispatcher: it reads your
change on its next tick and continues the task from there. With the dispatcher
stopped, paused or idle, nothing reviews or lands the task for you.

## Commands

Run `foreman <command> --help` for the options.

| Command                                                                               | Does                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `foreman queue [--project P] [--json]`                                                | Prints ready tasks in dispatch order, from the task store only                                                   |
| `foreman show <id> [--json]`                                                          | Prints one task with its definition of done and its log                                                          |
| `foreman log <id> <message\|->`                                                       | Appends to the task's log in its project's tracker; `-` reads stdin                                              |
| `foreman list -p <project> [--json]`                                                  | Prints every task of a project from its tracker, any status                                                      |
| `foreman add "<title>" -p <project> [-l L]... [-d <text>\|-] [--dispatch [--rung R]]` | Files a task in the project's tracker and prints its id; `-d -` reads stdin; `--dispatch` also starts its author |
| `foreman status [--json]`                                                             | Prints every row and the commands each takes; `--json` is the shape written to `state.json`                      |
| `foreman dispatch <id> [--rung R]`                                                    | Starts a queued task's author now                                                                                |
| `foreman wait <id> [--role R]`                                                        | Blocks until the task's agents (or one role) stop working, then prints its status                                |
| `foreman wait --asks`                                                                 | Blocks until a new step waits for your approval, then prints its task and the approve command                    |
| `foreman approve <id>`                                                                | Lets the step that task waits on run once, for that task alone                                                   |
| `foreman say <id> [--role R] <text>`                                                  | Sends a message to a task's live agent                                                                           |
| `foreman correct <id> <findings>`                                                     | Sends the author a correction round (two at most), and counts it                                                 |
| `foreman prompt author\|review <id>`                                                  | Prints the prompt foreman sends that role                                                                        |
| `foreman quota`                                                                       | Prints what each account has left                                                                                |
| `foreman policy <subcommand>`                                                         | Prints or changes what the dispatcher may do without you                                                         |
| `foreman ladder [edit\|enable\|disable\|suggest]`                                     | Prints, checks (`drift`, `size`), advises (`suggest`), or edits the model ladder                                 |

Each row action is a command that takes the id of a row in `foreman status`:

`retry`, `release`, `close`, `take-over`, `focus`, `descend`,
`unassign`, `onboard`, `adopt`, `complete --reason`, `kill [--reason]`,
`intervene --how continue|diagnose|review [--rung R]`.

A command that does not apply to the row says which commands do.

## What you do that foreman cannot

Foreman runs every step that has one right answer. These need judgement, so they
are yours, before `foreman dispatch`, `foreman add --dispatch` or the dispatcher's tick takes the task:

- **Slice.** One task is work one agent can finish and one verify run can
  prove. Record each prerequisite as `tasks blocks <first> <second>`: `tasks
ready` reads edges, never the text of a description.
- **Size.** Label every task `size:1` (one file or rule), `size:2` (one
  package) or `size:3` (crosses packages); larger is allowed. Foreman writes
  it into the run rows, which is how the record learns which rung each size
  needs.
- **Brief.** Write the task so a stranger can do it from `foreman show <id>`:
  the goal, the files in scope, the design decisions you already made, and a
  definition of done with checkable facts.
- **Decide first.** An agent given an open design question decides it without
  telling you. Answer it in the task, or file it with `-l question`.
- **Answer what parks.** A parked task, or one every rung has failed, waits
  for you. Write the decision into the task, then run `foreman descend <id>`.
  File work that is not ready for an agent as a `draft`.

## Use

- Pick work with `foreman queue`, start it with `foreman dispatch`, and run
  `foreman wait` in the background. The ladder chooses the model, so you do
  not choose launch flags.
- File and start new work in one command, with the brief on stdin:

  ```sh
  foreman add "<title>" -p <project> -l size:2 -d - --dispatch <<'EOF'
  <goal, files in scope, decisions, definition of done>
  EOF
  ```

  It prints the id, then the `foreman wait` command. Use it only for a task
  with no prerequisites: a `tasks blocks` edge needs the task to exist, and
  the author is already running by then. A refused dispatch leaves the task
  filed and names its id; start it later with `foreman dispatch <id>`.

- When `wait` returns, read the result with `foreman show <id>`. A task
  `in_progress` at a review step goes to a reviewer on the dispatcher's next
  tick.
- When an attempt is stuck, use `intervene`. Do not open the worktree and
  edit it yourself.
- `foreman policy` sets what the dispatcher does without you: `pause`,
  `resume`, `set <author|climb|review|land> on|ask|off`, `slots <n>`, and
  `grant <task-or-epic> <steps...> [--count n]` for one task or epic.
  `pause`, `resume` and `set` take `--project <name>` to apply to one project
  only, and `clear --project <name>` returns it to the default. The
  dispatcher reads the file on its next tick. A paused fleet, or one with no
  step on and no grant, writes nothing at all. `foreman dispatch` is not gated:
  it starts the author you asked for.
- Sending a reviewer to a finished task, and landing an approved branch, both
  wait for the policy. `foreman policy grant <id> land --count 1` lands one.
- A step set to `ask` stops at its task and waits. `foreman wait --asks` tells
  you when one is waiting; `foreman approve <id>` lets that step run once.
- Use the herd skill instead for work in a checkout that several agents
  share. Foreman gives each task its own worktree.
