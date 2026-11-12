# Local Pack Manifest

`manifest.json` uses `schemaVersion: 1`.

Required fields:

- `id`: namespaced lowercase ID such as `acme.design-review`; `crewvane.` is reserved.
- `name`: short user-facing name.
- `description`: when the method should be used.
- `version`: semver, normally `1.0.0`.
- `minimumCrewvane`: minimum compatible Crewvane version.
- `kind`: `process`.
- `roles`: one or both of `owner`, `verifier`.
- `entry`: usually `SKILL.md`.

Optional fields:

- `references`: relative files under the pack.
- `scripts`: objects with `id`, `path`, `sha256`, and `description`.

Example:

```json
{
  "schemaVersion": 1,
  "id": "acme.design-review",
  "name": "设计评审",
  "description": "界面设计或实现需要发布前评审时使用。",
  "version": "1.0.0",
  "minimumCrewvane": "0.10.0",
  "kind": "process",
  "roles": ["owner", "verifier"],
  "entry": "SKILL.md",
  "references": ["references/checklist.md"],
  "scripts": []
}
```

Pack limits:

- at most 100 files and 5 MB total;
- `SKILL.md` at most 12,000 characters;
- no symlinks, absolute paths, traversal, credentials, or generated caches;
- scripts must live under `scripts/`, match their declared SHA-256, and require explicit approval.

The user-facing method should say what must happen and what evidence proves it. Crewvane Core continues to own task state, permissions, acceptance, and concurrency.
