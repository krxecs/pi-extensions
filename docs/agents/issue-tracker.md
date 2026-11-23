# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `krxecs/pi-extensions`. Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, with appropriate `--label` and `--state` filters.
- Make a child issue: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` (`gh` 2.94+). On older versions, use `gh api --method POST repos/krxecs/pi-extensions/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`. Without sub-issues, put `Part of #<parent>` at the top of the child body.
- Add a blocker: `gh issue create --blocked-by <n>,<n> ...`, or `gh issue edit <child> --add-blocked-by <blocker>` (`gh` 2.94+). On older versions, use `gh api --method POST repos/krxecs/pi-extensions/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Get the database ID with `gh api repos/krxecs/pi-extensions/issues/<n> --jq .id`. If dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body.
- Count open blockers: `gh api repos/krxecs/pi-extensions/issues/<n> --jq .issue_dependencies_summary.blocked_by`. A ticket is unblocked when all blockers are closed.
- Comment: `gh issue comment <number> --body "..."`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: comment with the explanation, then run `gh issue close <number>`. On an already-closed issue, `gh issue close --comment` can drop the comment while exiting successfully.

Run `gh` from this clone so it selects the repo from `origin`. Before the first issue creation in a session, check `gh repo view --json nameWithOwner`. Confirm with the user if it does not show their repo. File issues only in the user's repo.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` if external PRs should enter the triage queue.

When enabled, read PRs with `gh pr view <number>`, `gh pr view <number> --comments`, and `gh pr diff <number>`. List open external PRs with `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`. Use `gh pr comment`, `gh pr edit`, and `gh pr close` to manage them. A bare `#<number>` may refer to an issue or PR; try `gh pr view` first.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it with `gh issue view`.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- Map: create one issue labelled `wayfinder:map` with Notes, Decisions-so-far, and Fog in its body.
- Child ticket: link an issue as a sub-issue of the map, or use a task list and `Part of #<map>` if sub-issues are unavailable. Use a `wayfinder:<type>` label (`research`, `prototype`, `grilling`, or `task`).
- Frontier: list open children in map order; skip assigned children and those with open blockers. The first remaining child is next.
- Claim: `gh issue edit <n> --add-assignee @me` is the session's first write.
- Resolve: comment with the answer, close the child, then add a short summary and link to the map's Decisions-so-far.
