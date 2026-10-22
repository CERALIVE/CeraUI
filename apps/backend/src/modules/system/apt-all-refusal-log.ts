import { logger } from "../../helpers/logger.ts";
import type { AptAllDiagnosticStep } from "./apt-all-diagnostics.ts";
import type { AptAllRefusalError } from "./apt-all-packages.ts";

const STAGES = {
	simulation: "simulation",
	"source-policy": "source-policy",
	"package-policy": "package-policy",
	"parse-simulation": "parse",
	"held-packages": "parse",
	"install-vector": "parse",
	"pinned-simulation": "simulation",
	"pinned-recheck": "parse",
} as const satisfies Record<AptAllDiagnosticStep, string>;

const signatures = new Map<AptAllDiagnosticStep, string>();

export function resetAptAllRefusalLogForTest(): void {
	signatures.clear();
}

export function logAptAllRefusal(error: AptAllRefusalError): void {
	const { reason, step, exit, detail, fingerprint } = error;
	const signature = JSON.stringify([reason, exit, fingerprint]);
	if (signatures.get(step) === signature) return;
	signatures.set(step, signature);
	logger.child({ stage: STAGES[step] }).warn("Capable APT update refused", {
		reason,
		step,
		exit,
		detail: detail?.slice(0, 300).replace(/[\uD800-\uDBFF]$/, ""),
	});
}
