/**
 * Host built-in extensions an in-process child session can resolve (D1).
 *
 * Names only, deliberately no SDK import: the regression gate asserts that every
 * `builtin:<name>` path a child receives is closed over this list, and importing
 * the host package just to compare names would load the whole SDK in a unit run.
 *
 * A name here is not a load switch — the `builtin:` path chosen by
 * `collectChildExtensions` is. It is not inert either: once a factory is
 * registered the name enters `DefaultPackageManager`'s builtin table, and
 * discovery synthesizes a **default-enabled** `builtin:<name>` for it
 * (`resource-loader.js:265-270` → `package-manager.js:766-772`). So "mcp has no
 * path yet" is NOT what keeps MCP out of MR1; the gates are `noExtensions: true`
 * (D3) and never triggering `session_start` (D5). Even if `builtin:mcp` were
 * loaded someday, nothing in MR1 opens an MCP connection.
 */
export const CHILD_BUILTIN_EXTENSIONS = ["codemode", "tool-search", "mcp"] as const;

/** One factory per name. Keyed, not positional, so a missing name is a type error. */
export type ChildBuiltinFactories = Record<(typeof CHILD_BUILTIN_EXTENSIONS)[number], unknown>;

/** A loader-ready inline extension, as `DefaultResourceLoader.extensionFactories` wants it. */
export interface ChildBuiltinExtensionEntry<Factory = unknown> {
	name: (typeof CHILD_BUILTIN_EXTENSIONS)[number];
	factory: Factory;
	builtin: true;
	replaceable: true;
}

/**
 * Turn a name→factory map into the loader's {@link ChildBuiltinExtensionEntry}
 * list (D7).
 *
 * This is the single construction point for `defaultSessionFactory`'s
 * `extensionFactories`: keeping it here makes the wiring testable without
 * building a session, and wiring by name (not by position) means reordering the
 * constant can never hand `codemode` the tool-search factory. The generic return
 * type preserves each factory's own type, so callers get an `InlineExtension[]`
 * with no cast.
 */
export function childBuiltinExtensionEntries<F extends ChildBuiltinFactories>(
	factories: F,
): ChildBuiltinExtensionEntry<F[(typeof CHILD_BUILTIN_EXTENSIONS)[number]]>[] {
	return CHILD_BUILTIN_EXTENSIONS.map((name) => ({
		name,
		factory: factories[name],
		builtin: true,
		replaceable: true,
	}));
}
