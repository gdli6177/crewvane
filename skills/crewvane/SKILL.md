---
name: crewvane
description: Use Crewvane CLI to submit goals and attachments, inspect goals or attention items, and append context in a user's local Crewvane workspace from another agent.
---

# Crewvane

Use the installed `crewvane` CLI to collaborate through the user's shared Crewvane workspace. The desktop app and CLI read and write the same `.crewvane/state.json`; do not create a parallel task list in chat or in another database.

## Resolve the workspace

Use the first source that is explicit and verified:

1. A workspace path supplied by the user.
2. `CREWVANE_WORKSPACE`.
3. The nearest parent directory containing `.crewvane/state.json`.

Pass `--root <absolute-path>` after the subcommand. Do not guess a different workspace from the current Git repository name. If no Crewvane workspace can be found, stop and state the missing path.

## Human-facing operations

These commands append user intent without inventing a status transition:

```sh
crewvane status --root "$WORKSPACE" --json
crewvane goal list --root "$WORKSPACE" --json
crewvane goal show "$GOAL_ID" --root "$WORKSPACE" --json
crewvane ask "$VERBATIM_REQUEST" --project "$PROJECT_ID" --root "$WORKSPACE"
crewvane goal message "$GOAL_ID" --text "$VERBATIM_MESSAGE" --root "$WORKSPACE"
```

Use repeatable `--attachment <absolute-path>` for PNG, JPEG, WebP, or GIF context. Preserve the user's original wording and constraints. `goal message` and `direct` do not change the goal status, next step, waiting owner, approval, or acceptance.

If the user asks to create work, prefer one `ask` call with the complete natural-language request. Do not split it into a progress form. Report the returned goal ID and the saved next step, then stop unless the user asked for further execution.

## Agent execution protocol

Only use status-changing commands when this agent is the registered owner or the concierge for that goal and the stated fact has actually happened. Read [references/cli-protocol.md](references/cli-protocol.md) before using `goal progress`, `goal wait`, `goal review`, `goal decide`, `goal risk`, `goal ship`, `session set`, or any acceptance command.

- An owner records a direct human answer using `goal scene-reply`, bound to the current `attentionRequest.id`; it does not approve or dismiss the question. The current-case concierge may apply an explicit human decision using `resolve`, `accept`, `complete`, `rework`, or `drop`, preserving the human's exact words. An external submitting agent must not make these decisions.
- Never report a check, file, deployment, approval, or message as complete unless it was actually observed.
- Ask the concierge to coordinate before escalating a routine implementation choice to the human.
- Treat an empty or idle terminal as unknown, not successful.
- After a human answers in the owner's Herdr scene, write the receipt before ending the turn. Do not ask the human to repeat the same answer in the desktop app. Never treat a Crewvane system check as a human reply.

Return concise results to the caller, including the goal ID and any unresolved human decision. Do not paste secrets, credentials, or unrelated workspace state into Crewvane.
