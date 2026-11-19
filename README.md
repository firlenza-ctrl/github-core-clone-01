# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/firlenza-ctrl/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/firlenza-ctrl/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process: git smart HTTP, REST v3, GraphQL v4 and MCP, served from its own deterministic in-memory store. No git binary, no package manager, no outside service — Node 22 standard library only. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port and, when `MAKEFUN_ENV_URL` is set, registers it with the harness environment (`POST $MAKEFUN_ENV_URL/register {"port": N}`) and exits once `GET $MAKEFUN_ENV_URL/done` answers `{"done": true}`. The bearer token comes from `MAKEFUN_SHOP_TOKEN`; when it is unset, any non-empty bearer token is accepted (local development only).

## Surfaces

- Git smart HTTP at `/{owner}/{repo}.git` — protocol v2 (`ls-refs`, `fetch`, shallow/deepen) and v0, plus `git-receive-pack` with report-status.
- REST v3 under `/api/v3` — repositories, branches, commits, git refs, contents, labels, issues, comments and pull requests with merge.
- GraphQL v4 at `/api/graphql` — viewer, repository, issues, pull requests, node, `__type` introspection, and the create/close/merge/comment mutations.
- MCP at `/mcp` — JSON-RPC 2.0 Streamable HTTP, modern era 2026-07-28 (`server/discover`), with nine tools: create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request, list_repos, get_issue, list_pull_requests.

State is fully deterministic: timestamps come from a logical clock and ids are assigned in creation order, so two runs of the same request sequence leave identical state.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
