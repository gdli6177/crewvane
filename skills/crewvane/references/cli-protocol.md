# Crewvane state protocol

Read this file only when the current agent is acting as a registered Crewvane owner or the global concierge. Every state command requires a real event; natural language alone never proves approval, acceptance, completion, or a passed check.

## Progress and waiting

```sh
crewvane goal progress "$GOAL_ID" --summary "$ACTUAL_RESULT" --next "$NEXT_STEP" --root "$WORKSPACE"
crewvane goal wait "$GOAL_ID" --reason "$WAITING_REASON" --owner "$WAITING_OWNER" --remind-at "$ISO_TIME" --root "$WORKSPACE"
```

Use `progress` after an observable result, not as a heartbeat. Use `wait` only while a named external third party (a contact, organization or external service) outside the human and every Crewvane Agent is blocking work. `--owner` is required and stores the external party in `waitingFor`; it does not replace the execution owner. The CLI rejects missing targets, the human, the concierge and registered Agents.

Human choices, confirmations, information or manual actions use `decide`; delivery uses `review`. Neither belongs in external waiting. Coordination with an owner or worker stays `active`; ending a turn or an idle terminal never proves external waiting. `remind` changes only the schedule, including on active goals.

Handing a waiting concierge goal back via `message`, `direct` or follow-up returns it to `active` and clears the old wait and reminder while an Agent processes it. Read the waiting activity/history to recover the original party and time; explicitly re-establish `wait` with an appropriate reminder if it is still an external dependency. Do not infer external completion from the message alone.

## Decisions and high-risk actions

```sh
crewvane goal decide "$GOAL_ID" --question "$SPECIFIC_QUESTION" --next "$PLANNED_NEXT_STEP" --root "$WORKSPACE"
crewvane goal risk "$GOAL_ID" --category "$CATEGORY" --summary "$PROPOSED_ACTION" --root "$WORKSPACE"
```

Use `decide` for a concrete choice Crewvane cannot resolve. Use `risk` before deleting data, stopping a service, spending money, sending an external message, changing product direction, creating or rotating a secret, changing permissions, or changing shipping policy. High-risk work waits for the human even when a project policy is automatic.

## Human replies in an owner scene

```sh
crewvane goal show "$GOAL_ID" --root "$WORKSPACE" --json
crewvane goal scene-reply "$GOAL_ID" --attention-id "$ATTENTION_REQUEST_ID" \
  --quote "$VERBATIM_HUMAN_ANSWER" --summary "$ACTUAL_RESULT_AND_NEXT_STEP" \
  --root "$WORKSPACE" --json
```

Read `attentionRequest.id` from `goal show`. Only the registered owner (or concierge) may submit the receipt; its actor comes from `CREWVANE_AGENT_NAME` or `--actor`. Keep the exact user answer and the owner's factual summary separate. The receipt is persisted and dispatched to the single concierge. It does not resolve a question, grant approval, pass acceptance or complete the goal. Do not submit a receipt without a genuine answer or for a different question; system reconciliation prompts are not human answers.

The concierge re-reads the current goal and processes only the matching receipt. Its CLI scope automatically binds `attentionId` and `sceneReplyId`; replaced questions and newer answers reject stale commands. A decision or ending command must preserve `sceneReply.quote` in `--note` / `--reason`. Use `resolve --outcome approved|rejected` for decisions, `accept` for explicit acceptance, `rework` for requested changes, and `complete` / `drop` for an explicit end or abandonment. A progress update does not resolve an outstanding decision. Finish the case turn after resolving it; a separate follow-up notifies the original owner.

If no attention item exists, use `direct --goal "$GOAL_ID" "$VERBATIM_HUMAN_MESSAGE"` for additional context, followed by factual progress or waiting as appropriate. Do not use an unguarded command or edit state files to bypass a stale receipt.

## Delivery and shipping

```sh
crewvane goal review "$GOAL_ID" --summary "$DELIVERY_SUMMARY" \
  --location "$REAL_ARTIFACT_PATH" \
  --check "$CHECK_NAME::$ACTUAL_OPERATION::$RESULT::$OBSERVED_RESULT" \
  --root "$WORKSPACE"
crewvane goal ship "$GOAL_ID" --operation merge --checks passed --root "$WORKSPACE"
```

`goal review` needs at least one real check. A check result is `passed` or `failed`; include what was actually executed or inspected. `goal ship` asks the policy engine whether an external merge or deployment is allowed. It does not perform the merge or deployment.

## Herdr owner session

Register a real owner scene only after Herdr returned its identifiers:

```sh
crewvane session set "$GOAL_ID" --session "$HERDR_SESSION" \
  --workspace "$HERDR_WORKSPACE_ID" --tab "$HERDR_TAB_ID" \
  --pane "$HERDR_PANE_ID" --agent "$LIVE_AGENT_NAME" --root "$WORKSPACE"
```

For an unrecognized interactive CLI, verify its foreground PID and add:

```sh
--transport pane --process-id "$FOREGROUND_PID"
```

After the goal is completed or dropped, Crewvane releases the owner scene. Do not register the global concierge or another active goal's pane as the owner.

## Boundaries

- Use the current goal ID only. Do not infer ownership from similar titles.
- Owners and external agents do not accept, approve, or close for the human. The current-case concierge may record an explicit human decision, preserving the original words and matching receipt.
- Do not bypass a rejected CLI scope by editing state files directly.
- Do not retry an external effect without current authorization.
- Treat Crewvane's coordinator scope as a data API boundary, not an operating-system sandbox.
