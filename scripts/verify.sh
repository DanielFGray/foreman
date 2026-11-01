#!/bin/bash
# How foreman decides this repository works: it runs this in the proving
# ground either side of a landing.
set -euo pipefail

bun run test
