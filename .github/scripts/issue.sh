#!/usr/bin/env bash
# Keep exactly one open issue per alarm, labelled so it can be found again.
#
#   issue.sh open  <label> <title> <body-file>   open it, or comment on the open one
#   issue.sh close <label> <message>             close the open one, if any
#
# A red workflow run notifies nobody who is not watching the Actions tab — the
# nightly data build went red for thirteen days in October 2026 without anyone
# noticing. An issue reaches whoever watches the repository, and the comment
# trail on one issue is the history of that outage.
#
# Needs GH_TOKEN and GH_REPO in the environment (the workflow's own token, with
# issues: write).
set -euo pipefail

action=$1 label=$2
existing=$(gh issue list --label "$label" --state open --limit 1 --json number --jq '.[0].number // empty')

case "$action" in
  open)
    title=$3 body=$4
    if [ -n "$existing" ]; then
      gh issue comment "$existing" --body-file "$body"
      echo "commented on #$existing"
    else
      gh label create "$label" --color B60205 --description "Opened and closed automatically by a workflow" --force >/dev/null
      gh issue create --title "$title" --label "$label" --body-file "$body"
    fi
    ;;
  close)
    message=$3
    if [ -n "$existing" ]; then
      gh issue close "$existing" --comment "$message"
      echo "closed #$existing"
    else
      echo "no open '$label' issue"
    fi
    ;;
  *) echo "usage: issue.sh open|close <label> ..." >&2; exit 2 ;;
esac
