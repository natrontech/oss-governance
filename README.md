# oss-governance

Declarative governance for the public repositories of `natrontech`.
Each repository has a file in `repos/` that names its tier and its maintainers, and a bot keeps GitHub in line with it.

The current state of all repositories is in [INVENTORY.md](INVENTORY.md).

## Changing a repository

Edit `repos/<name>.yaml` and open a pull request.
The `Plan` check comments what the change will do on GitHub, including a diff of every file it commits, and the sync runs once the pull request is merged.
Its read-only token cannot see the bypass actors of rulesets, so changes to them only show up in the sync.

```yaml
tier: tier-2
maintainers:
  - some-user # a member of natrontech
  - natrontech/some-team

# Optional, each of these overrides the tier or the org-wide default
license: GPL-3.0
licenseReason: Needs to stay on GPL-3.0 unless all external contributors agree to a relicense # required for a license other than the tier's
responseDays: 10 # working days, null for best effort
ruleset:
  requiredApprovals: 0
  signedCommits: false
  codeOwnerReview: true
syncSecurityPolicy: false # keep the repository's own SECURITY.md
keepUntil: 2027-11-01 # not suggested for archiving before this date
```

- A new public repository needs a file here, otherwise the sync reports it.
- A repository that must not be managed, such as a fork, goes into `ignored.yaml` with a reason.
- Tiers and the org-wide defaults are in `config.yaml`.
- Archiving is done by hand on GitHub, the bot then moves the file to `repos/archived/`.
- A finished tool that is still in use but rarely changes can set `keepUntil`, so it is not suggested for archiving before that date.

## What the sync does

For every active repository:

- **Files**, committed by the app directly to the default branch, which it may do as a bypass actor of the ruleset:
  - `.github/CODEOWNERS` with the maintainers and the fixed lines for `@natrontech/open-source-owners`
  - `SECURITY.md` from `templates/SECURITY.md`, unless the repository keeps its own with `syncSecurityPolicy: false`
  - `LICENSE`, only when GitHub detects another license than the configured one
- **Settings**:
  - write access for `open-source-owners` and for teams named as maintainers
  - the ruleset `oss-governance` on the default branch, which also blocks force pushes and deletion
  - CodeQL default setup, unless the repository has a CodeQL workflow of its own or no language CodeQL supports
  - private vulnerability reporting, secret scanning and push protection
- **Notifications**, as GitHub issues, assignments and mentions:
  - an issue here for every governance problem, such as a maintainer who left the organization or an unlisted public repository
  - an issue here, assigned to the maintainers, for a repository with workflows but no Dependabot or Renovate config
  - an unlisted public repository's issue is assigned to whoever made it public, and after a day and then every three days it mentions them and the owners again
  - an issue here per repository listing external issues and pull requests that are close to or past the tier's response time without an answer from a member
  - an issue here, assigned to the maintainers, that suggests archiving a repository:
    - without activity for 12 months, where activity is the last commit on the default branch not made by the app, including merged Dependabot and Renovate pull requests, or the last release
    - without activity for 6 months, if no maintainer is in the organization anymore or an external request has waited more than 90 days for a first response; the owners are assigned when a maintainer is gone

A repository can add its own rulesets on top of the managed one.
Their rules stay as they are, but the app adds itself as a bypass actor to those that would reject its commits, such as one that requires a pull request.
Classic branch protection is not touched, but it is reported, because it is better moved into a ruleset and it blocks the commits of the app.
A repository that needs required status checks adds its own ruleset, GitHub combines it with the managed one.

## Running it locally

```sh
pnpm install
GITHUB_TOKEN=$(gh auth token) pnpm plan
```

`plan` only reads.
`node src/cli.ts track` updates the issues here, and `node src/cli.ts apply` changes the repositories; both are meant to be run by the `Sync` workflow only.
All of them take optional repository names to limit the run to those repositories, which skips the org-wide archive moves and governance issues.

The `Sync` workflow runs after every merge to `main` and every day at 07:00 and 15:00 Zurich time, in two jobs:

1. `track` updates the issues and the archive folder right away and lists the changes to repositories, with a diff of every file, in its summary.
2. `apply` makes those changes, but only once a member of `open-source-owners` approves it in the run under **Review deployments**; GitHub notifies them when a run waits.

A run without changes needs no approval, and a newer run replaces one that still waits.
A failed run opens the issue "Sync run failed", which the next successful run closes.

The workflow can also be started by hand under Actions, where `dry-run` only prints what would change and `repos` limits the run to some repositories.

`pnpm install` also sets up the git hooks in `.githooks`:

- `pre-commit` validates every YAML file against the schema in `src/config.ts`, regenerates `INVENTORY.md` and `schemas/` with `pnpm generate` and checks the staged files with Biome
- `commit-msg` requires a [Conventional Commits](https://www.conventionalcommits.org) subject
- `pre-push` runs the typecheck and the tests

The `Plan` check runs the same steps and fails a pull request whose generated files are out of date, which catches commits made without the hooks, such as edits in the GitHub web editor.

`pnpm format` formats and fixes the code with [Biome](https://biomejs.dev).
The JSON Schemas in `schemas/` give editors completion and validation for the YAML files; VS Code picks them up through `.vscode/settings.json`.

## Setup

The workflows authenticate as the GitHub App `natron-oss-governance`, installed on all repositories of the organization.

| Permission                                                  | Access         |
| ----------------------------------------------------------- | -------------- |
| Repository: Administration, Contents, Issues, Pull requests | Read and write |
| Organization: Members                                       | Read and write |

Its client id is stored as the Actions variable `APP_CLIENT_ID` and its private key as the secret `APP_PRIVATE_KEY`.

The approval comes from the environment `sync`, which has `open-source-owners` as required reviewers and only allows the branch `main`.
