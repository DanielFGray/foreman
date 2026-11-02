/** The workflow text `tasks prime` prints for an agent starting a session. */
export const PRIME = `# tasks: the task tracker

Use \`tasks\` to track work across sessions. Task ids look like ts-a1b2c3. Epic ids look like ep-a1b2c3.

## Start work

    tasks ready -p <project>     # tasks you can start now
    tasks show <id>              # read the whole task first
    tasks start <id>             # claim it before you begin

## While you work

    tasks log <id> "message"     # record a result or a decision, not each step
    tasks append <id> "text"     # add a note to the description
    tasks blocks <first> <second>  # <second> cannot start until <first> is done

## Finish work

1. Read the definition of done in \`tasks show <id>\`. Check each point.
2. Log what you built and what you left out: \`tasks log <id> "..."\`.
3. Change the status:

    tasks review <id>            # the work waits for a reviewer
    tasks done <id>              # the work is complete

## File new work

    tasks add "title" -p <project>               # a task
    tasks add "title" -p <project> -e            # an epic
    tasks add "title" -p <project> --status proposed   # nobody has approved it yet
    tasks add "title" -p <project> -d "text" --dod "how to check it" -l bug

- A proposal stays out of \`tasks ready\` until someone runs \`tasks open <id>\`.
- A task labelled \`question\` is a decision to make. It is never ready work.
- Pass \`-\` as any text argument to read it from standard input:
  \`tasks log <id> - < note.md\`

## Statuses

proposed, draft, open, in_progress, reviewing, done, canceled.

A status change that the rules do not allow gives an error that names the status and the command.
An epic's status comes from its tasks. Only \`done\` and \`cancel\` close an epic by hand.

## Commands

    tasks add | show | list | ready | status | graph
    tasks start | review | done | open | cancel | propose | draft
    tasks log | append | desc | edit | label | unlabel
    tasks blocks | unblocks | parent | priority

Run \`tasks <command> --help\` for the flags of one command.
`;
