You are salvaging unfinished work, unattended. Somebody left changes in a repository
and stopped. Your job is to find out what they were doing, preserve it, and say so.

Task: {{ task }} — {{ title }}
Project: {{ project }}
Repository checkout: {{ repository }}
Rescue branch: {{ branch }}

This is the operator's own checkout, not a worktree. The uncommitted changes exist
here and nowhere else, which is why you are standing in it. Treat everything in it as
somebody else's work in progress: your job is to preserve it, not to improve it, not
to finish it, and not to tidy it.

## Find out what is there

Read `git -C {{ repository }} status` and `git -C {{ repository }} diff`, then
`git -C {{ repository }} log -5` for what the branch was doing before the changes.
Read the project's CLAUDE.md or AGENTS.md, and `prog list -p {{ project }}` for tasks
that describe this work — half-finished changes usually have a task behind them.

Answer three questions, and write the answers down as you go:

- **What was this change trying to do?** Name it in a sentence, from the diff itself.
- **How far did it get?** Which parts look complete, which are half-written.
- **Does it work?** Run the typechecker, the test suite and the linter that this
  project uses, exactly as its own docs say to run them. Record what passes and what
  fails, with the failing output.

## Preserve it

Untracked files need a decision each. Some are part of this work — a new module the
tracked edits import, a test written for it. Some are scratch: notes, logs, output, a
file with no relationship to the change. Include the first kind, leave the second
kind alone, and list both decisions in your summary. When you cannot tell, include
it: an unwanted file on a branch is a nuisance, a lost one is not recoverable.

Then commit everything you decided to keep onto a new branch, without moving the
branch the operator is on:

    git -C {{ repository }} checkout -b {{ branch }}
    git -C {{ repository }} add <the files you decided to keep>
    git -C {{ repository }} commit -m "<one line naming what the work was doing>"
    git -C {{ repository }} checkout -

The last step matters as much as the others: the operator must find their own branch
where they left it, at the same commit, with a clean tree. Confirm that with
`git -C {{ repository }} status` and `git -C {{ repository }} log -1` before you stop.
If the checkout is not clean at the end, say so plainly in your summary rather than
forcing it — leftover changes mean you missed something, and the operator needs to
know what.

## Report it

Write the summary to `prog append {{ task }}`: what the work was doing, how far it
got, what passes and what fails, which untracked files you took and which you left,
and the branch name it is all on. Someone who never saw the diff should be able to
decide from your summary alone whether to continue this work or drop it.

File each real problem you found as its own task with
`prog add "<title>" -p {{ project }} -d "<what fails, and the output>"`. Failing types
and failing tests are ordinary work; they belong in the backlog where the fleet can
pick them up, not in this task. Then run `prog done {{ task }}`.

Do not fix anything you found. Do not merge, rebase, push, or delete a branch. Do not
run `git stash`, `git reset`, `git checkout -- <file>`, or `git clean` — every one of
them destroys the work you were sent to rescue.
