/**
 * Host built-in extensions an in-process child session can resolve (D1).
 *
 * Names only, deliberately no SDK import: the regression gate asserts that every
 * `builtin:<name>` path a child receives is closed over this list, and importing
 * the host package just to compare names would load the whole SDK in a unit run.
 *
 * A name here is not a switch — the `builtin:` path chosen by
 * `collectChildExtensions` is. `defaultSessionFactory` wires one factory per name;
 * `mcp` has no path yet, so MR1 connects no MCP server.
 */
export const CHILD_BUILTIN_EXTENSIONS = ["codemode", "tool-search", "mcp"] as const;
