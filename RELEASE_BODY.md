# oh-my-codex 0.18.0

`0.18.0` ships the OMX API gateway and a safer SparkShell/operator-runtime baseline after `0.17.3`. The release also closes the notify, Stop-hook, tmux, HUD, Windows MCP, and release-smoke blockers found while preparing the train.

## Highlights

- **Local generation has an OMX-owned API path** — `omx api` exposes the local gateway used by OMX generation flows, with explicit real-private backend guidance and safer default auth behavior.
- **SparkShell is safer and more observable** — summaries can diagnose team panes and cache observations while preserving passthrough contracts and keeping raw secrets out of summary prompts.
- **Runtime loops are less sticky** — stale Ralph, ralplan, autoresearch-goal, MCP transport, and tmux diagnostic states no longer trigger erroneous loops after Stop/completion.
- **Process-storm regressions are blocked** — recursive notify wrappers, `previousNotify` self-reference, fallback watcher respawns, and worker tmux rc fan-out are fixed.
- **Team/HUD/Windows reliability improved** — wrapped tmux drafts are not treated as sent input, HUD resize hooks survive reflow, provider env vars reach direct tmux launches, and Windows MCP siblings avoid duplicate watchdog collisions.

## Fixes / compatibility

- `omx api --help` and `omx sparkshell --help` are now covered by release smoke tests.
- Real-private API mode remains experimental and explicitly opt-in; unauthenticated accidental startup is prevented by default token generation.
- Team readiness semantics are preserved; the release removes false draft trust and runaway launch/fan-out behavior rather than weakening failure detection.
- Lifecycle notification grouping remains tracked separately in #2353.

## Merged PR inventory

#2295, #2332, #2334, #2335, #2338, #2339, #2341, #2342, #2344, #2345, #2347, #2349, #2351, #2357, #2359, #2360, #2361, #2365, #2367, #2372, #2374, #2375, #2376.

## Validation

- `npm run build`
- `npm run lint`
- `npm run check:no-unused`
- Targeted compiled Node tests for version sync and the `omx api` CLI bridge
- `npm run verify:native-agents`
- `npm run verify:plugin-bundle`
- `npm run build:full`
- `npm run smoke:packed-install`
- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test -p omx-api -p omx-sparkshell -p omx-explore-harness`
- `git diff --check`

## Contributors

Thanks to everyone who reported and narrowed the post-`0.17.3` runtime issues, especially the notify dispatcher recursion/fork-bomb reports, tmux fan-out/OOM repro, provider-env launch report, and compaction/reconciliation drift reports.

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.17.3...v0.18.0
