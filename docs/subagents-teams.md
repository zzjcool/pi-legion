# Team configuration examples

`subagents.teams` maps team names to an ordered roster **and optional
team-scoped parent/child context**. A member can be a role name string or an
object with an `agent` name and per-member overrides. Each team may also set
`parentContext` / `childContext` (same forms as the global keys: inline
markdown, `@path`, or a string array; `false` disables that side). Team
context **replaces** the global value for that side — it never merges.

The examples below show two squads with **different operating workflows**, not
just different models. Replace every model placeholder with an ID available
from your provider.

```json
{
  "subagents": {
    "parentContext": "Global fallback: prefer named teams for real workflows.",
    "teams": {
      "fe-premium": {
        "description": "Frontend · complex projects",
        "parentContext": "FE premium parent workflow:\n1. Scout UX surface and design tokens first.\n2. Prototype before planner locks the slice.\n3. Designer gate before worker lands UI.\n4. Reviewer checks a11y + visual regress; escalate to advisor on product ambiguity.\n5. Stop when designer+reviewer both approve; do not expand scope mid-flight.",
        "childContext": "FE premium child guardrails: stay in the assigned component tree; no API shape changes without planner; hand off diffs with screenshot notes.",
        "members": [
          { "agent": "scout", "model": "your-provider/strong-model", "thinking": "high" },
          { "agent": "prototype", "model": "your-provider/strong-model", "thinking": "high" },
          { "agent": "planner", "model": "your-provider/strong-model", "thinking": "max" },
          { "agent": "worker", "model": "your-provider/strong-model", "thinking": "max" },
          { "agent": "reviewer", "model": "your-provider/strong-model", "thinking": "xhigh" },
          { "agent": "designer", "model": "your-provider/strong-model", "thinking": "xhigh" },
          { "agent": "advisor", "model": "your-provider/strong-model", "thinking": "xhigh" },
          "centurion"
        ]
      },
      "be-value": {
        "description": "Backend · standard projects",
        "parentContext": "BE value parent workflow:\n1. Scout existing handlers and data model only — no greenfield redesign.\n2. Planner writes a thin acceptance list (tests + curl).\n3. Worker implements behind feature flags; one PR-sized slice.\n4. Reviewer focuses on contracts/errors; advisor only on cross-service risk.\n5. Stop when acceptance tests pass; escalate early if schema migration is required.",
        "childContext": "BE value child guardrails: do not touch frontend; prefer existing patterns; document migration needs instead of applying them.",
        "members": [
          { "agent": "scout", "model": "your-provider/value-model", "thinking": "high" },
          { "agent": "planner", "model": "your-provider/strong-model", "thinking": "xhigh" },
          { "agent": "worker", "model": "your-provider/value-model", "thinking": "xhigh" },
          { "agent": "reviewer", "model": "your-provider/value-model", "thinking": "max" },
          { "agent": "advisor", "model": "your-provider/strong-model", "thinking": "xhigh" },
          "centurion"
        ]
      },
      "fe-value": {
        "description": "Frontend · standard projects (roster only — context falls back to global)",
        "members": [
          { "agent": "scout", "model": "your-provider/value-model", "thinking": "high" },
          { "agent": "prototype", "model": "your-provider/value-model", "thinking": "high" },
          { "agent": "planner", "model": "your-provider/strong-model", "thinking": "max" },
          { "agent": "worker", "model": "your-provider/value-model", "thinking": "xhigh" },
          { "agent": "reviewer", "model": "your-provider/value-model", "thinking": "max" },
          { "agent": "designer", "model": "your-provider/strong-model", "thinking": "xhigh" },
          { "agent": "advisor", "model": "your-provider/strong-model", "thinking": "xhigh" },
          "centurion"
        ]
      },
      "be-premium": {
        "description": "Backend · complex projects",
        "parentContext": false,
        "childContext": "@be-premium-child.md",
        "members": [
          { "agent": "scout", "model": "your-provider/strong-model", "thinking": "high" },
          { "agent": "planner", "model": "your-provider/strong-model", "thinking": "max" },
          { "agent": "worker", "model": "your-provider/strong-model", "thinking": "max" },
          { "agent": "reviewer", "model": "your-provider/strong-model", "thinking": "xhigh" },
          { "agent": "advisor", "model": "your-provider/strong-model", "thinking": "xhigh" },
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
