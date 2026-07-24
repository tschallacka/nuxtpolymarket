---
name: maintain-fork-branches
description: Maintain the Polynux fork branch model where origin/master is our long-lived integration branch, origin/main is the upstream-facing pull-request branch, and upstream/main is the canonical Polynux line. Use when syncing upstream, updating main or master, extracting our changes into a pull request, reconciling merged or squashed pull requests, resolving divergence, or deciding where new work should begin.
---

# Maintain Fork Branches

Preserve three distinct roles:

- `upstream/main`: Canonical Polynux owned by `AVMG20`.
- `origin/master`: Our durable integration line. Keep our tooling and private workflow guidance here; regularly merge upstream into it.
- `origin/main`: Our upstream-facing PR line. Keep it equal to `upstream/main` when idle. During a PR, allow only that PR's focused commits on top.

Never merge all of `master` into `main`. Extract only the changes intended for upstream.

## Inspect before changing branches

Run:

```bash
git fetch --prune upstream
git fetch --prune origin
git status --short --branch
git log --oneline --decorate --graph --all --max-count=30
git rev-list --left-right --count upstream/main...master
git rev-list --left-right --count upstream/main...main
```

Keep untracked local artifacts such as `.codegraph/` out of commits.

## Update from upstream

When no PR is open from `origin/main`:

```bash
git switch main
git merge --ff-only upstream/main
git push origin main

git switch master
git merge upstream/main
git push origin master
```

Resolve integration conflicts on `master`, never by rewriting `upstream/main`. Prefer upstream's public behavior where it conflicts with an older local copy, then reapply the smallest local adaptation.

When `main` has PR commits, do not fast-forward or merge unrelated upstream work blindly. Rebase or recreate the focused PR stack on current `upstream/main`, verify its diff, then update `origin/main` with `--force-with-lease` only after confirming the exact remote tip.

## Start work

Start private or exploratory work from `master`. Keep commits small and concern-focused so upstream-worthy parts can be cherry-picked later.

Start work intended immediately for upstream from a temporary branch based on current `upstream/main`, even though the final PR head will be `origin/main`. This avoids mixing unfinished work into the PR branch.

Do not add master-only skills, private notes, environment files, or unrelated fixes to an upstream PR.

## Prepare an upstream PR through main

Support one active `origin/main` PR at a time.

1. Fetch both remotes.
2. Confirm the previous PR is merged or closed.
3. Make local `main` match current `upstream/main`.
4. Cherry-pick the focused commits from `master` or the temporary feature branch.
5. Review exactly what upstream will receive:

```bash
git diff --check upstream/main...main
git diff --stat upstream/main...main
git log --oneline upstream/main..main
```

6. Run relevant lint, tests, typecheck, and production build.
7. Push `main` to `origin/main`.
8. Open the PR from `tschallacka:main` to `AVMG20:main`.

If a PR needs more work, commit the fix on `main`, push it, then merge or cherry-pick that fix back into `master` so our integration branch retains it.

For concurrent upstream PRs, temporarily use separate feature branches instead of `main`; GitHub cannot represent multiple independent PR stacks from one branch safely.

## Reconcile after a PR

After upstream merges:

1. Fetch upstream and inspect whether it used merge, squash, or rebase.
2. Make idle `main` match `upstream/main` again.
3. Merge `upstream/main` into `master`.
4. Resolve duplicate or conflicting patches in favor of the accepted upstream implementation.
5. Verify our master-only changes still differ cleanly:

```bash
git diff --stat upstream/main...master
git log --cherry-pick --right-only --oneline upstream/main...master
```

Squash merges create new commit identities even when patches are equivalent. Do not assume commit hashes prove a change is missing; compare patches and resulting files.

Before any operation that rewrites `main`, verify the current branch, local status, upstream tip, origin tip, and open PR state. Use `--force-with-lease`, never an unconditional force push.

## Compatibility strategy

- Merge upstream into `master` frequently; small intervals produce smaller conflicts.
- Keep master-only changes modular and avoid broad formatting churn.
- Put reusable tooling behind development-only boundaries when upstream runtime behavior must remain untouched.
- Prefer adapters and narrow extension points over editing game logic repeatedly.
- Re-run CodeGraph sync after merges.
- Treat a clean production build and a reviewed `upstream/main...main` diff as release gates for PRs.
