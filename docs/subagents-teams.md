# Team configuration examples

`subagents.teams` maps team names to an ordered roster **and optional
team-scoped parent/child context**. A member can be a role name string or an
object with an `agent` name and per-member overrides. Each team may also set
`parentContext` / `childContext` (same forms as the global keys: inline
markdown, `@path`, or a string array; `false` disables that side). Team
context **replaces** the global value for that side — it never merges.

The four teams below show **different operating workflows**, not just different
models. Replace every model placeholder with an ID available from your provider.

Every roster entry must name a role that has a card: the bundled
`centurion` / `worker` / `scout` (`agents/` in this repo, plus your own
`<agentDir>/agents/<name>.md`). A member naming a role with no card is refused
at launch (`UNKNOWN_AGENT`), so a team file that still lists a role you removed
is a startup failure, not a silent fallback.

```json
{
  "subagents": {
    "parentContext": "Global fallback: prefer named teams for real workflows.",
    "teams": {
      "fe-premium": {
        "description": "Frontend · complex projects",
        "parentContext": "FE premium parent workflow:
1. Scout UX surface and design tokens first.
2. Lock the slice in a short contract before any worker starts.
3. Design gate before the worker lands UI (screenshot + token check).
4. Adversarial review covers a11y + visual regress; product ambiguity goes back to the parent, never to a new layer.
5. Stop when the review passes; do not expand scope mid-flight.",
        "childContext": "FE premium child guardrails: stay in the assigned component tree; no API shape change without a contract revision; hand off diffs with screenshot notes.",
        "members": [
          { "agent": "scout", "model": "your-provider/strong-model", "thinking": "high" },
          { "agent": "worker", "model": "your-provider/strong-model", "thinking": "max" },
          "centurion"
        ]
      },
      "be-value": {
        "description": "Backend · standard projects",
        "parentContext": "BE value parent workflow:
1. Scout existing handlers and data model only — no greenfield redesign.
2. Write a thin acceptance list (tests + curl) before dispatch.
3. Worker implements behind feature flags; one PR-sized slice.
4. Review focuses on contracts/errors and cross-service risk.
5. Stop when acceptance tests pass; escalate early if schema migration is required.",
        "childContext": "BE value child guardrails: do not touch frontend; prefer existing patterns; document migration needs instead of applying them.",
        "members": [
          { "agent": "scout", "model": "your-provider/value-model", "thinking": "high" },
          { "agent": "worker", "model": "your-provider/value-model", "thinking": "xhigh" },
          "centurion"
        ]
      },
      "fe-value": {
        "description": "Frontend · standard projects (roster only — context falls back to global)",
        "members": [
          { "agent": "scout", "model": "your-provider/value-model", "thinking": "high" },
          { "agent": "worker", "model": "your-provider/value-model", "thinking": "xhigh" },
          "centurion"
        ]
      },
      "be-premium": {
        "description": "Backend · complex projects",
        "parentContext": false,
        "childContext": "@be-premium-child.md",
        "members": [
          { "agent": "scout", "model": "your-provider/strong-model", "thinking": "high" },
          { "agent": "worker", "model": "your-provider/strong-model", "thinking": "max" },
          "centurion"
        ]
      }
    }
  }
}
```

Notes on the examples:

- **`fe-premium` vs `be-value`**: different parent/child workflow text so
  switching `subagents.team` / `PI_SUBAGENTS_TEAM` changes operating
  discipline, not only the roster/models.
- **`fe-value`**: omits team context → falls back to global
  `parentContext` / `childContext` (or convention files).
- **`be-premium`**: `parentContext: false` disables parent injection for that
  team (no fallthrough to global). `childContext: "@be-premium-child.md"` is
  resolved relative to the settings file that declares the team.

Each team's `description` and `members` shape follows
`subagents.teams.<name>`. Member objects apply their own `model` and
`thinking` values to that role in this team; those values override the same
fields in the role card's frontmatter. Omitted member override fields continue
to use the role card/configuration defaults. The string `"centurion"` is a
plain roster entry with no member-level override.

To make one team the settings default, add a sibling `"team": "be-value"`
under `"subagents"`. `PI_SUBAGENTS_TEAM` takes precedence over that configured
`subagents.team` value when selecting the team. See the README's [Team
配置](../README.md#team-配置) section for the selection, context resolve order,
and override semantics.

## spawnMode (rpc | inprocess)

Omitted → `inprocess`, with an automatic `rpc` fallback when the resolved spawn
needs an OS worktree (`worktree: true`, which only a `centurion` can hold —
#214). A non-`pi` role is rejected before this point, so it never reaches the
fallback. An explicit `spawnMode: "inprocess"` + `worktree: true` is still
refused with `INVALID_PARAMS`. This precedence covers the SPAWN fields
(`spawnMode`, `worktree`) only: frontmatter →
`subagents.agentOverrides.<role>` → team member override. The model chain is a
different, longer list — see
[design.md §6.3](design.md) ("model 优先级 / Model precedence").

`worktree: true` is centurion-only: any other role that asks for it is
downgraded to `worktree: false` with a one-time warning, so squad members always
run in-process in the centurion's subtree worktree.

See [inprocess-supervisor.md](./inprocess-supervisor.md) (#197) for the backend
details, the separate `subagents.inprocess.*` limits, and the
AsyncLocalStorage identity channel.
