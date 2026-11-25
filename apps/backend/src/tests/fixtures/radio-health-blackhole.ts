import { stdin } from "bun";
import { z } from "zod";
import {
	diagnoseRadio,
	metric,
	type RadioEvidence,
} from "../../modules/modems/radio-health.ts";

const rows = z
	.array(z.object({ failed: z.boolean(), otherPassed: z.boolean() }))
	.parse(JSON.parse(await stdin.text()));
let failed = 0;
for (const [index, row] of rows.entries()) {
	if (!row.failed || !row.otherPassed)
		throw new Error("namespace observations did not match fixture");
	failed++;
	const at = (index + 1) * 30000;
	const evidence: RadioEvidence = {
		at,
		registration: "connected",
		homeNetwork: undefined,
		rejectedNetwork: undefined,
		refused: false,
		granted: true,
		failedProbes: failed,
		probeAt: at,
		rsrp: metric(null, "test", "dBm", "lte", at),
		quality: metric(null, "test", "dB", "lte", at),
		transmitting: "unknown",
		usb: [],
	};
	const result = diagnoseRadio(evidence, undefined, {});
	if (result.kind !== (index === 0 ? "unknown" : "data-path"))
		throw new Error("incorrect data-path verdict");
}
