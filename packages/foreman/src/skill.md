---
name: foreman
description: Drive foreman's task lifecycle by hand — dispatch a task, wait for it, read its prompt, act on any row, and set what the fleet may do by itself — from a shell. Use when coordinating agents on a project foreman manages.
---

# Foreman by hand

Foreman moves prog tasks through agents in herdr workspaces. Each task gets
its own git worktree and branch, `foreman/<task-id>`. One task goes through
these steps:

1. **Queue.** The task is ready in prog.
2. **Author.** An agent works in the task's worktree, commits, and runs `prog review`.
3. **Review.** An agent one rung up reads the diff and labels the task `approved`, or sends the work back.
4. **Land.** Foreman proves the merge in a scratch checkout, runs the project's verify command, merges, and runs `prog done`.

Every command below reads the world (prog, herdr, git) once, does one thing,
and exits. Foreman keeps no state between runs. So you can run these commands
while foreman's dispatcher runs inside herdr-web's server: it reads your
change on its next tick and continues the task from there. With the dispatcher
stopped, paused or idle, nothing reviews or lands the task for you.

## Commands

Run `foreman <command> --help` for the options.

| Command                                           | Does                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `foreman queue [--project P] [--json]`            | Prints ready tasks in dispatch order, from the task store only                              |
| `foreman show <id> [--json]`                      | Prints one task with its definition of done and its log                                     |
| `foreman status [--json]`                         | Prints every row and the commands each takes; `--json` is the shape written to `state.json` |
| `foreman dispatch <id> [--rung R]`                | Starts a queued task's author now                                                           |
| `foreman wait <id> [--role R]`                    | Blocks until the task's agents (or one role) stop working, then prints its status           |
| `foreman say <id> [--role R] <text>`              | Sends a message to a task's live agent                                                      |
| `foreman correct <id> <findings>`                 | Sends the author a correction round (two at most), and counts it                            |
| `foreman prompt author\|review <id>`              | Prints the prompt foreman sends that role                                                   |
| `foreman quota`                                   | Prints what each account has left                                                           |
| `foreman policy <subcommand>`                     | Prints or changes what the dispatcher may do without you                                    |
| `foreman ladder [edit\|enable\|disable\|suggest]` | Prints, checks (`drift`, `size`), advises (`suggest`), or edits the model ladder            |

Each row action is a command that takes the id of a row in `foreman status`:

`retry`, `release`, `close`, `take-over`, `focus`, `descend`,
`unassign`, `onboard`, `adopt`, `complete --reason`, `kill [--reason]`,
`intervene --how continue|diagnose|review [--rung R]`.

A command that does not apply to the row says which commands do.

## What you do that foreman cannot

Foreman runs every step that has one right answer. These need judgement, so they
are yours, before `foreman dispatch` or before the dispatcher's tick takes the task:

- **Slice.** One task is work one agent can finish and one verify run can
  prove. Record each prerequisite as `prog blocks <first> <second>`: `prog
ready` reads edges, never the text of a description.
- **Size.** Label every task `size:1` (one file or rule), `size:2` (one
  package) or `size:3` (crosses packages); larger is allowed. Foreman writes
  it into the trial rows, which is how the record learns which rung each size
  needs.
- **Brief.** Write the task so a stranger can do it from `prog show <id>`:
  the goal, the files in scope, the design decisions you already made, and a
  definition of done with checkable facts.
- **Decide first.** An agent given an open design question decides it without
  telling you. Answer it in the task, or file it with `-l question`.
- **Answer what parks.** A task labelled `needs-you`, or one every rung has
  failed, waits for you. Write the decision into the task, then remove the
  label.

## Use

- Pick work with `foreman queue`, start it with `foreman dispatch`, and run
  `foreman wait` in the background. The ladder chooses the model, so you do
  not choose launch flags.
- When `wait` returns, read the result with `foreman show <id>`. A task in
  `reviewing` goes to a reviewer on the dispatcher's next tick.
- When an attempt is stuck, use `intervene`. Do not open the worktree and
  edit it yourself.
- `foreman policy` sets what the dispatcher does without you: `pause`,
  `resume`, `set <author|climb|review|land> on|off`, `slots <n>`, and
  `grant <task-or-epic> <steps...> [--count n]` for one task or epic. The
  dispatcher reads the file on its next tick. A paused fleet, or one with no
  step on and no grant, writes nothing at all. `foreman dispatch` is not gated:
  it starts the author you asked for.
- Sending a reviewer to a finished task, and landing an approved branch, both
  wait for the policy. `foreman policy grant <id> land --count 1` lands one.
- Use the herd skill instead for work in a checkout that several agents
  share. Foreman gives each task its own worktree.
