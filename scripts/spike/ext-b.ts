/** Spike registrant B (issue #417). EXPERIMENT ONLY — delete with scripts/spike/. */
import { installHold } from "./hold-common.ts";

export default function spikeExtB(pi: any): void {
	installHold(pi, "B");
}
