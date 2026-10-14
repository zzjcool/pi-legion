/**
 * Resolve the Pi agent directory (`~/.pi/agent` by default).
 *
 * Mirrors pi-subagents: `PI_CODING_AGENT_DIR` overrides the location so tests
 * and hermetic installs do not have to rewrite `$HOME`.
 */

import * as os from "node:os";
import * as path from "node:path";

/** Directory that holds `settings.json` and user-defined `agents/`. */
export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured === "~") return os.homedir();
	if (configured?.startsWith("~/")) {
		return path.join(os.homedir(), configured.slice(2));
	}
	if (configured) return configured;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
	return path.join(home, ".pi", "agent");
}
