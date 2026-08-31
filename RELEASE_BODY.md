# oh-my-codex 0.21.1

`0.21.1` is a patch release for `v0.21.0..abf2393af1e1f9355adfe43166432462a86d2e54` (125 commits, 116 changed files, 28 commit-subject references plus linked issues #3587/#3589).

## Highlights

- **Ralplan Advisory / Contract A** — cooperative Planner → Architect → Critic evidence without execution authority, global suppression, or automatic implementation handoff; lifecycle evidence, reviewer-time artifacts, crash recovery, and cross-platform state mirrors fail closed (#3594).
- **HUD and detached session reliability** — exact pane ownership, failure cleanup, rendering refresh, split/non-split layout reconciliation, stable hook identity, and contention re-arming (#3577, #3578, #3584, #3587, #3588, #3595).
- **Team legacy HUD compatibility** — startup safely recognizes and retires both same-session and leader-only legacy HUD panes before topology freeze (#3597).
- **Trusted publishing and provenance** — immutable tag/main ancestry and SHA checks, verified native assets, trusted npm publication, and retirement of manual token publishing; plugin/cache/launcher provenance rejects symlink and namespace confusion (#3552, #3566, #3570, #3571, #3572).
- **State/process authority** — exact process incarnation, canonical lease recovery, Windows/macOS durability, and session pointer cleanup are hardened (#3558, #3561, #3581, #3582).
- **Compatibility fixes** — Ralph native deadlock recovery, SparkShell tail validation, empty hooks-state recovery, and generated configuration trust checks (#3589, #3590, #3592).

## Compatibility

Patch release. Ralplan Advisory is additive and non-authorizing. Existing standard workflows remain independent. The tag workflow publishes GitHub Release/native assets; npm publication uses the exact tag/SHA-bound OIDC trusted-publish job in the CI workflow.

## Contributors

Thanks to Bellman (@Yeachan-Heo), @FacuVCanale, @NagyVikt, @berahac, @XCRobert, @colanx, @wangxingzhen, @chenjiaming-kezaihui, @app/dependabot, and the gaebal-gajae (clawdbot) release and repair lanes.

## Frozen-range acknowledgements

The release PR must be merged with a two-parent merge commit, not squash/rebase, so the complete frozen `dev@abf2393a` history remains reachable from the `v0.21.1` tag. This preserves generated contributor attribution for every frozen-range contributor, including @wangxingzhen for #3597. The tag gate resolves the exact `origin/release/0.21.1` head immediately before merge and verifies both that recorded head and frozen dev `abf2393a` are ancestors of the tagged `main` commit.

**Full Changelog**: [`v0.21.0...v0.21.1`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.0...v0.21.1)
