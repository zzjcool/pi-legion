# Team configuration examples

`subagents.teams` maps team names to an ordered roster. A member can be a role
name string or an object with an `agent` name and per-member overrides. The
examples below mirror the four local practice teams; replace every model
placeholder with an ID available from your provider. No provider-specific
model is required by these templates.

```json
{
  "subagents": {
    "teams": {
      "fe-premium": {
        "description": "Frontend · complex projects",
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
      "fe-value": {
        "description": "Frontend · standard projects",
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
        "members": [
          { "agent": "scout", "model": "your-provider/strong-model", "thinking": "high" },
          { "agent": "planner", "model": "your-provider/strong-model", "thinking": "max" },
          { "agent": "worker", "model": "your-provider/strong-model", "thinking": "max" },
          { "agent": "reviewer", "model": "your-provider/strong-model", "thinking": "xhigh" },
          { "agent": "advisor", "model": "your-provider/strong-model", "thinking": "xhigh" },
          "centurion"
        ]
      },
      "be-value": {
        "description": "Backend · standard projects",
        "members": [
          { "agent": "scout", "model": "your-provider/value-model", "thinking": "high" },
          { "agent": "planner", "model": "your-provider/strong-model", "thinking": "xhigh" },
          { "agent": "worker", "model": "your-provider/value-model", "thinking": "xhigh" },
          { "agent": "reviewer", "model": "your-provider/value-model", "thinking": "max" },
          { "agent": "advisor", "model": "your-provider/strong-model", "thinking": "xhigh" },
          "centurion"
        ]
      }
    }
  }
}
```

Each team's `description` and `members` shape follows
`subagents.teams.<name>`. Member objects apply their own `model` and
`thinking` values to that role in this team; those values override the same
fields in the role card's frontmatter. Omitted member override fields continue
to use the role card/configuration defaults. The string `"centurion"` is a
plain roster entry with no member-level override.

To make one team the settings default, add a sibling `"team": "be-value"`
under `"subagents"`. `PI_SUBAGENTS_TEAM` takes precedence over that configured
`subagents.team` value when selecting the team. See the README's [Team
配置](../README.md#team-配置) section for the selection and override semantics.
