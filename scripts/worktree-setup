#!/bin/bash
# A foreman worktree shares none of the main checkout's installed dependencies,
# so a dispatch into one needs them installed before the agent starts. The
# package manager's own install is already safe to run again, which is what
# makes a re-run the repair for a worktree whose deps went stale.
set -euo pipefail

bun install
