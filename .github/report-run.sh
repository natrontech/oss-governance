#!/usr/bin/env bash
# Keeps one issue open while sync runs fail and closes it once a run succeeds again
# GitHub only mails the last editor of the workflow file about a failed scheduled run, so the issue is what notifies the owners
set -euo pipefail

number=$(gh issue list --author app/natron-oss-governance --search 'in:title "Sync run failed"' --json number --jq '.[0].number // empty')

if [ "$1" = success ]; then
  if [ -n "$number" ]; then
    gh issue close "$number" --comment "Succeeded again: $RUN_URL"
  fi
  exit 0
fi

if [ -n "$number" ]; then
  gh issue comment "$number" --body "Failed again: $RUN_URL"
  exit 0
fi

# Issues can only be assigned to users, so the owners team is assigned through its members
assignees=()
for login in $(gh api orgs/natrontech/teams/open-source-owners/members --jq '.[].login'); do
  assignees+=(-f "assignees[]=$login")
done
gh api "repos/$GH_REPO/issues" -f title="Sync run failed" "${assignees[@]}" -f body="The sync run failed: $RUN_URL" > /dev/null
