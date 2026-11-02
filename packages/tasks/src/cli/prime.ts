/** The workflow text `tasks prime` prints for an agent starting a session. */
export const PRIME = `# Tasks CLI context

This project uses \`tasks\` for cross-session task management.
Find your work with \`tasks ready\`. Task ids look like ts-a1b2c3. Epic ids look like ep-a1b2c3.

## Starting work

1. \`tasks ready -p <project>\`  # tasks you can start now
2. \`tasks show <id>\`           # read the whole task: description, definition of done, dependencies, log
3. \`tasks start <id>\`          # claim it before you begin

## Closing a session

When you worked on a task, do these steps before you end the session. A session
with no task needs no \`tasks\` entry.

1. Log the results and decisions, with reasons:
   tasks log <id> "What you accomplished"

2. Verify artifacts are updated:
   - If you changed behavior: is help text / CLI output updated?
   - If you added features: is documentation current?
   - If you fixed bugs: do error messages reflect the fix?
   - Do new tests need to be written? Do existing tests need updating?
   Run the relevant commands to confirm outputs match the code.

3. Update task status:
   - tasks review <id>   # the work waits for a reviewer
   - tasks done <id>     # if complete
   - tasks open <id>     # reopen if needed

4. Add handoff context for the next agent:
   tasks append <id> "Next steps: ..."

5. Update the parent epic (if the task is part of one):
   tasks append <epic-id> "Completed X, next: Y"

## Filing conventions

- Scoped work awaiting authorisation: \`tasks add --status proposed\`. Work still being
  scoped: \`tasks add --status draft\`. A first-line apology does not keep a task out of
  \`tasks ready\`: it filters on status, never on the description. Promote with
  \`tasks open <id>\`; reject with \`tasks cancel <id>\`; return scoped work with
  \`tasks propose <id>\`.
- An unresolved decision is a task with \`-l question\`, never prose in a description.
  \`tasks status\` lists questions under "Questions (open decisions)", and
  \`tasks list -l question\` lists them per project. A question is never ready work at
  any status, so keep it at proposed until it is answered. Answer it with
  \`tasks done <id>\`, and gate follow-on work with \`tasks blocks <question> <task>\`.
- Record each prerequisite as an edge: \`tasks blocks <first> <second>\` means <second>
  cannot start until <first> is done. Text in a description is invisible to
  \`tasks ready\`; only an edge keeps a task out of it.
- Before the last child of an epic closes, file known-unfilled work as a draft child.
  An epic with no unresolved children reads done, so unfiled work vanishes from scans.
  A draft child holds the epic at in_progress and stays out of \`tasks ready\`.

## Core rules

- Use \`tasks\` for strategic work tracking (it persists across sessions).
- Always claim work before starting: \`tasks start <id>\`.
- Log results and decisions, not individual steps.
- Pass \`-\` as any text argument to read it from standard input, so never shell-quote a
  long note: \`tasks log <id> -\`, \`tasks desc <id> -\`, \`tasks append <id> -\`,
  \`tasks add "t" -p proj -d -\`, \`tasks edit <id> --dod -\`.
- \`-p <project>\` scopes a command, before or after the command name:
  \`tasks -p proj list\` and \`tasks list -p proj\` are the same.

## Before completing work

If a task has a definition of done:
1. Run \`tasks show <id>\` to see the criteria.
2. Verify each criterion is met before marking the task done.
3. Run any commands the criteria mention.
4. Only then call \`tasks done <id>\`.

## Statuses

proposed, draft, open, in_progress, reviewing, done, canceled.

A status change that the rules do not allow gives an error that names the status and
the command. An epic's status comes from its tasks. Only \`done\` and \`cancel\` close an
epic by hand.

## Essential commands

    # Finding work
    tasks status                 # overview: counts, work under way, questions, ready
    tasks ready                  # tasks ready to work on (-l <label>, --json)
    tasks list                   # -p, --status, --type, --parent, -l, --json
    tasks show <id>              # full details (--json: one object, read fields with jq)
    tasks graph                  # dependency graph as a Mermaid flowchart

    # Working
    tasks start <id>             # claim a task
    tasks log <id> "message"     # log a result or a decision
    tasks review <id>            # mark as reviewing (awaiting merge)
    tasks done <id>              # mark as done
    tasks open <id>              # reopen a task, or authorise a proposal or draft
    tasks cancel <id> [reason]   # cancel without completing
    tasks propose <id>           # return to proposed
    tasks draft <id>             # return to draft

    # Creating
    tasks add "title" -p project            # a task; prints the new id
    tasks add "title" -p project -d "text"  # with a description
    tasks add "title" -p project -l bug     # with a label
    tasks add "title" -p project -e         # an epic
    tasks add "title" --parent <epic-id> --priority 1 --dod "how to check it"
    tasks add "title" --blocks <task-id>    # the new task must finish before <task-id>

    # Editing
    tasks append <id> "text"     # add to the description
    tasks desc <id> "text"       # replace the description
    tasks edit <id> --title "..."
    tasks edit <id> --dod "..."  # an empty value clears it
    tasks label <id> <name>      # add a label
    tasks unlabel <id> <name>    # remove a label
    tasks blocks <first> <second>    # <second> waits for <first>
    tasks unblocks <first> <second>
    tasks parent <id> <epic-id>  # put a task under an epic
    tasks priority <id> <1|2|3>  # 1 is high, 2 is medium, 3 is low

Run \`tasks <command> --help\` for the flags of one command.
`;
