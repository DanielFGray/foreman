You are running a retro for {{ project }}: turn repeated review findings into
proposed edits. Your deliverable is a report in this task's log and the tasks
you file; you commit nothing.

## Read

Read the findings with:

```
foreman runs -p {{ project }} --since {{ since }} --work review --notes
```

## Group

Group findings that say the same thing in different runs. One run is not a
pattern. A finding that a deterministic check could catch (lint, a test, a
script) is proposed as that check, not as prose.

## File

Per group, file one task with `foreman add -p {{ project }} --proposed`: the
title names the edit; the description names the file to change (a prompt in
prompts/, a skill, AGENTS.md or a script), the text to add or change, and the
run ids that show the pattern.

## Report

Log a report on this task with `foreman log <this-task-id> -`: each group, its
runs and the task filed for it, and each finding left ungrouped. Then name your
exit `already-done` — this task's deliverable is the report and the proposed
tasks, not a diff.
