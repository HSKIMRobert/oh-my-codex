# Release inventory — v0.21.0..dev@39c70861

- Previous tag: `v0.21.0` = `3ad79a8a6fe6e95fdbb8c00e40716fffe4011ce2`.
- Candidate: `dev@39c70861a124b733f3b7eef42969e1dcba4344b9`.
- Range: 123 commits, 114 files, +23,880/−1,140.
- Merge commits: 29, including branch reconciliation commits inside the long-running Advisory contribution.
- Commit-subject issue/PR references: 27 — #3552, #3555, #3557, #3558, #3560, #3561, #3562, #3563, #3566, #3568, #3569, #3570, #3571, #3572, #3577, #3578, #3579, #3580, #3581, #3582, #3584, #3585, #3588, #3590, #3592, #3594, #3595.
- Additional linked issues cited by the merged changes and release notes: #3587 and #3589. Total tracked release references: 29.
- Contributors in git shortlog: gaebal-gajae, Bellman, FacuVCanale, NagyVikt, Cristian Beraha, Colan Xu, dependabot, and 陈家名.

## Release trains

### Trusted publishing and package provenance

- #3552/#3566/#3570/#3571/#3572 retire manual npm-token publication, bind immutable tags to main ancestry and SHA, verify native release assets, and harden cache/plugin/launcher provenance.

### Detached HUD/session lifecycle

- #3577/#3578/#3579/#3580/#3581/#3582/#3584/#3585/#3587/#3588/#3595 harden detached leader cleanup, HUD ownership, refresh rendering, pane adjacency, tmux hook identity, non-split layout reconciliation, and contention re-arming.

### Ralplan Advisory

- #3594 adds cooperative, non-authorizing Contract A planning review with durable evidence, generation/mirror CAS, immutable reviewer artifacts, crash recovery, process identity, and cross-platform fail-closed state transactions.

### Runtime/configuration fixes

- #3589/#3590 recover empty hooks-state configurations.
- #3592 fixes Ralph native application deadlock handling.
- SparkShell tail-line validation, Windows state identity, and generated config trust checks are included in the frozen dev range.

## Reproduction

```sh
git rev-list --count v0.21.0..39c70861a124b733f3b7eef42969e1dcba4344b9
git diff --shortstat v0.21.0..39c70861a124b733f3b7eef42969e1dcba4344b9
git log --pretty='%s' v0.21.0..39c70861a124b733f3b7eef42969e1dcba4344b9 | grep -oE '#[0-9]+' | sort -u # 27 subject references
```
