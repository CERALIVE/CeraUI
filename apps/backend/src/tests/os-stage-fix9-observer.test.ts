import { expect, test } from "bun:test";
import { STAGE_CENSUS_DRIFT } from "../modules/system/update-orchestrator/os-stage-admission-diagnostics.ts";
import { observeRaucStage } from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { censusDriftFixture } from "./helpers/os-stage-census-drift-fixture.ts";

test.each(["retiring-process", "appearing-process", "resource"] as const)(
	"observer returns no authorizing snapshot for %s drift",
	async (kind) => {
		// Given two successful censuses with different process/resource membership.
		const fixture = censusDriftFixture(kind);
		const details: string[] = [];
		// When the observer compares its final pair.
		const snapshot = await observeRaucStage(
			{ processes: new Set(), resources: new Set() },
			fixture.deps,
			(detail) => details.push(detail),
		);
		// Then only the closed retry diagnostic escapes, never a stale snapshot.
		expect(snapshot).toBeNull();
		expect(details).toEqual([STAGE_CENSUS_DRIFT]);
	},
);
