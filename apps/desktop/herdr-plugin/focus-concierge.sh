#!/bin/sh
set -eu

if [ "${HERDR_ENV:-}" != "1" ]; then
  printf '%s\n' "Crewvane: open this action from inside Herdr." >&2
  exit 1
fi

# Resolve the registered scene, including custom CLIs which have no Herdr Agent
# name. The action must never rely on a global name or whichever tab is focused.
exec /bin/sh "$(dirname "$0")/run-cli.sh" scene focus
