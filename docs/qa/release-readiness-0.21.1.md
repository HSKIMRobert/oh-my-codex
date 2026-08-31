# Release readiness — 0.21.1

## Release identity

- Release: `0.21.1` (patch).
- Date: 2026-08-31.
- Previous tag: `v0.21.0` (`3ad79a8a6fe6e95fdbb8c00e40716fffe4011ce2`).
- Frozen dev base: `39c70861a124b733f3b7eef42969e1dcba4344b9`.
- Exact range: `v0.21.0..39c70861a124b733f3b7eef42969e1dcba4344b9`.
- Range size: 123 commits, 114 changed files (+23,880/−1,140), 27 referenced issues/PRs.
- Backlog at freeze: 0 open PRs, 0 open issues.
- Owner authorization: direct `ㄱ` in the OmX release-candidate thread, reaffirmed on 2026-08-31.

## Version carriers

- `package.json` → `0.21.1`
- `package-lock.json` root and package entry → `0.21.1`
- `Cargo.toml` workspace package → `0.21.1`
- `plugins/oh-my-codex/.codex-plugin/plugin.json` → `0.21.1`
- Workspace crates remain `version.workspace = true`.

## Required gates

| Gate | Evidence | Status |
|---|---|---|
| Ancestry | `git merge-base --is-ancestor v0.21.0 39c70861` | Pending recorded run |
| Inventory | `artifacts/release-0.21.1/inventory.md` | Prepared |
| Version sync | `GITHUB_REF_NAME=v0.21.1 node dist/scripts/check-version-sync.js` | Pending validation |
| Build/static/generated | build, no-unused, lint, native/plugin/capability/prompt parity | Pending validation |
| Full tests | `npm test` under supported Node | Pending validation |
| Package smoke | `npm pack --dry-run` and packed install smoke | Pending validation |
| Main promotion | one release PR targeting `main` | Pending |
| Tag/publish | annotated `v0.21.1`, tag-triggered trusted Release workflow | Pending |
| External verification | GitHub Release assets and npm `oh-my-codex@0.21.1` | Pending |

## Publish contract

The annotated tag is created only after the release PR is merged to `main` and the exact main commit is green. The `.github/workflows/release.yml` tag workflow is the sole publication path. The retired Manual npm publish workflow must not be used.
