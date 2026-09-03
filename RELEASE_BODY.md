# oh-my-codex 0.21.3

`0.21.3` is a patch release for `v0.21.2..3902573ef309e54534d7388579f2a7243ca7f465` (15 commits, 20 changed files, PRs #3604/#3605/#3606/#3608/#3610/#3612, linked issues #3609/#3611).

## Highlights

- **No duplicate Team wakes** — already-terminal projections are retired instead of re-waking Team coordination (#3608).
- **Long sessions keep their transcripts** — the detached tmux scrollback clamp is raised 500 → 5000 lines with an `OMX_TMUX_HISTORY_LIMIT` override, so multi-line responses are no longer discarded from the pane in long sessions (#3612, fixes #3611).
- **Composer drift triage documented** — `docs/troubleshooting.md` records the prompt-drift symptom, the measured repro matrix, the `tmux resize-pane -D 1 && tmux resize-pane -U 1` recovery, and the fact that `history-limit` is fixed at pane creation (#3610, documents #3609).

## Compatibility

Patch release, no breaking changes. The scrollback change only raises the ceiling for OMX-owned detached leader sessions and adds an opt-in override; panes that already exist keep the scrollback size they were created with.

## Dependencies

`@types/node` 26.2.0 → 26.4.0 (#3606), `zod` 4.4.3 → 4.5.2 (#3605), `@biomejs/biome` 2.5.10 → 2.5.11 (#3604).

## Contributors

Thanks to Bellman (@Yeachan-Heo), @Oreochococukie, dependabot, and the gaebal-gajae (clawdbot) triage/repair lanes.

## Frozen-range acknowledgements

Merge this release PR with a two-parent merge commit so frozen `dev@3902573e` remains reachable. Immediately before merge, force-fetch and record the exact `origin/release/0.21.3` head; verify both it and frozen dev are ancestors of the tagged main commit.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.3/inventory.md`.

**Full Changelog**: [`v0.21.2...v0.21.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.2...v0.21.3)
