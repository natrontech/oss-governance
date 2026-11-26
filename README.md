# oss-governance

This repository decides how we run the public repositories of `natrontech`.
Every public repository has a small YAML file in `repos/` with its tier and its maintainers.
A bot reads these files and makes sure that GitHub looks like this, so nobody has to click through the settings of 20 repositories by hand.

You find the current state of all repositories in [INVENTORY.md](INVENTORY.md).

## Changing a repository

Just edit `repos/<name>.yaml` and open a pull request.

The `Plan` check writes a comment with everything the change will do on GitHub, also a diff of every file.
After the merge, the sync does the rest.

```yaml
tier: tier-2
maintainers:
  - some-user # must be a member of natrontech
  - natrontech/some-team

# Everything below is optional and overrides the tier or the default from config.yaml
license: GPL-3.0
licenseReason: Needs to stay on GPL-3.0 unless all external contributors agree # required if the license is not the one of the tier
responseDays: 10 # working days until the first response, null for best effort
ruleset:
  requiredApprovals: 0
  signedCommits: false
  codeOwnerReview: true
syncSecurityPolicy: false # keep the own SECURITY.md of the repository
keepUntil: 2027-11-01 # don't suggest to archive it before this date
```

Some things good to know:

- Every new public repository needs a file here, otherwise the bot opens an issue and asks for it.
- A repository we don't want to manage, for example a fork, goes into `ignored.yaml` together with a reason.
- To archive a repository, archive it on GitHub. The bot moves the file to `repos/archived/` by itself.
- The `Plan` check can't see the bypass actors of rulesets, so changes to them only show up in the sync.

## What the bot does

For every active repository, the bot takes care of three things.

**Files**, which it commits directly to the default branch:

- `.github/CODEOWNERS` with the maintainers
- `SECURITY.md` from `templates/SECURITY.md`, if the repository doesn't keep its own
- `LICENSE`, but only if GitHub detects another license than the one in the file

**Settings:**

- write access for `open-source-owners` and for the teams that are maintainers
- the ruleset `oss-governance` on the default branch, which also blocks force pushes and deleting the branch
- CodeQL default setup, if the repository has no own CodeQL workflow and a language CodeQL supports
- private vulnerability reporting, secret scanning and push protection

**Issues** in this repository, when something needs a human:

- a governance problem, for example a maintainer who left the organization
- a public repository without a file here, assigned to the person who made it public, with a reminder after one day and then every three days
- a repository with workflows but without Dependabot or Renovate
- external issues and pull requests that wait too long for a first response, compared to the response time of the tier
- a repository that could be archived, because it had no activity for 12 months, or for 6 months if no maintainer is left or external requests wait for more than 90 days

A repository can have its own rulesets on top, for example for required status checks, and GitHub combines them with ours.
If one of them would block the commits of the bot, the bot adds itself as a bypass actor.

## Working on the bot

```sh
pnpm install
GITHUB_TOKEN=$(gh auth token) pnpm plan
```

`plan` only reads, so it's safe to run it locally.
`node src/cli.ts track` and `node src/cli.ts apply` change things on GitHub, these are only for the `Sync` workflow.
All three accept repository names to run only for them, but then they skip the archive moves and the governance issues.

## Setup

The workflows log in as the GitHub App `natron-oss-governance`, which is installed on all repositories of the organization.

| Permission                                                  | Access         |
| ----------------------------------------------------------- | -------------- |
| Repository: Administration, Contents, Issues, Pull requests | Read and write |
| Organization: Members                                       | Read and write |

The client ID of the app is in the Actions variable `APP_CLIENT_ID` and its private key in the secret `APP_PRIVATE_KEY`.
The approval comes from the environment `sync`, which has `open-source-owners` as required reviewers and only allows the branch `main`.
