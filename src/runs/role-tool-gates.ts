/**
 * Extensible doctor gates: role `tools:` that need an extension under
 * `--no-extensions` (#70 lens, #89/#97 codemode, future builtins).
 *
 * Add a row here when a new tool would otherwise false-promise under
 * `--no-extensions`. Keep stable `code` values when tests/docs depend on them.
 */

import { CHILD_EXTENSIONS_ENV, BUILTIN_CODEMODE, isCodemodeExtension } from "./args.ts";
import type { AgentConfig } from "../shared/types.ts";

export interface RoleToolExtensionGate {
	/** Stable issue code (lens/codemode keep specific codes for back-compat). */
	code: string;
	/** Match against role `tools:` entries. */
	matchesTools: (tools: readonly string[]) => boolean;
	/** True when the effective child extension list satisfies the requirement. */
	extensionsSatisfy: (exts: readonly string[]) => boolean;
	toolLabel: string;
	extensionLabel: string;
	fix: (roleName: string) => string;
	nextStep: string;
}

/**
 * Configurable tool → extension requirements for `/legion doctor` (#97).
 *
 * Order is the issue emission order. Prefer specific codes over a single
 * `ROLE_TOOL_UNAVAILABLE` so Next steps and existing tests stay precise.
 */
export const ROLE_TOOL_EXTENSION_GATES: readonly RoleToolExtensionGate[] = [
	{
		code: "ROLE_MISSING_LENS",
		matchesTools: (tools) =>
			tools.some((t) =>
				/lens|symbol_search|project_report|module_report|read_symbol|read_enclosing/i.test(t),
			),
		extensionsSatisfy: (exts) => exts.some((e) => /pi-lens/i.test(e)),
		toolLabel: "lens tools",
		extensionLabel: "pi-lens",
		fix: (roleName) =>
			`Add pi-lens to ${roleName}'s extensions: frontmatter, or to ${CHILD_EXTENSIONS_ENV}.`,
		nextStep:
			"Add pi-lens extension path to roles that list lens_* tools, or to PI_LEGION_CHILD_EXTENSIONS.",
	},
	{
		code: "ROLE_MISSING_CODEMODE",
		matchesTools: (tools) => tools.some((t) => t === "codemode"),
		extensionsSatisfy: (exts) => exts.some(isCodemodeExtension),
		toolLabel: "codemode",
		extensionLabel: BUILTIN_CODEMODE,
		fix: (roleName) =>
			`Add ${BUILTIN_CODEMODE} to ${roleName}'s extensions: frontmatter, or ensure tools: includes codemode so Legion auto-loads it.`,
		nextStep: `Add ${BUILTIN_CODEMODE} to roles that list codemode (or keep tools: codemode so Legion auto-loads it).`,
	},
];

/** Plain issue shape so this module stays free of doctor imports. */
export interface RoleToolGateIssue {
	severity: "warning";
	code: string;
	section: "extensions";
	message: string;
	fix: string;
}

/**
 * Collect role-tool / extension mismatch issues for one agent.
 *
 * `effectiveExts` should be the same list the child argv would load
 * (e.g. `collectChildExtensions`). When `inheritsExtensions` is true the
 * child loads host discovery — gates do not fire.
 */
export function collectRoleToolExtensionIssues(
	agent: Pick<AgentConfig, "name" | "tools">,
	effectiveExts: readonly string[],
	opts: { inheritsExtensions: boolean },
): RoleToolGateIssue[] {
	if (opts.inheritsExtensions) return [];
	const tools = agent.tools ?? [];
	const out: RoleToolGateIssue[] = [];
	for (const gate of ROLE_TOOL_EXTENSION_GATES) {
		if (!gate.matchesTools(tools)) continue;
		if (gate.extensionsSatisfy(effectiveExts)) continue;
		out.push({
			severity: "warning",
			code: gate.code,
			section: "extensions",
			message: `Role "${agent.name}" lists ${gate.toolLabel} but would not load ${gate.extensionLabel} under --no-extensions.`,
			fix: gate.fix(agent.name),
		});
	}
	return out;
}

/** Next-step lines for any gate codes present in `issues`. */
export function roleToolGateNextSteps(issues: readonly { code: string }[]): string[] {
	const steps: string[] = [];
	for (const gate of ROLE_TOOL_EXTENSION_GATES) {
		if (issues.some((i) => i.code === gate.code)) steps.push(gate.nextStep);
	}
	return steps;
}
