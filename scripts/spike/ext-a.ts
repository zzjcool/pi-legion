/** Spike registrant A (issue #417). EXPERIMENT ONLY — delete with scripts/spike/. */
import { installHold } from "./hold-common.ts";

export default function spikeExtA(pi: any): void {
	installHold(pi, "A");
}
