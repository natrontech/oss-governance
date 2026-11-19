# oss-governance

Declarative governance for the public repositories of `natrontech`.
Each repository has a file in `repos/` that names its tier and its maintainers, and a bot keeps GitHub in line with it.

The current state of all repositories is in [INVENTORY.md](INVENTORY.md).

## Changing a repository

Edit `repos/<name>.yaml` and open a pull request.
The `Plan` check comments what the change will do on GitHub, and the sync runs once the pull request is merged.

```yaml
tier: tier-2
maintainers:
  - some-user # a member of natrontech
  - natrontech/some-team

# Optional, each of these overrides the tier or the org-wide default
license: GPL-3.0
responseDays: 10 # working days, null for best effort
ruleset:
  requiredApprovals: 0
  signedCommits: false
  codeOwnerReview: true
```

- A new public repository needs a file here, otherwise the sync reports it.
- A repository that must not be managed, such as a fork, goes into `ignored.yaml` with a reason.
- Tiers and the org-wide defaults are in `config.yaml`.
- Archiving is done by hand on GitHub, the bot then moves the file to `repos/archived/`.

## What the sync does

For every active repository:

- **Files**, by a pull request from the branch `oss-governance/sync` that the maintainers merge:
  - `.github/CODEOWNERS` with the maintainers and the fixed lines for `@natrontech/open-source-owners`
  - `SECURITY.md` from `templates/SECURITY.md`
  - `LICENSE`, only when GitHub detects another license than the configured one
- **Settings**, directly:
  - write access for `open-source-owners` and for teams named as maintainers
  - the ruleset `oss-governance` on the default branch
  - private vulnerability reporting, secret scanning and push protection
- **Notifications**, as GitHub review requests and mentions:
  - a review request to the maintainers and the owners on every sync pull request, and reminders when it stays open
  - an issue here for every governance problem, such as a maintainer who left the organization or an unlisted public repository
  - an issue here per repository listing external issues and pull requests that are close to or past the tier's response time without an answer from a member

Other rulesets and classic branch protection are not touched, only reported.
A repository that needs required status checks adds its own ruleset, GitHub combines it with the managed one.

## Running it locally

```sh
pnpm install
GITHUB_TOKEN=$(gh auth token) pnpm plan
```

`plan` only reads.
`pnpm install` also sets up the git hooks in `.githooks`:

- `pre-commit` validates every YAML file against the schema in `src/config.ts`, regenerates `INVENTORY.md` with `pnpm inventory` and adds it to the commit
- `commit-msg` requires a [Conventional Commits](https://www.conventionalcommits.org) subject
- `pre-push` runs the typecheck and the tests

The `Plan` check runs the same validation and fails a pull request whose inventory is out of date, which catches commits made without the hooks, such as edits in the GitHub web editor.
`node src/cli.ts apply` makes the changes and is meant to be run by the `Sync` workflow only.

## Setup

The workflows authenticate as the GitHub App `natron-oss-governance`, installed on all repositories of the organization.

| Permission                                                  | Access         |
| ----------------------------------------------------------- | -------------- |
| Repository: Administration, Contents, Issues, Pull requests | Read and write |
| Organization: Members                                       | Read and write |

Its client id is stored as the Actions variable `APP_CLIENT_ID` and its private key as the secret `APP_PRIVATE_KEY`.
