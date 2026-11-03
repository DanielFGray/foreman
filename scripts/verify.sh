#!/bin/bash
# How foreman decides this repository works: it runs this in the proving
# ground either side of a landing.
#
# The typecheck and the lint run here, not only in the author's worktree: two
# branches that each pass can break a type once merged, and only the merged
# tree shows it.
set -euo pipefail

bun run typecheck
bun run lint
bun run test
