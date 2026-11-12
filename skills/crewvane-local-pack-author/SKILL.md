---
name: crewvane-local-pack-author
description: Create, validate, and install a Crewvane local method pack from a user's workflow, checklist, or existing SOP. Use when the user asks to save a repeatable Crewvane method, turn a completed workflow into a reusable capability, or install a local capability pack.
---

# Crewvane Local Pack Author

Create a reusable method from the user's real workflow. Keep the experience conversational: the user should not edit JSON or know the storage layout.

## Find The Workspace

Resolve the workspace from the user's explicit path, `CREWVANE_WORKSPACE`, or the nearest parent containing `.crewvane/state.json`. Verify the selected `crewvane` CLI points to the current app. Do not guess a workspace from a Git repository name.

## Gather Only Missing Information

Infer as much as possible from the current conversation. Ask only for information that materially changes the pack:

- What repeated work or situation should trigger this method?
- What should the Agent do, in what order?
- What must be checked before the work is considered delivered?
- Should the method apply to the owner, the verifier, or both?

Use a namespace-style ID such as `acme.design-review`. The `crewvane.` prefix is reserved for built-in packs.

Do not put credentials, customer data, target-specific private facts, or copied terminal logs into a pack. Preserve user wording for company rules when precision matters.

## Create A Draft

Choose a private directory under the workspace:

```text
<workspace>/.crewvane/skill-drafts/<pack-id>-<timestamp>/
```

Create the skeleton through the CLI:

```sh
crewvane skill draft "$DRAFT" --id "$PACK_ID" --name "$NAME" \
  --description "$WHEN_TO_USE" --role owner --root "$WORKSPACE"
```

Add `--role verifier` when needed. Then replace the placeholder guidance in `SKILL.md` with the user's actual method. Keep it concise enough to load on every relevant goal. Put long checklists or references in `references/` and declare them in `manifest.json`.

Prefer instruction-only packs. Add a script only when deterministic execution is materially better than instructions. If scripts are needed:

1. Put executables under `scripts/`.
2. Display the exact purpose and SHA-256 in the final preview.
3. Declare only scripts the user explicitly wants.
4. Never approve a script on the user's behalf.

Read [references/manifest.md](references/manifest.md) before changing manifest fields, references, or scripts.

## Validate And Preview

Run:

```sh
crewvane skill validate "$DRAFT" --json --root "$WORKSPACE"
```

Repair every validation error. Then show one compact preview containing:

- name and one-sentence purpose;
- owner / verifier applicability;
- the actual workflow or checklist in readable form;
- references and why they are needed;
- each script, its purpose, and SHA-256.

Ask for one explicit install decision. If the user asks for changes, edit and validate the draft again.

## Install

Instruction-only pack:

```sh
crewvane skill install "$DRAFT" --json --root "$WORKSPACE"
```

Script pack, only after the user approves the exact scripts:

```sh
crewvane skill install "$DRAFT" --approve-script SCRIPT_ID --json \
  --root "$WORKSPACE"
```

Report the installed pack ID and version. If the user started from a goal and wants the method used there, attach it:

```sh
crewvane skill attach GOAL_ID PACK_ID --json --root "$WORKSPACE"
```

Do not claim the method will always run. The concierge may recommend or attach it to matching goals; users can remove it from a target.
