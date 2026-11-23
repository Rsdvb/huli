#!/usr/bin/env bash
# The one issue that says the nightly sync with Kettu failed: opened on the first failure, its
# body replaced on each later one (with a comment only when what failed changed, so a failure that
# lasts does not notify every night), and closed once a sync merges or finds nothing to merge,
# with the one-a-night issues the sync opened before it. huli-sync.yml runs it with GH_TOKEN and
# GH_REPO set.
#
#   sync-issue.sh report <body-file>   the body holds what failed between <!-- what --> markers
#   sync-issue.sh close <comment>
set -euo pipefail

title='上游同步失败'
legacy='合并官方 Kettu 更新'

open_issues() {
  gh issue list --state open --limit 200 --json number,title --jq "$1"
}

number="$(open_issues "map(select(.title == \"$title\")) | first | .number // empty")"

# GitHub may hand the body back with CRLF line ends.
what() { tr -d '\r' | sed -n '/<!-- what -->/,/<!-- \/what -->/p'; }

case "${1:-}" in
  report)
    body="$2"
    if [ -z "$number" ]; then
      gh issue create --title "$title" --body-file "$body"
      exit 0
    fi
    before="$(gh issue view "$number" --json body --jq .body | what)"
    gh issue edit "$number" --body-file "$body"
    if [ "$before" != "$(what < "$body")" ]; then
      gh issue comment "$number" --body "又失败了，失败的内容变了，正文已更新（$(date -u +%F)）。"
    fi
    ;;
  close)
    if [ -n "$number" ]; then
      gh issue close "$number" --comment "$2"
    fi
    open_issues ".[] | select(.title | startswith(\"$legacy\")) | .number" |
      while read -r old; do gh issue close "$old" --comment "$2"; done
    ;;
  *)
    echo "usage: $0 report <body-file> | close <comment>" >&2
    exit 2
    ;;
esac
