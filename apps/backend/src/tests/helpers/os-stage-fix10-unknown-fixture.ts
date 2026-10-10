import type { RaucObservationDeps } from "../../modules/system/update-orchestrator/os-stage-observation.ts";

export const nonCensusFaults = [
	"operation-command",
	"operation-malformed",
	"health-unavailable",
] as const;
export type NonCensusFault = (typeof nonCensusFaults)[number];

/** One independent fault on the first observation; subsequent evidence is clean. */
export function unknownEvidenceFixture(
	source: RaucObservationDeps,
	fault: NonCensusFault,
) {
	let operations = 0;
	const deps: RaucObservationDeps = {
		...source,
		run: async (...args) => {
			const result = await source.run(...args);
			if (args[0][0] !== "busctl" || ++operations !== 1) return result;
			switch (fault) {
				case "operation-command":
					return { ...result, exitCode: 1 };
				case "operation-malformed":
					return { ...result, stdout: "invalid" };
				case "health-unavailable":
					return result;
				default:
					throw new Error(fault satisfies never);
			}
		},
		healthy: () =>
			fault === "health-unavailable" && operations === 1
				? Promise.resolve(null)
				: source.healthy(),
	};
	return { deps, operations: () => operations };
}
