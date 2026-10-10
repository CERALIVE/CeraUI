import type { RaucObservationDeps } from "../../modules/system/update-orchestrator/os-stage-observation.ts";
import {
	rockHelperFixture,
	rockStats,
} from "./os-stage-rock-helper-fixture.ts";

export type CensusDrift = "retiring-process" | "appearing-process" | "resource";

/** Captured process identities; synthetic slots/resources; deterministic census barrier. */
export function censusDriftFixture(kind: CensusDrift, persistent = false) {
	const fixture = rockHelperFixture([]);
	let censuses = 0;
	let helper = false;
	let resource = false;
	const deps: RaucObservationDeps = {
		...fixture.deps,
		read: async (path) => {
			if (path.endsWith("cgroup.procs")) {
				censuses++;
				const drifting = persistent || censuses <= 2;
				switch (kind) {
					case "retiring-process":
						helper = drifting && censuses % 2 === 1;
						break;
					case "appearing-process":
						helper = drifting && censuses % 2 === 0;
						break;
					case "resource":
						resource = drifting && censuses % 2 === 1;
						break;
					default:
						throw new Error(kind satisfies never);
				}
				return `729106\n${helper ? "877184\n" : ""}`;
			}
			if (path === "/proc/self/mountinfo" && resource)
				return "42 1 1:2 / /run/rauc rw - tmpfs tmpfs rw\n";
			if (path === "/proc/877184/stat" && helper) {
				const raw = rockStats.get("877184");
				if (raw) return raw;
			}
			return fixture.deps.read(path);
		},
	};
	return { deps, censuses: () => censuses };
}
